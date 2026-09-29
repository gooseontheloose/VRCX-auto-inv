import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    config: new Map(),
    cachedUsers: new Map(),
    watchState: { isLoggedIn: true },
    lastLocation: null,
    groupInvite: { rateLimitCooldownUntil: 0 },
    cacheRows: [],
    savedRows: new Map(),
    api: {
        fetch: vi.fn(),
        getUser: vi.fn()
    }
}));

vi.mock('../../services/config', () => ({
    default: {
        getBool: vi.fn(async (key, d) =>
            mocks.config.has(key) ? mocks.config.get(key) : d
        ),
        setBool: vi.fn(async (key, value) => mocks.config.set(key, value)),
        getString: vi.fn(async (key, d) =>
            mocks.config.has(key) ? mocks.config.get(key) : d
        ),
        setString: vi.fn(async (key, value) => mocks.config.set(key, value))
    }
}));
vi.mock('../../services/watchState', () => ({ watchState: mocks.watchState }));
vi.mock('../../services/database', () => ({
    database: { addFriendLogHistory: vi.fn() }
}));
vi.mock('../../services/database/airiUserCache', () => ({
    airiUserCache: {
        initAiriUserCache: vi.fn(async () => {}),
        pruneAiriUserCache: vi.fn(async () => {}),
        loadAiriUserCache: vi.fn(async () => mocks.cacheRows),
        saveAiriUserCacheEntry: vi.fn(async (entry) => {
            mocks.savedRows.set(entry.userId, { ...entry });
        })
    }
}));
vi.mock('../../api', () => ({
    friendRequest: { getFriendStatus: vi.fn(), sendFriendRequest: vi.fn() },
    notificationRequest: { acceptFriendRequestNotification: vi.fn() },
    queryRequest: { fetch: mocks.api.fetch },
    userRequest: { getUser: mocks.api.getUser }
}));
vi.mock('../../coordinators/friendRelationshipCoordinator', () => ({
    addFriendship: vi.fn(),
    getFriendRequest: vi.fn(() => ''),
    handleFriendStatus: vi.fn()
}));
vi.mock('../friend', () => ({
    useFriendStore: () => ({
        friends: new Map(),
        friendLog: new Map(),
        friendLogTable: { data: [] }
    })
}));
vi.mock('../notification', () => ({
    useNotificationStore: () => ({
        notificationTable: { data: [] },
        isNotificationsLoading: false,
        refreshNotifications: vi.fn()
    })
}));
vi.mock('../groupInvite', () => ({
    useGroupInviteStore: () => mocks.groupInvite
}));
vi.mock('../user', () => ({
    useUserStore: () => ({
        currentUser: { id: ME },
        cachedUsers: mocks.cachedUsers
    })
}));
vi.mock('../location', () => ({
    useLocationStore: () => ({
        get lastLocation() {
            return mocks.lastLocation;
        }
    })
}));
vi.mock('../gameLog', () => ({ useGameLogStore: () => ({ state: {} }) }));

import { useAiriIntegrationStore } from '../airiIntegration';

const ME = 'usr_99999999-9999-4999-8999-999999999999';
const HOUR = 60 * 60 * 1000;

