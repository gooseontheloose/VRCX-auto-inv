import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import {
    AIRI_ACTION_KINDS,
    buildIncomingFriendRequests,
    buildPlayersPayload,
    checkActionRateLimit,
    isValidAiriUserId,
    pruneActionHistory
} from '../shared/utils/airiIntegration';
import {
    friendRequest,
    notificationRequest,
    queryRequest,
    userRequest
} from '../api';
import {
    addFriendship,
    getFriendRequest,
    handleFriendStatus
} from '../coordinators/friendRelationshipCoordinator';
import { database } from '../services/database';
import { useFriendStore } from './friend';
import { useGameLogStore } from './gameLog';
import { useLocationStore } from './location';
import { useNotificationStore } from './notification';
import { useUserStore } from './user';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';

/** Minimum gap between two represented-group API calls. */
const GROUP_FETCH_INTERVAL_MS = 3000;
/** Hard cap of represented-group API calls per app session. */
const GROUP_FETCH_SESSION_CAP = 100;
/** Minimum gap between two full-profile (bio) API calls. */
const PROFILE_FETCH_INTERVAL_MS = 3000;
/** Hard cap of full-profile API calls per app session. */
const PROFILE_FETCH_SESSION_CAP = 150;

const CONFIG_KEYS = {
    enabled: 'PAW_airiIntegration_enabled',
    shareBios: 'PAW_airiIntegration_shareBios',
    fetchGroups: 'PAW_airiIntegration_fetchGroups',
    actionsEnabled: 'PAW_airiIntegration_actionsEnabled',
    actionHistory: 'PAW_airiIntegration_actionHistory'
};

/** Entries kept in the "recent AIRI actions" list. */
const ACTION_LOG_MAX = 25;

/**
 * After a successful accept, VRChat's friend status can lag for a minute or
 * two. For this long friend-status reports the accepted user as a friend.
 */
const ACCEPT_SYNC_WINDOW_MS = 10 * 60 * 1000;
/**
 * VRCX's own addFriendship() checks the friend status once, right after the
 * accept, and VRChat usually still says "not friends" then, so the friend
 * list / friend log entry is missed. Re-run it after these delays.
 */
const ACCEPT_FOLLOW_UP_DELAYS_MS = [15 * 1000, 45 * 1000, 2 * 60 * 1000];
/** GET /paw/friend-requests refreshes VRCX's notifications at most this often. */
const NOTIFICATION_REFRESH_INTERVAL_MS = 60 * 1000;
/** Max wait for a notification refresh VRCX is already running. */
const NOTIFICATION_REFRESH_WAIT_MS = 20 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Local AIRI companion integration.
 * The C# overlay server calls `window.$pinia.airiIntegration.getPlayersJson()`
 * to answer GET http://127.0.0.1:34582/paw/players.
 */
