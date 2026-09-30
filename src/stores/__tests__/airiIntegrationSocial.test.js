import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    config: new Map(),
    friends: new Map(),
    cachedUsers: new Map(),
    cachedProfiles: new Map(),
    cachedWorlds: new Map(),
    avatarList: new Map(),
    notifications: [],
    currentUser: {},
    watchState: { isLoggedIn: true },
    location: { lastLocation: null, lastLocationDestination: '' },
    groupInvite: { rateLimitCooldownUntil: 0 },
    rateLimitListeners: new Set(),
    handleNotificationHide: vi.fn(),
    api: {
        sendBoop: vi.fn(),
        saveNote: vi.fn(),
        sendInvite: vi.fn(),
        sendInviteResponse: vi.fn(),
        hideNotification: vi.fn(),
        refreshInviteMessageTableData: vi.fn(),
        editInviteMessage: vi.fn(),
        getUser: vi.fn(),
        getMutualCounts: vi.fn(),
        saveCurrentUser: vi.fn(),
        getWorld: vi.fn(),
        getFriendStatus: vi.fn(),
        sendFriendRequest: vi.fn()
    }
}));

vi.mock('../../services/config', () => ({
    default: {
        getBool: vi.fn(async (key, d) => (mocks.config.has(key) ? mocks.config.get(key) : d)),
        setBool: vi.fn(async (key, value) => mocks.config.set(key, value)),
        getString: vi.fn(async (key, d) => (mocks.config.has(key) ? mocks.config.get(key) : d)),
        setString: vi.fn(async (key, value) => mocks.config.set(key, value))
    }
}));
vi.mock('../../services/watchState', () => ({ watchState: mocks.watchState }));
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
vi.mock('../../services/database', () => ({ database: { addFriendLogHistory: vi.fn() } }));
vi.mock('../../services/database/airiUserCache', () => ({
    airiUserCache: {
        initAiriUserCache: vi.fn(async () => {}),
        pruneAiriUserCache: vi.fn(async () => {}),
        loadAiriUserCache: vi.fn(async () => []),
        saveAiriUserCacheEntry: vi.fn(async () => {})
    }
}));
vi.mock('../groupInvite', () => ({ useGroupInviteStore: () => mocks.groupInvite }));
vi.mock('../../api', () => ({
    friendRequest: {
        getFriendStatus: mocks.api.getFriendStatus,
        sendFriendRequest: mocks.api.sendFriendRequest
    },
    notificationRequest: {
        acceptFriendRequestNotification: vi.fn(),
        sendInvite: mocks.api.sendInvite,
        sendInviteResponse: mocks.api.sendInviteResponse,
        hideNotification: mocks.api.hideNotification
    },
    groupRequest: { getRepresentedGroup: vi.fn() },
    userRequest: {
        getUser: mocks.api.getUser,
        getPublicProfile: vi.fn(),
        getMutualCounts: mocks.api.getMutualCounts,
        saveCurrentUser: mocks.api.saveCurrentUser
    },
    miscRequest: { sendBoop: mocks.api.sendBoop, saveNote: mocks.api.saveNote },
    inviteMessagesRequest: {
        refreshInviteMessageTableData: mocks.api.refreshInviteMessageTableData,
        editInviteMessage: mocks.api.editInviteMessage
    },
    worldRequest: { getWorld: mocks.api.getWorld }
}));
vi.mock('../../coordinators/friendRelationshipCoordinator', () => ({
    addFriendship: vi.fn(),
    getFriendRequest: vi.fn(() => ''),
    handleFriendStatus: vi.fn()
}));
vi.mock('../friend', () => ({
    useFriendStore: () => ({
        friends: mocks.friends,
        friendLog: new Map(),
        friendLogTable: { data: [] }
    })
}));
vi.mock('../notification', () => ({
    useNotificationStore: () => ({
        handleNotificationAccept: vi.fn(),
        handleNotificationHide: mocks.handleNotificationHide,
        notificationTable: { data: mocks.notifications },
        isNotificationsLoading: false,
        refreshNotifications: vi.fn()
    })
}));
vi.mock('../user', () => ({
    useUserStore: () => ({
        get currentUser() {
            return mocks.currentUser;
        },
        cachedUsers: mocks.cachedUsers,
        cachedProfiles: mocks.cachedProfiles
    })
}));
vi.mock('../location', () => ({
    useLocationStore: () => ({
        get lastLocation() {
            return mocks.location.lastLocation;
        },
        get lastLocationDestination() {
            return mocks.location.lastLocationDestination;
        }
    })
}));
vi.mock('../gameLog', () => ({
    useGameLogStore: () => ({ state: { lastLocationAvatarList: mocks.avatarList } })
}));
vi.mock('../world', () => ({ useWorldStore: () => ({ cachedWorlds: mocks.cachedWorlds }) }));

import { useAiriIntegrationStore } from '../airiIntegration';
import { notifyVrchatRateLimit } from '../../services/vrchatRateLimit';
import { forwardAiriSocialEvent } from '../../services/airiSocialEvents';

