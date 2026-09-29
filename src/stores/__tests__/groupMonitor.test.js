import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Everything that could reach VRChat, Discord, SQLite or IndexedDB is faked.
const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    sqlExecute: vi.fn(async () => {}),
    idb: new Map(),
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
    auditDbLoadMeta: vi.fn(async () => ({ fullyLoaded: true })),
    auditDbSaveMeta: vi.fn(async () => {}),
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
import { CATCH_UP_CAP, useGroupMonitorStore } from '../groupMonitor';

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
    auditLog = [];
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (endpoint, { params }) => {
        if (!/^groups\/grp_[\w-]+\/auditLogs$/.test(endpoint))
            throw new Error(`unexpected ${endpoint}`);
        return {
            results: auditLog.slice(params.offset, params.offset + params.n),
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
