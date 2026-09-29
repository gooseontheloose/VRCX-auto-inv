/**
 * AIRI integration: one paced, prioritized queue for the extra VRChat API
 * lookups (represented group, full profile for the bio) made for players in
 * the current instance.
 *
 * - Token bucket shared by every lookup: one call per `intervalMs`, bursts of
 *   up to `burst`, plus a hard safety ceiling of `hourlyCeiling` calls per
 *   hour (a fixed window that resets every hour). There is no per-session cap.
 * - HTTP 429 pauses the whole queue with exponential backoff
 *   (`backoffBaseMs` doubling up to `backoffMaxMs`) and is reported through
 *   `onRateLimit` so other senders (PAW's auto-inviter) can back off too.
 * - Priorities: explicit requests first (FIFO), then present players (newest
 *   first), then the backlog (retries after a failure, FIFO).
 * - `precheck(task)` runs right before a call and may skip it without
 *   spending a token (player left, already fetched elsewhere, cached).
 * - Failures are never cached: `onFailure` decides when to retry.
 */

export const AIRI_LOOKUP_INTERVAL_MS = 2500;
export const AIRI_LOOKUP_BURST = 10;
export const AIRI_LOOKUP_HOURLY_CEILING = 600;
export const AIRI_LOOKUP_BACKOFF_BASE_MS = 60 * 1000;
export const AIRI_LOOKUP_BACKOFF_MAX_MS = 10 * 60 * 1000;
export const AIRI_LOOKUP_QUEUE_MAX = 5000;

export const AIRI_LOOKUP_PRIORITY = Object.freeze({
    explicit: 0,
    present: 1,
    backlog: 2
});

const HOUR_MS = 60 * 60 * 1000;
const PRIORITY_NAMES = ['explicit', 'present', 'backlog'];

/**
 * @param {number} strikes consecutive rate limits (1 = first)
 * @param {number} [baseMs]
 * @param {number} [maxMs]
 * @returns {number}
 */
export function computeBackoffMs(
    strikes,
    baseMs = AIRI_LOOKUP_BACKOFF_BASE_MS,
    maxMs = AIRI_LOOKUP_BACKOFF_MAX_MS
) {
    const exponent = Math.min(20, Math.max(0, strikes - 1));
    return Math.min(maxMs, baseMs * 2 ** exponent);
}

/**
 * VRCX's request layer throws Error objects with `status` set to the HTTP code
 * and a message that starts with the code.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRateLimitError(err) {
    if (!err || typeof err !== 'object') {
        return false;
    }
    const e = /** @type {{status?: unknown, message?: unknown}} */ (err);
    if (e.status === 429) {
        return true;
    }
    return typeof e.message === 'string' && /^429\b/.test(e.message);
}

/**
 * @typedef {object} PacedTask
 * @property {string} key unique task key, e.g. "group:usr_..."
 * @property {number} priority AIRI_LOOKUP_PRIORITY value
 * @property {number} seq insertion order (refreshed for present players)
 * @property {number} notBefore earliest run time (ms)
 * @property {number} attempts failed attempts so far
 * @property {boolean} sticky explicit request: never skipped for presence
 * @property {any} data caller data
 */

/**
 * @param {object} options
 * @param {(task: PacedTask) => Promise<unknown>} options.execute performs exactly one API call
 * @param {(task: PacedTask) => (string | Promise<string>)} [options.precheck] 'run' or a skip reason
 * @param {() => boolean} [options.isActive] the loop only runs while true
 * @param {() => number} [options.now]
 * @param {number} [options.intervalMs]
 * @param {number} [options.burst]
 * @param {number} [options.hourlyCeiling]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 * @param {number} [options.maxQueue]
 * @param {() => number} [options.externalPauseUntil] another sender's cooldown (ms timestamp)
 * @param {(pausedUntil: number, strikes: number) => void} [options.onRateLimit]
 * @param {() => void} [options.onBudgetFreed] after a 429 pause ends or the hourly window resets
 * @param {(task: PacedTask, err: unknown) => (number | null)} [options.onFailure] retry delay in ms, or null to drop
 */
