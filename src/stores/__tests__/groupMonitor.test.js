import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Everything that could reach VRChat, Discord, SQLite or IndexedDB is faked.
const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    sqlExecute: vi.fn(async () => {}),
    idb: new Map(),
    meta: new Map(),
    storage: null,
    intervals: new Map(),
    nextTimer: 1,
    fetch: vi.fn()
}));

vi.mock('worker-timers', () => ({
    setInterval: (fn, ms) => {
        const id = mocks.nextTimer++;
        mocks.intervals.set(id, { fn, ms });
        return id;
    },
    clearInterval: (id) => {
        mocks.intervals.delete(id);
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn()
}));

vi.mock('../../services/request', () => ({
    request: (...a) => mocks.request(...a)
}));

vi.mock('../../services/sqlite', () => ({
    default: {
        execute: (...a) => mocks.sqlExecute(...a),
        executeNonQuery: vi.fn(async () => 0)
    }
}));

vi.mock('../../services/auditLogDb', () => ({
    auditDbLoadEntries: vi.fn(async (gid) => mocks.idb.get(gid) ?? []),
    auditDbSaveEntries: vi.fn(async (gid, entries) => {
        const cur = mocks.idb.get(gid) ?? [];
        const ids = new Set(cur.map((e) => e.id));
        mocks.idb.set(gid, [...entries.filter((e) => !ids.has(e.id)), ...cur]);
    }),
    auditDbLoadNewest: vi.fn(async (gid) => {
        const rows = mocks.idb.get(gid) ?? [];
        const max = rows.reduce((m, e) => (e.created_at > m ? e.created_at : m), '');
        return rows.filter((e) => e.created_at === max);
    }),
    auditDbLoadMeta: vi.fn(async (gid) => mocks.meta.get(gid) ?? null),
    auditDbUpdateMeta: vi.fn(async (gid, fn) => {
        const next = fn(mocks.meta.get(gid) ?? null);
        if (next) mocks.meta.set(gid, { ...next, groupId: gid });
        return mocks.meta.get(gid) ?? null;
    }),
    auditDbSaveMeta: vi.fn(async (gid, meta) => {
        mocks.meta.set(gid, { ...(mocks.meta.get(gid) ?? {}), ...meta });
    }),
    auditDbMigrateFromLocalStorage: vi.fn(async () => {})
}));

// The store talks to storage through this proxy so a test can "restart"
// VRCX by swapping in a fresh storage instance over the same backing data.
vi.mock('../../services/groupMonitor/storage', () => ({
    default: new Proxy(
        {},
        {
            get:
                (_t, key) =>
                (...args) =>
                    mocks.storage[key](...args)
        }
    )
}));

const fakes = await vi.hoisted(async () => {
    const { reactive: r } = await import('vue');
    return {
        user: r({ currentUser: { id: '' } }),
        group: r({
            currentUserGroups: new Map(),
            currentUserGroupsInit: false
        }),
        location: r({ lastLocation: { location: '' } })
    };
});

vi.mock('../user', () => ({ useUserStore: () => fakes.user }));
vi.mock('../group', () => ({ useGroupStore: () => fakes.group }));
vi.mock('../location', () => ({ useLocationStore: () => fakes.location }));

import { createMemoryMonitorStorage } from '../../services/groupMonitor/memoryStorage';
import { watchState } from '../../services/watchState';
import { makeGap } from '../../services/groupMonitor/auditGaps';
import { notifyVrchatRateLimit } from '../../services/vrchatRateLimit';
import { BACKFILL_PAGES_PER_CYCLE, CATCH_UP_CAP, useGroupMonitorStore } from '../groupMonitor';

const GROUP_A = 'grp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_B = 'grp_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HOOK = 'https://discord.com/api/webhooks/1/token-a';
const HOOK_B = 'https://discord.com/api/webhooks/2/token-b';

let auditLog = []; // newest first, like the API

function kick(i) {
    return {
        id: `gaud_${String(i).padStart(6, '0')}`,
        created_at: new Date(Date.UTC(2026, 8, 29, 0, 0, i)).toISOString(),
        eventType: 'group.instance.kick',
        actorDisplayName: 'Mod',
        targetDisplayName: `Troll${i}`,
        description: `Mod has issued an instance kick for Troll${i}.`
    };
}

function addKicks(from, to) {
    for (let i = from; i <= to; i++) auditLog.unshift(kick(i));
}

function adminGroup(id, name) {
    return { id, name, myMember: { permissions: ['*'] } };
}

async function flush(times = 8) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
}

