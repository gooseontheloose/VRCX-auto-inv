import http from 'node:http';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
    DISCORD_LIMITS,
    clampPayload,
    isValidDiscordWebhookUrl,
    postDiscordWebhook,
    withWait
} from '../discord';

// Local mock of Discord's webhook endpoint. Never talks to discord.com.
let server;
let baseUrl;
const received = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            received.push({ url: req.url, body });
            const path = req.url.split('?')[0];
            if (path === '/ok') {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset-After': '1.5'
                });
                res.end('{"id":"1"}');
            } else if (path === '/ratelimited') {
                res.writeHead(429, {
                    'Content-Type': 'application/json',
                    'Retry-After': '9'
                });
                res.end(
                    '{"message":"You are being rate limited.","retry_after":2.5,"global":false}'
                );
            } else if (path === '/global') {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end('{"retry_after":1,"global":true}');
            } else if (path === '/hang') {
                // never answers: the client has to time out on its own
            } else if (path === '/boom') {
                res.writeHead(502);
                res.end('bad gateway');
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{"message":"Unknown Webhook","code":10015}');
            }
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(
    () =>
        new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
        })
);

describe('isValidDiscordWebhookUrl', () => {
    test.each([
        ['https://discord.com/api/webhooks/123/abc-DEF_1', true],
        ['https://canary.discord.com/api/webhooks/123/abc', true],
        ['https://discordapp.com/api/v10/webhooks/123/abc?thread_id=5', true],
        ['http://discord.com/api/webhooks/123/abc', false],
        ['https://evil.example/api/webhooks/123/abc', false],
        ['https://discord.com/api/webhooks/abc/abc', false],
        ['', false],
        [null, false]
    ])('%s -> %s', (url, ok) => {
        expect(isValidDiscordWebhookUrl(url)).toBe(ok);
    });
});

test('withWait keeps an existing query', () => {
    expect(withWait('https://x/y')).toBe('https://x/y?wait=true');
    expect(withWait('https://x/y?thread_id=1')).toBe(
        'https://x/y?thread_id=1&wait=true'
    );
    expect(withWait('https://x/y?wait=false')).toBe('https://x/y?wait=false');
});

describe('clampPayload', () => {
    test('truncates every field to Discord limits', () => {
        const long = 'x'.repeat(5000);
        const out = clampPayload({
            embeds: Array.from({ length: 12 }, () => ({
                title: long,
                description: long,
                fields: Array.from({ length: 30 }, () => ({
                    name: long,
                    value: long
                }))
            }))
        });
        expect(out.embeds.length).toBeLessThanOrEqual(DISCORD_LIMITS.embeds);
        const e = out.embeds[0];
        expect(e.title.length).toBeLessThanOrEqual(256);
        expect(e.fields.length).toBeLessThanOrEqual(25);
        for (const f of e.fields) {
            expect(f.name.length).toBeLessThanOrEqual(256);
            expect(f.value.length).toBeLessThanOrEqual(1024);
        }
        const total = out.embeds.reduce(
            (s, x) =>
                s +
                (x.title ?? '').length +
                (x.description ?? '').length +
                (x.fields ?? []).reduce(
                    (a, f) => a + f.name.length + f.value.length,
                    0
                ),
            0
        );
        expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
    });

    test('leaves small payloads untouched', () => {
        const p = {
            embeds: [
                {
                    title: 'a',
                    description: 'b',
                    fields: [{ name: 'n', value: 'v' }]
                }
            ]
        };
        expect(clampPayload(p)).toEqual(p);
    });
});

describe('postDiscordWebhook against a local mock server', () => {
    test('success adds wait=true and reports bucket exhaustion', async () => {
        const res = await postDiscordWebhook(`${baseUrl}/ok`, {
            content: 'hi'
        });
        expect(res).toMatchObject({
            kind: 'ok',
            status: 200,
            bucketResetMs: 1500
        });
        expect(received.at(-1).url).toBe('/ok?wait=true');
        expect(JSON.parse(received.at(-1).body)).toEqual({ content: 'hi' });
    });

    test('429 uses retry_after from the body', async () => {
        const res = await postDiscordWebhook(`${baseUrl}/ratelimited`, {
            content: 'x'
        });
        expect(res).toMatchObject({
            kind: 'rate_limited',
            status: 429,
            retryAfterMs: 2500,
            global: false
        });
    });

    test('global 429 is flagged', async () => {
        const res = await postDiscordWebhook(`${baseUrl}/global`, {
            content: 'x'
        });
        expect(res).toMatchObject({
            kind: 'rate_limited',
            global: true,
            retryAfterMs: 1000
        });
    });

    test('5xx is retryable, 404 is permanent', async () => {
        expect(await postDiscordWebhook(`${baseUrl}/boom`, {})).toMatchObject({
            kind: 'retry',
            status: 502
        });
        const gone = await postDiscordWebhook(`${baseUrl}/deleted`, {});
        expect(gone).toMatchObject({ kind: 'permanent', status: 404 });
        expect(gone.error).toContain('Unknown Webhook');
    });

    test('network errors are retryable', async () => {
        const res = await postDiscordWebhook('http://127.0.0.1:1/nothing', {});
        expect(res.kind).toBe('retry');
        expect(res.status).toBe(0);
    });

    test('a request that never finishes times out as a retryable network error', async () => {
        const started = Date.now();
        const res = await postDiscordWebhook(
            `${baseUrl}/hang`,
            { content: 'x' },
            { timeoutMs: 300 }
        );
        expect(res).toMatchObject({ kind: 'retry', status: 0 });
        expect(res.error).toContain('Timed out');
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test('times out even if fetch ignores the abort signal', async () => {
        let signal;
        const res = await postDiscordWebhook(
            'https://discord.com/api/webhooks/1/x',
            {},
            {
                timeoutMs: 50,
                fetchImpl: (_url, init) => {
                    signal = init.signal;
                    return new Promise(() => {});
                }
            }
        );
        expect(res).toMatchObject({ kind: 'retry', status: 0 });
        expect(signal?.aborted).toBe(true);
    });
});
