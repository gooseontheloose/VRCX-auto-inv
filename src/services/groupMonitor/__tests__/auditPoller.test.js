import { describe, expect, test, vi } from 'vitest';

import { advanceWatermark, pollAuditLog } from '../auditPoller';

function entries(n, startMinute = 0) {
    // newest first, like the API
    return Array.from({ length: n }, (_, i) => {
        const m = startMinute + n - 1 - i;
        return {
            id: `gaud_${String(m).padStart(5, '0')}`,
            created_at: new Date(Date.UTC(2026, 8, 29, 0, m)).toISOString(),
            eventType: 'group.instance.kick'
        };
    });
}

function pager(all, pageSize = 100) {
    return vi.fn(async (offset) => ({
        entries: all.slice(offset, offset + pageSize),
        totalCount: all.length
    }));
}

describe('pollAuditLog', () => {
    test('first run only sets the watermark (no history flood)', async () => {
        const all = entries(250);
        const fetchPage = pager(all);
        const res = await pollAuditLog({ fetchPage, watermark: null });
        expect(fetchPage).toHaveBeenCalledTimes(1);
        expect(res.firstRun).toBe(true);
        expect(res.newEntries).toEqual([]);
        expect(res.watermark).toEqual({
            at: all[0].created_at,
            ids: [all[0].id]
        });
        expect(res.fetched).toHaveLength(100);
    });

    test('returns only entries newer than the watermark, oldest first', async () => {
        const all = entries(120);
        const wm = advanceWatermark(all.slice(3), null);
        const res = await pollAuditLog({
            fetchPage: pager(all),
            watermark: wm
        });
        expect(res.newEntries.map((e) => e.id)).toEqual([
            all[2].id,
            all[1].id,
            all[0].id
        ]);
        expect(res.truncated).toBe(false);
        expect(res.watermark.at).toBe(all[0].created_at);
    });

    test('pages past page 0 until the watermark is reached', async () => {
        const all = entries(400);
        const wm = advanceWatermark(all.slice(250), null); // 250 new entries
        const fetchPage = pager(all);
        const res = await pollAuditLog({ fetchPage, watermark: wm });
        expect(fetchPage).toHaveBeenCalledTimes(3);
        expect(res.newEntries).toHaveLength(250);
        expect(res.truncated).toBe(false);
    });

    test('is bounded and reports truncation', async () => {
        const all = entries(1000);
        const wm = advanceWatermark(all.slice(900), null);
        const fetchPage = pager(all);
        const res = await pollAuditLog({
            fetchPage,
            watermark: wm,
            maxPages: 2
        });
        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect(res.newEntries).toHaveLength(200);
        expect(res.truncated).toBe(true);
    });

    test('entries sharing the watermark timestamp are not lost or repeated', async () => {
        const at = '2026-09-29T10:00:00.000Z';
        const a = { id: 'gaud_a', created_at: at };
        const b = { id: 'gaud_b', created_at: at };
        const wm = advanceWatermark([a], null);
        const res = await pollAuditLog({
            fetchPage: async () => ({ entries: [b, a], totalCount: 2 }),
            watermark: wm
        });
        expect(res.newEntries.map((e) => e.id)).toEqual(['gaud_b']);
        expect(res.watermark).toEqual({ at, ids: ['gaud_a', 'gaud_b'] });
    });

    test('truncation reports the unfetched window as a gap', async () => {
        const all = entries(1000);
        const wm = advanceWatermark(all.slice(900), null);
        const res = await pollAuditLog({ fetchPage: pager(all), watermark: wm, maxPages: 2 });
        expect(res.gap).toEqual({ after: all[900].created_at, before: all[199].created_at });
    });

    test('first run with a cache pages back to the newest cached entry, posting nothing', async () => {
        const all = entries(450);
        const cacheMark = advanceWatermark(all.slice(250), null);
        const fetchPage = pager(all);
        const res = await pollAuditLog({ fetchPage, watermark: null, cacheMark });
        expect(fetchPage).toHaveBeenCalledTimes(3);
        expect(res.fetched.map((e) => e.id)).toEqual(expect.arrayContaining(all.slice(0, 250).map((e) => e.id)));
        expect(res.newEntries).toEqual([]);
        expect(res.firstRun).toBe(true);
        expect(res.gap).toBeNull();
        expect(res.watermark.at).toBe(all[0].created_at);
    });

    test('first run that cannot reach the cache returns the gap to queue', async () => {
        const all = entries(1000);
        const cacheMark = advanceWatermark(all.slice(800), null);
        const res = await pollAuditLog({ fetchPage: pager(all), watermark: null, cacheMark, maxPages: 5 });
        expect(res.truncated).toBe(true);
        expect(res.gap).toEqual({ after: all[800].created_at, before: all[499].created_at });
    });

    test('the gap starts at the newest cached entry when that is newer than the watermark', async () => {
        const all = entries(3000);
        const wm = advanceWatermark(all.slice(2900), null); // stale: this account was away
        const cacheMark = advanceWatermark(all.slice(1500), null); // the other account cached up to here
        const res = await pollAuditLog({ fetchPage: pager(all), watermark: wm, cacheMark, maxPages: 5 });
        expect(res.gap).toEqual({ after: all[1500].created_at, before: all[499].created_at });
        // posting still follows this account's own watermark
        expect(res.newEntries).toHaveLength(500);
    });

    test('no gap when the cache already reaches past the fetched pages', async () => {
        const all = entries(3000);
        const wm = advanceWatermark(all.slice(2900), null);
        const cacheMark = advanceWatermark(all.slice(10), null);
        const res = await pollAuditLog({ fetchPage: pager(all), watermark: wm, cacheMark, maxPages: 5 });
        expect(res.truncated).toBe(true);
        expect(res.gap).toBeNull();
    });
});