function activeIntervals() {
    return mocks.intervals.size;
}

async function fireTimers() {
    for (const { fn } of [...mocks.intervals.values()]) fn();
    await flush();
}

function discordPosts() {
    return mocks.fetch.mock.calls.map(([url, init]) => ({
        url,
        body: JSON.parse(init.body)
    }));
}

async function login(userId, groups = [adminGroup(GROUP_A, 'Alpha')]) {
    fakes.user.currentUser = { id: userId };
    fakes.group.currentUserGroups = new Map(groups.map((g) => [g.id, g]));
    watchState.isLoggedIn = true;
    await flush();
    fakes.group.currentUserGroupsInit = true;
    await flush();
}

async function logout() {
    watchState.isLoggedIn = false;
    fakes.group.currentUserGroupsInit = false;
    fakes.user.currentUser = { id: '' };
    await flush();
}

let currentStore = null;

// One app instance at a time, like production: dispose the previous store so
// its login watcher is gone ("VRCX closed").
function disposeApp() {
    if (!currentStore) return;
    currentStore.stop();
    currentStore.$dispose();
    currentStore = null;
}

function freshApp() {
    disposeApp();
    setActivePinia(createPinia());
    currentStore = useGroupMonitorStore();
    return currentStore;
}

let backing;

beforeEach(() => {
    backing = {};
    mocks.storage = createMemoryMonitorStorage(backing);
    mocks.intervals.clear();
    mocks.idb.clear();
    mocks.meta.clear();
    auditLog = [];
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (endpoint, { params }) => {
        if (!/^groups\/grp_[\w-]+\/auditLogs$/.test(endpoint))
            throw new Error(`unexpected ${endpoint}`);
        let rows = auditLog;
        if (params.endDate)
            rows = rows.filter((e) => Date.parse(e.created_at) < Date.parse(params.endDate));
        if (params.startDate)
            rows = rows.filter((e) => Date.parse(e.created_at) >= Date.parse(params.startDate));
        const offset = params.offset ?? 0;
        return {
            results: rows.slice(offset, offset + params.n),
            totalCount: auditLog.length
        };
    });
    mocks.sqlExecute.mockReset();
    mocks.sqlExecute.mockImplementation(async () => {});
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(
        async () => new Response('{"id":"1"}', { status: 200 })
    );
    vi.stubGlobal('fetch', (...a) => mocks.fetch(...a));
    watchState.isLoggedIn = false;
    fakes.user.currentUser = { id: '' };
    fakes.group.currentUserGroups = new Map();
    fakes.group.currentUserGroupsInit = false;
});

afterEach(() => {
    disposeApp();
    vi.unstubAllGlobals();
    watchState.isLoggedIn = false;
});

async function seedAccount(
    userId,
    webhooks,
    groupSettings = { [GROUP_A]: { monitored: true } }
) {
    await mocks.storage.setKv(`gm:${userId}:config`, {
        version: 1,
        enabled: true,
        webhooks,
        groupSettings
    });
}

const auditHook = (over = {}) => ({
    id: 'wh-audit',
    name: 'Mod log',
    url: HOOK,
    groupId: GROUP_A,
    type: 'audit-events',
    eventFilter: ['kick', 'ban', 'warn'],
    enabled: true,
    ...over
});

