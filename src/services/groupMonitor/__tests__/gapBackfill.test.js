import { describe, expect, test } from 'vitest';

import { MAX_GAP_ATTEMPTS, REPAIR_SCAN_VERSION, findCacheHoles, isWindowChecked, newestMark } from '../auditGaps';
import { pollAuditLog } from '../auditPoller';
import { drainGaps, recordGap, runRepairScan } from '../gapBackfill';
import { createAuditServer, createMemoryAuditDb, steadyLog, utcDay } from './auditFixtures';

const GID = 'grp_9a9863c1-0000-0000-0000-000000000000';

// The holes the data audit proved in the "Meow" cache since August: each one
// is where polling stopped and the next load fetched only the newest page.
const MEOW_HOLES = [
    ['2026-08-07T17:36:00Z', '2026-08-08T00:03:00Z'],
    ['2026-08-10T09:15:00Z', '2026-08-10T18:30:00Z'],
    ['2026-08-15T06:25:00Z', '2026-08-16T05:21:00Z'],
    ['2026-08-25T11:26:00Z', '2026-08-27T09:22:00Z'],
    ['2026-09-02T05:04:00Z', '2026-09-02T17:16:00Z'],
    ['2026-09-03T15:50:00Z', '2026-09-06T12:07:00Z'],
    ['2026-09-12T09:28:00Z', '2026-09-14T21:38:00Z'],
    ['2026-09-17T23:00:00Z', '2026-09-20T23:33:00Z'],
    ['2026-09-24T04:03:00Z', '2026-09-24T21:16:00Z'],
    ['2026-09-25T03:44:00Z', '2026-09-26T16:15:00Z'],
    ['2026-09-27T17:58:00Z', '2026-09-28T20:45:00Z']
];
const NOW = Date.parse('2026-09-29T12:00:00Z');
// VRChat keeps roughly the last 8 weeks
const RETENTION_FROM = Date.parse('2026-08-04T00:00:00Z');

function inHole(e) {
    const t = Date.parse(e.created_at);
    return MEOW_HOLES.some(([a, b]) => t > Date.parse(a) && t < Date.parse(b));
}

function countByDay(entries, type) {
    const days = new Map();
    for (const e of entries) {
        if (type && e.eventType !== type) continue;
        days.set(utcDay(e.created_at), (days.get(utcDay(e.created_at)) ?? 0) + 1);
    }
    return days;
}

/** One background cycle's worth of backfill (the store's budget). */
async function cycle(db, server, nowMs, budget = 3) {
    return drainGaps({ db, groupId: GID, fetchWindow: server.fetchWindow, budget, nowMs });
}

describe('Meow gap replay', () => {
    test('holes on the audit days and ~18% missing join requests end with no holes after backfill', async () => {
        const all = steadyLog('2026-07-01T00:00:00Z', '2026-09-29T12:00:00Z', 6);
        const cache = all.filter((e) => !inHole(e));
        const db = createMemoryAuditDb();
        db.seed(GID, cache);
        const server = createAuditServer(all, { retentionFromMs: RETENTION_FROM });

        // the shape the audit found
        const cachedDays = countByDay(cache);
        for (const day of ['2026-08-26', '2026-09-04', '2026-09-05', '2026-09-13', '2026-09-18', '2026-09-19']) {
            expect(cachedDays.get(day) ?? 0).toBe(0);
        }
        const requests = all.filter((e) => e.eventType === 'group.request.create');
        const missingRequests = requests.filter(inHole).length / requests.length;
        expect(missingRequests).toBeGreaterThan(0.15);
        expect(missingRequests).toBeLessThan(0.21);

        // one-time repair scan finds exactly those holes
        const scan = await runRepairScan({ db, groupId: GID, nowMs: NOW });
        expect(scan.queued).toBe(MEOW_HOLES.length);
        expect(db.meta.get(GID).repairScanVersion).toBe(REPAIR_SCAN_VERSION);

        // backfill a few requests per cycle until nothing is queued
        let cycles = 0;
        let res;
        do {
            res = await cycle(db, server, NOW + cycles * 60_000);
            cycles++;
        } while (res.remaining > 0 && cycles < 500);
        expect(res.remaining).toBe(0);

        const after = db.all(GID);
        const byDay = countByDay(after);
        const serverByDay = countByDay(all.filter((e) => Date.parse(e.created_at) >= RETENTION_FROM));
        for (const [day, n] of serverByDay) {
            if (day < '2026-08-05') continue; // first retained day is partial
            expect(byDay.get(day), day).toBe(n);
        }
        const cachedIds = new Set(after.map((e) => e.id));
        const stillMissing = requests.filter((e) => Date.parse(e.created_at) >= RETENTION_FROM && !cachedIds.has(e.id));
        expect(stillMissing).toEqual([]);
        // and a fresh scan finds nothing left to repair
        expect(findCacheHoles(after, { nowMs: NOW })).toEqual([]);
        // ~3,800 missing entries at 100 per request, plus the closing pages
        expect(server.fetchWindow.mock.calls.length).toBeLessThan(80);
        // within the per-cycle budget throughout
        expect(server.fetchWindow.mock.calls.length).toBeLessThanOrEqual(cycles * 3);
    });

    test('the scan runs once per group', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z', 6);
        const db = createMemoryAuditDb();
        db.seed(
            GID,
            all.filter((e) => e.created_at < '2026-09-04' || e.created_at > '2026-09-06')
        );
        expect((await runRepairScan({ db, groupId: GID, nowMs: NOW })).queued).toBe(1);
        db.meta.get(GID).gaps = [];
        expect(await runRepairScan({ db, groupId: GID, nowMs: NOW })).toEqual({ queued: 0, skipped: true });
        expect(db.loadEntries).toHaveBeenCalledTimes(1);
    });
});