export function createPacedQueue({
    execute,
    precheck = () => 'run',
    isActive = () => true,
    now = () => Date.now(),
    intervalMs = AIRI_LOOKUP_INTERVAL_MS,
    burst = AIRI_LOOKUP_BURST,
    hourlyCeiling = AIRI_LOOKUP_HOURLY_CEILING,
    backoffBaseMs = AIRI_LOOKUP_BACKOFF_BASE_MS,
    backoffMaxMs = AIRI_LOOKUP_BACKOFF_MAX_MS,
    maxQueue = AIRI_LOOKUP_QUEUE_MAX,
    externalPauseUntil = () => 0,
    onRateLimit = () => {},
    onBudgetFreed = () => {},
    onFailure = () => null
}) {
    /** @type {Map<string, PacedTask>} */
    const tasks = new Map();
    /** @type {Map<string, Set<() => void>>} */
    const waiters = new Map();
    let seq = 0;
    let tokens = burst;
    let lastRefillAt = now();
    let windowStart = 0;
    let windowCalls = 0;
    let pausedUntil = 0;
    let strikes = 0;
    let lastRateLimitAt = 0;
    let wasPaused = false;
    let externalSeen = 0;
    let externalCappedUntil = 0;
    let running = false;
    /** @type {PacedTask | null} */
    let inFlight = null;
    /** @type {(() => void) | null} */
    let wakeUp = null;
    const counters = {
        calls: 0,
        ok: 0,
        failed: 0,
        rateLimited: 0,
        dropped: 0,
        skipped: /** @type {Record<string, number>} */ ({})
    };

    function rank(task) {
        // Present players: newest first. Everything else: first in, first out.
        const order =
            task.priority === AIRI_LOOKUP_PRIORITY.present
                ? -task.seq
                : task.seq;
        return [task.priority, order];
    }

    function isBetter(a, b) {
        const [pa, oa] = rank(a);
        const [pb, ob] = rank(b);
        return pa !== pb ? pa < pb : oa < ob;
    }

    function settle(key) {
        const set = waiters.get(key);
        if (!set) {
            return;
        }
        waiters.delete(key);
        for (const resolve of set) {
            resolve();
        }
    }

    function wake() {
        const resolve = wakeUp;
        wakeUp = null;
        resolve?.();
    }

    function waitFor(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(
                () => {
                    if (wakeUp === done) {
                        wakeUp = null;
                    }
                    resolve();
                },
                Math.max(0, Math.ceil(ms))
            );
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            wakeUp = done;
        });
    }

    function rollWindow(t) {
        if (windowStart && t - windowStart < HOUR_MS) {
            return;
        }
        const wasCapped = windowCalls >= hourlyCeiling;
        windowStart = t;
        windowCalls = 0;
        if (wasCapped) {
            onBudgetFreed();
        }
    }

    function refill(t) {
        if (t > lastRefillAt) {
            tokens = Math.min(burst, tokens + (t - lastRefillAt) / intervalMs);
        }
        lastRefillAt = t;
    }

    /**
     * Another sender's cooldown, honored for at most `backoffMaxMs` from when
     * it was first seen (the auto-inviter can set a whole hour).
     */
    function externalPause(t) {
        let value = 0;
        try {
            value = Number(externalPauseUntil()) || 0;
        } catch {
            value = 0;
        }
        if (value !== externalSeen) {
            externalSeen = value;
            externalCappedUntil = Math.min(value, t + backoffMaxMs);
        }
        return externalCappedUntil;
    }

    /** @returns {{until: number, reason: string}} */
    function currentPause(t) {
        let until = pausedUntil;
        let reason = until > t ? 'rate_limited' : '';
        const external = externalPause(t);
        if (external > until && external > t) {
            until = external;
            reason = 'shared_cooldown';
        }
        if (windowCalls >= hourlyCeiling) {
            const windowEnd = windowStart + HOUR_MS;
            if (windowEnd > until) {
                until = windowEnd;
                reason = 'hourly_ceiling';
            }
        }
        return { until, reason };
    }

    function pickNext(t) {
        /** @type {PacedTask | null} */
        let best = null;
        let nextAt = Infinity;
        for (const task of tasks.values()) {
            if (task.notBefore > t) {
                nextAt = Math.min(nextAt, task.notBefore);
                continue;
            }
            if (!best || isBetter(task, best)) {
                best = task;
            }
        }
        return { task: best, nextAt };
    }

    function applyRateLimit() {
        const t = now();
        strikes++;
        lastRateLimitAt = t;
        counters.rateLimited++;
        pausedUntil = Math.max(
            pausedUntil,
            t + computeBackoffMs(strikes, backoffBaseMs, backoffMaxMs)
        );
        tokens = 0;
        lastRefillAt = t;
        wasPaused = true;
        try {
            onRateLimit(pausedUntil, strikes);
        } catch (err) {
            console.warn('[AiriLookupQueue] onRateLimit failed', err);
        }
    }

    async function loop() {
        if (running) {
            return;
        }
        running = true;
        try {
            while (tasks.size > 0 && isActive()) {
                const t = now();
                rollWindow(t);
                const pause = currentPause(t);
                if (pause.until > t) {
                    wasPaused = true;
                    await waitFor(pause.until - t);
                    continue;
                }
                if (wasPaused) {
                    // No burst right after a pause: one probe call, then paced.
                    wasPaused = false;
                    refill(t);
                    tokens = Math.min(tokens, 1);
                    onBudgetFreed();
                }
                refill(t);
                if (tokens < 1) {
                    await waitFor((1 - tokens) * intervalMs);
                    continue;
                }
                const { task, nextAt } = pickNext(t);
                if (!task) {
                    await waitFor(nextAt - t);
                    continue;
                }
                tasks.delete(task.key);
                let verdict = 'run';
                try {
                    verdict = await precheck(task);
                } catch (err) {
                    console.warn('[AiriLookupQueue] precheck failed', err);
                }
                if (verdict !== 'run') {
                    counters.skipped[verdict] =
                        (counters.skipped[verdict] ?? 0) + 1;
                    settle(task.key);
                    continue;
                }
                tokens -= 1;
                windowCalls++;
                counters.calls++;
                inFlight = task;
                try {
                    await execute(task);
                    strikes = 0;
                    counters.ok++;
                    settle(task.key);
                } catch (err) {
                    if (isRateLimitError(err)) {
                        // Not the player's fault: retry them first once the pause ends.
                        if (!tasks.has(task.key)) {
                            tasks.set(task.key, task);
                        }
                        applyRateLimit();
                        settle(task.key);
                        continue;
                    }
                    counters.failed++;
                    task.attempts++;
                    let delay = null;
                    try {
                        delay = onFailure(task, err);
                    } catch (hookErr) {
                        console.warn(
                            '[AiriLookupQueue] onFailure failed',
                            hookErr
                        );
                    }
                    if (
                        typeof delay === 'number' &&
                        Number.isFinite(delay) &&
                        !tasks.has(task.key)
                    ) {
                        task.notBefore = now() + Math.max(0, delay);
                        task.priority = Math.max(
                            task.priority,
                            AIRI_LOOKUP_PRIORITY.backlog
                        );
                        tasks.set(task.key, task);
                    }
                    settle(task.key);
                } finally {
                    inFlight = null;
                }
            }
        } catch (err) {
            console.error('[AiriLookupQueue] loop crashed', err);
        } finally {
            running = false;
        }
    }

    function start() {
        if (!running && tasks.size > 0 && isActive()) {
            loop();
        }
    }

    function evictWorstFor(candidate) {
        /** @type {PacedTask | null} */
        let worst = null;
        for (const task of tasks.values()) {
            if (!worst || isBetter(worst, task)) {
                worst = task;
            }
        }
        if (worst && isBetter(candidate, worst)) {
            tasks.delete(worst.key);
            counters.dropped++;
            settle(worst.key);
            return true;
        }
        return false;
    }

    /**
     * Queue a task (merged with an existing one for the same key).
     * @param {string} key
     * @param {{priority?: number, sticky?: boolean, data?: any}} [options]
     * @returns {boolean} whether the task is queued or in flight
     */
    function enqueue(key, options = {}) {
        const priority = options.priority ?? AIRI_LOOKUP_PRIORITY.present;
        const sticky = Boolean(options.sticky);
        if (inFlight?.key === key) {
            return true;
        }
        const existing = tasks.get(key);
        if (existing) {
            if (priority < existing.priority) {
                existing.priority = priority;
                existing.seq = ++seq;
            } else if (
                priority === AIRI_LOOKUP_PRIORITY.present &&
                existing.priority === priority
            ) {
                existing.seq = ++seq;
            }
            if (sticky) {
                existing.sticky = true;
                existing.notBefore = 0;
            }
            if (options.data !== undefined) {
                existing.data = options.data;
            }
            wake();
            start();
            return true;
        }
        /** @type {PacedTask} */
        const task = {
            key,
            priority,
            seq: ++seq,
            notBefore: 0,
            attempts: 0,
            sticky,
            data: options.data
        };
        if (tasks.size >= maxQueue && !evictWorstFor(task)) {
            counters.dropped++;
            return false;
        }
        tasks.set(key, task);
        wake();
        start();
        return true;
    }

    /**
     * Resolves true once the task left the queue (done, skipped, failed or
     * paused by a rate limit), false after `timeoutMs`.
     * @param {string} key
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    function whenSettled(key, timeoutMs) {
        if (!tasks.has(key) && inFlight?.key !== key) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            let set = waiters.get(key);
            if (!set) {
                set = new Set();
                waiters.set(key, set);
            }
            const done = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                set.delete(done);
                resolve(false);
            }, timeoutMs);
            set.add(done);
        });
    }

    /** Remove queued tasks matching `predicate` (not the one in flight). */
    function removeWhere(predicate) {
        for (const task of [...tasks.values()]) {
            if (predicate(task)) {
                tasks.delete(task.key);
                settle(task.key);
            }
        }
    }

    function clear() {
        removeWhere(() => true);
    }

    /** A 429 seen outside the queue (e.g. a friend action): pause lookups too. */
    function reportRateLimit() {
        applyRateLimit();
        wake();
    }

    /**
     * Current pause: reason is 'rate_limited' (VRChat answered 429),
     * 'shared_cooldown' (the auto-inviter's cooldown), 'hourly_ceiling', or ''.
     * @returns {{paused: boolean, reason: string, until: number, retryAfterSec: number}}
     */
    function pauseState() {
        const t = now();
        const pause = currentPause(t);
        const paused = pause.until > t;
        return {
            paused,
            reason: paused ? pause.reason : '',
            until: paused ? pause.until : 0,
            retryAfterSec: paused ? Math.ceil((pause.until - t) / 1000) : 0
        };
    }

    /** Seconds until lookups may run again (0 when not paused). */
    function retryAfterSec() {
        return pauseState().retryAfterSec;
    }

    function stats() {
        const t = now();
        const byPriority = { explicit: 0, present: 0, backlog: 0 };
        for (const task of tasks.values()) {
            byPriority[PRIORITY_NAMES[task.priority] ?? 'backlog']++;
        }
        const windowActive = windowStart && t - windowStart < HOUR_MS;
        const callsThisHour = windowActive ? windowCalls : 0;
        const pause = currentPause(t);
        let bucket = tokens;
        if (t > lastRefillAt) {
            bucket = Math.min(burst, tokens + (t - lastRefillAt) / intervalMs);
        }
        return {
            queued: tasks.size,
            byPriority,
            running,
            inFlight: inFlight?.key ?? null,
            tokens: Math.floor(Math.max(0, bucket) * 10) / 10,
            burst,
            intervalMs,
            hourlyCeiling,
            callsThisHour,
            remainingThisHour: Math.max(0, hourlyCeiling - callsThisHour),
            windowResetsInSec: windowActive
                ? Math.ceil((windowStart + HOUR_MS - t) / 1000)
                : 0,
            paused: pause.until > t,
            pauseReason: pause.until > t ? pause.reason : '',
            retryAfterSec:
                pause.until > t ? Math.ceil((pause.until - t) / 1000) : 0,
            strikes,
            lastRateLimitAt,
            calls: counters.calls,
            ok: counters.ok,
            failed: counters.failed,
            rateLimited: counters.rateLimited,
            dropped: counters.dropped,
            skipped: { ...counters.skipped }
        };
    }

    return {
        enqueue,
        whenSettled,
        removeWhere,
        clear,
        start,
        wake,
        reportRateLimit,
        pauseState,
        retryAfterSec,
        stats,
        has: (key) => tasks.has(key) || inFlight?.key === key,
        get size() {
            return tasks.size;
        }
    };
}