describe('groupMonitor store lifecycle', () => {
    test('starts at login without any Group Monitor page being mounted', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 3);
        const store = freshApp();
        expect(store.serviceState).toBe('stopped');
        expect(activeIntervals()).toBe(0);

        await login('usr_a');
        expect(store.serviceState).toBe('running');
        expect(activeIntervals()).toBe(1);
        // first poll only records the watermark: no history flood
        expect(mocks.request).toHaveBeenCalledWith(
            `groups/${GROUP_A}/auditLogs`,
            expect.anything()
        );
        expect(mocks.fetch).not.toHaveBeenCalled();

        // new kick arrives; next cycle posts it with no page open
        addKicks(4, 4);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        await fireTimers();
        vi.restoreAllMocks();
        const posts = discordPosts();
        expect(posts).toHaveLength(1);
        expect(posts[0].url).toBe(`${HOOK}?wait=true`);
        expect(posts[0].body.embeds[0].title).toContain('Instance Kick');
        expect(posts[0].body.embeds[0].title).toContain('Alpha');
        expect(store.webhookState['wh-audit'].lastSuccessAt).toBeGreaterThan(0);
        expect(store.pollStatus[GROUP_A]).toMatchObject({
            ok: true,
            newCount: 1
        });
    });

    test('logout stops the timer; login/logout x3 never leaves duplicate timers', async () => {
        await seedAccount('usr_a', [auditHook()]);
        const store = freshApp();
        for (let i = 0; i < 3; i++) {
            await login('usr_a');
            expect(activeIntervals()).toBe(1);
            expect(store.serviceState).toBe('running');
            await logout();
            expect(activeIntervals()).toBe(0);
            expect(store.serviceState).toBe('stopped');
            expect(store.webhooks).toEqual([]);
        }
    });

    test('disabled background monitoring pauses polling but keeps delivery', async () => {
        await mocks.storage.setKv('gm:usr_a:config', {
            enabled: false,
            webhooks: [auditHook()],
            groupSettings: {}
        });
        const store = freshApp();
        await login('usr_a');
        expect(store.serviceState).toBe('paused');
        expect(mocks.request).not.toHaveBeenCalled();
        await store.testWebhook('wh-audit');
        await flush();
        expect(discordPosts()).toHaveLength(1);
        expect(discordPosts()[0].body.embeds[0].title).toContain('Test');
    });

    test('account switch: stops A, loads B config, never posts A webhooks for B', async () => {
        await seedAccount('usr_a', [auditHook()]);
        await seedAccount(
            'usr_b',
            [auditHook({ id: 'wh-b', url: HOOK_B, groupId: GROUP_B })],
            {
                [GROUP_B]: { monitored: true }
            }
        );
        const store = freshApp();
        await login('usr_a');
        expect(store.activeUserId).toBe('usr_a');
        expect(store.webhooks.map((w) => w.id)).toEqual(['wh-audit']);

        // switch without an explicit logout
        fakes.group.currentUserGroupsInit = false;
        fakes.user.currentUser = { id: 'usr_b' };
        fakes.group.currentUserGroups = new Map([
            [GROUP_B, adminGroup(GROUP_B, 'Bravo')]
        ]);
        await flush();
        fakes.group.currentUserGroupsInit = true;
        await flush();
        expect(store.activeUserId).toBe('usr_b');
        expect(store.webhooks.map((w) => w.id)).toEqual(['wh-b']);
        expect(activeIntervals()).toBe(1);
        const polled = mocks.request.mock.calls.map((c) => c[0]);
        expect(polled.at(-1)).toBe(`groups/${GROUP_B}/auditLogs`);
    });

    test('catch-up after downtime is capped per webhook with a summary', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 5);
        const first = freshApp();
        await login('usr_a');
        await logout();
        expect(mocks.fetch).not.toHaveBeenCalled();

        // VRCX closed while 35 kicks happened
        addKicks(6, 40);
        const second = freshApp();
        await login('usr_a');
        await flush(20);
        const posts = discordPosts();
        const titles = posts.map((p) => p.body.embeds[0].title);
        expect(posts).toHaveLength(CATCH_UP_CAP + 1);
        expect(titles[0]).toMatch(/^\+15 more events/);
        expect(posts[0].body.embeds[0].description).toContain(
            'while VRCX was closed'
        );
        // the newest 20 are posted individually
        expect(titles.at(-1)).toContain('Instance Kick');
        expect(JSON.stringify(posts.at(-1).body)).toContain('Troll40');
        expect(JSON.stringify(posts)).not.toContain('Troll20.');
        expect(first).not.toBe(second);
    });

    test('dedupe survives a restart even if the watermark was lost', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 2);
        freshApp();
        await login('usr_a');
        addKicks(3, 4);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        await fireTimers();
        vi.restoreAllMocks();
        expect(discordPosts()).toHaveLength(2);
        await logout();

        // simulate a crash before runtime state was saved: roll the watermark back
        const rt = await mocks.storage.getKv('gm:usr_a:runtime');
        rt.watermarks[GROUP_A] = { at: kick(2).created_at, ids: [kick(2).id] };
        await mocks.storage.setKv('gm:usr_a:runtime', rt);

        mocks.storage = createMemoryMonitorStorage(backing); // "restart"
        freshApp();
        await login('usr_a');
        await flush(20);
        expect(discordPosts()).toHaveLength(2); // kicks 3 and 4 not re-posted
    });

    test('429 from Discord is retried after retry_after, not dropped', async () => {
        await seedAccount('usr_a', [auditHook()]);
        const store = freshApp();
        await login('usr_a');
        mocks.fetch.mockReset();
        mocks.fetch
            .mockImplementationOnce(
                async () =>
                    new Response('{"retry_after":1.5,"global":false}', {
                        status: 429,
                        headers: { 'Content-Type': 'application/json' }
                    })
            )
            .mockImplementation(
                async () => new Response('{"id":"1"}', { status: 200 })
            );
        await store.testWebhook('wh-audit');
        await flush();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(store.queueStats.pending).toBe(1);
        expect(store.webhookState['wh-audit'].lastErrorStatus).toBe(429);

        const base = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(base + 1000);
        await fireTimers();
        expect(mocks.fetch).toHaveBeenCalledTimes(1); // still inside retry_after
        Date.now.mockReturnValue(base + 1600);
        await fireTimers();
        vi.restoreAllMocks();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(store.queueStats.pending).toBe(0);
        expect(store.deliveryLog[0].status).toBe('sent');
    });

    test('legacy global webhooks migrate once to the first account, with a group', async () => {
        localStorage.setItem('gm-monitored-group', GROUP_A);
        localStorage.setItem('gm-monitor-crash', '1');
        await mocks.storage.setKv('gm-webhooks-v1', [
            {
                id: 'wh-old',
                name: 'Old',
                url: HOOK,
                type: 'kick-board',
                enabled: true,
                intervalMinutes: 60
            }
        ]);
        const store = freshApp();
        await login('usr_a');
        expect(store.webhooks).toMatchObject([
            { id: 'wh-old', groupId: GROUP_A, type: 'kick-board' }
        ]);
        expect(store.getGroupSettings(GROUP_A).crashEnabled).toBe(true);
        await logout();
        await login('usr_b');
        expect(store.webhooks).toEqual([]);
        localStorage.removeItem('gm-monitored-group');
        localStorage.removeItem('gm-monitor-crash');
    });

    test('scheduled leaderboard is not consumed while there is no data, then posts once per slot', async () => {
        await seedAccount(
            'usr_a',
            [
                {
                    id: 'wh-lb',
                    name: 'Kickers',
                    url: HOOK,
                    groupId: GROUP_A,
                    type: 'kick-board',
                    intervalMinutes: 60,
                    enabled: true
                }
            ],
            {}
        );
        const store = freshApp();
        await login('usr_a');
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(store.webhookState['wh-lb'].lastError).toMatch(
            /No audit history/
        );
        expect(store.lastSent['wh-lb']).toBeUndefined();

        mocks.idb.set(GROUP_A, [kick(1), kick(2)]);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        await fireTimers();
        const posts = discordPosts();
        expect(posts).toHaveLength(1);
        expect(posts[0].body.embeds[0].title).toBe('Top Kickers — Alpha');
        expect(posts[0].body.embeds[0].description).toContain('1. Mod — 2');
        // next cycle in the same slot: nothing
        Date.now.mockReturnValue(Date.now() + 61_000);
        await fireTimers();
        vi.restoreAllMocks();
        expect(discordPosts()).toHaveLength(1);
    });
});