const ME = 'usr_99999999-9999-4999-8999-999999999999';
const USER_A = 'usr_0f1e2d3c-4b5a-4968-8776-655443322110';
const USER_B = 'usr_11111111-2222-4333-8444-555555555555';
const WORLD = 'wrld_4cf554b4-430c-4f8f-b53e-1f294eed230b';
const MY_LOCATION = `${WORLD}:12345~hidden(${ME})~region(eu)`;
const OTHER_LOCATION = `${WORLD}:77777~friends(${USER_B})`;
const NOTIFICATION = 'not_0f1e2d3c-4b5a-4968-8776-655443322110';
const MIN = 60 * 1000;

function rateLimitError() {
    const err = new Error('429 Too Many Requests');
    // @ts-ignore
    err.status = 429;
    return err;
}

function httpError(status) {
    const err = new Error(`${status} error`);
    // @ts-ignore
    err.status = status;
    return err;
}

function slots(overrides = {}) {
    return Array.from({ length: 12 }, (_, slot) => ({
        slot,
        message: `line ${slot}`,
        remainingCooldownMinutes: 0,
        canBeUpdated: true,
        updatedAt: new Date(Date.now() - (20 - slot) * 60 * MIN).toISOString(),
        ...(overrides[slot] ?? {})
    }));
}

async function makeStore({ enabled = true, social = true, dryRun = false, kinds } = {}) {
    mocks.config.set('PAW_airiIntegration_enabled', enabled);
    mocks.config.set('PAW_airiIntegration_socialEnabled', social);
    mocks.config.set('PAW_airiIntegration_socialDryRun', dryRun);
    if (kinds) {
        mocks.config.set('PAW_airiIntegration_socialKinds', JSON.stringify(kinds));
    }
    const store = useAiriIntegrationStore();
    await vi.waitFor(() => {
        expect(store.socialEnabled).toBe(social);
        expect(store.enabled).toBe(enabled);
    });
    return store;
}

async function call(store, kind, payload = {}) {
    return JSON.parse(await store.handleSocialRequest(kind, JSON.stringify(payload)));
}

