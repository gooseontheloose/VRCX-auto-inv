import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    config: new Map(),
    friends: new Map(),
    friendLog: [],
    cachedUsers: new Map(),
    friendRequestKey: '',
    watchState: { isLoggedIn: true },
    api: {
        getFriendStatus: vi.fn(),
        sendFriendRequest: vi.fn(),
        acceptFriendRequestNotification: vi.fn(),
        getUser: vi.fn()
    },
    handleNotificationAccept: vi.fn(),
    handleNotificationHide: vi.fn(),
    refreshNotifications: vi.fn(),
    addFriendship: vi.fn(),
    friendLogCurrent: new Map(),
    notifications: [],
    notificationState: { isNotificationsLoading: false },
    groupInvite: { rateLimitCooldownUntil: 0 },
    lastLocation: null,
    rateLimitListeners: new Set()
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
// Fresh listener registry per test (every test builds a new store).
vi.mock('../../services/vrchatRateLimit', () => ({
    onVrchatRateLimit: (listener) => {
        mocks.rateLimitListeners.add(listener);
        return () => mocks.rateLimitListeners.delete(listener);
    },
    notifyVrchatRateLimit: (endpoint) => {
        for (const listener of mocks.rateLimitListeners) {
            listener(endpoint);
        }
    }
}));
vi.mock('../../services/database', () => ({
    database: { addFriendLogHistory: vi.fn() }
}));
vi.mock('../../services/database/airiUserCache', () => ({
    airiUserCache: {
        initAiriUserCache: vi.fn(async () => {}),
        pruneAiriUserCache: vi.fn(async () => {}),
        loadAiriUserCache: vi.fn(async () => []),
        saveAiriUserCacheEntry: vi.fn(async () => {})
    }
}));
vi.mock('../groupInvite', () => ({
    useGroupInviteStore: () => mocks.groupInvite
}));
vi.mock('../../api', () => ({
    friendRequest: {
        getFriendStatus: mocks.api.getFriendStatus,
        sendFriendRequest: mocks.api.sendFriendRequest
    },
    notificationRequest: {
        acceptFriendRequestNotification:
            mocks.api.acceptFriendRequestNotification
    },
    groupRequest: { getRepresentedGroup: vi.fn() },
    userRequest: { getUser: mocks.api.getUser }
}));
vi.mock('../../coordinators/friendRelationshipCoordinator', () => ({
    addFriendship: mocks.addFriendship,
    getFriendRequest: vi.fn(() => mocks.friendRequestKey),
    handleFriendStatus: vi.fn()
}));
vi.mock('../friend', () => ({
    useFriendStore: () => ({
        friends: mocks.friends,
        friendLog: mocks.friendLogCurrent,
        friendLogTable: { data: mocks.friendLog }
    })
}));
vi.mock('../notification', () => ({
    useNotificationStore: () => ({
        handleNotificationAccept: mocks.handleNotificationAccept,
        handleNotificationHide: mocks.handleNotificationHide,
        notificationTable: { data: mocks.notifications },
        get isNotificationsLoading() {
            return mocks.notificationState.isNotificationsLoading;
        },
        refreshNotifications: mocks.refreshNotifications
    })
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
vi.mock('../world', () => ({ useWorldStore: () => ({ cachedWorlds: new Map() }) }));

import { useAiriIntegrationStore } from '../airiIntegration';
import { notifyVrchatRateLimit } from '../../services/vrchatRateLimit';

const ME = 'usr_99999999-9999-4999-8999-999999999999';
const USER_A = 'usr_0f1e2d3c-4b5a-4968-8776-655443322110';

function status(json) {
    return Promise.resolve({ json, params: {} });
}

async function makeStore({ enabled = true, actionsEnabled = true } = {}) {
    mocks.config.set('PAW_airiIntegration_enabled', enabled);
    mocks.config.set('PAW_airiIntegration_actionsEnabled', actionsEnabled);
    const store = useAiriIntegrationStore();
    await vi.waitFor(() => {
        expect(store.actionsEnabled).toBe(actionsEnabled);
    });
    return store;
}

async function call(store, kind, userId = USER_A) {
    return JSON.parse(await store.handleActionRequest(kind, userId));
}

beforeEach(() => {
    setActivePinia(createPinia());
    mocks.config.clear();
    mocks.friends.clear();
    mocks.friendLog.length = 0;
    mocks.cachedUsers.clear();
    mocks.cachedUsers.set(USER_A, { id: USER_A, displayName: 'Alice' });
    mocks.friendRequestKey = '';
    mocks.notifications.length = 0;
    mocks.friendLogCurrent.clear();
    mocks.watchState.isLoggedIn = true;
    mocks.notificationState.isNotificationsLoading = false;
    mocks.groupInvite.rateLimitCooldownUntil = 0;
    mocks.lastLocation = null;
    mocks.rateLimitListeners.clear();
    vi.clearAllMocks();
    mocks.api.getFriendStatus.mockImplementation(() =>
        status({
            isFriend: false,
            outgoingRequest: false,
            incomingRequest: false
        })
    );
    mocks.api.sendFriendRequest.mockResolvedValue({ json: {}, params: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('AIRI actions', () => {
    test('are refused unless both toggles are on', async () => {
        const store = await makeStore({ actionsEnabled: false });
        const res = await call(store, 'friend-request');
        expect(res.status).toBe(403);
        expect(res.body.actionsEnabled).toBe(false);
        expect(mocks.api.sendFriendRequest).not.toHaveBeenCalled();
        expect(JSON.parse(store.getStatusJson()).actionsEnabled).toBe(false);
    });

    test('are refused when the read-only integration is off', async () => {
        const store = await makeStore({ enabled: false });
        expect((await call(store, 'friend-status')).status).toBe(403);
    });

    test('reject invalid user ids and self', async () => {
        const store = await makeStore();
        expect((await call(store, 'friend-request', 'usr_bad')).body).toEqual({
            ok: false,
            error: 'invalid_user_id'
        });
        expect((await call(store, 'friend-request', ME)).body.error).toBe(
            'self_not_allowed'
        );
        expect(mocks.api.getFriendStatus).not.toHaveBeenCalled();
    });

    test('friend-status maps VRChat fields', async () => {
        const store = await makeStore();
        mocks.api.getFriendStatus.mockImplementation(() =>
            status({
                isFriend: false,
                outgoingRequest: true,
                incomingRequest: false
            })
        );
        const res = await call(store, 'friend-status');
        expect(res).toEqual({
            status: 200,
            body: {
                ok: true,
                userId: USER_A,
                displayName: 'Alice',
                isFriend: false,
                outgoingPending: true,
                incomingPending: false
            }
        });
    });

    test('friend-request sends once, then hits the per-user cooldown', async () => {
        const store = await makeStore();
        const first = await call(store, 'friend-request');
        expect(first).toEqual({
            status: 200,
            body: {
                ok: true,
                result: 'sent',
                userId: USER_A,
                displayName: 'Alice'
            }
        });
        expect(mocks.api.sendFriendRequest).toHaveBeenCalledWith({
            userId: USER_A
        });
        expect(mocks.friendLog).toHaveLength(1);
        expect(store.actionLog[0]).toMatchObject({
            kind: 'friend-request',
            userId: USER_A,
            displayName: 'Alice',
            result: 'sent',
            status: 200
        });
        // Saved shortly after (debounced).
        await vi.waitFor(
            () => {
                expect(
                    JSON.parse(
                        mocks.config.get('PAW_airiIntegration_actionHistory') ??
                            '[]'
                    )
                ).toHaveLength(1);
            },
            { timeout: 3000 }
        );

        const second = await call(store, 'friend-request');
        expect(second.status).toBe(429);
        expect(second.body.reason).toBe('user_cooldown');
        expect(mocks.api.sendFriendRequest).toHaveBeenCalledTimes(1);
    });

    test('friend-request skips friends and pending requests', async () => {
        const store = await makeStore();
        mocks.friends.set(USER_A, {});
        expect((await call(store, 'friend-request')).body.result).toBe(
            'already_friends'
        );
        mocks.friends.clear();
        mocks.api.getFriendStatus.mockImplementation(() =>
            status({ isFriend: false, outgoingRequest: true })
        );
        expect((await call(store, 'friend-request')).body.result).toBe(
            'already_pending'
        );
        mocks.api.getFriendStatus.mockImplementation(() =>
            status({ isFriend: false, incomingRequest: true })
        );
        expect((await call(store, 'friend-request')).body.result).toBe(
            'incoming_pending'
        );
        expect(mocks.api.sendFriendRequest).not.toHaveBeenCalled();
    });

    test('friend-accept accepts the pending notification', async () => {
        const store = await makeStore();
        mocks.friendRequestKey = 'not_123';
        mocks.api.acceptFriendRequestNotification.mockResolvedValue({
            json: {},
            params: { notificationId: 'not_123' }
        });
        const res = await call(store, 'friend-accept');
        expect(res.body).toMatchObject({ ok: true, result: 'accepted' });
        expect(mocks.api.acceptFriendRequestNotification).toHaveBeenCalledWith({
            notificationId: 'not_123'
        });
        expect(mocks.handleNotificationAccept).toHaveBeenCalled();
    });

    test('friend-accept without a pending request does nothing', async () => {
        const store = await makeStore();
        const res = await call(store, 'friend-accept');
        expect(res.body).toMatchObject({
            ok: false,
            result: 'no_pending_request'
        });
        expect(mocks.api.sendFriendRequest).not.toHaveBeenCalled();
    });

    test('VRChat errors become 502', async () => {
        const store = await makeStore();
        mocks.api.sendFriendRequest.mockRejectedValue(new Error('boom'));
        const res = await call(store, 'friend-request');
        expect(res.status).toBe(502);
        expect(res.body).toEqual({
            ok: false,
            error: 'vrchat_error',
            message: 'boom'
        });
    });

    test('rate-limit history survives a restart', async () => {
        mocks.config.set(
            'PAW_airiIntegration_actionHistory',
            JSON.stringify([
                {
                    kind: 'friend-request',
                    userId: USER_A,
                    at: Date.now() - 1000
                }
            ])
        );
        const store = await makeStore();
        const res = await call(store, 'friend-request');
        expect(res.status).toBe(429);
        expect(res.body.reason).toBe('user_cooldown');
    });

    test('friend-requests lists incoming requests from notifications', async () => {
        const store = await makeStore();
        const USER_B = 'usr_11111111-2222-4333-8444-555555555555';
        mocks.friends.set(USER_B, {});
        mocks.notifications.push(
            {
                id: 'frq_1',
                type: 'friendRequest',
                senderUserId: USER_A,
                senderUsername: 'Alice',
                created_at: '2026-01-01T10:00:00.000Z'
            },
            {
                id: 'frq_2',
                type: 'friendRequest',
                senderUserId: USER_B,
                senderUsername: 'Bob',
                created_at: '2026-01-02T10:00:00.000Z'
            },
            { id: 'not_3', type: 'invite', senderUserId: USER_A }
        );
        const res = await call(store, 'friend-requests', '');
        expect(res).toEqual({
            status: 200,
            body: {
                ok: true,
                requests: [
                    {
                        userId: USER_A,
                        displayName: 'Alice',
                        createdAt: '2026-01-01T10:00:00.000Z',
                        inLobby: false
                    }
                ],
                pendingTotal: 1,
                stale: false
            }
        });
        expect(mocks.api.getFriendStatus).not.toHaveBeenCalled();
        expect(store.actionLog).toHaveLength(0);
    });

    test('friend-requests needs both toggles and is rate limited', async () => {
        const off = await makeStore({ actionsEnabled: false });
        expect((await call(off, 'friend-requests', '')).status).toBe(403);

        setActivePinia(createPinia());
        mocks.config.set(
            'PAW_airiIntegration_actionHistory',
            JSON.stringify(
                Array.from({ length: 120 }, () => ({
                    kind: 'friend-requests',
                    userId: '',
                    at: Date.now() - 1000
                }))
            )
        );
        const store = await makeStore();
        const res = await call(store, 'friend-requests', '');
        expect(res.status).toBe(429);
        expect(res.body.reason).toBe('hourly_limit');
    });

    test('friend-requests answers from the table without waiting for a refresh', async () => {
        const store = await makeStore();
        mocks.notifications.push({
            id: 'frq_1',
            type: 'friendRequest',
            senderUserId: USER_A,
            senderUsername: 'Alice',
            created_at: '2026-01-01T10:00:00.000Z'
        });
        // A refresh that never finishes must not delay the answer.
        mocks.refreshNotifications.mockImplementation(
            () => new Promise(() => {})
        );
        const first = await call(store, 'friend-requests', '');
        expect(first.body.requests.map((r) => r.userId)).toEqual([USER_A]);
        await call(store, 'friend-requests', '');
        expect(mocks.refreshNotifications).toHaveBeenCalledTimes(1);
    });

    test('friend-requests refreshes in the background only when older than 10 minutes', async () => {
        vi.useFakeTimers();
        try {
            const store = await makeStore();
            mocks.refreshNotifications.mockResolvedValue(undefined);
            await call(store, 'friend-requests', '');
            await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
            await call(store, 'friend-requests', '');
            expect(mocks.refreshNotifications).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
            await call(store, 'friend-requests', '');
            expect(mocks.refreshNotifications).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('friend-requests answers from the last complete list while VRCX refreshes', async () => {
        const store = await makeStore();
        mocks.notifications.push({
            id: 'frq_1',
            type: 'friendRequest',
            senderUserId: USER_A,
            senderUsername: 'Alice',
            created_at: '2026-01-01T10:00:00.000Z'
        });
        expect(
            (await call(store, 'friend-requests', '')).body.pendingTotal
        ).toBe(1);
        // VRCX's refresh removes friend requests until it refetched them.
        mocks.notifications.length = 0;
        mocks.notificationState.isNotificationsLoading = true;
        const during = await call(store, 'friend-requests', '');
        expect(during.body).toMatchObject({ pendingTotal: 1, stale: true });
        expect(during.body.requests[0].userId).toBe(USER_A);
    });

    test('friend-requests: lobby first, then oldest, with pendingTotal beyond 50', async () => {
        const store = await makeStore();
        const ids = Array.from(
            { length: 60 },
            (_, i) =>
                `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        );
        ids.forEach((id, i) =>
            mocks.notifications.push({
                id: `frq_${i}`,
                type: 'friendRequest',
                senderUserId: id,
                senderUsername: `n${i}`,
                created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
            })
        );
        mocks.lastLocation = {
            playerList: new Map([[ids[42], { userId: ids[42] }]])
        };
        const res = await call(store, 'friend-requests', '');
        expect(res.body.pendingTotal).toBe(60);
        expect(res.body.requests).toHaveLength(50);
        expect(res.body.requests[0]).toMatchObject({
            userId: ids[42],
            inLobby: true
        });
        expect(res.body.requests[1].userId).toBe(ids[0]);
        expect(res.body.requests[2].userId).toBe(ids[1]);
    });

    test('friend-accept reports VRChat errors and does not claim success', async () => {
        const store = await makeStore();
        mocks.friendRequestKey = 'not_123';
        mocks.api.acceptFriendRequestNotification.mockRejectedValue(
            new Error('500 internal')
        );
        const res = await call(store, 'friend-accept');
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ ok: false, error: 'vrchat_error' });
        expect(mocks.handleNotificationAccept).not.toHaveBeenCalled();

        mocks.api.getFriendStatus.mockImplementation(() =>
            status({ isFriend: false, incomingRequest: true })
        );
        const after = await call(store, 'friend-status');
        expect(after.body).toMatchObject({
            isFriend: false,
            incomingPending: true
        });
        expect(after.body).not.toHaveProperty('syncing');
    });

    test('friend-accept of an expired request returns no_pending_request', async () => {
        const store = await makeStore();
        mocks.friendRequestKey = 'not_123';
        mocks.api.acceptFriendRequestNotification.mockRejectedValue(
            new Error('404 not found')
        );
        const res = await call(store, 'friend-accept');
        expect(res.body).toMatchObject({
            ok: false,
            result: 'no_pending_request'
        });
        expect(mocks.handleNotificationHide).toHaveBeenCalledWith('not_123');
    });

    test('after a confirmed accept, friend-status covers VRChat lag and VRCX re-syncs', async () => {
        const store = await makeStore();
        vi.useFakeTimers();
        try {
            mocks.friendRequestKey = 'not_123';
            mocks.api.acceptFriendRequestNotification.mockResolvedValue({
                json: {},
                params: { notificationId: 'not_123' }
            });
            expect((await call(store, 'friend-accept')).body.result).toBe(
                'accepted'
            );
            // VRChat still reports the old state for a while.
            mocks.api.getFriendStatus.mockImplementation(() =>
                status({ isFriend: false, incomingRequest: true })
            );
            expect((await call(store, 'friend-status')).body).toMatchObject({
                isFriend: true,
                incomingPending: false,
                syncing: true
            });
            // A second accept is not sent again.
            expect((await call(store, 'friend-accept')).body.result).toBe(
                'already_friends'
            );
            expect(
                mocks.api.acceptFriendRequestNotification
            ).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(15 * 1000);
            expect(mocks.addFriendship).toHaveBeenCalledWith(USER_A);
            mocks.friendLogCurrent.set(USER_A, {});
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
            expect(mocks.addFriendship).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AIRI actions: budgets and VRChat rate limits', () => {
    function vrchat429() {
        const err = new Error('429 Too Many Requests');
        err.status = 429;
        return err;
    }

    test('a VRChat 429 becomes vrchat_rate_limited and pauses everything that calls VRChat', async () => {
        const store = await makeStore();
        mocks.api.sendFriendRequest.mockRejectedValue(vrchat429());
        const res = await call(store, 'friend-request');
        expect(res.status).toBe(429);
        expect(res.body).toEqual({
            ok: false,
            error: 'vrchat_rate_limited',
            retryAfterSec: 60
        });
        // PAW's auto-inviter backs off too.
        expect(mocks.groupInvite.rateLimitCooldownUntil).toBeGreaterThan(
            Date.now() + 55 * 1000
        );
        // Further actions are refused without calling VRChat.
        const again = await call(store, 'friend-status');
        expect(again.status).toBe(429);
        expect(again.body.error).toBe('vrchat_rate_limited');
        expect(mocks.api.getFriendStatus).toHaveBeenCalledTimes(1);
        const status = JSON.parse(store.getStatusJson());
        expect(status.lookups).toMatchObject({
            paused: true,
            pauseReason: 'rate_limited',
            strikes: 1
        });
        expect(status.lookups.lastRateLimitAt).toBeGreaterThan(0);
    });

    test('a 429 anywhere in VRCX pauses AIRI too; more 429s while paused do not escalate', async () => {
        const store = await makeStore();
        notifyVrchatRateLimit('users/usr_x');
        notifyVrchatRateLimit('users/usr_y');
        notifyVrchatRateLimit('users/usr_z');
        const res = await call(store, 'friend-status');
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({
            error: 'vrchat_rate_limited',
            retryAfterSec: 60
        });
        expect(mocks.api.getFriendStatus).not.toHaveBeenCalled();
        expect(mocks.groupInvite.rateLimitCooldownUntil).toBeGreaterThan(
            Date.now() + 55 * 1000
        );
        expect(JSON.parse(store.getStatusJson()).lookups).toMatchObject({
            pauseReason: 'rate_limited',
            strikes: 1
        });
    });

    test('a 429 elsewhere is ignored while the integration is off', async () => {
        await makeStore({ enabled: false });
        notifyVrchatRateLimit('users/usr_x');
        expect(mocks.groupInvite.rateLimitCooldownUntil).toBe(0);
    });

    test('friend-requests skips the background refresh while VRChat rate limits', async () => {
        const store = await makeStore();
        notifyVrchatRateLimit('users/usr_x');
        const res = await call(store, 'friend-requests', '');
        expect(res.status).toBe(200);
        expect(mocks.refreshNotifications).not.toHaveBeenCalled();
    });

    test('friend-requests while VRCX reloads with no complete list yet is 503, not "none"', async () => {
        const store = await makeStore();
        mocks.notificationState.isNotificationsLoading = true;
        const res = await call(store, 'friend-requests', '');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ ok: false, error: 'loading' });
        mocks.notificationState.isNotificationsLoading = false;
        expect((await call(store, 'friend-requests', '')).status).toBe(200);
    });

    test('friend-accept with a loaded notification is one VRChat call (no friend-status)', async () => {
        const store = await makeStore();
        mocks.friendRequestKey = 'not_1';
        mocks.api.acceptFriendRequestNotification.mockResolvedValue({
            json: {},
            params: { notificationId: 'not_1' }
        });
        expect((await call(store, 'friend-accept')).body.result).toBe(
            'accepted'
        );
        expect(mocks.api.getFriendStatus).not.toHaveBeenCalled();
        expect(mocks.api.acceptFriendRequestNotification).toHaveBeenCalledTimes(
            1
        );
    });

    test('the accepts-per-hour setting is applied and saved', async () => {
        mocks.config.set(
            'PAW_airiIntegration_actionHistory',
            JSON.stringify(
                Array.from({ length: 30 }, (_, i) => ({
                    kind: 'friend-accept',
                    userId: `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                    at: Date.now() - 1000
                }))
            )
        );
        mocks.config.set('PAW_airiIntegration_acceptPerHour', '30');
        const store = await makeStore();
        expect(store.acceptPerHour).toBe(30);
        mocks.friendRequestKey = 'not_1';
        mocks.api.acceptFriendRequestNotification.mockResolvedValue({
            json: {},
            params: { notificationId: 'not_1' }
        });
        const limited = await call(store, 'friend-accept');
        expect(limited.status).toBe(429);
        expect(limited.body.reason).toBe('hourly_limit');

        store.setAcceptPerHour(90);
        expect(mocks.config.get('PAW_airiIntegration_acceptPerHour')).toBe(
            '90'
        );
        expect((await call(store, 'friend-accept')).body.result).toBe(
            'accepted'
        );
        const budget = JSON.parse(store.getStatusJson()).friendBudget;
        expect(budget['friend-accept']).toMatchObject({
            usedHour: 31,
            perHour: 90,
            remainingHour: 59
        });
    });

    test('status checks and request lists are not written to the config', async () => {
        const store = await makeStore();
        await call(store, 'friend-status');
        await call(store, 'friend-requests', '');
        await call(store, 'friend-request');
        await vi.waitFor(
            () => {
                const saved = JSON.parse(
                    mocks.config.get('PAW_airiIntegration_actionHistory') ??
                        '[]'
                );
                expect(saved.map((e) => e.kind)).toEqual(['friend-request']);
            },
            { timeout: 3000 }
        );
        // ...but still count in memory.
        const budget = JSON.parse(store.getStatusJson()).friendBudget;
        expect(budget['friend-status'].usedHour).toBe(1);
        expect(budget['friend-requests'].usedHour).toBe(1);
    });

    test('/paw/status exposes lookup and friend budgets', async () => {
        const store = await makeStore();
        const status = JSON.parse(store.getStatusJson());
        expect(status).toMatchObject({
            enabled: true,
            actionsEnabled: true,
            acceptPerHour: 60,
            lookups: {
                queued: 0,
                hourlyCeiling: 600,
                burst: 10,
                intervalMs: 2500,
                paused: false
            }
        });
        expect(Object.keys(status.friendBudget).sort()).toEqual([
            'friend-accept',
            'friend-request',
            'friend-requests',
            'friend-status'
        ]);
    });
});