describe('crash alerts', () => {
    const LOC = `wrld_x:1~group(${GROUP_A})~groupAccessType(public)`;
    const crashHook = {
        id: 'wh-crash',
        name: 'Crashes',
        url: HOOK,
        groupId: GROUP_A,
        type: 'crash-alert',
        enabled: true
    };

    function serveGamelog({ leaves, visits = [] }) {
        mocks.sqlExecute.mockImplementation(async (cb, sql, args) => {
            if (sql.includes('FROM gamelog_join_leave')) {
                // honour the ISO cutoff like SQLite's string comparison would
                for (const l of leaves)
                    if (l.at >= args['@cutoff']) cb([l.at, l.name, l.location]);
            } else if (sql.includes('FROM gamelog_location')) {
                for (const v of visits) cb([v.created_at, v.location, v.time]);
            }
        });
    }

    test('a spike is alerted once, not every minute afterwards', async () => {
        const now = Date.now();
        serveGamelog({
            leaves: Array.from({ length: 6 }, (_, i) => ({
                at: new Date(now - 120_000 + i * 3000).toISOString(),
                name: `p${i}`,
                location: LOC
            }))
        });
        await seedAccount('usr_a', [crashHook], {
            [GROUP_A]: {
                monitored: false,
                crashEnabled: true,
                crashThreshold: 5,
                crashWindowSec: 60
            }
        });
        const store = freshApp();
        await login('usr_a');
        expect(discordPosts()).toHaveLength(1);
        expect(discordPosts()[0].body.embeds[0].title).toContain(
            'Crash Detected'
        );
        expect(store.recentCrashes).toHaveLength(1);
        for (let i = 1; i <= 3; i++) {
            vi.spyOn(Date, 'now').mockReturnValue(now + i * 61_000);
            await fireTimers();
            vi.restoreAllMocks();
        }
        expect(discordPosts()).toHaveLength(1);
        // and not again after a restart
        await logout();
        freshApp();
        await login('usr_a');
        expect(discordPosts()).toHaveLength(1);
    });

    test('leaving a group instance yourself is not a crash', async () => {
        const now = Date.now();
        const leftAt = new Date(now - 60_000).toISOString();
        serveGamelog({
            leaves: Array.from({ length: 10 }, (_, i) => ({
                at: leftAt,
                name: `p${i}`,
                location: LOC
            })),
            visits: [
                {
                    created_at: new Date(
                        now - 60_000 - 3_600_000
                    ).toISOString(),
                    location: LOC,
                    time: 3_600_000
                }
            ]
        });
        await seedAccount('usr_a', [crashHook], {
            [GROUP_A]: { crashEnabled: true }
        });
        const store = freshApp();
        await login('usr_a');
        expect(discordPosts()).toHaveLength(0);
        expect(store.recentCrashes).toHaveLength(0);
    });

    test('turning crash alerts off stops them everywhere', async () => {
        const now = Date.now();
        await seedAccount('usr_a', [crashHook], {
            [GROUP_A]: { crashEnabled: true }
        });
        const store = freshApp();
        serveGamelog({ leaves: [] });
        await login('usr_a');
        await store.setGroupSettings(GROUP_A, { crashEnabled: false });
        serveGamelog({
            leaves: Array.from({ length: 6 }, (_, i) => ({
                at: new Date(now - 60_000 + i * 1000).toISOString(),
                name: `p${i}`,
                location: LOC
            }))
        });
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        await fireTimers();
        vi.restoreAllMocks();
        expect(discordPosts()).toHaveLength(0);
    });
});