describe('quiet periods and dead ends', () => {
    test('a real quiet day costs one request and is never fetched again', async () => {
        // every 20 min, but nothing at all for 30 h: VRChat has nothing there either
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 20).filter(
            (e) => e.created_at < '2026-09-10T00:00:00Z' || e.created_at > '2026-09-11T06:00:00Z'
        );
        const db = createMemoryAuditDb();
        db.seed(GID, all);
        const server = createAuditServer(all);

        expect((await runRepairScan({ db, groupId: GID, nowMs: NOW })).queued).toBe(1);
        for (let i = 0; i < 100; i++) await cycle(db, server, NOW + i * 60_000);
        expect(server.fetchWindow).toHaveBeenCalledTimes(1);
        expect(db.meta.get(GID).gaps).toEqual([]);

        // even a forced re-scan skips the window it already checked
        const hole = findCacheHoles(db.all(GID), { nowMs: NOW })[0];
        expect(isWindowChecked(hole, db.meta.get(GID).checked)).toBe(true);
        db.meta.get(GID).repairScanVersion = 0;
        expect((await runRepairScan({ db, groupId: GID, nowMs: NOW })).queued).toBe(0);
        for (let i = 0; i < 20; i++) await cycle(db, server, NOW + i * 60_000);
        expect(server.fetchWindow).toHaveBeenCalledTimes(1);
    });

    test('stops cleanly when VRChat no longer returns entries that old', async () => {
        const all = steadyLog('2026-06-01T00:00:00Z', '2026-09-29T00:00:00Z', 30);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all, { retentionFromMs: RETENTION_FROM });
        await recordGap(db, GID, { after: '2026-07-04T19:29:00Z', before: '2026-07-07T23:16:00Z' }, 'repair');
        const res = await cycle(db, server, NOW);
        expect(res).toMatchObject({ requests: 1, closed: 1, remaining: 0 });
        for (let i = 1; i < 10; i++) await cycle(db, server, NOW + i * 60_000);
        expect(server.fetchWindow).toHaveBeenCalledTimes(1);
    });

    test('a failing gap backs off instead of retrying every cycle, and is kept', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 6);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all);
        await recordGap(db, GID, { after: '2026-09-10T00:00:00Z', before: '2026-09-11T00:00:00Z' }, 'catch-up');
        server.fail = new Error('429 Too Many Requests');
        const first = await cycle(db, server, NOW);
        expect(first.error).toBeTruthy();
        expect(first.requests).toBe(1);
        await cycle(db, server, NOW + 30_000);
        expect(server.fetchWindow).toHaveBeenCalledTimes(1);
        expect(db.meta.get(GID).gaps).toHaveLength(1);

        server.fail = null;
        let res;
        let i = 0;
        do {
            res = await cycle(db, server, NOW + ++i * 5 * 60_000);
        } while (res.remaining && i < 50);
        expect(res.remaining).toBe(0);
    });

    test('isPaused stops a drain before the next request', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 1);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all);
        await recordGap(db, GID, { after: '2026-09-10T00:00:00Z', before: '2026-09-11T00:00:00Z' }, 'catch-up');
        let paused = false;
        server.fetchWindow.mockImplementationOnce(async (p) => {
            paused = true; // e.g. a 429 somewhere else in VRCX
            return all.filter((e) => e.created_at < p.endDate).slice(0, 100);
        });
        const res = await drainGaps({
            db,
            groupId: GID,
            fetchWindow: server.fetchWindow,
            budget: 3,
            nowMs: NOW,
            isPaused: () => paused
        });
        expect(res.requests).toBe(1);
        expect(db.meta.get(GID).gaps).toHaveLength(1);
    });
});