function vrchatWrites() {
    return (
        mocks.api.sendBoop.mock.calls.length +
        mocks.api.saveNote.mock.calls.length +
        mocks.api.sendInvite.mock.calls.length +
        mocks.api.sendInviteResponse.mock.calls.length +
        mocks.api.editInviteMessage.mock.calls.length +
        mocks.api.saveCurrentUser.mock.calls.length
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    mocks.config.clear();
    mocks.friends.clear();
    mocks.friends.set(USER_A, { id: USER_A });
    mocks.cachedUsers.clear();
    mocks.cachedUsers.set(USER_A, {
        id: USER_A,
        displayName: 'Alice',
        tags: ['system_trust_known'],
        status: 'active',
        ageVerificationStatus: '18+',
        bioLinks: ['a', 'b'],
        note: ''
    });
    mocks.cachedUsers.set(USER_B, { id: USER_B, displayName: 'Bob', tags: [], status: 'active' });
    mocks.cachedProfiles.clear();
    mocks.cachedWorlds.clear();
    mocks.avatarList.clear();
    mocks.notifications.length = 0;
    mocks.currentUser = { id: ME, status: 'active', statusDescription: '', hasSharedConnectionsOptOut: false };
    mocks.watchState.isLoggedIn = true;
    mocks.location.lastLocation = {
        location: MY_LOCATION,
        name: 'The Club',
        playerList: new Map(),
        friendList: new Map()
    };
    mocks.location.lastLocationDestination = '';
    mocks.groupInvite.rateLimitCooldownUntil = 0;
    mocks.rateLimitListeners.clear();
    vi.clearAllMocks();
    mocks.api.sendBoop.mockResolvedValue({ json: {}, params: {} });
    mocks.api.saveNote.mockImplementation(async (params) => ({ json: { note: params.note }, params }));
    mocks.api.sendInvite.mockResolvedValue({ json: {}, params: {} });
    mocks.api.sendInviteResponse.mockResolvedValue({ json: {}, params: {} });
    mocks.api.hideNotification.mockResolvedValue({ json: {}, params: {} });
    mocks.api.refreshInviteMessageTableData.mockImplementation(async (type) => ({
        json: slots(),
        messageType: type
    }));
    mocks.api.editInviteMessage.mockImplementation(async (params, type, slot) => ({
        json: slots({ [slot]: { message: params.message, remainingCooldownMinutes: 60 } }),
        params,
        messageType: type,
        slot
    }));
    mocks.api.getMutualCounts.mockResolvedValue({ json: { friends: 3, groups: 1 } });
    mocks.api.saveCurrentUser.mockResolvedValue({ json: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('auth and toggles', () => {
    test('writes are refused while "Allow AIRI social actions" is off (default)', async () => {
        const store = await makeStore({ social: false });
        for (const kind of ['boop', 'invite', 'inviteRespond', 'status', 'note']) {
            const res = await call(store, kind, { userId: USER_A });
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ socialEnabled: false, error: 'social_disabled' });
        }
        expect(vrchatWrites()).toBe(0);
        expect(JSON.parse(store.getStatusJson()).socialEnabled).toBe(false);
    });

    test('the social toggle is off by default', async () => {
        const store = useAiriIntegrationStore();
        await vi.waitFor(() => expect(mocks.api.sendBoop).not.toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(store.socialEnabled).toBe(false);
        expect(store.socialDryRun).toBe(false);
    });

    test('everything is refused while the integration is off', async () => {
        const store = await makeStore({ enabled: false });
        for (const kind of ['boop', 'events', 'user', 'world']) {
            const res = await call(store, kind, { userId: USER_A });
            expect(res.status).toBe(403);
            expect(res.body.enabled).toBe(false);
        }
    });

    test('reads need only the integration switch', async () => {
        const store = await makeStore({ social: false });
        expect((await call(store, 'events', {})).status).toBe(200);
        expect((await call(store, 'user', { userId: USER_A })).status).toBe(200);
        expect((await call(store, 'world', {})).status).toBe(200);
    });

    test('a per-kind switch turns one action off', async () => {
        const store = await makeStore({ kinds: { boop: false } });
        const res = await call(store, 'boop', { userId: USER_A });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'kind_disabled', kind: 'boop' });
        store.setSocialKindEnabled('boop', true);
        expect((await call(store, 'boop', { userId: USER_A })).body.result).toBe('booped');
    });

    test('invalid payloads and unknown kinds', async () => {
        const store = await makeStore();
        expect(JSON.parse(await store.handleSocialRequest('boop', 'nope'))).toEqual({
            status: 400,
            body: { ok: false, error: 'invalid_body' }
        });
        expect(JSON.parse(await store.handleSocialRequest('boop', '[1]')).status).toBe(400);
        expect((await call(store, 'hug', {})).status).toBe(404);
    });

    test('not logged in', async () => {
        const store = await makeStore();
        mocks.watchState.isLoggedIn = false;
        expect((await call(store, 'boop', { userId: USER_A })).status).toBe(503);
    });

    test('status json exports the social state and budgets', async () => {
        const store = await makeStore();
        await call(store, 'boop', { userId: USER_A, emojiId: 'default_heart' });
        const status = JSON.parse(store.getStatusJson());
        expect(status.socialEnabled).toBe(true);
        expect(status.socialDryRun).toBe(false);
        expect(status.socialKinds).toEqual({ boop: true, invite: true, inviteRespond: true, status: true, note: true });
        expect(status.socialBudget.boop).toMatchObject({ usedHour: 1, perHour: 20 });
        expect(status.socialBudget.invite).toMatchObject({ usedHour: 0, perHour: 10 });
        expect(status.socialBudget.inviteRespond.perHour).toBe(30);
        expect(status.socialBudget.status.perDay).toBe(20);
        expect(status.socialBudget.note.perHour).toBe(60);
        expect(status.socialPause).toEqual({ paused: false, retryAfterSec: 0, strikes: 0 });
    });

    test('settings persist', async () => {
        const store = await makeStore({ social: false });
        store.setSocialEnabled(true);
        store.setSocialDryRun(true);
        store.setSocialKindEnabled('note', false);
        expect(mocks.config.get('PAW_airiIntegration_socialEnabled')).toBe(true);
        expect(mocks.config.get('PAW_airiIntegration_socialDryRun')).toBe(true);
        expect(JSON.parse(mocks.config.get('PAW_airiIntegration_socialKinds')).note).toBe(false);
    });
});

describe('POST /paw/boop', () => {
    test('boops a friend with the emoji and logs it', async () => {
        const store = await makeStore();
        const res = await call(store, 'boop', { userId: USER_A, emojiId: 'default_hand_wave' });
        expect(res).toEqual({ status: 200, body: { ok: true, result: 'booped' } });
        expect(mocks.api.sendBoop).toHaveBeenCalledWith(
            { userId: USER_A, emojiId: 'default_hand_wave' },
            { silentErrors: true }
        );
        expect(store.actionLog[0]).toMatchObject({
            kind: 'social:boop',
            userId: USER_A,
            displayName: 'Alice',
            result: 'booped',
            status: 200
        });
    });

    test('validates ids and emojis', async () => {
        const store = await makeStore();
        expect((await call(store, 'boop', { userId: 'usr_bad' })).body.error).toBe('invalid_user_id');
        expect((await call(store, 'boop', { userId: ME })).body.error).toBe('self_not_allowed');
        expect((await call(store, 'boop', { userId: USER_A, emojiId: 'file_x' })).body.error).toBe('invalid_emoji');
        expect(mocks.api.sendBoop).not.toHaveBeenCalled();
    });

    test('friends only, never troll-tagged or busy users', async () => {
        const store = await makeStore();
        expect((await call(store, 'boop', { userId: USER_B })).body.result).toBe('not_friends');
        mocks.friends.set(USER_B, {});
        mocks.cachedUsers.get(USER_B).tags = ['system_probable_troll'];
        expect((await call(store, 'boop', { userId: USER_B })).body.result).toBe('target_blocked');
        mocks.cachedUsers.get(USER_B).tags = ['system_troll'];
        expect((await call(store, 'boop', { userId: USER_B })).body.result).toBe('target_blocked');
        mocks.cachedUsers.get(USER_B).tags = [];
        mocks.cachedUsers.get(USER_B).status = 'busy';
        expect((await call(store, 'boop', { userId: USER_B })).body.result).toBe('target_busy');
        expect(mocks.api.sendBoop).not.toHaveBeenCalled();
    });

    test('flirty emojis need a verified 18+ target', async () => {
        const store = await makeStore();
        mocks.friends.set(USER_B, {});
        mocks.api.getUser.mockImplementation(async () => {
            mocks.cachedUsers.get(USER_B).ageVerificationStatus = 'hidden';
            return { json: {} };
        });
        const res = await call(store, 'boop', { userId: USER_B, emojiId: 'default_kiss' });
        expect(res.body).toMatchObject({ ok: false, result: 'age_gate', ageVerificationStatus: 'hidden' });
        expect(mocks.api.getUser).toHaveBeenCalledTimes(1);
        expect((await call(store, 'boop', { userId: USER_A, emojiId: 'default_kiss' })).body.result).toBe(
            'booped'
        );
        // Non-flirty emojis are fine for everyone.
        expect((await call(store, 'boop', { userId: USER_B, emojiId: 'default_hand_wave' })).body.result).toBe(
            'booped'
        );
    });

    test('one boop per person per 30 minutes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const store = await makeStore();
        await call(store, 'boop', { userId: USER_A });
        const res = await call(store, 'boop', { userId: USER_A });
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({
            ok: false,
            result: 'rate_limited',
            reason: 'user_cooldown',
            scope: 'local',
            retryAfterSec: 30 * 60
        });
        vi.setSystemTime(Date.now() + 30 * MIN + 1000);
        expect((await call(store, 'boop', { userId: USER_A })).body.result).toBe('booped');
    });

    test('at most 20 boops per hour', async () => {
        const store = await makeStore();
        for (let i = 0; i < 20; i++) {
            const id = `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
            mocks.friends.set(id, {});
            expect((await call(store, 'boop', { userId: id })).body.result).toBe('booped');
        }
        const res = await call(store, 'boop', { userId: USER_A });
        expect(res.body.reason).toBe('hourly_limit');
        expect(mocks.api.sendBoop).toHaveBeenCalledTimes(20);
    });

    test('a refused boop is not retried for a day', async () => {
        const store = await makeStore();
        mocks.api.sendBoop.mockRejectedValueOnce(httpError(403));
        expect((await call(store, 'boop', { userId: USER_A })).body).toMatchObject({
            ok: false,
            result: 'not_friends',
            vrchatStatus: 403
        });
        expect((await call(store, 'boop', { userId: USER_A })).body.result).toBe('boop_unavailable');
        expect(mocks.api.sendBoop).toHaveBeenCalledTimes(1);
    });

    test('other VRChat errors answer 502', async () => {
        const store = await makeStore();
        mocks.api.sendBoop.mockRejectedValueOnce(httpError(500));
        expect((await call(store, 'boop', { userId: USER_A })).status).toBe(502);
    });
});

describe('VRChat 429: shared backoff', () => {
    test('a 429 pauses every social write, escalating 1 min, 10 min, 1 h', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const store = await makeStore();
        mocks.friends.set(USER_B, {});
        mocks.api.sendBoop.mockRejectedValueOnce(rateLimitError());
        const first = await call(store, 'boop', { userId: USER_A });
        expect(first.status).toBe(429);
        expect(first.body).toMatchObject({ result: 'rate_limited', reason: 'vrchat_rate_limited', scope: 'vrchat' });
        expect(first.body.retryAfterSec).toBeGreaterThanOrEqual(60);
        // Everything else stops too, without calling VRChat.
        const note = await call(store, 'note', { userId: USER_B, note: 'hi' });
        expect(note.status).toBe(429);
        expect(mocks.api.saveNote).not.toHaveBeenCalled();
        expect(store.getSocialPause()).toMatchObject({ paused: true, strikes: 1 });

        vi.setSystemTime(Date.now() + 61 * 1000);
        mocks.api.saveNote.mockRejectedValueOnce(rateLimitError());
        await call(store, 'note', { userId: USER_B, note: 'hi' });
        expect(store.getSocialPause().strikes).toBe(2);
        expect(store.getSocialPause().retryAfterSec).toBeGreaterThanOrEqual(10 * 60 - 1);

        vi.setSystemTime(Date.now() + 10 * MIN + 1000);
        mocks.api.saveNote.mockRejectedValueOnce(rateLimitError());
        await call(store, 'note', { userId: USER_B, note: 'hi' });
        expect(store.getSocialPause().strikes).toBe(3);
        expect(store.getSocialPause().retryAfterSec).toBeGreaterThanOrEqual(60 * 60 - 1);
    });

    test('a 429 anywhere in VRCX pauses social writes', async () => {
        const store = await makeStore();
        notifyVrchatRateLimit('users/x');
        const res = await call(store, 'boop', { userId: USER_A });
        expect(res.status).toBe(429);
        expect(res.body.scope).toBe('vrchat');
        expect(mocks.api.sendBoop).not.toHaveBeenCalled();
        expect(JSON.parse(store.getStatusJson()).socialPause.paused).toBe(true);
    });

    test('the auto-inviter cooldown pauses social writes too', async () => {
        const store = await makeStore();
        mocks.api.sendBoop.mockRejectedValueOnce(rateLimitError());
        await call(store, 'boop', { userId: USER_A });
        // The lookup queue shares its pause with the auto-inviter.
        expect(mocks.groupInvite.rateLimitCooldownUntil).toBeGreaterThan(Date.now());
    });
});

describe('dry run', () => {
    test('checks and logs but never calls VRChat', async () => {
        const store = await makeStore({ dryRun: true });
        mocks.notifications.push({ id: NOTIFICATION, type: 'invite', senderUserId: USER_A });
        const results = [
            await call(store, 'boop', { userId: USER_A, emojiId: 'default_heart' }),
            await call(store, 'invite', { userId: USER_A, message: 'hiii Alice' }),
            await call(store, 'inviteRespond', { notificationId: NOTIFICATION, message: 'omw!' }),
            await call(store, 'status', { status: 'join me', statusDescription: 'at the club' }),
            await call(store, 'note', { userId: USER_A, note: 'likes techno' })
        ];
        expect(results.map((r) => r.body.result)).toEqual(['dry_run', 'dry_run', 'dry_run', 'dry_run', 'dry_run']);
        expect(results.map((r) => r.body.wouldBe)).toEqual(['booped', 'invited', 'responded', 'updated', 'saved']);
        expect(vrchatWrites()).toBe(0);
        expect(mocks.api.refreshInviteMessageTableData).not.toHaveBeenCalled();
        expect(store.actionLog).toHaveLength(5);
        // Nothing counted against the budget.
        expect(store.getSocialBudget().boop.usedHour).toBe(0);
        // Guards still apply in dry run.
        expect((await call(store, 'boop', { userId: USER_B })).body.result).toBe('not_friends');
    });
});

describe('POST /paw/invite', () => {
    test('invites a friend to her current instance', async () => {
        const store = await makeStore();
        const res = await call(store, 'invite', { userId: USER_A });
        expect(res.body).toEqual({ ok: true, result: 'invited', worldName: 'The Club', messageApplied: false });
        expect(mocks.api.sendInvite).toHaveBeenCalledWith(
            { instanceId: MY_LOCATION, worldId: MY_LOCATION, worldName: 'The Club' },
            USER_A,
            { silentErrors: true }
        );
        expect(mocks.api.editInviteMessage).not.toHaveBeenCalled();
    });

    test('uses the given slot as is', async () => {
        const store = await makeStore();
        const res = await call(store, 'invite', { userId: USER_A, messageSlot: 2 });
        expect(res.body.messageSlot).toBe(2);
        expect(mocks.api.sendInvite.mock.calls[0][0].messageSlot).toBe(2);
    });

    test('personalized text goes into a free slot first', async () => {
        const store = await makeStore();
        const res = await call(store, 'invite', { userId: USER_A, message: 'hiii Alice, you owe me a dance' });
        expect(res.body).toMatchObject({ ok: true, result: 'invited', messageApplied: true, messageSlot: 4 });
        expect(mocks.api.editInviteMessage).toHaveBeenCalledWith(
            { message: 'hiii Alice, you owe me a dance' },
            'message',
            4,
            { silentErrors: true }
        );
        expect(mocks.api.sendInvite.mock.calls[0][0].messageSlot).toBe(4);
    });

    test('text that is already in a slot is reused without an edit', async () => {
        const store = await makeStore();
        const res = await call(store, 'invite', { userId: USER_A, message: 'line 7' });
        expect(res.body).toMatchObject({ messageApplied: true, messageSlot: 7 });
        expect(mocks.api.editInviteMessage).not.toHaveBeenCalled();
    });

    test('slot on cooldown: another free slot', async () => {
        const store = await makeStore();
        mocks.api.refreshInviteMessageTableData.mockResolvedValue({
            json: slots({ 3: { remainingCooldownMinutes: 50 } })
        });
        const res = await call(store, 'invite', { userId: USER_A, messageSlot: 3, message: 'hey you' });
        expect(res.body).toMatchObject({ messageApplied: true, messageSlot: 4 });
    });

    test('every slot cooling down: the requested slot stored text, or slot_cooldown', async () => {
        const store = await makeStore();
        mocks.friends.set(USER_B, {});
        const cooling = Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [i, { remainingCooldownMinutes: 45 }])
        );
        mocks.api.refreshInviteMessageTableData.mockResolvedValue({ json: slots(cooling) });
        const withSlot = await call(store, 'invite', { userId: USER_A, messageSlot: 1, message: 'hey you' });
        expect(withSlot.body).toMatchObject({
            ok: true,
            result: 'invited',
            messageSlot: 1,
            messageApplied: false,
            messageSkipped: 'slot_cooldown'
        });
        const without = await call(store, 'invite', { userId: USER_B, message: 'hey you' });
        expect(without.body).toMatchObject({ ok: false, result: 'slot_cooldown' });
        expect(without.body.retryAfterSec).toBeGreaterThan(0);
        expect(mocks.api.sendInvite).toHaveBeenCalledTimes(1);
        expect(mocks.api.editInviteMessage).not.toHaveBeenCalled();
    });

    test('slot edits are paced to one per 10 minutes', async () => {
        const store = await makeStore();
        mocks.friends.set(USER_B, {});
        await call(store, 'invite', { userId: USER_A, message: 'hey Alice' });
        const res = await call(store, 'invite', { userId: USER_B, message: 'hey Bob' });
        expect(res.body).toMatchObject({ ok: false, result: 'slot_cooldown' });
        expect(mocks.api.editInviteMessage).toHaveBeenCalledTimes(1);
    });

    test('not in an instance', async () => {
        const store = await makeStore();
        mocks.location.lastLocation = { location: 'offline', name: '' };
        expect((await call(store, 'invite', { userId: USER_A })).body.result).toBe('not_in_instance');
        mocks.location.lastLocation = { location: 'traveling', name: '' };
        mocks.location.lastLocationDestination = MY_LOCATION;
        mocks.cachedWorlds.set(WORLD, { name: 'Club (cached)' });
        expect((await call(store, 'invite', { userId: USER_A })).body).toMatchObject({
            result: 'invited',
            worldName: 'Club (cached)'
        });
    });

    test('guards, validation and per-person pacing', async () => {
        const store = await makeStore();
        expect((await call(store, 'invite', { userId: USER_B })).body.result).toBe('not_friends');
        expect((await call(store, 'invite', { userId: USER_A, messageSlot: 12 })).body.error).toBe(
            'invalid_message_slot'
        );
        expect((await call(store, 'invite', { userId: USER_A, message: 'x'.repeat(65) })).body.error).toBe(
            'invalid_message'
        );
        expect((await call(store, 'invite', { userId: USER_A })).body.result).toBe('invited');
        const again = await call(store, 'invite', { userId: USER_A });
        expect(again.status).toBe(429);
        expect(again.body.reason).toBe('user_cooldown');
    });

    test('at most 10 invites per hour', async () => {
        const store = await makeStore();
        for (let i = 0; i < 10; i++) {
            const id = `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
            mocks.friends.set(id, {});
            expect((await call(store, 'invite', { userId: id })).body.result).toBe('invited');
        }
        expect((await call(store, 'invite', { userId: USER_A })).body.reason).toBe('hourly_limit');
    });

    test('flirty invites need 18+', async () => {
        const store = await makeStore();
        mocks.friends.set(USER_B, {});
        mocks.cachedUsers.get(USER_B).ageVerificationStatus = 'hidden';
        expect((await call(store, 'invite', { userId: USER_B, flirty: true })).body.result).toBe('age_gate');
        expect((await call(store, 'invite', { userId: USER_A, flirty: true })).body.result).toBe('invited');
    });
});