// Real page mount/unmount x3 lives in views/GroupMonitor/__tests__/pageLifecycle.test.js
describe('Group Monitor pages do not own the service', () => {
    test('page sources contain no webhook/crash timers or service start/stop', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.resolve(
            import.meta.dirname,
            '../../views/GroupMonitor'
        );
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.vue'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            expect(src, f).not.toMatch(
                /startWebhookScheduler|startCrashMonitor|backgroundCrashCheck|webhookScheduler\(/
            );
            expect(src, f).not.toMatch(/fetch\(/);
            expect(src, f).not.toMatch(/setInterval\(/);
        }
    });
});

describe('review fixes', () => {
    test('login with cached groups (permissions not loaded yet) polls right away, no false permission error', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 3);
        const store = freshApp();
        const cached = {
            id: GROUP_A,
            name: 'Alpha',
            myMember: { roleIds: [] }
        };
        await login('usr_a', [cached]);
        expect(mocks.request).toHaveBeenCalled();
        expect(store.pollStatus[GROUP_A]).toMatchObject({
            ok: true,
            error: null
        });
        expect(store.isPollingGroup(GROUP_A)).toBe(true);
    });

    test('a known missing audit permission is reported and not polled', async () => {
        await seedAccount('usr_a', [auditHook()]);
        const store = freshApp();
        await login('usr_a', [
            {
                id: GROUP_A,
                name: 'Alpha',
                myMember: { permissions: ['group-members-viewall'] }
            }
        ]);
        expect(mocks.request).not.toHaveBeenCalled();
        expect(store.pollStatus[GROUP_A].error).toMatch(
            /No audit-log permission/
        );
        expect(store.isPollingGroup(GROUP_A)).toBe(false);
    });

    test('background audit requests never raise error toasts', async () => {
        await seedAccount('usr_a', [auditHook()]);
        freshApp();
        await login('usr_a');
        expect(mocks.request).toHaveBeenCalled();
        for (const [endpoint, opts] of mocks.request.mock.calls) {
            expect(endpoint).toMatch(/auditLogs$/);
            expect(opts.silentErrors).toBe(true);
        }
    });

    test('a Discord post that never finishes does not stop audit polling', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 2);
        const store = freshApp();
        await login('usr_a');
        mocks.fetch.mockImplementationOnce(() => new Promise(() => {}));
        addKicks(3, 4);
        const t0 = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
        await fireTimers();
        const polls = mocks.request.mock.calls.length;
        for (let m = 2; m <= 5; m++) {
            spy.mockReturnValue(t0 + m * 61_000);
            await fireTimers();
        }
        vi.restoreAllMocks();
        expect(mocks.request.mock.calls.length).toBeGreaterThanOrEqual(
            polls + 4
        );
        expect(store.lastCycleAt).toBeGreaterThanOrEqual(t0 + 5 * 61_000);
    });

    test('logout + quick re-login while a post is in flight posts it only once', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 2);
        freshApp();
        await login('usr_a');
        let release;
        mocks.fetch.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    release = () =>
                        r(new Response('{"id":"1"}', { status: 200 }));
                })
        );
        addKicks(3, 3);
        const t0 = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
        await fireTimers();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        await logout();
        await login('usr_a');
        release();
        await flush(20);
        spy.mockReturnValue(t0 + 70_000);
        await fireTimers();
        vi.restoreAllMocks();
        const troll3 = discordPosts().filter((p) =>
            JSON.stringify(p.body).includes('Troll3')
        ).length;
        expect(troll3).toBe(1);
    });

    test('legacy migration: leaderboards keep the viewed group, crash alerts the monitored group', async () => {
        localStorage.setItem('gm-group-id', GROUP_A);
        localStorage.setItem('gm-monitored-group', GROUP_B);
        localStorage.setItem('gm-monitor-crash', '1');
        await mocks.storage.setKv('gm-webhooks-v1', [
            {
                id: 'wh-kicks',
                name: 'Kicks',
                url: HOOK,
                type: 'kick-board',
                intervalMinutes: 60,
                enabled: true
            },
            {
                id: 'wh-crash',
                name: 'Crash',
                url: HOOK_B,
                type: 'crash-alert',
                enabled: true
            }
        ]);
        const store = freshApp();
        await login('usr_a', [
            adminGroup(GROUP_A, 'Alpha'),
            adminGroup(GROUP_B, 'Bravo')
        ]);
        localStorage.removeItem('gm-group-id');
        localStorage.removeItem('gm-monitored-group');
        localStorage.removeItem('gm-monitor-crash');
        const byId = Object.fromEntries(
            store.webhooks.map((w) => [w.id, w.groupId])
        );
        expect(byId).toEqual({ 'wh-kicks': GROUP_A, 'wh-crash': GROUP_B });
        expect(store.getGroupSettings(GROUP_B).crashEnabled).toBe(true);
        expect(store.getGroupSettings(GROUP_A).crashEnabled).toBe(false);
    });

    test('schedules run every N minutes since the last post, not on clock boundaries', async () => {
        const base = Date.UTC(2026, 8, 29, 12, 59, 0);
        const spy = vi.spyOn(Date, 'now').mockReturnValue(base);
        mocks.idb.set(GROUP_A, [kick(1), kick(2)]);
        const hook = {
            id: 'wh-lb',
            name: 'Top',
            url: HOOK,
            groupId: GROUP_A,
            type: 'kick-board',
            intervalMinutes: 60,
            enabled: true
        };
        await seedAccount('usr_a', [hook], {});
        // the previous build posted 4 minutes ago (migrated lastSent)
        await mocks.storage.setKv('gm:usr_a:runtime', {
            lastSent: { 'wh-lb': base - 4 * 60_000 }
        });
        freshApp();
        await login('usr_a');
        await flush(10);
        spy.mockReturnValue(base + 61_000); // 13:00:01, a new hour
        await fireTimers();
        expect(mocks.fetch).not.toHaveBeenCalled();
        spy.mockReturnValue(base + 56 * 60_000 + 1000); // 60 min after the last post
        await fireTimers();
        await flush(10);
        vi.restoreAllMocks();
        expect(discordPosts()).toHaveLength(1);
    });

    test('vote-kick boards with no data are held, not posted as "No data yet."', async () => {
        await seedAccount(
            'usr_a',
            [
                {
                    id: 'wh-vk',
                    name: 'VK',
                    url: HOOK,
                    groupId: GROUP_A,
                    type: 'vk-targets',
                    intervalMinutes: 60,
                    enabled: true
                }
            ],
            {}
        );
        const store = freshApp();
        await login('usr_a');
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(store.webhookState['wh-vk'].lastError).toMatch(/No vote kicks/);
        expect(store.lastSent['wh-vk']).toBeUndefined();
    });

    test('a 5xx keeps per-event posts in order; disabling a webhook drops its queued posts', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 2);
        const store = freshApp();
        await login('usr_a');
        mocks.fetch.mockImplementationOnce(
            async () => new Response('{"message":"oops"}', { status: 502 })
        );
        addKicks(3, 5);
        const t0 = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
        await fireTimers();
        spy.mockReturnValue(t0 + 61_000 + 15_000);
        await fireTimers();
        const order = mocks.fetch.mock.calls.map(
            ([, init]) =>
                JSON.parse(init.body).embeds[0].description.match(
                    /Troll\d+/
                )?.[0]
        );
        expect(order).toEqual(['Troll3', 'Troll3', 'Troll4', 'Troll5']);

        mocks.fetch.mockImplementation(
            async () => new Response('{"message":"oops"}', { status: 502 })
        );
        addKicks(6, 7);
        spy.mockReturnValue(t0 + 3 * 61_000);
        await fireTimers();
        expect(store.queueStats.pending).toBeGreaterThan(0);
        await store.updateWebhook('wh-audit', { enabled: false });
        vi.restoreAllMocks();
        expect(store.queueStats.pending).toBe(0);
    });
});

