// Discord webhook transport: URL validation, payload clamping to Discord's
// embed limits, and a single POST that classifies the outcome so the delivery
// queue can decide between success / retry / rate-limit / permanent failure.

export const DISCORD_LIMITS = Object.freeze({
    content: 2000,
    embeds: 10,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    author: 256,
    total: 6000
});

const WEBHOOK_URL_RE =
    /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/;

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isValidDiscordWebhookUrl(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    // Allow the ?thread_id= query some users paste, strip it for the regex check.
    const [base] = trimmed.split('?');
    return WEBHOOK_URL_RE.test(base);
}

/**
 * Adds wait=true so Discord returns the created message (and a real error
 * body) instead of an empty 204, keeping any query the user already had.
 * @param {string} url
 * @returns {string}
 */
export function withWait(url) {
    const trimmed = String(url).trim();
    if (/[?&]wait=/.test(trimmed)) return trimmed;
    return trimmed + (trimmed.includes('?') ? '&' : '?') + 'wait=true';
}

function cut(value, max) {
    if (value === undefined || value === null) return value;
    const s = String(value);
    return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function embedSize(e) {
    let n = 0;
    n += (e.title ?? '').length;
    n += (e.description ?? '').length;
    n += (e.footer?.text ?? '').length;
    n += (e.author?.name ?? '').length;
    for (const f of e.fields ?? [])
        n += (f.name ?? '').length + (f.value ?? '').length;
    return n;
}

/**
 * Returns a copy of the payload that fits Discord's documented limits.
 * Over-long strings are cut with an ellipsis; if all embeds together still
 * exceed 6000 chars, descriptions are shortened (last embed first) and then
 * trailing embeds dropped.
 * @param {object} payload
 * @returns {object}
 */
export function clampPayload(payload) {
    const L = DISCORD_LIMITS;
    const out = { ...payload };
    if (out.content !== undefined) out.content = cut(out.content, L.content);
    if (!Array.isArray(out.embeds)) return out;
    let embeds = out.embeds.slice(0, L.embeds).map((e) => {
        const c = { ...e };
        if (c.title !== undefined) c.title = cut(c.title, L.title);
        if (c.description !== undefined)
            c.description = cut(c.description, L.description);
        if (c.footer)
            c.footer = { ...c.footer, text: cut(c.footer.text, L.footer) };
        if (c.author)
            c.author = { ...c.author, name: cut(c.author.name, L.author) };
        if (Array.isArray(c.fields)) {
            c.fields = c.fields.slice(0, L.fields).map((f) => ({
                ...f,
                name: cut(f.name || '​', L.fieldName),
                value: cut(f.value || '​', L.fieldValue)
            }));
        }
        return c;
    });
    let total = embeds.reduce((s, e) => s + embedSize(e), 0);
    for (let i = embeds.length - 1; i >= 0 && total > L.total; i--) {
        const e = embeds[i];
        const desc = e.description ?? '';
        if (!desc) continue;
        const keep = Math.max(0, desc.length - (total - L.total));
        const next = keep > 0 ? cut(desc, keep) : '';
        total -= desc.length - next.length;
        embeds[i] = { ...e, description: next };
    }
    while (total > L.total && embeds.length > 1) {
        total -= embedSize(embeds.pop());
    }
    if (total > L.total && embeds.length === 1) {
        const e = { ...embeds[0], fields: [...(embeds[0].fields ?? [])] };
        while (total > L.total && e.fields.length) {
            const f = e.fields.pop();
            total -= f.name.length + f.value.length;
        }
        if (total > L.total && e.title) {
            const next = cut(
                e.title,
                Math.max(1, e.title.length - (total - L.total))
            );
            total -= e.title.length - next.length;
            e.title = next;
        }
        embeds = [e];
    }
    out.embeds = embeds;
    return out;
}

function headerNumber(headers, name) {
    try {
        const v = headers?.get?.(name);
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/**
 * POSTs a payload to a Discord webhook and classifies the result.
 *
 * kind:
 *  - 'ok'           delivered
 *  - 'rate_limited' 429; retryAfterMs says when to try again (global = whole bucket)
 *  - 'retry'        network error / 5xx; caller should back off
 *  - 'permanent'    4xx other than 429 (bad URL, deleted webhook, invalid body)
 *
 * @param {string} url
 * @param {object} payload
 * A request that has not finished after `timeoutMs` (default 30s) is aborted
 * and reported as a network error ('retry', status 0), so one stalled
 * connection can never block the delivery queue.
 *
 * @param {string} url
 * @param {object} payload
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{kind: 'ok'|'rate_limited'|'retry'|'permanent', status: number, retryAfterMs?: number, global?: boolean, bucketResetMs?: number|null, error?: string}>}
 */
export async function postDiscordWebhook(url, payload, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
    const controller =
        typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
            controller?.abort();
            resolve({
                kind: 'retry',
                status: 0,
                error: `Timed out after ${Math.round(timeoutMs / 1000)}s`
            });
        }, timeoutMs);
    });
    try {
        // race as well as abort: a fetch that ignores the signal still can't hang us
        return await Promise.race([
            sendAndClassify(url, payload, opts, controller?.signal),
            timedOut
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Default timeout for one webhook POST. */
export const POST_TIMEOUT_MS = 30_000;

async function sendAndClassify(url, payload, opts, signal) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    let res;
    try {
        res = await fetchImpl(withWait(url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clampPayload(payload)),
            ...(signal ? { signal } : {})
        });
    } catch (err) {
        return {
            kind: 'retry',
            status: 0,
            error: err?.message || 'Network error'
        };
    }
    const status = res.status;
    // When the bucket is exhausted after this request, Discord tells us how long
    // until it resets; the queue uses it to space out the next send.
    const remaining = headerNumber(res.headers, 'X-RateLimit-Remaining');
    const resetAfter = headerNumber(res.headers, 'X-RateLimit-Reset-After');
    const bucketResetMs =
        remaining === 0 && resetAfter !== null
            ? Math.ceil(resetAfter * 1000)
            : null;

    if (res.ok) return { kind: 'ok', status, bucketResetMs };

    let body = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }
    if (status === 429) {
        let seconds = Number(body?.retry_after);
        if (!Number.isFinite(seconds))
            seconds = headerNumber(res.headers, 'Retry-After');
        if (!Number.isFinite(seconds) || seconds === null)
            seconds = resetAfter ?? 5;
        return {
            kind: 'rate_limited',
            status,
            retryAfterMs: Math.max(250, Math.ceil(seconds * 1000)),
            global:
                Boolean(body?.global) ||
                res.headers?.get?.('X-RateLimit-Global') === 'true',
            error: 'HTTP 429 rate limited'
        };
    }
    const detail = body?.message ? `: ${body.message}` : '';
    if (status >= 500)
        return { kind: 'retry', status, error: `HTTP ${status}${detail}` };
    return { kind: 'permanent', status, error: `HTTP ${status}${detail}` };
}
