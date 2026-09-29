// One persisted delivery queue for every Group Monitor webhook post.
//
// - enqueue() dedupes on (account, webhookId, eventId) using a persisted
//   ledger, so the same audit entry / crash / schedule slot is never posted
//   twice, even across restarts.
// - processDue() is a single serial worker. A 429 blocks only that webhook URL
//   (or everything, for a global limit) for Discord's retry_after; 5xx and
//   network errors back off exponentially; other 4xx are permanent.
// - Items that exhaust their attempts become 'dead' and stay visible in the UI
//   until retried or cleared.

export const QUEUE_DEFAULTS = Object.freeze({
    maxAttempts: 6,
    baseDelayMs: 10_000,
    maxDelayMs: 10 * 60_000,
    maxRateLimitHits: 10,
    dedupeRetentionMs: 14 * 24 * 60 * 60_000
});

let _seq = 0;
function newId(now) {
    _seq = (_seq + 1) % 1_000_000;
    return `q-${now.toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} deps
 * @param {Omit<ReturnType<typeof import('./memoryStorage').createMemoryMonitorStorage>, 'backing'>} deps.storage
 * @param {(url: string, payload: object) => Promise<{kind: string, status: number, retryAfterMs?: number, global?: boolean, bucketResetMs?: number|null, error?: string}>} deps.post
 * @param {(webhookId: string) => ({url: string, enabled: boolean} | null)} deps.resolveWebhook
 * @param {() => number} [deps.now]
 * @param {(evt: {type: string, item: object, result?: object}) => void} [deps.onEvent]
 * @param {Partial<typeof QUEUE_DEFAULTS>} [deps.options]
 */
export function createDeliveryQueue(deps) {
    const opts = { ...QUEUE_DEFAULTS, ...(deps.options ?? {}) };
    const now = deps.now ?? (() => Date.now());
    const emit = (type, item, result) => {
        try {
            deps.onEvent?.({ type, item, result });
        } catch (err) {
            console.error('[GroupMonitor] queue listener failed:', err);
        }
    };

    let userId = null;
    let generation = 0;
    /** @type {Array<any>} */
    let items = [];
    const blockedUntil = new Map(); // url -> ms
    let globalBlockedUntil = 0;
    let working = null;

    function dedupeKey(webhookId, eventId) {
        return `${userId}|${webhookId}|${eventId}`;
    }

    async function load(forUserId) {
        generation++;
        userId = forUserId;
        items = [];
        blockedUntil.clear();
        globalBlockedUntil = 0;
        const gen = generation;
        const loaded = await deps.storage.loadQueue(forUserId);
        if (gen !== generation) return;
        // Anything that was 'sending' when VRCX closed is retried.
        items = loaded.map((i) =>
            i.status === 'sending' ? { ...i, status: 'pending' } : i
        );
        await deps.storage
            .pruneDedupe(now() - opts.dedupeRetentionMs)
            .catch(() => {});
    }

    function reset() {
        generation++;
        userId = null;
        items = [];
        blockedUntil.clear();
        globalBlockedUntil = 0;
    }

    /**
     * @param {{webhookId: string, eventId: string, payload: object, dedupe?: boolean, force?: boolean}} input
     * @returns {Promise<{queued: boolean, reason?: string, item?: object}>}
     */
    async function enqueue(input) {
        if (!userId) return { queued: false, reason: 'stopped' };
        const gen = generation;
        const dedupe = input.dedupe !== false;
        const key = dedupeKey(input.webhookId, input.eventId);
        if (dedupe) {
            if (
                items.some(
                    (i) =>
                        i.webhookId === input.webhookId &&
                        i.eventId === input.eventId
                )
            ) {
                return { queued: false, reason: 'duplicate' };
            }
            if (await deps.storage.hasDedupe(key))
                return { queued: false, reason: 'duplicate' };
            if (gen !== generation) return { queued: false, reason: 'stopped' };
        }
        const t = now();
        const item = {
            id: newId(t),
            userId,
            webhookId: input.webhookId,
            eventId: input.eventId,
            payload: input.payload,
            attempts: 0,
            rateLimitHits: 0,
            force: Boolean(input.force),
            nextAt: t,
            status: 'pending',
            lastError: null,
            createdAt: t
        };
        // Ledger first: if we crash between the two writes the event is lost
        // rather than posted twice, which is the lesser evil for alerts.
        if (dedupe) await deps.storage.addDedupe(key, t);
        await deps.storage.saveQueueItem(item);
        if (gen !== generation) return { queued: false, reason: 'stopped' };
        items.push(item);
        emit('queued', item);
        return { queued: true, item };
    }

    function isBlocked(url, t) {
        if (globalBlockedUntil > t) return true;
        return (blockedUntil.get(url) ?? 0) > t;
    }

    function pickNext(t) {
        for (const item of items) {
            if (item.status !== 'pending' || item.nextAt > t) continue;
            const wh = deps.resolveWebhook(item.webhookId);
            if (!wh) return { item, wh: null };
            // Test sends (eventId "test:…") go out even while the webhook is disabled.
            if (
                !wh.enabled &&
                !item.force &&
                !String(item.eventId).startsWith('test:')
            )
                continue;
            if (isBlocked(wh.url, t)) continue;
            return { item, wh };
        }
        return null;
    }

    async function persist(item) {
        try {
            await deps.storage.saveQueueItem(item);
        } catch (err) {
            console.warn('[GroupMonitor] queue persist failed:', err);
        }
    }

    async function remove(item) {
        items = items.filter((i) => i !== item);
        try {
            await deps.storage.deleteQueueItem(item.id);
        } catch (err) {
            console.warn('[GroupMonitor] queue delete failed:', err);
        }
    }

    async function sendOne(item, wh, gen) {
        item.status = 'sending';
        emit('sending', item);
        const result = await deps.post(wh.url, item.payload);
        if (gen !== generation) {
            // Logged out mid-send: still forget a delivered item so the next
            // login does not post it again.
            if (result.kind === 'ok')
                await deps.storage.deleteQueueItem(item.id).catch(() => {});
            return;
        }
        const t = now();
        if (result.bucketResetMs)
            blockedUntil.set(wh.url, t + result.bucketResetMs);
        if (result.kind === 'ok') {
            await remove(item);
            emit('sent', item, result);
            return;
        }
        if (result.kind === 'rate_limited') {
            item.rateLimitHits = (item.rateLimitHits ?? 0) + 1;
            const until = t + (result.retryAfterMs ?? 5000);
            if (result.global) globalBlockedUntil = until;
            else blockedUntil.set(wh.url, until);
            item.lastError = result.error ?? 'HTTP 429';
            if (item.rateLimitHits >= opts.maxRateLimitHits) {
                item.status = 'dead';
                await persist(item);
                emit('dead', item, result);
                return;
            }
            item.status = 'pending';
            item.nextAt = until;
            await persist(item);
            emit('rate_limited', item, result);
            return;
        }
        item.attempts += 1;
        item.lastError = result.error ?? `HTTP ${result.status}`;
        if (result.kind === 'permanent' || item.attempts >= opts.maxAttempts) {
            item.status = 'dead';
            await persist(item);
            emit('dead', item, result);
            return;
        }
        item.status = 'pending';
        item.nextAt =
            t +
            Math.min(
                opts.maxDelayMs,
                opts.baseDelayMs * 2 ** (item.attempts - 1)
            );
        await persist(item);
        emit('failed', item, result);
    }

    /**
     * Sends every item that is due, one at a time. Concurrent callers share
     * the same run, so there is never more than one request in flight.
     * @returns {Promise<void>}
     */
    function processDue() {
        if (working) return working;
        const gen = generation;
        const run = (async () => {
            await null; // always yield first so `working` is set before the loop can finish
            try {
                for (let guard = 0; guard < 500; guard++) {
                    if (gen !== generation || !userId) return;
                    const next = pickNext(now());
                    if (!next) return;
                    if (!next.wh) {
                        await remove(next.item);
                        emit('dropped', next.item, {
                            error: 'Webhook no longer exists'
                        });
                        continue;
                    }
                    try {
                        await sendOne(next.item, next.wh, gen);
                    } catch (err) {
                        // post() never throws by contract; be defensive anyway
                        next.item.status = 'pending';
                        next.item.attempts += 1;
                        next.item.nextAt = now() + opts.baseDelayMs;
                        next.item.lastError = err?.message ?? String(err);
                        await persist(next.item);
                    }
                }
            } finally {
                if (working === run) working = null;
            }
        })();
        working = run;
        return run;
    }

    async function retryDead(webhookId = null) {
        const t = now();
        for (const item of items) {
            if (item.status !== 'dead') continue;
            if (webhookId && item.webhookId !== webhookId) continue;
            item.status = 'pending';
            item.attempts = 0;
            item.rateLimitHits = 0;
            item.nextAt = t;
            await persist(item);
        }
    }

    async function clearDead(webhookId = null) {
        const dead = items.filter(
            (i) =>
                i.status === 'dead' && (!webhookId || i.webhookId === webhookId)
        );
        for (const item of dead) await remove(item);
    }

    async function dropWebhook(webhookId) {
        const mine = items.filter((i) => i.webhookId === webhookId);
        for (const item of mine) await remove(item);
    }

    function stats(webhookId = null) {
        let pending = 0;
        let dead = 0;
        for (const i of items) {
            if (webhookId && i.webhookId !== webhookId) continue;
            if (i.status === 'dead') dead++;
            else pending++;
        }
        return { pending, dead };
    }

    function nextDueAt() {
        let min = Infinity;
        for (const i of items)
            if (i.status === 'pending' && i.nextAt < min) min = i.nextAt;
        return min;
    }

    return {
        load,
        reset,
        enqueue,
        processDue,
        retryDead,
        clearDead,
        dropWebhook,
        stats,
        nextDueAt,
        get items() {
            return items;
        },
        get userId() {
            return userId;
        },
        isBusy: () => Boolean(working)
    };
}
