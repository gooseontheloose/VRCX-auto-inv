import { describe, expect, test, vi } from 'vitest';

import { createDeliveryQueue } from '../deliveryQueue';
import { createMemoryMonitorStorage } from '../memoryStorage';

function setup({ backing = {}, results = [], webhooks, options } = {}) {
    let now = 1_000_000;
    const storage = createMemoryMonitorStorage(backing);
    const hooks = webhooks ?? {
        a: { url: 'https://hook/a', enabled: true },
        b: { url: 'https://hook/b', enabled: true }
    };
    const calls = [];
    const post = vi.fn(async (url, payload) => {
        calls.push({ url, payload, at: now });
        const r = results.length
            ? results.shift()
            : { kind: 'ok', status: 200 };
        return typeof r === 'function' ? r(url) : r;
    });
    const events = [];
    const queue = createDeliveryQueue({
        storage,
        post,
        now: () => now,
        resolveWebhook: (id) => hooks[id] ?? null,
        onEvent: (e) => events.push(e.type),
        options
    });
    return {
        queue,
        storage,
        post,
        calls,
        events,
        hooks,
        backing,
        advance: (ms) => {
            now += ms;
        }
    };
}

describe('delivery queue', () => {
    test('sends serially and removes delivered items', async () => {
        const t = setup();
        await t.queue.load('usr_1');
        await t.queue.enqueue({
            webhookId: 'a',
            eventId: 'e1',
            payload: { n: 1 }
        });
        await t.queue.enqueue({
            webhookId: 'b',
            eventId: 'e2',
            payload: { n: 2 }
        });
        await Promise.all([t.queue.processDue(), t.queue.processDue()]);
        expect(t.post).toHaveBeenCalledTimes(2);
        expect(t.calls.map((c) => c.payload.n)).toEqual([1, 2]);
        expect(t.queue.stats()).toEqual({ pending: 0, dead: 0 });
        expect(await t.storage.loadQueue('usr_1')).toEqual([]);
    });

    test('dedupes on webhook + event id, also across a restart', async () => {
        const backing = {};
        const first = setup({ backing });
        await first.queue.load('usr_1');
        expect(
            (
                await first.queue.enqueue({
                    webhookId: 'a',
                    eventId: 'audit:1',
                    payload: {}
                })
            ).queued
        ).toBe(true);
        expect(
            (
                await first.queue.enqueue({
                    webhookId: 'a',
                    eventId: 'audit:1',
                    payload: {}
                })
            ).reason
        ).toBe('duplicate');
        // other webhook, same event: allowed
        expect(
            (
                await first.queue.enqueue({
                    webhookId: 'b',
                    eventId: 'audit:1',
                    payload: {}
                })
            ).queued
        ).toBe(true);
        await first.queue.processDue();

        const second = setup({ backing });
        await second.queue.load('usr_1');
        expect(
            (
                await second.queue.enqueue({
                    webhookId: 'a',
                    eventId: 'audit:1',
                    payload: {}
                })
            ).queued
        ).toBe(false);
        // a different account has its own ledger
        await second.queue.load('usr_2');
        expect(
            (
                await second.queue.enqueue({
                    webhookId: 'a',
                    eventId: 'audit:1',
                    payload: {}
                })
            ).queued
        ).toBe(true);
    });

    test('pending items survive a restart and are sent after reload', async () => {
        const backing = {};
        const first = setup({
            backing,
            results: [{ kind: 'retry', status: 503, error: 'HTTP 503' }]
        });
        await first.queue.load('usr_1');
        await first.queue.enqueue({
            webhookId: 'a',
            eventId: 'e1',
            payload: { n: 1 }
        });
        await first.queue.processDue();
        expect(first.queue.stats()).toEqual({ pending: 1, dead: 0 });

        const second = setup({ backing });
        await second.queue.load('usr_1');
        second.advance(60_000);
        await second.queue.processDue();
        expect(second.post).toHaveBeenCalledTimes(1);
        expect(second.queue.stats()).toEqual({ pending: 0, dead: 0 });
    });

    test('429 honours retry_after and only blocks that webhook URL', async () => {
        const t = setup({
            results: [
                {
                    kind: 'rate_limited',
                    status: 429,
                    retryAfterMs: 2500,
                    error: 'HTTP 429'
                },
                { kind: 'ok', status: 200 },
                { kind: 'ok', status: 200 }
            ]
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({
            webhookId: 'a',
            eventId: 'e1',
            payload: { n: 'a1' }
        });
        await t.queue.enqueue({
            webhookId: 'b',
            eventId: 'e2',
            payload: { n: 'b1' }
        });
        await t.queue.processDue();
        // a was limited, b still went out
        expect(t.calls.map((c) => c.payload.n)).toEqual(['a1', 'b1']);
        expect(t.queue.stats()).toEqual({ pending: 1, dead: 0 });

        t.advance(2000);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(2); // still blocked

        t.advance(600);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(3);
        expect(t.calls[2].payload.n).toBe('a1');
        expect(t.queue.stats()).toEqual({ pending: 0, dead: 0 });
        // a 429 does not burn a normal attempt
        expect(t.events).toContain('rate_limited');
    });

    test('global 429 pauses every webhook', async () => {
        const t = setup({
            results: [
                {
                    kind: 'rate_limited',
                    status: 429,
                    retryAfterMs: 1000,
                    global: true
                }
            ]
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e1', payload: {} });
        await t.queue.enqueue({ webhookId: 'b', eventId: 'e2', payload: {} });
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(1);
        t.advance(1000);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(3);
    });

    test('bucket exhaustion headers space out the next send to the same URL', async () => {
        const t = setup({
            results: [{ kind: 'ok', status: 200, bucketResetMs: 1500 }]
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e1', payload: {} });
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e2', payload: {} });
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(1);
        t.advance(1500);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(2);
    });

    test('5xx / network errors back off exponentially then dead-letter', async () => {
        const fail = { kind: 'retry', status: 500, error: 'HTTP 500' };
        const t = setup({
            results: Array.from({ length: 10 }, () => fail),
            options: { maxAttempts: 4, baseDelayMs: 1000 }
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e1', payload: {} });
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(1);
        for (const delay of [1000, 2000, 4000]) {
            t.advance(delay - 1);
            await t.queue.processDue();
            const before = t.post.mock.calls.length;
            t.advance(1);
            await t.queue.processDue();
            expect(t.post.mock.calls.length).toBe(before + 1);
        }
        expect(t.queue.stats()).toEqual({ pending: 0, dead: 1 });
        expect(t.events.at(-1)).toBe('dead');
        // stays dead
        t.advance(3_600_000);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(4);
        // retry puts it back
        await t.queue.retryDead();
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(5);
    });

    test('4xx other than 429 is permanent', async () => {
        const t = setup({
            results: [
                {
                    kind: 'permanent',
                    status: 404,
                    error: 'HTTP 404: Unknown Webhook'
                }
            ]
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e1', payload: {} });
        await t.queue.processDue();
        t.advance(3_600_000);
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(1);
        expect(t.queue.items[0]).toMatchObject({
            status: 'dead',
            lastError: 'HTTP 404: Unknown Webhook'
        });
    });

    test('disabled webhooks hold their items; test sends still go out; deleted ones are dropped', async () => {
        const t = setup({
            webhooks: { a: { url: 'https://hook/a', enabled: false } }
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({
            webhookId: 'a',
            eventId: 'audit:1',
            payload: {}
        });
        await t.queue.enqueue({
            webhookId: 'a',
            eventId: 'test:1',
            payload: {},
            dedupe: false
        });
        await t.queue.enqueue({
            webhookId: 'gone',
            eventId: 'audit:2',
            payload: {}
        });
        await t.queue.processDue();
        expect(t.post).toHaveBeenCalledTimes(1);
        expect(t.events).toContain('dropped');
        expect(t.queue.stats()).toEqual({ pending: 1, dead: 0 });
    });

    test('reset() (logout) stops work and ignores late results', async () => {
        let release;
        const t = setup({
            results: [
                () =>
                    new Promise(
                        (r) => (release = () => r({ kind: 'ok', status: 200 }))
                    )
            ]
        });
        await t.queue.load('usr_1');
        await t.queue.enqueue({ webhookId: 'a', eventId: 'e1', payload: {} });
        const run = t.queue.processDue();
        await Promise.resolve();
        t.queue.reset();
        release();
        await run;
        expect(t.queue.items).toEqual([]);
        // delivered while logging out: must not be re-sent next login
        expect(await t.storage.loadQueue('usr_1')).toEqual([]);
        expect(
            (
                await t.queue.enqueue({
                    webhookId: 'a',
                    eventId: 'e2',
                    payload: {}
                })
            ).reason
        ).toBe('stopped');
    });
});