describe('failures never lose a gap', () => {
    const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

    function missing(db, all) {
        const have = new Set(db.all(GID).map((e) => e.id));
        return all.filter((e) => !have.has(e.id)).length;
    }

    async function drainFor(db, server, from, minutes) {
        let t = from;
        for (let i = 0; i < minutes; i++) {
            t += 60_000;
            await cycle(db, server, t);
        }
        return t;
    }

    test('hours of 5xx / offline keep the gap, which fills once VRChat is back', async () => {
        const all = steadyLog('2026-09-20T00:00:00Z', '2026-09-29T00:00:00Z', 6);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all);
        db.seed(
            GID,
            all.filter((_, i) => i < 100 || i > 800)
        );
        await runRepairScan({ db, groupId: GID, nowMs: NOW }); // already ran at first start
        await recordGap(db, GID, { after: all[801].created_at, before: all[99].created_at }, 'catch-up');

        server.fail = httpError(503);
        let t = await drainFor(db, server, NOW, 400);
        server.fail = httpError(-1);
        t = await drainFor(db, server, t, 200);
        expect(db.meta.get(GID).gaps).toHaveLength(1);
        // backed off to at most one try an hour
        expect(server.requests.length).toBeLessThan(25);

        server.fail = null;
        await drainFor(db, server, t, 120);
        expect(db.meta.get(GID).gaps).toEqual([]);
        expect(missing(db, all)).toBe(0);
    });

    test('repeated 429s never drop a gap or count as failed attempts', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 6);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all);
        await recordGap(db, GID, { after: '2026-09-10T00:00:00Z', before: '2026-09-11T00:00:00Z' }, 'catch-up');
        server.fail = httpError(429);
        await drainFor(db, server, NOW, 5 * MAX_GAP_ATTEMPTS);
        expect(server.requests.length).toBeGreaterThanOrEqual(MAX_GAP_ATTEMPTS);
        const [gap] = db.meta.get(GID).gaps;
        expect(gap.attempts).toBe(0);
    });

    test('only a group that stays gone (404) is given up', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', 6);
        const db = createMemoryAuditDb();
        const server = createAuditServer(all);
        await recordGap(db, GID, { after: '2026-09-10T00:00:00Z', before: '2026-09-11T00:00:00Z' }, 'catch-up');
        server.fail = httpError(404);
        await drainFor(db, server, NOW, 24 * 60);
        expect(db.meta.get(GID).gaps).toEqual([]);
        expect(server.requests).toHaveLength(MAX_GAP_ATTEMPTS);
    });
});

describe('gap boundaries', () => {
    test('entries sharing the oldest fetched millisecond are not lost when endDate is exclusive', async () => {
        const all = steadyLog('2026-09-20T00:00:00Z', '2026-09-29T00:00:00Z', 6);
        // 498, 499 end the last fetched page; 500, 501 share their millisecond
        // but sit on the next, unfetched page
        for (let i = 498; i < 502; i++) all[i] = { ...all[i], created_at: all[498].created_at };
        const server = createAuditServer(all, { endInclusive: false });
        const db = createMemoryAuditDb();
        const cached = all.slice(900);
        db.seed(GID, cached);
        const res = await pollAuditLog({
            fetchPage: server.fetchPage,
            watermark: null,
            cacheMark: newestMark(cached),
            maxPages: 5
        });
        await db.saveEntries(GID, res.fetched);
        await recordGap(db, GID, res.gap, 'catch-up');
        for (let i = 0; i < 50; i++) await cycle(db, server, NOW + i * 60_000);
        const have = new Set(db.all(GID).map((e) => e.id));
        expect(all.filter((e) => !have.has(e.id)).map((e) => e.id)).toEqual([]);
    });
});
