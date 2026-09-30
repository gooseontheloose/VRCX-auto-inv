import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The page loader against a fake VRChat audit endpoint and an in-memory cache.
const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    sqlExecute: vi.fn(async () => {}),
    db: null,
    store: null
}));

vi.mock('../../../services/request', () => ({ request: (...a) => mocks.request(...a) }));
vi.mock('../../../services/sqlite', () => ({
    default: { execute: (...a) => mocks.sqlExecute(...a) }
}));
vi.mock('../../../services/auditLogDb', () => ({
    auditDbLoadEntries: (...a) => mocks.db.loadEntries(...a),
    auditDbLoadNewest: (...a) => mocks.db.loadNewest(...a),
    auditDbSaveEntries: (...a) => mocks.db.saveEntries(...a),
    auditDbLoadMeta: (...a) => mocks.db.loadMeta(...a),
    auditDbUpdateMeta: (...a) => mocks.db.updateMeta(...a),
    auditDbSaveMeta: async (gid, meta) => mocks.db.updateMeta(gid, (cur) => ({ ...(cur ?? {}), ...meta })),
    auditDbMigrateFromLocalStorage: async () => {}
}));
vi.mock('../../../coordinators/userCoordinator', () => ({ showUserDialog: vi.fn() }));
vi.mock('../../../stores/groupMonitor', () => ({ useGroupMonitorStore: () => mocks.store }));
vi.mock('../../../stores/user', () => ({ useUserStore: () => ({ currentUser: { id: 'usr_me' } }) }));
vi.mock('vue-sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { HISTORY_VERSION } from '../../../services/groupMonitor/auditGaps';
import { createMemoryAuditDb, steadyLog } from '../../../services/groupMonitor/__tests__/auditFixtures';

const GID = 'grp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let server;

/**
 * @param {any[]} all Newest first
 * @param {{ totalCount?: number; failAt?: (params: any) => boolean }} [opts]
 */
function serve(all, { totalCount, failAt } = {}) {
    server = { all, calls: [] };
    mocks.request.mockImplementation(async (endpoint, { params }) => {
        server.calls.push({ ...params, at: Date.now() });
        if (failAt?.(params)) throw new Error('429 Too Many Requests');
        let rows = all;
        if (params.endDate) rows = rows.filter((e) => Date.parse(e.created_at) < Date.parse(params.endDate));
        if (params.startDate) rows = rows.filter((e) => Date.parse(e.created_at) >= Date.parse(params.startDate));
        const offset = params.offset ?? 0;
        return { results: rows.slice(offset, offset + params.n), totalCount: totalCount ?? all.length };
    });
}

async function settle(done, max = 400) {
    for (let i = 0; i < max; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        if (done()) return;
    }
    throw new Error('did not settle');
}

let gm;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-29T12:00:00Z'));
    mocks.db = createMemoryAuditDb();
    mocks.store = {
        isPollingGroup: () => false,
        onAuditEntries: () => () => {},
        noteViewedGroup: vi.fn(),
        backfillPausedUntil: 0
    };
    mocks.request.mockReset();
    mocks.sqlExecute.mockReset();
    mocks.sqlExecute.mockImplementation(async () => {});
    vi.resetModules();
    const mod = await import('../useGroupMonitorData');
    gm = mod.useGroupMonitorData();
});

afterEach(() => {
    gm.stopPolling();
    vi.useRealTimers();
});

describe('catch-up on open', () => {
    test('a cache larger than totalCount still pages back to the newest cached entry', async () => {
        const all = steadyLog('2026-09-20T00:00:00Z', '2026-09-29T11:00:00Z', 5);
        const newer = all.slice(0, 250);
        const cached = all.slice(250, 750);
        mocks.db.seed(GID, cached);
        mocks.db.meta.set(GID, { groupId: GID, total: 300, fullyLoaded: true, historyVersion: HISTORY_VERSION });
        // VRChat reports only what it still keeps: less than the cache holds
        serve(all, { totalCount: 300 });

        const p = gm.handleGroupChange(GID);
        await settle(() => !gm.isLoadingAudit.value && !gm.auditAutoLoading.value);
        await p;

        const ids = new Set(gm.auditLogs.value.map((e) => e.id));
        for (const e of newer) expect(ids.has(e.id)).toBe(true);
        const stored = new Set(mocks.db.all(GID).map((e) => e.id));
        for (const e of newer) expect(stored.has(e.id)).toBe(true);
        // 3 pages, paced
        const pages = server.calls.filter((c) => c.offset !== undefined && !c.endDate);
        expect(pages.map((c) => c.offset)).toEqual([0, 100, 200]);
        expect(pages[1].at - pages[0].at).toBeGreaterThanOrEqual(800);
        expect(mocks.db.meta.get(GID).gaps ?? []).toEqual([]);
    });
});