describe('gap-aware catch-up and backfill', () => {
    const windowCalls = () =>
        mocks.request.mock.calls.filter(([, o]) => o.params.endDate);

    async function cycles(n, from = Date.now()) {
        const spy = vi.spyOn(Date, 'now');
        for (let i = 1; i <= n; i++) {
            spy.mockReturnValue(from + i * 61_000);
            await fireTimers();
        }
        spy.mockRestore();
        return from + n * 61_000;
    }

    test('downtime longer than the catch-up budget is queued and backfilled, never skipped', async () => {
        await seedAccount('usr_a', [auditHook()]);
        addKicks(1, 50);
        freshApp();
        await login('usr_a');
        await logout();

        addKicks(51, 1550); // 1,500 while VRCX was closed: more than 5 pages
        const store = freshApp();
        await login('usr_a');
        await flush(20);
        // the window between the watermark and the 5 fetched pages is queued
        expect(mocks.meta.get(GROUP_A).gaps).toHaveLength(1);
        expect(mocks.meta.get(GROUP_A).gaps[0].after).toBe(kick(50).created_at);

        await cycles(6);
        expect(mocks.meta.get(GROUP_A).gaps).toEqual([]);
        const cached = new Set((mocks.idb.get(GROUP_A) ?? []).map((e) => e.id));
        for (let i = 1; i <= 1550; i++) expect(cached.has(kick(i).id)).toBe(true);
        // per-event posts stay capped with one summary; backfill posts nothing
        expect(discordPosts()).toHaveLength(CATCH_UP_CAP + 1);
        expect(store.pollStatus[GROUP_A].gapsRemaining).toBe(0);
        // budget: never more than BACKFILL_PAGES_PER_CYCLE window requests per cycle
        expect(windowCalls().length).toBeLessThanOrEqual(7 * BACKFILL_PAGES_PER_CYCLE);
    });

    test('an account without a watermark pages back to the cached entries instead of trusting page 0', async () => {
        addKicks(1, 100);
        mocks.idb.set(GROUP_A, [...auditLog]);
        await seedAccount('usr_b', [auditHook()]);
        addKicks(101, 350);
        freshApp();
        await login('usr_b');
        await flush(20);
        const cached = new Set(mocks.idb.get(GROUP_A).map((e) => e.id));
        for (let i = 101; i <= 350; i++) expect(cached.has(kick(i).id)).toBe(true);
        expect(mocks.meta.get(GROUP_A)?.gaps ?? []).toEqual([]);
        expect(discordPosts()).toEqual([]); // first run posts nothing
    });

    test('a VRChat 429 anywhere pauses the backfill, which resumes afterwards', async () => {
        addKicks(1, 400);
        await seedAccount('usr_a', []);
        mocks.meta.set(GROUP_A, {
            gaps: [makeGap({ after: kick(1).created_at, before: kick(300).created_at }, 'repair')],
            repairScanVersion: 1
        });
        freshApp();
        await login('usr_a');
        await flush(20);
        const before = windowCalls().length;
        expect(before).toBeGreaterThan(0);

        notifyVrchatRateLimit('users/usr_x'); // e.g. AIRI hit the limit
        let t = await cycles(1);
        expect(windowCalls().length).toBe(before);
        t = await cycles(3, t); // pause is 2 minutes
        expect(windowCalls().length).toBeGreaterThan(before);
    });

    test('a failed cache write keeps the watermark, so the entries are fetched again', async () => {
        await seedAccount('usr_a', []);
        addKicks(1, 50);
        freshApp();
        await login('usr_a');
        await flush(20);

        addKicks(51, 120);
        const { auditDbSaveEntries } = await import('../../services/auditLogDb');
        vi.mocked(auditDbSaveEntries).mockRejectedValueOnce(new Error('QuotaExceededError'));
        const store = useGroupMonitorStore();
        const t = await cycles(1);
        expect(store.pollStatus[GROUP_A].ok).toBe(false);
        await cycles(1, t);
        expect(store.pollStatus[GROUP_A].ok).toBe(true);
        const cached = new Set(mocks.idb.get(GROUP_A).map((e) => e.id));
        for (let i = 1; i <= 120; i++) expect(cached.has(kick(i).id)).toBe(true);
        expect(mocks.meta.get(GROUP_A)?.gaps ?? []).toEqual([]);
    });

    test('a stale watermark does not queue what the other account already cached', async () => {
        await seedAccount('usr_a', []);
        addKicks(1, 50);
        freshApp();
        await login('usr_a');
        await logout();

        // the other account kept polling: everything but the newest 10 is cached
        addKicks(51, 1550);
        mocks.idb.set(GROUP_A, auditLog.slice(10));
        freshApp();
        await login('usr_a');
        await flush(20);
        expect(mocks.meta.get(GROUP_A)?.gaps ?? []).toEqual([]);
        expect(windowCalls()).toEqual([]);
    });
});