function uid(i) {
    return `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function rateLimitError() {
    const err = new Error('429 Too Many Requests');
    err.status = 429;
    return err;
}

/** Fake VRChat: records every call; `failures` maps call number -> error. */
function installApi({ failures = new Map() } = {}) {
    const calls = [];
    const respond = (kind, userId) => {
        calls.push({ kind, userId, at: Date.now() });
        const error = failures.get(calls.length);
        if (error) {
            return Promise.reject(error);
        }
        const n = Number(userId.slice(-12));
        if (kind === 'group') {
            return Promise.resolve({
                json:
                    n % 3 === 0 ? {} : { name: `Group ${n}`, shortCode: 'GRP' }
            });
        }
        return Promise.resolve({
            json: {
                id: userId,
                bio: `bio of ${n}`,
                tags: n % 2 ? ['system_supporter'] : ['system_trust_known']
            }
        });
    };
    mocks.api.fetch.mockImplementation((name, { userId }) =>
        respond('group', userId)
    );
    mocks.api.getUser.mockImplementation(({ userId }) =>
        respond('profile', userId)
    );
    return calls;
}

function setPlayers(ids) {
    mocks.lastLocation = {
        location: 'wrld_x:1',
        name: 'Club',
        playerList: new Map(
            ids.map((id, i) => [
                id,
                { userId: id, displayName: `P${i}`, joinTime: i }
            ])
        )
    };
}

async function makeStore({ fetchGroups = true, shareBios = true } = {}) {
    mocks.config.set('PAW_airiIntegration_enabled', true);
    mocks.config.set('PAW_airiIntegration_fetchGroups', fetchGroups);
    mocks.config.set('PAW_airiIntegration_shareBios', shareBios);
    const store = useAiriIntegrationStore();
    for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
    expect(store.enabled).toBe(true);
    expect(store.getLookupStatus().cacheState).toBe('ready');
    return store;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 29, 20, 0, 0));
    setActivePinia(createPinia());
    mocks.config.clear();
    mocks.cachedUsers.clear();
    mocks.watchState.isLoggedIn = true;
    mocks.lastLocation = null;
    mocks.groupInvite.rateLimitCooldownUntil = 0;
    mocks.cacheRows = [];
    mocks.savedRows.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('AIRI lookups at stream scale', () => {
    test('300-join burst with injected 429s: paced, backs off, no caps, nothing lost', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => uid(i));
        // Calls 25 and 26 are rate limited (the second one right after the first pause).
        const calls = installApi({
            failures: new Map([
                [25, rateLimitError()],
                [26, rateLimitError()]
            ])
        });
        setPlayers([]);
        const store = await makeStore();
        const start = Date.now();

        // Everyone joins within a few seconds, like a lobby filling up.
        for (const [i, id] of ids.entries()) {
            mocks.lastLocation.playerList.set(id, {
                userId: id,
                displayName: `P${i}`,
                joinTime: i
            });
            store.handlePlayerJoined(id);
        }
        // 20 early joiners leave before their turn (they are looked up last).
        const leavers = ids.slice(1, 21);
        await vi.advanceTimersByTimeAsync(1000);
        for (const id of leavers) {
            mocks.lastLocation.playerList.delete(id);
        }

        // The first joiner was looked up at once; then newest joiner first.
        expect(calls[0].userId).toBe(ids[0]);
        expect(calls[1].userId).toBe(ids[299]);
        // Burst of 10, then paced.
        expect(calls.filter((c) => c.at - start <= 1000)).toHaveLength(10);

        await vi.advanceTimersByTimeAsync(3 * HOUR);

        // First 429 -> 60 s pause, second 429 -> 120 s pause, no calls inside either.
        const first429 = calls[24].at;
        const second429 = calls[25].at;
        expect(second429 - first429).toBeGreaterThanOrEqual(60 * 1000);
        expect(calls[26].at - second429).toBeGreaterThanOrEqual(120 * 1000);
        expect(mocks.groupInvite.rateLimitCooldownUntil).toBe(
            second429 + 120 * 1000
        );

        // Pacing: after the burst, never faster than one call per 2.5 s.
        for (let i = 10; i < calls.length; i++) {
            expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(2500);
        }
        // Never more than 600 calls in any hour.
        for (let i = 0; i < calls.length; i++) {
            const inHour = calls.filter(
                (c) => c.at >= calls[i].at && c.at < calls[i].at + HOUR
            ).length;
            expect(inHour).toBeLessThanOrEqual(600);
        }

        // 280 present players x (group + profile), plus the 2 retried 429s.
        // No session cap: everyone present got both lookups.
        expect(calls).toHaveLength(280 * 2 + 2);
        const fetched = new Set(calls.map((c) => c.userId));
        for (const id of leavers) {
            expect(fetched.has(id)).toBe(false);
        }
        const payload = store.buildPayload();
        expect(payload.players).toHaveLength(280);
        for (const player of payload.players) {
            const n = Number(player.userId.slice(-12));
            expect(player.bio).toBe(`bio of ${n}`);
            expect(player.vrcPlusKnown).toBe(true);
            expect(player.isVRCPlus).toBe(n % 2 === 1);
            if (n % 3 === 0) {
                expect(player).not.toHaveProperty('representedGroup');
            } else {
                expect(player.representedGroup).toEqual({
                    name: `Group ${n}`,
                    shortCode: 'GRP'
                });
            }
        }
        const status = store.getLookupStatus();
        expect(status).toMatchObject({
            queued: 0,
            rateLimited: 2,
            strikes: 0,
            failed: 0,
            skipped: { left: 40 }
        });
        // Everything learned is persisted.
        expect(mocks.savedRows.size).toBe(280);
    });

    test('GET /paw/player jumps the queue during a burst', async () => {
        const ids = Array.from({ length: 100 }, (_, i) => uid(i));
        const calls = installApi();
        setPlayers(ids);
        const store = await makeStore();
        store.enqueueCurrentPlayers();
        await vi.advanceTimersByTimeAsync(5000);
        const before = calls.length;
        // An early joiner: would be looked up last.
        const pending = store.handlePlayerRequest(ids[1]);
        await vi.advanceTimersByTimeAsync(6000);
        const res = JSON.parse(await pending);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            inInstance: true,
            pending: false,
            player: {
                userId: ids[1],
                bio: 'bio of 1',
                vrcPlusKnown: true,
                isVRCPlus: true
            }
        });
        expect(calls.slice(before, before + 2).map((c) => c.userId)).toEqual([
            ids[1],
            ids[1]
        ]);
    });

    test('GET /paw/player works for someone not in the instance and checks input', async () => {
        installApi();
        setPlayers([]);
        const store = await makeStore({ fetchGroups: false, shareBios: false });
        const pending = store.handlePlayerRequest(uid(7));
        await vi.advanceTimersByTimeAsync(3000);
        const res = JSON.parse(await pending);
        expect(res.body).toMatchObject({
            ok: true,
            inInstance: false,
            player: { isVRCPlus: true, vrcPlusKnown: true }
        });
        // Bios are not shared while "Share bios" is off.
        expect(res.body.player).not.toHaveProperty('bio');
        expect(
            JSON.parse(await store.handlePlayerRequest('usr_bad')).status
        ).toBe(400);
        expect(JSON.parse(await store.handlePlayerRequest(ME)).status).toBe(
            400
        );
        store.setEnabled(false);
        expect(JSON.parse(await store.handlePlayerRequest(uid(8))).status).toBe(
            403
        );
    });

    test('GET /paw/player answers right away during a long rate-limit pause', async () => {
        const calls = installApi({
            failures: new Map([[1, rateLimitError()]])
        });
        setPlayers([uid(1)]);
        const store = await makeStore();
        store.enqueueCurrentPlayers();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        const res = JSON.parse(await store.handlePlayerRequest(uid(2)));
        expect(res.body.pending).toBe(true);
        expect(res.body.retryAfterSec).toBeGreaterThan(50);
    });

    test('persistent cache: fresh rows cost no calls, stale ones are refreshed', async () => {
        const now = Date.now();
        mocks.cacheRows = [
            {
                userId: uid(1),
                groupName: 'Cached Club',
                shortCode: 'CC',
                bio: 'cached bio',
                isVRCPlus: true,
                groupFetchedAt: now - HOUR,
                bioFetchedAt: now - HOUR,
                lastSeenAt: now - HOUR
            },
            {
                userId: uid(2),
                groupName: '',
                shortCode: '',
                bio: 'old bio',
                isVRCPlus: false,
                groupFetchedAt: now - 10 * 24 * HOUR,
                bioFetchedAt: now - 2 * 24 * HOUR,
                lastSeenAt: now - 2 * 24 * HOUR
            }
        ];
        const calls = installApi();
        setPlayers([uid(1), uid(2)]);
        const store = await makeStore();
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(calls.map((c) => [c.kind, c.userId]).sort()).toEqual(
            [
                ['group', uid(2)],
                ['profile', uid(2)]
            ].sort()
        );
        const [p1, p2] = store.buildPayload().players;
        expect(p1).toMatchObject({
            bio: 'cached bio',
            isVRCPlus: true,
            representedGroup: { name: 'Cached Club', shortCode: 'CC' }
        });
        expect(p2).toMatchObject({ bio: 'bio of 2', isVRCPlus: false });
        expect(mocks.savedRows.get(uid(2))).toMatchObject({
            bio: 'bio of 2',
            groupName: 'Group 2'
        });
    });

    test('a full profile VRCX already fetched is reused ($lastFetch dedupe)', async () => {
        const calls = installApi();
        mocks.cachedUsers.set(uid(4), {
            id: uid(4),
            displayName: 'P0',
            bio: 'core bio',
            tags: ['system_supporter'],
            $isVRCPlus: true,
            $lastFetch: Date.now() - 1000
        });
        setPlayers([uid(4)]);
        const store = await makeStore({ fetchGroups: false });
        store.enqueueCurrentPlayers();
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(calls).toHaveLength(0);
        expect(store.buildPayload().players[0].bio).toBe('core bio');
        // Kept for after VRCX evicts the profile.
        mocks.cachedUsers.clear();
        expect(store.buildPayload().players[0]).toMatchObject({
            bio: 'core bio',
            isVRCPlus: true,
            vrcPlusKnown: true
        });
    });

    test('bios are looked up on join even with groups off', async () => {
        const calls = installApi();
        setPlayers([uid(5)]);
        const store = await makeStore({ fetchGroups: false });
        store.handlePlayerJoined(uid(5));
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls.map((c) => c.kind)).toEqual(['profile']);
    });

    test('failures are not cached as "no group": retried later', async () => {
        const boom = new Error('500 Internal Server Error');
        boom.status = 500;
        const calls = installApi({ failures: new Map([[1, boom]]) });
        setPlayers([uid(1)]);
        const store = await makeStore({ shareBios: false });
        store.enqueueCurrentPlayers();
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toHaveLength(1);
        expect(store.buildPayload().players[0]).not.toHaveProperty(
            'representedGroup'
        );
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(calls).toHaveLength(2);
        expect(store.buildPayload().players[0].representedGroup.name).toBe(
            'Group 1'
        );
    });

    test('logout clears the queue; the cache stays', async () => {
        const calls = installApi();
        setPlayers(Array.from({ length: 30 }, (_, i) => uid(i)));
        const store = await makeStore();
        store.enqueueCurrentPlayers();
        await vi.advanceTimersByTimeAsync(0);
        const done = calls.length;
        mocks.watchState.isLoggedIn = false;
        // watchState is a plain object in tests: drive the watcher's effect.
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(calls.length).toBe(done);
        expect(store.getLookupStatus().cacheSize).toBeGreaterThan(0);
    });
});