describe('fully-loaded flag', () => {
    test('a 429 during the history load does not mark it fully loaded', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-29T11:00:00Z', 30);
        serve(all, { failAt: (p) => p.offset === 300 });
        const p = gm.handleGroupChange(GID);
        await settle(() => !gm.isLoadingAudit.value && !gm.auditAutoLoading.value && server.calls.length > 3);
        await p;
        expect(gm.auditFullyLoaded.value).toBe(false);
        const meta = mocks.db.meta.get(GID);
        expect(meta.fullyLoaded).toBe(false);
        expect(meta.lastError).toMatch(/429/);
    });

    test('at the offset cap it switches to date paging and only then completes', async () => {
        const all = steadyLog('2026-06-01T00:00:00Z', '2026-09-29T11:00:00Z', 20).slice(0, 7700);
        serve(all);
        const p = gm.handleGroupChange(GID);
        await settle(() => !gm.isLoadingAudit.value && !gm.auditAutoLoading.value, 2000);
        await p;
        expect(server.calls.some((c) => c.endDate)).toBe(true);
        expect(gm.auditLogs.value).toHaveLength(7700);
        expect(gm.auditFullyLoaded.value).toBe(true);
        expect(mocks.db.meta.get(GID)).toMatchObject({ fullyLoaded: true, historyVersion: HISTORY_VERSION });
    });

    test('groups wrongly marked complete by older builds resume by date, once', async () => {
        const all = steadyLog('2026-09-01T00:00:00Z', '2026-09-29T11:00:00Z', 20);
        const cached = all.slice(0, 797); // stuck at 797 of 1,9xx
        mocks.db.seed(GID, cached);
        mocks.db.meta.set(GID, { groupId: GID, total: all.length, fullyLoaded: true });
        serve(all);
        const p = gm.handleGroupChange(GID);
        await settle(() => !gm.isLoadingAudit.value && !gm.auditAutoLoading.value && gm.auditFullyLoaded.value, 500);
        await p;
        expect(gm.auditLogs.value).toHaveLength(all.length);
        expect(server.calls.filter((c) => c.endDate).length).toBeGreaterThan(0);
        expect(mocks.db.meta.get(GID)).toMatchObject({ fullyLoaded: true, historyVersion: HISTORY_VERSION });
    });
});

describe('stale pages', () => {
    test('coming back to a kept-alive page reloads SQLite data and moves the time window', async () => {
        serve([]);
        const p = gm.handleGroupChange(GID);
        await settle(() => !gm.isLoadingAudit.value && !gm.auditAutoLoading.value && gm.selectedGroupId.value === GID);
        await p;
        const before = mocks.sqlExecute.mock.calls.length;
        const tick = gm.nowTick.value;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        gm.onPageActivated();
        await vi.advanceTimersByTimeAsync(10);
        expect(gm.nowTick.value).toBeGreaterThan(tick);
        const sql = mocks.sqlExecute.mock.calls.slice(before).map((c) => c[1]);
        expect(sql.some((q) => q.includes('gamelog_location'))).toBe(true);
        expect(sql.some((q) => q.includes('vote kick'))).toBe(true);
    });

    test('the last viewed group is remembered per account', async () => {
        serve([]);
        const p = gm.handleGroupChange(GID);
        await settle(() => gm.selectedGroupId.value === GID && !gm.isLoadingAudit.value);
        await p;
        expect(localStorage.getItem('gm-group-id:usr_me')).toBe(GID);
        expect(gm.lastViewedGroupId()).toBe(GID);
        expect(mocks.store.noteViewedGroup).toHaveBeenCalledWith(GID);
    });
});
