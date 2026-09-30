import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    AIRI_LOOKUP_PRIORITY,
    computeBackoffMs,
    createPacedQueue,
    isRateLimitError
} from '../airiLookupQueue';

const HOUR = 60 * 60 * 1000;

function rateLimitError() {
    const err = new Error('429 Too Many Requests');
    err.status = 429;
    return err;
}

function makeQueue(options = {}) {
    const calls = [];
    const queue = createPacedQueue({
        intervalMs: 1000,
        burst: 3,
        hourlyCeiling: 1000,
        backoffBaseMs: 60 * 1000,
        backoffMaxMs: 10 * 60 * 1000,
        execute: async (task) => {
            calls.push({ key: task.key, at: Date.now() });
        },
        ...options
    });
    return { queue, calls };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 29, 20, 0, 0));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('helpers', () => {
    test('computeBackoffMs doubles from 60 s up to 10 min', () => {
        expect(computeBackoffMs(1)).toBe(60 * 1000);
        expect(computeBackoffMs(2)).toBe(120 * 1000);
        expect(computeBackoffMs(3)).toBe(240 * 1000);
        expect(computeBackoffMs(4)).toBe(480 * 1000);
        expect(computeBackoffMs(5)).toBe(600 * 1000);
        expect(computeBackoffMs(50)).toBe(600 * 1000);
    });

    test('isRateLimitError', () => {
        expect(isRateLimitError(rateLimitError())).toBe(true);
        expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
        expect(isRateLimitError(new Error('500 boom 429'))).toBe(false);
        expect(isRateLimitError(null)).toBe(false);
    });
});

