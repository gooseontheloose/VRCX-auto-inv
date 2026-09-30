import { describe, expect, test, vi } from 'vitest';

import {
    HISTORY_VERSION,
    fillGapStep,
    findCacheHoles,
    isHistoryComplete,
    isWindowChecked,
    makeGap,
    mergeGaps,
    newestMark
} from '../auditGaps';
import { createAuditServer, steadyLog } from './auditFixtures';

const iso = (s) => new Date(s).toISOString();

describe('findCacheHoles', () => {
    test('finds a multi-day silence in a busy log, not the normal spacing', () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 6);
        const cache = all.filter((e) => e.created_at < '2026-09-04T03:00:00Z' || e.created_at > '2026-09-06T12:00:00Z');
        const holes = findCacheHoles(cache, { nowMs: Date.parse('2026-09-10T00:00:00Z') });
        expect(holes).toHaveLength(1);
        expect(holes[0].after < '2026-09-04T03:00:00Z').toBe(true);
        expect(holes[0].before > '2026-09-06T12:00:00Z').toBe(true);
        expect(holes[0].expected).toBeGreaterThan(300);
    });

    test('a slow group is not flagged for its normal quiet stretches', () => {
        // one entry every 5 hours: a 9 h silence is only two missing entries
        const all = steadyLog('2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z', 300);
        const cache = all.filter((_, i) => i !== 50);
        expect(findCacheHoles(cache, { nowMs: Date.parse('2026-09-10T00:00:00Z') })).toEqual([]);
    });

    test('holes older than the retention horizon are ignored', () => {
        const all = steadyLog('2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z', 6);
        const cache = all.filter((e) => e.created_at < '2026-01-05T00:00:00Z' || e.created_at > '2026-01-08T00:00:00Z');
        expect(findCacheHoles(cache, { nowMs: Date.parse('2026-09-29T00:00:00Z') })).toEqual([]);
    });
});

describe('fillGapStep', () => {
    const log = steadyLog('2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', 1);

    test.each([false, true])(
        'walks a window newest first until it is complete (endDate inclusive: %s)',
        async (endInclusive) => {
            const server = createAuditServer(log, { endInclusive });
            let gap = makeGap({ after: '2026-09-01T10:00:00.000Z', before: '2026-09-01T16:00:00.000Z' }, 'test');
            const got = new Map();
            let steps = 0;
            while (gap && steps < 50) {
                steps++;
                const res = await fillGapStep({ gap, fetchWindow: server.fetchWindow });
                for (const e of res.entries) got.set(e.id, e);
                gap = res.done ? null : res.next;
            }
            const expected = log.filter(
                (e) => e.created_at > '2026-09-01T10:00:00.000Z' && e.created_at < '2026-09-01T16:00:00.000Z'
            );
            for (const e of expected) expect(got.has(e.id)).toBe(true);
            expect(steps).toBeLessThanOrEqual(5); // 359 entries, 100 per page
        }
    );

    test('an empty page (older than VRChat keeps) closes the gap', async () => {
        const server = createAuditServer(log, { retentionFromMs: Date.parse('2026-09-02T00:00:00Z') });
        const gap = makeGap({ after: '2026-09-01T10:00:00Z', before: '2026-09-01T16:00:00Z' }, 'test');
        const res = await fillGapStep({ gap, fetchWindow: server.fetchWindow });
        expect(res).toMatchObject({ done: true, reason: 'empty', entries: [] });
    });

    test('more than a page within one millisecond pages on by offset', async () => {
        const same = Array.from({ length: 250 }, (_, i) => ({
            id: `gaud_s${i}`,
            created_at: '2026-09-01T12:00:00.000Z'
        }));
        const server = createAuditServer(same, { endInclusive: true });
        let gap = makeGap({ after: '2026-09-01T11:00:00Z', before: '2026-09-01T12:00:00.000Z' }, 'test');
        const got = new Set();
        for (let i = 0; i < 10 && gap; i++) {
            const res = await fillGapStep({ gap, fetchWindow: server.fetchWindow });
            res.entries.forEach((e) => got.add(e.id));
            gap = res.done ? null : res.next;
        }
        expect(got.size).toBe(250);
        expect(gap).toBeNull();
    });

    test('an API that ignores the dates still terminates', async () => {
        const fetchWindow = vi.fn(async ({ offset = 0 }) => log.slice(offset, offset + 100));
        let gap = makeGap({ after: '2026-09-02T20:00:00Z', before: '2026-09-02T22:00:00Z' }, 'test');
        let steps = 0;
        while (gap && steps < 200) {
            steps++;
            const res = await fillGapStep({ gap, fetchWindow });
            gap = res.done ? null : res.next;
        }
        expect(gap).toBeNull();
        expect(steps).toBeLessThan(10);
    });
});

describe('gap list', () => {
    test('overlapping windows merge, disjoint ones stay, newest first', () => {
        const a = makeGap({ after: iso('2026-09-01T00:00Z'), before: iso('2026-09-02T00:00Z') }, 'x');
        const b = makeGap({ after: iso('2026-09-01T12:00Z'), before: iso('2026-09-03T00:00Z') }, 'x');
        const c = makeGap({ after: iso('2026-08-01T00:00Z'), before: iso('2026-08-02T00:00Z') }, 'x');
        const merged = mergeGaps([a], [b, c]);
        expect(merged).toHaveLength(2);
        expect(merged[0]).toMatchObject({ after: a.after, before: b.before });
        expect(merged[1]).toMatchObject({ after: c.after, before: c.before });
    });

    test('checked windows cover sub-windows only', () => {
        const checked = [{ after: iso('2026-09-01T00:00Z'), before: iso('2026-09-02T00:00Z') }];
        expect(isWindowChecked({ after: iso('2026-09-01T01:00Z'), before: iso('2026-09-01T05:00Z') }, checked)).toBe(
            true
        );
        expect(isWindowChecked({ after: iso('2026-08-31T01:00Z'), before: iso('2026-09-01T05:00Z') }, checked)).toBe(
            false
        );
    });

    test('newestMark keeps every id at the newest timestamp', () => {
        const mark = newestMark([
            { id: 'a', created_at: '2026-09-01T00:00:00Z' },
            { id: 'b', created_at: '2026-09-02T00:00:00Z' },
            { id: 'c', created_at: '2026-09-02T00:00:00Z' }
        ]);
        expect(mark).toEqual({ at: '2026-09-02T00:00:00Z', ids: ['b', 'c'] });
    });

    test('only a fullyLoaded flag written by the new loader counts', () => {
        expect(isHistoryComplete({ fullyLoaded: true })).toBe(false);
        expect(isHistoryComplete({ fullyLoaded: true, historyVersion: HISTORY_VERSION })).toBe(true);
        expect(isHistoryComplete({ fullyLoaded: false, historyVersion: HISTORY_VERSION })).toBe(false);
    });
});