describe('monitoring per account', () => {
    test('legacy settings reach every account; webhooks only the first', async () => {
        localStorage.setItem('gm-group-id', GROUP_A);
        await mocks.storage.setKv('gm-webhooks-v1', [
            { id: 'wh-old', name: 'Old', url: HOOK, type: 'kick-board', enabled: true, intervalMinutes: 60 }
        ]);
        const store = freshApp();
        await login('usr_a');
        expect(store.webhooks.map((w) => w.id)).toEqual(['wh-old']);
        expect(store.polledGroupIds).toEqual([GROUP_A]);
        await logout();

        mocks.request.mockClear();
        await login('usr_b');
        localStorage.removeItem('gm-group-id');
        expect(store.webhooks).toEqual([]);
        expect(store.getGroupSettings(GROUP_A).monitored).toBe(true);
        expect(store.polledGroupIds).toEqual([GROUP_A]);
        expect(mocks.request).toHaveBeenCalledWith(`groups/${GROUP_A}/auditLogs`, expect.anything());
    });

    test('groups with cached history are polled for any account that can read them', async () => {
        localStorage.setItem('gm-group-audit-data-ids', JSON.stringify([GROUP_A, GROUP_B]));
        const store = freshApp();
        await login('usr_c', [
            adminGroup(GROUP_A, 'Alpha'),
            { id: GROUP_B, name: 'Bravo', myMember: { permissions: ['group-members-view'] } }
        ]);
        localStorage.removeItem('gm-group-audit-data-ids');
        expect(store.polledGroupIds).toEqual([GROUP_A]);
        expect(store.isPollingGroup(GROUP_A)).toBe(true);

        // an explicit "off" wins over the default
        await store.setGroupSettings(GROUP_A, { monitored: false });
        expect(store.polledGroupIds).toEqual([]);
    });

    test('a group opened in Group Monitor is picked up without a restart', async () => {
        const store = freshApp();
        await login('usr_d', [adminGroup(GROUP_B, 'Bravo')]);
        expect(store.polledGroupIds).toEqual([]);
        store.noteViewedGroup(GROUP_B);
        expect(store.polledGroupIds).toEqual([GROUP_B]);
    });
});