describe('POST /paw/invite-respond', () => {
    beforeEach(() => {
        mocks.notifications.push({ id: NOTIFICATION, type: 'invite', senderUserId: USER_A, senderUsername: 'Alice' });
    });

    test('answers an invite once, with a response slot, and hides it', async () => {
        const store = await makeStore();
        const res = await call(store, 'inviteRespond', { notificationId: NOTIFICATION, responseSlot: 2 });
        expect(res.body).toMatchObject({ ok: true, result: 'responded', responseSlot: 2, userId: USER_A });
        expect(mocks.api.sendInviteResponse).toHaveBeenCalledWith({ responseSlot: 2, rsvp: true }, NOTIFICATION, {
            silentErrors: true
        });
        await vi.waitFor(() => expect(mocks.handleNotificationHide).toHaveBeenCalledWith(NOTIFICATION));
        expect((await call(store, 'inviteRespond', { notificationId: NOTIFICATION })).body.result).toBe(
            'already_responded'
        );
        expect(mocks.api.sendInviteResponse).toHaveBeenCalledTimes(1);
        expect(store.actionLog[0].userId).toBe(USER_A);
    });

    test('custom text goes into a response slot (requestResponse for invite requests)', async () => {
        const store = await makeStore();
        await call(store, 'inviteRespond', { notificationId: NOTIFICATION, message: 'busy dancing, later!' });
        expect(mocks.api.editInviteMessage.mock.calls[0][1]).toBe('response');
        mocks.notifications.length = 0;
        const request = 'not_11111111-2222-4333-8444-555555555555';
        mocks.notifications.push({ id: request, type: 'requestInvite', senderUserId: USER_A });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 11 * MIN);
        await call(store, 'inviteRespond', { notificationId: request, message: 'not right now!' });
        expect(mocks.api.refreshInviteMessageTableData).toHaveBeenCalledWith('requestResponse', {
            silentErrors: true
        });
        expect(mocks.api.editInviteMessage.mock.calls[1][1]).toBe('requestResponse');
    });

    test('VRChat "can only reply once" maps to already_responded', async () => {
        const store = await makeStore();
        mocks.api.sendInviteResponse.mockRejectedValueOnce(httpError(400));
        expect((await call(store, 'inviteRespond', { notificationId: NOTIFICATION })).body.result).toBe(
            'already_responded'
        );
    });

    test('unknown notifications, bad ids, trolls', async () => {
        const store = await makeStore();
        expect(
            (await call(store, 'inviteRespond', { notificationId: 'not_11111111-2222-4333-8444-555555555555' })).body
                .result
        ).toBe('not_found');
        expect((await call(store, 'inviteRespond', { notificationId: 'nope' })).body.error).toBe(
            'invalid_notification_id'
        );
        mocks.cachedUsers.get(USER_A).tags = ['system_troll'];
        expect((await call(store, 'inviteRespond', { notificationId: NOTIFICATION })).body.result).toBe(
            'target_blocked'
        );
        expect(mocks.api.sendInviteResponse).not.toHaveBeenCalled();
    });

    test('at most 30 replies per hour', async () => {
        const store = await makeStore();
        mocks.notifications.length = 0;
        for (let i = 0; i < 31; i++) {
            mocks.notifications.push({
                id: `not_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                type: 'invite',
                senderUserId: USER_A
            });
        }
        for (let i = 0; i < 30; i++) {
            const res = await call(store, 'inviteRespond', { notificationId: mocks.notifications[i].id });
            expect(res.body.result).toBe('responded');
        }
        const res = await call(store, 'inviteRespond', { notificationId: mocks.notifications[30].id });
        expect(res.status).toBe(429);
        expect(res.body.reason).toBe('hourly_limit');
    });
});

describe('POST /paw/self/status', () => {
    test('updates status and line, then at least 20 minutes apart', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const store = await makeStore();
        const res = await call(store, 'status', { status: 'join me', statusDescription: 'at the club, come say hi' });
        expect(res.body.result).toBe('updated');
        expect(new Date(res.body.nextAllowedAt).getTime() - Date.now()).toBe(20 * MIN);
        expect(mocks.api.saveCurrentUser).toHaveBeenCalledWith({
            status: 'join me',
            statusDescription: 'at the club, come say hi'
        });
        mocks.currentUser.status = 'join me';
        mocks.currentUser.statusDescription = 'at the club, come say hi';
        const soon = await call(store, 'status', { statusDescription: 'brain empty' });
        expect(soon.status).toBe(429);
        expect(soon.body).toMatchObject({ result: 'too_soon', retryAfterSec: 20 * 60 });
        expect(soon.body.nextAllowedAt).toBeTruthy();
        vi.setSystemTime(Date.now() + 20 * MIN);
        expect((await call(store, 'status', { statusDescription: 'brain empty' })).body.result).toBe('updated');
        expect(mocks.api.saveCurrentUser).toHaveBeenLastCalledWith({ statusDescription: 'brain empty' });
    });

    test('unchanged values cost nothing', async () => {
        const store = await makeStore();
        const res = await call(store, 'status', { status: 'active', statusDescription: '' });
        expect(res.body).toMatchObject({ ok: true, result: 'unchanged' });
        expect(mocks.api.saveCurrentUser).not.toHaveBeenCalled();
    });

    test('validation', async () => {
        const store = await makeStore();
        expect((await call(store, 'status', { status: 'offline' })).body.error).toBe('invalid_status');
        expect((await call(store, 'status', { statusDescription: 'x'.repeat(33) })).body.error).toBe(
            'invalid_status_description'
        );
        expect((await call(store, 'status', {})).body.error).toBe('nothing_to_update');
    });

    test('at most 20 changes per day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const store = await makeStore();
        for (let i = 0; i < 20; i++) {
            expect((await call(store, 'status', { statusDescription: `line ${i}` })).body.result).toBe('updated');
            vi.setSystemTime(Date.now() + 21 * MIN);
        }
        const res = await call(store, 'status', { statusDescription: 'one more' });
        expect(res.body).toMatchObject({ result: 'rate_limited', reason: 'daily_limit' });
    });
});

describe('POST /paw/note', () => {
    test('saves a private note (any user, not only friends)', async () => {
        const store = await makeStore();
        const res = await call(store, 'note', { userId: USER_B, note: 'likes techno, calls me gremlin' });
        expect(res.body).toEqual({ ok: true, result: 'saved' });
        expect(mocks.api.saveNote).toHaveBeenCalledWith(
            { targetUserId: USER_B, note: 'likes techno, calls me gremlin' },
            { silentErrors: true }
        );
        expect(mocks.cachedUsers.get(USER_B).note).toBe('likes techno, calls me gremlin');
        expect((await call(store, 'note', { userId: USER_B, note: 'likes techno, calls me gremlin' })).body.result).toBe(
            'unchanged'
        );
    });

    test('validation and hourly limit', async () => {
        const store = await makeStore();
        expect((await call(store, 'note', { userId: USER_A })).body.error).toBe('invalid_note');
        expect((await call(store, 'note', { userId: USER_A, note: 'x'.repeat(257) })).body.error).toBe(
            'invalid_note'
        );
        for (let i = 0; i < 60; i++) {
            expect((await call(store, 'note', { userId: USER_A, note: `n${i}` })).body.result).toBe('saved');
        }
        expect((await call(store, 'note', { userId: USER_A, note: 'n60' })).body.reason).toBe('hourly_limit');
    });
});

describe('GET /paw/events', () => {
    test('websocket messages become events, read with a cursor', async () => {
        const store = await makeStore({ social: false });
        forwardAiriSocialEvent('notification-v2', {
            id: NOTIFICATION,
            type: 'boop',
            senderUserId: USER_A,
            details: { emojiId: 'default_heart' }
        });
        forwardAiriSocialEvent('friend-location', {
            userId: USER_A,
            location: 'traveling',
            travelingToLocation: MY_LOCATION,
            user: { displayName: 'Alice' }
        });
        // Repeats of the same place are dropped.
        forwardAiriSocialEvent('friend-location', {
            userId: USER_A,
            location: MY_LOCATION,
            user: { displayName: 'Alice' }
        });
        forwardAiriSocialEvent('friend-location', { userId: USER_B, location: OTHER_LOCATION });
        forwardAiriSocialEvent('friend-update', { userId: USER_A });
        const all = await call(store, 'events', { after: '0' });
        expect(all.body.seq).toBe(3);
        expect(all.body.events.map((e) => [e.seq, e.type, e.location ?? e.emojiId])).toEqual([
            [1, 'boop', 'default_heart'],
            [2, 'friend-location', 'same-instance'],
            [3, 'friend-location', 'other']
        ]);
        expect(JSON.stringify(all.body)).not.toContain('77777');
        const after = await call(store, 'events', { after: '2' });
        expect(after.body.events.map((e) => e.seq)).toEqual([3]);
        expect(store.recentSocialEvents()[0].seq).toBe(3);
    });

    test('nothing is recorded while the integration is off', async () => {
        const store = await makeStore({ enabled: false });
        forwardAiriSocialEvent('friend-online', { userId: USER_A, location: OTHER_LOCATION });
        expect(store.recentSocialEvents()).toEqual([]);
    });
});

describe('GET /paw/user', () => {
    test('public, safe fields only', async () => {
        const store = await makeStore({ social: false });
        mocks.avatarList.set('Alice', 'Rusk base');
        const res = await call(store, 'user', { userId: USER_A });
        expect(res.body).toEqual({
            ok: true,
            user: {
                userId: USER_A,
                displayName: 'Alice',
                isFriend: true,
                ageVerificationStatus: '18+',
                tags: { troll: false, probableTroll: false },
                mutualFriendsCount: 3,
                mutualGroupsCount: 1,
                avatarName: 'Rusk base',
                bioLinksCount: 2
            }
        });
        // Mutual counts are cached for a day.
        await call(store, 'user', { userId: USER_A });
        expect(mocks.api.getMutualCounts).toHaveBeenCalledTimes(1);
    });

    test('fetches the user once when VRCX lacks age/tags; skips mutuals when opted out', async () => {
        const store = await makeStore({ social: false });
        mocks.currentUser.hasSharedConnectionsOptOut = true;
        mocks.cachedUsers.delete(USER_B);
        mocks.api.getUser.mockImplementation(async () => {
            mocks.cachedUsers.set(USER_B, {
                id: USER_B,
                displayName: 'Bob',
                tags: ['system_probable_troll'],
                ageVerificationStatus: 'hidden'
            });
            return { json: {} };
        });
        const res = await call(store, 'user', { userId: USER_B });
        expect(res.body.user).toMatchObject({
            displayName: 'Bob',
            isFriend: false,
            ageVerificationStatus: 'hidden',
            tags: { troll: false, probableTroll: true }
        });
        expect(res.body.user).not.toHaveProperty('mutualFriendsCount');
        expect(mocks.api.getMutualCounts).not.toHaveBeenCalled();
        await call(store, 'user', { userId: USER_B });
        expect(mocks.api.getUser).toHaveBeenCalledTimes(1);
    });

    test('validation', async () => {
        const store = await makeStore();
        expect((await call(store, 'user', { userId: 'x' })).status).toBe(400);
        expect((await call(store, 'user', { userId: ME })).body.error).toBe('self_not_allowed');
    });
});

describe('GET /paw/world', () => {
    test('her current world, sanitized', async () => {
        const store = await makeStore({ social: false });
        mocks.api.getWorld.mockResolvedValue({
            json: {
                name: 'The Club',
                authorName: 'Someone',
                visits: 3000000,
                favorites: 12000,
                capacity: 40,
                tags: ['author_tag_dance', 'system_approved', 'author_tag_club'],
                description: 'Best club! join discord.gg/abc or mail me@x.com'
            }
        });
        const res = await call(store, 'world', {});
        expect(res.body).toEqual({
            ok: true,
            world: {
                name: 'The Club',
                authorName: 'Someone',
                visits: 3000000,
                favorites: 12000,
                capacity: 40,
                tags: ['dance', 'club'],
                description: 'Best club! join or mail'
            }
        });
        await call(store, 'world', {});
        expect(mocks.api.getWorld).toHaveBeenCalledTimes(1);
    });

    test('uses VRCX cached world data first; not in an instance', async () => {
        const store = await makeStore({ social: false });
        mocks.cachedWorlds.set(WORLD, { name: 'Cached Club', description: 'hi', tags: [] });
        expect((await call(store, 'world', {})).body.world.name).toBe('Cached Club');
        expect(mocks.api.getWorld).not.toHaveBeenCalled();
        mocks.location.lastLocation = { location: 'offline', name: '' };
        expect((await call(store, 'world', {})).body.result).toBe('not_in_instance');
    });
});