describe('createPacedQueue', () => {
    test('bursts, then paces one call per interval', async () => {
        const { queue, calls } = makeQueue();
        for (let i = 0; i < 6; i++) {
            queue.enqueue(`k${i}`);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls).toHaveLength(6);
        const gaps = calls.slice(3).map((c, i) => c.at - calls[i + 2].at);
        expect(gaps.every((gap) => gap >= 1000)).toBe(true);
    });

    test('explicit first, present newest first, backlog last', async () => {
        const { queue, calls } = makeQueue({ burst: 1 });
        // Hold the loop on its first (token) wait so everything is queued first.
        queue.enqueue('first', { priority: AIRI_LOOKUP_PRIORITY.present });
        await vi.advanceTimersByTimeAsync(0);
        queue.enqueue('backlog', { priority: AIRI_LOOKUP_PRIORITY.backlog });
        queue.enqueue('old', { priority: AIRI_LOOKUP_PRIORITY.present });
        queue.enqueue('new', { priority: AIRI_LOOKUP_PRIORITY.present });
        queue.enqueue('asked', {
            priority: AIRI_LOOKUP_PRIORITY.explicit,
            sticky: true
        });
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(calls.map((c) => c.key)).toEqual([
            'first',
            'asked',
            'new',
            'old',
            'backlog'
        ]);
    });

    test('a re-enqueued present task moves to the front of its level', async () => {
        const { queue, calls } = makeQueue({ burst: 1 });
        queue.enqueue('first');
        await vi.advanceTimersByTimeAsync(0);
        queue.enqueue('a');
        queue.enqueue('b');
        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(5000);
        expect(calls.map((c) => c.key)).toEqual(['first', 'a', 'b']);
    });

    test('skips cost no token and are counted', async () => {
        const { queue, calls } = makeQueue({
            burst: 1,
            precheck: (task) => (task.key.startsWith('gone') ? 'left' : 'run')
        });
        queue.enqueue('gone1');
        queue.enqueue('gone2');
        queue.enqueue('here');
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls.map((c) => c.key)).toEqual(['here']);
        expect(queue.stats()).toMatchObject({
            calls: 1,
            skipped: { left: 2 }
        });
    });

    test('429 pauses everything with exponential backoff and reports it', async () => {
        const onRateLimit = vi.fn();
        let failNext = 2;
        const calls = [];
        const queue = createPacedQueue({
            intervalMs: 1000,
            burst: 1,
            backoffBaseMs: 60 * 1000,
            backoffMaxMs: 10 * 60 * 1000,
            onRateLimit,
            execute: async (task) => {
                calls.push({ key: task.key, at: Date.now() });
                if (failNext > 0) {
                    failNext--;
                    throw rateLimitError();
                }
            }
        });
        const start = Date.now();
        queue.enqueue('a');
        queue.enqueue('b');
        await vi.advanceTimersByTimeAsync(0);
        expect(onRateLimit).toHaveBeenCalledTimes(1);
        expect(onRateLimit.mock.calls[0][0]).toBe(start + 60 * 1000);
        expect(queue.stats()).toMatchObject({
            paused: true,
            pauseReason: 'rate_limited',
            strikes: 1
        });
        expect(queue.has('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(59 * 1000);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2 * 1000);
        // Second 429 right after the pause: 120 s this time.
        expect(calls).toHaveLength(2);
        expect(queue.stats().strikes).toBe(2);
        expect(onRateLimit.mock.calls[1][0] - calls[1].at).toBe(120 * 1000);

        await vi.advanceTimersByTimeAsync(118 * 1000);
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(5 * 1000);
        // Both were put back (present players: newest first) and succeed now.
        expect(calls.map((c) => c.key)).toEqual(['a', 'b', 'b', 'a']);
        expect(queue.stats().strikes).toBe(0);
        expect(queue.size).toBe(0);
    });

    test('reportRateLimit (a friend action got 429) pauses lookups too', async () => {
        const { queue, calls } = makeQueue();
        queue.reportRateLimit();
        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(30 * 1000);
        expect(calls).toHaveLength(0);
        expect(queue.pauseState()).toMatchObject({
            paused: true,
            reason: 'rate_limited',
            retryAfterSec: 30
        });
        await vi.advanceTimersByTimeAsync(31 * 1000);
        expect(calls).toHaveLength(1);
    });

    test('hourly ceiling stops calls until the window resets', async () => {
        const onBudgetFreed = vi.fn();
        const { queue, calls } = makeQueue({
            hourlyCeiling: 5,
            burst: 10,
            onBudgetFreed
        });
        for (let i = 0; i < 8; i++) {
            queue.enqueue(`k${i}`);
        }
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(calls).toHaveLength(5);
        expect(queue.stats()).toMatchObject({
            callsThisHour: 5,
            remainingThisHour: 0,
            paused: true,
            pauseReason: 'hourly_ceiling'
        });
        await vi.advanceTimersByTimeAsync(HOUR);
        expect(calls).toHaveLength(8);
        expect(onBudgetFreed).toHaveBeenCalled();
    });

    test('hourly ceiling is a sliding hour: a burst starting mid-window cannot double up', async () => {
        const { queue, calls } = makeQueue({ hourlyCeiling: 5, burst: 10 });
        queue.enqueue('first');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(35 * 60 * 1000);
        for (let i = 0; i < 20; i++) {
            queue.enqueue(`k${i}`);
        }
        await vi.advanceTimersByTimeAsync(6 * HOUR);
        expect(calls).toHaveLength(21);
        const times = calls.map((c) => c.at);
        for (const start of times) {
            const inHour = times.filter((t) => t >= start && t < start + HOUR);
            expect(inHour.length).toBeLessThanOrEqual(5);
        }
        // The slot of the first call frees 60 min after it, not at a reset.
        expect(times[5] - times[0]).toBeGreaterThanOrEqual(HOUR);
    });

    test('429s reported while already paused do not escalate the backoff', async () => {
        const { queue } = makeQueue();
        queue.reportRateLimit();
        queue.reportRateLimit();
        await vi.advanceTimersByTimeAsync(30 * 1000);
        queue.reportRateLimit();
        expect(queue.stats()).toMatchObject({
            strikes: 1,
            rateLimited: 3,
            retryAfterSec: 30
        });
        await vi.advanceTimersByTimeAsync(31 * 1000);
        queue.reportRateLimit();
        expect(queue.stats()).toMatchObject({ strikes: 2, retryAfterSec: 120 });
    });

    test('failures are not cached: retried after the onFailure delay', async () => {
        let fail = true;
        const calls = [];
        const onFailure = vi.fn(() => 5 * 60 * 1000);
        const queue = createPacedQueue({
            intervalMs: 1000,
            burst: 1,
            onFailure,
            execute: async (task) => {
                calls.push(task.key);
                if (fail) {
                    fail = false;
                    throw new Error('500 boom');
                }
            }
        });
        queue.enqueue('a', { priority: AIRI_LOOKUP_PRIORITY.present });
        await vi.advanceTimersByTimeAsync(0);
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(queue.has('a')).toBe(true);
        expect(queue.stats().byPriority.backlog).toBe(1);
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
        expect(calls).toEqual(['a']);
        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(calls).toEqual(['a', 'a']);
        expect(queue.has('a')).toBe(false);
    });

    test('a null onFailure delay drops the task', async () => {
        const { queue } = makeQueue({
            execute: async () => {
                throw new Error('500');
            },
            onFailure: () => null
        });
        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(0);
        expect(queue.has('a')).toBe(false);
        expect(queue.stats().failed).toBe(1);
    });

    test('honors another sender cooldown for at most the max backoff', async () => {
        let external = Date.now() + HOUR;
        const { queue, calls } = makeQueue({
            externalPauseUntil: () => external
        });
        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        expect(calls).toHaveLength(0);
        expect(queue.pauseState().reason).toBe('shared_cooldown');
        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(calls).toHaveLength(1);
        external = 0;
    });

    test('whenSettled resolves when the task is done or times out', async () => {
        const { queue } = makeQueue({ burst: 1 });
        queue.enqueue('a');
        queue.enqueue('b');
        const a = queue.whenSettled('b', 500);
        const b = queue.whenSettled('b', 5000);
        await vi.advanceTimersByTimeAsync(600);
        await expect(a).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(b).resolves.toBe(true);
        await expect(queue.whenSettled('none', 10)).resolves.toBe(true);
    });

    test('does not run while inactive and resumes on start()', async () => {
        let active = false;
        const { queue, calls } = makeQueue({ isActive: () => active });
        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(5000);
        expect(calls).toHaveLength(0);
        active = true;
        queue.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
    });

    test('bounded: the worst task is evicted for a better one', async () => {
        const { queue } = makeQueue({ maxQueue: 2, isActive: () => false });
        queue.enqueue('b1', { priority: AIRI_LOOKUP_PRIORITY.backlog });
        queue.enqueue('p1', { priority: AIRI_LOOKUP_PRIORITY.present });
        expect(
            queue.enqueue('e1', { priority: AIRI_LOOKUP_PRIORITY.explicit })
        ).toBe(true);
        expect(queue.has('b1')).toBe(false);
        expect(
            queue.enqueue('b2', { priority: AIRI_LOOKUP_PRIORITY.backlog })
        ).toBe(false);
        expect(queue.stats().dropped).toBe(2);
    });
});
