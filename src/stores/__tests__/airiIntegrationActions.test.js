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
    notifications: []
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
vi.mock('../../api', () => ({
    friendRequest: {
        getFriendStatus: mocks.api.getFriendStatus,
        sendFriendRequest: mocks.api.sendFriendRequest
    },
    notificationRequest: {
        acceptFriendRequestNotification:
            mocks.api.acceptFriendRequestNotification
    },
    queryRequest: { fetch: vi.fn() },
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
        isNotificationsLoading: false,
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
    useLocationStore: () => ({ lastLocation: null })
}));
vi.mock('../gameLog', () => ({ useGameLogStore: () => ({ state: {} }) }));

import { useAiriIntegrationStore } from '../airiIntegration';

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
        expect(
            JSON.parse(mocks.config.get('PAW_airiIntegration_actionHistory'))
        ).toHaveLength(1);

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
                        createdAt: '2026-01-01T10:00:00.000Z'
                    }
                ]
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

    test('friend-requests refreshes notifications at most once a minute', async () => {
        const store = await makeStore();
        mocks.refreshNotifications.mockImplementation(async () => {
            mocks.notifications.push({
                id: 'frq_1',
                type: 'friendRequest',
                senderUserId: USER_A,
                senderUsername: 'Alice',
                created_at: '2026-01-01T10:00:00.000Z'
            });
        });
        const first = await call(store, 'friend-requests', '');
        expect(first.body.requests.map((r) => r.userId)).toEqual([USER_A]);
        await call(store, 'friend-requests', '');
        expect(mocks.refreshNotifications).toHaveBeenCalledTimes(1);
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