export const useAiriIntegrationStore = defineStore('AiriIntegration', () => {
    const locationStore = useLocationStore();
    const userStore = useUserStore();
    const gameLogStore = useGameLogStore();

    // ── Persisted settings ─────────────────────────────────────
    const enabled = ref(false);
    const shareBios = ref(true);
    const fetchGroups = ref(false);
    const actionsEnabled = ref(false);

    // ── Actions (friend requests) ──────────────────────────────
    /** Persisted rate-limit history: {kind, userId, at}[] (last 24 h). */
    let actionHistory = [];
    /** Recent actions shown on the AIRI Integration page (newest first). */
    const actionLog = ref([]);
    /** Serializes actions so rate-limit checks and records never race. */
    let actionChain = Promise.resolve();
    /** userId -> time of an accept VRChat confirmed (in memory). */
    const recentAccepts = new Map();
    let lastNotificationRefreshAt = 0;

    /**
     * After a confirmed accept, re-run VRCX's own addFriendship() a few times
     * until VRChat reports the friendship (it adds the friend and writes the
     * "Friend" friend-log entry).
     * @param {string} userId
     */
    function scheduleAcceptFollowUp(userId) {
        let attempt = 0;
        const step = async () => {
            const friendLog = useFriendStore().friendLog;
            if (!watchState.isLoggedIn || friendLog?.has(userId)) {
                return;
            }
            try {
                if (!userStore.cachedUsers.has(userId)) {
                    await userRequest.getUser({ userId });
                }
                addFriendship(userId);
            } catch (err) {
                console.warn('[AiriIntegration] accept follow-up failed', err);
            }
            if (attempt < ACCEPT_FOLLOW_UP_DELAYS_MS.length) {
                setTimeout(step, ACCEPT_FOLLOW_UP_DELAYS_MS[attempt++]);
            }
        };
        setTimeout(step, ACCEPT_FOLLOW_UP_DELAYS_MS[attempt++]);
    }

    function markAccepted(userId) {
        recentAccepts.set(userId, Date.now());
        scheduleAcceptFollowUp(userId);
    }

    /**
     * Refresh notifications from VRChat with VRCX's own refresh (the same
     * as the Notifications page refresh button), at most once a minute.
     * Waits for a refresh VRCX is already running, because that one clears
     * the friend requests before refetching them.
     */
    async function refreshNotificationsThrottled() {
        const notificationStore = useNotificationStore();
        const now = Date.now();
        if (
            !notificationStore.isNotificationsLoading &&
            now - lastNotificationRefreshAt >=
                NOTIFICATION_REFRESH_INTERVAL_MS &&
            typeof notificationStore.refreshNotifications === 'function'
        ) {
            lastNotificationRefreshAt = now;
            await notificationStore.refreshNotifications();
        }
        const deadline = Date.now() + NOTIFICATION_REFRESH_WAIT_MS;
        while (
            notificationStore.isNotificationsLoading &&
            Date.now() < deadline
        ) {
            await sleep(250);
        }
    }

    /**
     * @param {string} userId
     * @returns {boolean} accepted recently and VRChat may still lag
     */
    function isRecentlyAccepted(userId) {
        const at = recentAccepts.get(userId);
        if (at === undefined) {
            return false;
        }
        if (Date.now() - at >= ACCEPT_SYNC_WINDOW_MS) {
            recentAccepts.delete(userId);
            return false;
        }
        return true;
    }

    // ── In-memory stats ────────────────────────────────────────
    const requestCount = ref(0);
    const lastRequestAt = ref(0);
    const lastPlayerCount = ref(0);

    // ── Represented groups (in-memory, this session only) ──────
    /**
     * userId -> { name, shortCode } or null when the user represents no group.
     * @type {Map<string, {name: string, shortCode: string} | null>}
     */
    const representedGroups = reactive(new Map());
    const groupFetchQueue = ref([]);
    const groupFetchCount = ref(0);
    const isGroupFetcherRunning = ref(false);

    // ── Full profiles for bios (in-memory, this session only) ──
    // Instance players are often cached from lighter sources (the friends
    // list, instance data) that carry no bio. When bios are shared, players
    // whose profile was never fully fetched get one getUser call each,
    // throttled and capped, which fills cachedUsers with their bio.
    const profileFetched = new Set();
    const profileFetchQueue = ref([]);
    const profileFetchCount = ref(0);
    const isProfileFetcherRunning = ref(false);

    let isSettingsLoaded = false;

    async function loadSettings() {
        const [
            enabledConfig,
            shareBiosConfig,
            fetchGroupsConfig,
            actionsEnabledConfig,
            actionHistoryConfig
        ] = await Promise.all([
            configRepository.getBool(CONFIG_KEYS.enabled, false),
            configRepository.getBool(CONFIG_KEYS.shareBios, true),
            configRepository.getBool(CONFIG_KEYS.fetchGroups, false),
            configRepository.getBool(CONFIG_KEYS.actionsEnabled, false),
            configRepository.getString(CONFIG_KEYS.actionHistory, '[]')
        ]);
        enabled.value = Boolean(enabledConfig);
        shareBios.value = Boolean(shareBiosConfig);
        fetchGroups.value = Boolean(fetchGroupsConfig);
        actionsEnabled.value = Boolean(actionsEnabledConfig);
        try {
            actionHistory = pruneActionHistory(
                JSON.parse(actionHistoryConfig || '[]'),
                Date.now()
            );
        } catch {
            actionHistory = [];
        }
        isSettingsLoaded = true;
    }

    function setActionsEnabled(value) {
        actionsEnabled.value = Boolean(value);
        if (isSettingsLoaded) {
            configRepository.setBool(
                CONFIG_KEYS.actionsEnabled,
                actionsEnabled.value
            );
        }
    }

    function setEnabled(value) {
        enabled.value = Boolean(value);
        if (isSettingsLoaded) {
            configRepository.setBool(CONFIG_KEYS.enabled, enabled.value);
        }
    }

    function setShareBios(value) {
        shareBios.value = Boolean(value);
        if (isSettingsLoaded) {
            configRepository.setBool(CONFIG_KEYS.shareBios, shareBios.value);
        }
    }

    function setFetchGroups(value) {
        fetchGroups.value = Boolean(value);
        if (isSettingsLoaded) {
            configRepository.setBool(
                CONFIG_KEYS.fetchGroups,
                fetchGroups.value
            );
        }
    }

    function isGroupFetchingActive() {
        return (
            enabled.value && fetchGroups.value && Boolean(watchState.isLoggedIn)
        );
    }

    /**
     * Build the payload for the players currently in the instance.
     * Pure read of existing store state; never triggers API calls.
     */
    function buildPayload() {
        const lastLocation = locationStore.lastLocation;
        return buildPlayersPayload({
            location: lastLocation?.location,
            worldName: lastLocation?.name,
            playerList: lastLocation?.playerList,
            cachedUsers: userStore.cachedUsers,
            avatarNames: gameLogStore.state?.lastLocationAvatarList,
            groupsByUserId: representedGroups,
            settings: {
                shareBios: shareBios.value,
                fetchGroups: fetchGroups.value
            }
        });
    }

    /**
     * Called by the C# host for GET /paw/players.
     * @returns {string | null} JSON string, or null when the integration is disabled.
     */
    function getPlayersJson() {
        if (!enabled.value) {
            return null;
        }
        const payload = buildPayload();
        requestCount.value++;
        lastRequestAt.value = Date.now();
        lastPlayerCount.value = payload.players.length;
        return JSON.stringify(payload);
    }

    /**
     * Called by the C# host for GET /paw/status. Does not count as a request.
     * @returns {string} JSON string
     */
    function getStatusJson() {
        const playerCount = enabled.value
            ? (locationStore.lastLocation?.playerList?.size ?? 0)
            : 0;
        return JSON.stringify({
            enabled: enabled.value,
            actionsEnabled: enabled.value && actionsEnabled.value,
            playerCount
        });
    }

    // ── Actions ────────────────────────────────────────────────

    function actionResponse(status, body) {
        return JSON.stringify({ status, body });
    }

    function saveActionHistory() {
        configRepository
            .setString(CONFIG_KEYS.actionHistory, JSON.stringify(actionHistory))
            .catch((err) =>
                console.warn('[AiriIntegration] saving history failed', err)
            );
    }

    /**
     * Count an action against the rate limits (called right before the
     * VRChat API call that performs it).
     */
    function recordAction(kind, userId) {
        const now = Date.now();
        actionHistory = pruneActionHistory(actionHistory, now);
        actionHistory.push({ kind, userId, at: now });
        saveActionHistory();
    }

    function logAction(kind, userId, displayName, result, status) {
        const at = Date.now();
        console.log(
            `[AiriIntegration] ${new Date(at).toISOString()} action=${kind} userId=${userId} displayName=${JSON.stringify(displayName || '')} result=${result} status=${status}`
        );
        if (kind === 'friend-status' || kind === 'friend-requests') {
            return;
        }
        actionLog.value = [
            { at, kind, userId, displayName, result, status },
            ...actionLog.value
        ].slice(0, ACTION_LOG_MAX);
    }

    function cachedDisplayName(userId) {
        const cached = userStore.cachedUsers.get(userId);
        return typeof cached?.displayName === 'string'
            ? cached.displayName
            : '';
    }

    async function resolveDisplayName(userId) {
        const cached = cachedDisplayName(userId);
        if (cached) {
            return cached;
        }
        try {
            const args = await userRequest.getUser({ userId });
            return typeof args?.json?.displayName === 'string'
                ? args.json.displayName
                : '';
        } catch {
            return '';
        }
    }

    async function fetchFriendStatus(userId) {
        const args = await friendRequest.getFriendStatus({
            userId,
            currentUserId: userStore.currentUser.id
        });
        handleFriendStatus(args);
        return {
            isFriend: Boolean(args.json?.isFriend),
            outgoingPending: Boolean(args.json?.outgoingRequest),
            incomingPending: Boolean(args.json?.incomingRequest)
        };
    }

    /** Same friend-log bookkeeping VRCX does after "Send Friend Request". */
    function addFriendRequestLog(userId, displayName) {
        const friendLogHistory = {
            created_at: new Date().toJSON(),
            type: 'FriendRequest',
            userId,
            displayName: displayName || userId
        };
        useFriendStore().friendLogTable.data.push(friendLogHistory);
        database.addFriendLogHistory(friendLogHistory);
    }

    function rateLimited(limit) {
        return [
            429,
            {
                ok: false,
                error: 'rate_limited',
                reason: limit.reason,
                retryAfterSec: limit.retryAfterSec
            }
        ];
    }

    async function runFriendStatus(userId) {
        const limit = checkActionRateLimit(
            actionHistory,
            'friend-status',
            userId,
            Date.now()
        );
        if (!limit.allowed) {
            return rateLimited(limit);
        }
        recordAction('friend-status', userId);
        const status = await fetchFriendStatus(userId);
        if (status.isFriend) {
            recentAccepts.delete(userId);
        } else if (isRecentlyAccepted(userId)) {
            // Accepted and confirmed by VRChat, but its status endpoint lags.
            return [
                200,
                {
                    ok: true,
                    userId,
                    isFriend: true,
                    outgoingPending: false,
                    incomingPending: false,
                    syncing: true
                }
            ];
        }
        return [200, { ok: true, userId, ...status }];
    }

    /**
     * Incoming pending friend requests from VRCX's notification table,
     * refreshed first with VRCX's own notification refresh (throttled).
     */
    async function runFriendRequests() {
        const limit = checkActionRateLimit(
            actionHistory,
            'friend-requests',
            '',
            Date.now()
        );
        if (!limit.allowed) {
            return rateLimited(limit);
        }
        recordAction('friend-requests', '');
        await refreshNotificationsThrottled();
        const friends = useFriendStore().friends;
        const requests = buildIncomingFriendRequests(
            useNotificationStore().notificationTable?.data,
            {
                currentUserId: userStore.currentUser.id,
                friendIds: {
                    has: (id) => friends.has(id) || isRecentlyAccepted(id)
                },
                displayNameFor: cachedDisplayName
            }
        );
        return [200, { ok: true, requests }];
    }

    async function runFriendRequest(userId) {
        if (useFriendStore().friends.has(userId)) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        const limit = checkActionRateLimit(
            actionHistory,
            'friend-request',
            userId,
            Date.now()
        );
        if (!limit.allowed) {
            return rateLimited(limit);
        }
        const status = await fetchFriendStatus(userId);
        if (status.isFriend) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        if (status.outgoingPending) {
            return [200, { ok: false, result: 'already_pending' }];
        }
        if (status.incomingPending) {
            // They already asked us; accepting is a separate, explicit action.
            return [200, { ok: false, result: 'incoming_pending' }];
        }
        recordAction('friend-request', userId);
        await friendRequest.sendFriendRequest({ userId });
        addFriendRequestLog(userId, await resolveDisplayName(userId));
        return [200, { ok: true, result: 'sent' }];
    }

    async function runFriendAccept(userId) {
        if (
            useFriendStore().friends.has(userId) ||
            isRecentlyAccepted(userId)
        ) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        const limit = checkActionRateLimit(
            actionHistory,
            'friend-accept',
            userId,
            Date.now()
        );
        if (!limit.allowed) {
            return rateLimited(limit);
        }
        const notificationStore = useNotificationStore();
        const notificationId = getFriendRequest(userId);
        if (notificationId) {
            recordAction('friend-accept', userId);
            try {
                const args =
                    await notificationRequest.acceptFriendRequestNotification({
                        notificationId
                    });
                // Only reached once VRChat answered the accept with success;
                // API errors throw and become 502 / no_pending_request.
                markAccepted(userId);
                notificationStore.handleNotificationAccept(args);
                return [200, { ok: true, result: 'accepted' }];
            } catch (err) {
                if (err?.message?.includes('404')) {
                    notificationStore.handleNotificationHide(notificationId);
                    return [200, { ok: false, result: 'no_pending_request' }];
                }
                throw err;
            }
        }
        // No notification loaded: VRCX's own "Accept Friend Request" command
        // falls back to sending a request, which accepts a pending incoming one.
        const status = await fetchFriendStatus(userId);
        if (status.isFriend) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        if (!status.incomingPending) {
            return [200, { ok: false, result: 'no_pending_request' }];
        }
        recordAction('friend-accept', userId);
        await friendRequest.sendFriendRequest({ userId });
        markAccepted(userId);
        addFriendRequestLog(userId, await resolveDisplayName(userId));
        return [200, { ok: true, result: 'accepted' }];
    }

    async function runAction(kind, userId) {
        if (!enabled.value || !actionsEnabled.value) {
            return [
                403,
                {
                    enabled: enabled.value,
                    actionsEnabled: false,
                    error: 'actions_disabled'
                }
            ];
        }
        if (!AIRI_ACTION_KINDS.includes(kind)) {
            return [404, { ok: false, error: 'not_found' }];
        }
        if (kind === 'friend-requests') {
            if (!watchState.isLoggedIn || !userStore.currentUser?.id) {
                return [503, { ok: false, error: 'not_logged_in' }];
            }
            return await runFriendRequests();
        }
        if (!isValidAiriUserId(userId)) {
            return [400, { ok: false, error: 'invalid_user_id' }];
        }
        if (!watchState.isLoggedIn || !userStore.currentUser?.id) {
            return [503, { ok: false, error: 'not_logged_in' }];
        }
        if (userId === userStore.currentUser.id) {
            return [400, { ok: false, error: 'self_not_allowed' }];
        }
        try {
            if (kind === 'friend-status') {
                return await runFriendStatus(userId);
            }
            if (kind === 'friend-request') {
                return await runFriendRequest(userId);
            }
            return await runFriendAccept(userId);
        } catch (err) {
            return [
                502,
                {
                    ok: false,
                    error: 'vrchat_error',
                    message: String(err?.message ?? err).slice(0, 200)
                }
            ];
        }
    }

    /**
     * Called by the C# host for POST /paw/friend-request, POST
     * /paw/friend-accept, GET /paw/friend-status and GET
     * /paw/friend-requests (userId '' for the latter; after it checked the
     * X-Paw-Token header). Actions run one at a time.
     * @param {string} kind
     * @param {string} userId
     * @returns {Promise<string>} JSON {status, body}
     */
    function handleActionRequest(kind, userId) {
        const run = actionChain.then(async () => {
            const [status, body] = await runAction(kind, userId);
            if (kind === 'friend-requests') {
                const result =
                    status === 200
                        ? `count:${body.requests.length}`
                        : `${body.error}${body.reason ? `:${body.reason}` : ''}`;
                logAction(kind, '-', '', result, status);
                return actionResponse(status, body);
            }
            const safeUserId = isValidAiriUserId(userId) ? userId : '';
            const displayName = safeUserId ? cachedDisplayName(safeUserId) : '';
            if (status === 200) {
                body.userId = safeUserId;
                body.displayName = displayName;
            }
            let result = body.result || body.error || 'ok';
            if (body.reason) {
                result += `:${body.reason}`;
            }
            logAction(
                kind,
                safeUserId || 'invalid',
                displayName,
                result,
                status
            );
            return actionResponse(status, body);
        });
        actionChain = run.catch(() => {});
        return run;
    }

    /**
     * Queue a represented-group lookup for a player (throttled, capped).
     * @param {string} userId
     */
    function enqueueGroupFetch(userId) {
        if (!isGroupFetchingActive() || typeof userId !== 'string') {
            return;
        }
        if (
            !userId.startsWith('usr_') ||
            userId === userStore.currentUser?.id
        ) {
            return;
        }
        if (
            representedGroups.has(userId) ||
            groupFetchQueue.value.includes(userId) ||
            groupFetchCount.value >= GROUP_FETCH_SESSION_CAP
        ) {
            return;
        }
        groupFetchQueue.value.push(userId);
        if (!isGroupFetcherRunning.value) {
            processGroupFetchQueue();
        }
    }

    function enqueueCurrentPlayers() {
        const playerList = locationStore.lastLocation?.playerList;
        if (!playerList) {
            return;
        }
        for (const userId of playerList.keys()) {
            enqueueGroupFetch(userId);
            enqueueProfileFetch(userId);
        }
    }

    function isProfileFetchingActive() {
        return (
            enabled.value && shareBios.value && Boolean(watchState.isLoggedIn)
        );
    }

    /**
     * Queue a full profile fetch (for the bio) when the cached profile was
     * never fully fetched. Throttled and capped like the group lookups.
     * @param {string} userId
     */
    function enqueueProfileFetch(userId) {
        if (!isProfileFetchingActive() || typeof userId !== 'string') {
            return;
        }
        if (
            !userId.startsWith('usr_') ||
            userId === userStore.currentUser?.id ||
            profileFetched.has(userId) ||
            profileFetchQueue.value.includes(userId) ||
            profileFetchCount.value >= PROFILE_FETCH_SESSION_CAP
        ) {
            return;
        }
        const cached = userStore.cachedUsers.get(userId);
        if (cached?.$lastFetch) {
            profileFetched.add(userId);
            return;
        }
        profileFetchQueue.value.push(userId);
        if (!isProfileFetcherRunning.value) {
            processProfileFetchQueue();
        }
    }

    async function processProfileFetchQueue() {
        if (isProfileFetcherRunning.value) {
            return;
        }
        isProfileFetcherRunning.value = true;
        try {
            while (
                profileFetchQueue.value.length > 0 &&
                isProfileFetchingActive() &&
                profileFetchCount.value < PROFILE_FETCH_SESSION_CAP
            ) {
                const userId = profileFetchQueue.value.shift();
                if (profileFetched.has(userId)) {
                    continue;
                }
                profileFetched.add(userId);
                profileFetchCount.value++;
                try {
                    await userRequest.getUser({ userId });
                } catch (err) {
                    console.warn(
                        '[AiriIntegration] profile fetch failed',
                        userId,
                        err
                    );
                }
                await sleep(PROFILE_FETCH_INTERVAL_MS);
            }
        } finally {
            isProfileFetcherRunning.value = false;
        }
    }

    /**
     * Hook for the game log 'player-joined' event.
     * @param {string} userId
     */
    function handlePlayerJoined(userId) {
        enqueueGroupFetch(userId);
        enqueueProfileFetch(userId);
    }

    async function processGroupFetchQueue() {
        if (isGroupFetcherRunning.value) {
            return;
        }
        isGroupFetcherRunning.value = true;
        try {
            while (
                groupFetchQueue.value.length > 0 &&
                isGroupFetchingActive() &&
                groupFetchCount.value < GROUP_FETCH_SESSION_CAP
            ) {
                const userId = groupFetchQueue.value.shift();
                if (representedGroups.has(userId)) {
                    continue;
                }
                groupFetchCount.value++;
                try {
                    const args = await queryRequest.fetch('representedGroup', {
                        userId
                    });
                    const json = args?.json;
                    representedGroups.set(
                        userId,
                        json && typeof json.name === 'string' && json.name
                            ? {
                                  name: json.name,
                                  shortCode:
                                      typeof json.shortCode === 'string'
                                          ? json.shortCode
                                          : ''
                              }
                            : null
                    );
                } catch (err) {
                    console.warn(
                        '[AiriIntegration] represented group fetch failed',
                        userId,
                        err
                    );
                    representedGroups.set(userId, null);
                }
                await sleep(GROUP_FETCH_INTERVAL_MS);
            }
        } finally {
            isGroupFetcherRunning.value = false;
        }
    }

    watch([enabled, fetchGroups], ([isEnabled, isFetchGroups]) => {
        if (isEnabled && isFetchGroups) {
            enqueueCurrentPlayers();
        } else {
            groupFetchQueue.value = [];
        }
    });

    watch([enabled, shareBios], ([isEnabled, isShareBios]) => {
        if (isEnabled && isShareBios) {
            enqueueCurrentPlayers();
        } else {
            profileFetchQueue.value = [];
        }
    });

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            if (!isLoggedIn) {
                groupFetchQueue.value = [];
                representedGroups.clear();
                profileFetchQueue.value = [];
                profileFetched.clear();
            }
        },
        { flush: 'sync' }
    );

    loadSettings();

    return {
        enabled,
        shareBios,
        fetchGroups,
        actionsEnabled,
        actionLog,
        requestCount,
        lastRequestAt,
        lastPlayerCount,
        representedGroups,
        groupFetchQueue,
        groupFetchCount,
        isGroupFetcherRunning,
        setEnabled,
        setShareBios,
        setFetchGroups,
        setActionsEnabled,
        buildPayload,
        getPlayersJson,
        getStatusJson,
        handleActionRequest,
        handlePlayerJoined,
        enqueueCurrentPlayers
    };
});
