import { onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import {
    AIRI_ACTION_KINDS,
    AIRI_BIO_TTL_MS,
    AIRI_FRIEND_REQUESTS_MAX,
    AIRI_GROUP_TTL_MS,
    AIRI_PERSISTED_ACTION_KINDS,
    AIRI_USER_CACHE_DB_MAX,
    AIRI_USER_CACHE_DB_MAX_AGE_MS,
    AIRI_USER_CACHE_MAX,
    buildIncomingFriendRequests,
    buildPlayerEntry,
    buildPlayersPayload,
    checkActionRateLimit,
    computeActionBudget,
    createLruMap,
    isCacheFresh,
    isValidAiriUserId,
    normalizeAcceptPerHour,
    pruneActionHistory,
    resolveActionLimits
} from '../shared/utils/airiIntegration';
import {
    AIRI_LOOKUP_PRIORITY,
    createPacedQueue,
    isRateLimitError
} from '../shared/utils/airiLookupQueue';
import {
    friendRequest,
    groupRequest,
    notificationRequest,
    userRequest
} from '../api';
import {
    addFriendship,
    getFriendRequest,
    handleFriendStatus
} from '../coordinators/friendRelationshipCoordinator';
import { airiUserCache } from '../services/database/airiUserCache';
import { database } from '../services/database';
import { onVrchatRateLimit } from '../services/vrchatRateLimit';
import { useFriendStore } from './friend';
import { useGameLogStore } from './gameLog';
import { useGroupInviteStore } from './groupInvite';
import { useLocationStore } from './location';
import { useNotificationStore } from './notification';
import { useUserStore } from './user';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';

const CONFIG_KEYS = {
    enabled: 'PAW_airiIntegration_enabled',
    shareBios: 'PAW_airiIntegration_shareBios',
    fetchGroups: 'PAW_airiIntegration_fetchGroups',
    actionsEnabled: 'PAW_airiIntegration_actionsEnabled',
    actionHistory: 'PAW_airiIntegration_actionHistory',
    acceptPerHour: 'PAW_airiIntegration_acceptPerHour'
};

/** Entries kept in the "recent AIRI actions" list. */
const ACTION_LOG_MAX = 25;
/** Persisted action history is written at most this often. */
const ACTION_HISTORY_SAVE_DELAY_MS = 1000;

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
/**
 * GET /paw/friend-requests answers from VRCX's notification table right away
 * (the websocket keeps it current) and starts VRCX's full notification
 * refresh in the background only when the last one is older than this.
 */
const NOTIFICATION_STALE_MS = 10 * 60 * 1000;

/** GET /paw/player waits at most this long for its lookups (C# allows 25 s). */
const PLAYER_WAIT_MS = 15 * 1000;
/** Retry delays after failed lookups (attempts 1 and 2); then give up for a while. */
const LOOKUP_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000];
/** A player whose lookups failed 3 times is not queued again for this long. */
const LOOKUP_GIVE_UP_MS = 60 * 60 * 1000;
/** Present players missing data are re-queued this often (cheap, deduplicated). */
const LOOKUP_SWEEP_INTERVAL_MS = 60 * 1000;
/** Changed cache entries are written to the database this long after a change. */
const USER_CACHE_SAVE_DELAY_MS = 5 * 1000;
/** A cached player's "last seen" is written back at most this often. */
const USER_CACHE_SEEN_RESOLUTION_MS = 24 * 60 * 60 * 1000;

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
    const acceptPerHour = ref(normalizeAcceptPerHour(undefined));

    // ── Actions (friend requests) ──────────────────────────────
    /**
     * Rate-limit history: {kind, userId, at}[] (last 24 h). Sends and
     * accepts are persisted; status checks and request lists stay in memory.
     */
    let actionHistory = [];
    let actionHistorySaveTimer = null;
    /** Recent actions shown on the AIRI Integration page (newest first). */
    const actionLog = ref([]);
    /** Serializes actions so rate-limit checks and records never race. */
    let actionChain = Promise.resolve();
    /** userId -> time of an accept VRChat confirmed (in memory). */
    const recentAccepts = new Map();
    /** When VRCX's notification refresh last ran (started by us or at login). */
    let notificationsRefreshedAt = 0;
    let isNotificationRefreshRunning = false;
    /**
     * Friend-request notifications from the last time the table was complete.
     * VRCX's refresh marks every friend request expired while it runs, so
     * this snapshot answers during a refresh.
     */
    let friendRequestSnapshot = null;

    function actionLimits() {
        return resolveActionLimits({ acceptPerHour: acceptPerHour.value });
    }

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
     * Start VRCX's own notification refresh (the same as the Notifications
     * page refresh button) without waiting for it, when the last one is
     * older than NOTIFICATION_STALE_MS. Not while VRChat rate limits us.
     */
    function refreshNotificationsInBackground() {
        const notificationStore = useNotificationStore();
        const now = Date.now();
        if (
            isNotificationRefreshRunning ||
            vrchatCooldownSec() > 0 ||
            notificationStore.isNotificationsLoading ||
            now - notificationsRefreshedAt < NOTIFICATION_STALE_MS ||
            typeof notificationStore.refreshNotifications !== 'function'
        ) {
            return;
        }
        notificationsRefreshedAt = now;
        isNotificationRefreshRunning = true;
        Promise.resolve()
            .then(() => notificationStore.refreshNotifications())
            .catch((err) =>
                console.warn(
                    '[AiriIntegration] notification refresh failed',
                    err
                )
            )
            .finally(() => {
                isNotificationRefreshRunning = false;
            });
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

    // ── Lookup cache (represented group, bio, VRC+) ────────────
    // Instance players are often cached from lighter sources (the friends
    // list, instance data) that carry no bio, and represented groups need
    // their own call. Both go through one paced queue, and the results are
    // kept in an LRU backed by the paw_airi_user_cache table.
    const userCache = createLruMap(AIRI_USER_CACHE_MAX);
    /** 'idle' | 'loading' | 'ready' | 'failed' (failed: memory only) */
    let userCacheState = 'idle';
    const dirtyCacheIds = new Set();
    let userCacheSaveTimer = null;
    let userCacheSaveFailed = false;
    /** Task key -> time it was given up after repeated failures. */
    const lookupGaveUp = new Map();
    /** Bumped when lookup data changes (the page re-renders on it). */
    const lookupVersion = ref(0);

    let isSettingsLoaded = false;

    async function loadSettings() {
        const [
            enabledConfig,
            shareBiosConfig,
            fetchGroupsConfig,
            actionsEnabledConfig,
            actionHistoryConfig,
            acceptPerHourConfig
        ] = await Promise.all([
            configRepository.getBool(CONFIG_KEYS.enabled, false),
            configRepository.getBool(CONFIG_KEYS.shareBios, true),
            configRepository.getBool(CONFIG_KEYS.fetchGroups, false),
            configRepository.getBool(CONFIG_KEYS.actionsEnabled, false),
            configRepository.getString(CONFIG_KEYS.actionHistory, '[]'),
            configRepository.getString(CONFIG_KEYS.acceptPerHour, '')
        ]);
        enabled.value = Boolean(enabledConfig);
        shareBios.value = Boolean(shareBiosConfig);
        fetchGroups.value = Boolean(fetchGroupsConfig);
        actionsEnabled.value = Boolean(actionsEnabledConfig);
        acceptPerHour.value = normalizeAcceptPerHour(
            acceptPerHourConfig || undefined
        );
        try {
            actionHistory = pruneActionHistory(
                JSON.parse(actionHistoryConfig || '[]'),
                Date.now()
            );
        } catch {
            actionHistory = [];
        }
        isSettingsLoaded = true;
        if (enabled.value) {
            loadUserCache();
        }
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

    function setAcceptPerHour(value) {
        acceptPerHour.value = normalizeAcceptPerHour(value);
        if (isSettingsLoaded) {
            configRepository.setString(
                CONFIG_KEYS.acceptPerHour,
                String(acceptPerHour.value)
            );
        }
    }

    // ── Lookup cache helpers ───────────────────────────────────

    function blankCacheEntry(userId) {
        return {
            userId,
            groupName: '',
            shortCode: '',
            bio: '',
            isVRCPlus: null,
            groupFetchedAt: 0,
            bioFetchedAt: 0,
            lastSeenAt: 0
        };
    }

    function scheduleUserCacheSave() {
        if (userCacheSaveTimer || userCacheState === 'failed') {
            return;
        }
        userCacheSaveTimer = setTimeout(
            flushUserCache,
            USER_CACHE_SAVE_DELAY_MS
        );
    }

    async function flushUserCache() {
        userCacheSaveTimer = null;
        const ids = [...dirtyCacheIds];
        dirtyCacheIds.clear();
        for (const userId of ids) {
            const entry = userCache.peek(userId);
            if (!entry) {
                continue;
            }
            try {
                await airiUserCache.saveAiriUserCacheEntry(entry);
            } catch (err) {
                if (!userCacheSaveFailed) {
                    userCacheSaveFailed = true;
                    console.warn(
                        '[AiriIntegration] saving the lookup cache failed',
                        err
                    );
                }
            }
        }
    }

    /**
     * @param {string} userId
     * @param {Record<string, any>} patch
     */
    function updateCacheEntry(userId, patch) {
        const entry = userCache.peek(userId) ?? blankCacheEntry(userId);
        userCache.set(userId, {
            ...entry,
            ...patch,
            lastSeenAt: Math.max(entry.lastSeenAt, Date.now())
        });
        dirtyCacheIds.add(userId);
        lookupVersion.value++;
        scheduleUserCacheSave();
    }

    function markSeen(userId) {
        const entry = userCache.peek(userId);
        if (
            entry &&
            Date.now() - entry.lastSeenAt >= USER_CACHE_SEEN_RESOLUTION_MS
        ) {
            updateCacheEntry(userId, {});
        }
    }

    /**
     * A profile VRCX core already loaded that carries the bio. VRChat moved
     * the bio from users/{id} to the public profile (profile/{id}), which
     * VRCX core now fetches for every player who joins. A user object only
     * counts when it still has a bio field (older API responses, tests).
     * @param {string} userId
     * @returns {any | null}
     */
    function coreProfile(userId) {
        const publicProfile = userStore.cachedProfiles?.get(userId);
        if (publicProfile?.$lastFetch) {
            return publicProfile;
        }
        const core = userStore.cachedUsers.get(userId);
        if (core?.$lastFetch && typeof core.bio === 'string') {
            return core;
        }
        return null;
    }

    /**
     * Keep the bio and VRC+ flag of a full profile (from our own fetch or
     * one VRCX core already made).
     * @param {string} userId
     * @param {any} json public profile or user object
     * @param {number} fetchedAt
     */
    function rememberProfile(userId, json, fetchedAt) {
        if (!json || typeof json !== 'object') {
            return;
        }
        const entry = userCache.peek(userId);
        if (entry && entry.bioFetchedAt >= fetchedAt) {
            return;
        }
        updateCacheEntry(userId, {
            bio: typeof json.bio === 'string' ? json.bio : '',
            isVRCPlus: Array.isArray(json.tags)
                ? json.tags.includes('system_supporter')
                : typeof json.hasVrcPlus === 'boolean'
                  ? json.hasVrcPlus
                  : (entry?.isVRCPlus ?? null),
            bioFetchedAt: fetchedAt
        });
    }

    function groupOf(entry) {
        return entry?.groupName
            ? { name: entry.groupName, shortCode: entry.shortCode }
            : null;
    }

    async function loadUserCache() {
        if (userCacheState !== 'idle') {
            return;
        }
        userCacheState = 'loading';
        try {
            await airiUserCache.initAiriUserCache();
            await airiUserCache.pruneAiriUserCache(
                AIRI_USER_CACHE_DB_MAX,
                AIRI_USER_CACHE_DB_MAX_AGE_MS,
                Date.now()
            );
            const rows =
                await airiUserCache.loadAiriUserCache(AIRI_USER_CACHE_MAX);
            // Oldest first, so the most recently seen end up most recently used.
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i];
                // Anything learned while loading is newer than the row.
                if (!userCache.has(row.userId)) {
                    userCache.set(row.userId, row);
                }
            }
            userCacheState = 'ready';
        } catch (err) {
            console.warn(
                '[AiriIntegration] lookup cache unavailable, using memory only',
                err
            );
            userCacheState = 'failed';
        }
        lookupVersion.value++;
        enqueueCurrentPlayers();
        lookupQueue.start();
    }

    // ── Lookup queue ───────────────────────────────────────────

    function groupInviteStore() {
        try {
            return useGroupInviteStore();
        } catch {
            return null;
        }
    }

    function isPresent(userId) {
        const playerList = locationStore.lastLocation?.playerList;
        return Boolean(playerList?.has?.(userId));
    }

    function isLookupActive() {
        return (
            enabled.value &&
            Boolean(watchState.isLoggedIn) &&
            (userCacheState === 'ready' || userCacheState === 'failed')
        );
    }

    /**
     * Decides right before a call whether it is still needed. Skips cost no
     * token.
     * @returns {string} 'run' or the skip reason
     */
    function precheckLookup(task) {
        const { kind, userId } = task.data;
        if (!watchState.isLoggedIn) {
            return 'logged_out';
        }
        if (kind === 'group' && !fetchGroups.value) {
            return 'disabled';
        }
        if (kind === 'profile' && !shareBios.value && !task.sticky) {
            return 'disabled';
        }
        if (!task.sticky && !isPresent(userId)) {
            return 'left';
        }
        const now = Date.now();
        const entry = userCache.peek(userId);
        if (kind === 'group') {
            return isCacheFresh(entry?.groupFetchedAt, AIRI_GROUP_TTL_MS, now)
                ? 'cached'
                : 'run';
        }
        const core = coreProfile(userId);
        if (core) {
            rememberProfile(userId, core, core.$lastFetch);
            return 'core';
        }
        return isCacheFresh(entry?.bioFetchedAt, AIRI_BIO_TTL_MS, now)
            ? 'cached'
            : 'run';
    }

    async function runLookup(task) {
        const { kind, userId } = task.data;
        if (kind === 'group') {
            // Straight to the API: the query layer would retry a 429 on its
            // own, and the queue is already the cache and the pacer.
            const args = await groupRequest.getRepresentedGroup({ userId });
            const json = args?.json;
            // Only a successful answer without a group means "no group".
            const name = json && typeof json.name === 'string' ? json.name : '';
            updateCacheEntry(userId, {
                groupName: name,
                shortCode:
                    name && typeof json.shortCode === 'string'
                        ? json.shortCode
                        : '',
                groupFetchedAt: Date.now()
            });
            return;
        }
        // The bio lives on the public profile now; this also fills VRCX
        // core's profile cache (applyPublicProfile) for the user dialog.
        const args = await userRequest.getPublicProfile({ userId });
        rememberProfile(userId, args?.json, Date.now());
    }

    const lookupQueue = createPacedQueue({
        execute: runLookup,
        precheck: precheckLookup,
        isActive: isLookupActive,
        externalPauseUntil: () =>
            Number(groupInviteStore()?.rateLimitCooldownUntil) || 0,
        onRateLimit: (pausedUntil, strikes) => {
            console.warn(
                `[AiriIntegration] VRChat rate limit (strike ${strikes}), lookups paused until ${new Date(pausedUntil).toISOString()}`
            );
            // PAW's auto-inviter backs off together with the lookups.
            const store = groupInviteStore();
            if (
                store &&
                (Number(store.rateLimitCooldownUntil) || 0) < pausedUntil
            ) {
                store.rateLimitCooldownUntil = pausedUntil;
            }
            lookupVersion.value++;
        },
        onBudgetFreed: () => enqueueCurrentPlayers(),
        onFailure: (task, err) => {
            console.warn(
                '[AiriIntegration] lookup failed',
                task.key,
                /** @type {any} */ (err)?.message ?? err
            );
            lookupVersion.value++;
            if (task.attempts <= LOOKUP_RETRY_DELAYS_MS.length) {
                return LOOKUP_RETRY_DELAYS_MS[task.attempts - 1];
            }
            lookupGaveUp.set(task.key, Date.now());
            return null;
        }
    });

    function hasGivenUp(key) {
        const at = lookupGaveUp.get(key);
        if (at === undefined) {
            return false;
        }
        if (Date.now() - at >= LOOKUP_GIVE_UP_MS) {
            lookupGaveUp.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Queue the lookups a player still needs.
     * @param {string} userId
     * @param {number} priority AIRI_LOOKUP_PRIORITY value
     * @param {boolean} [explicit] asked for through GET /paw/player
     * @returns {string[]} keys of the queued (or running) lookups
     */
    function enqueueLookups(userId, priority, explicit = false) {
        if (
            !enabled.value ||
            !watchState.isLoggedIn ||
            typeof userId !== 'string' ||
            !userId.startsWith('usr_') ||
            userId === userStore.currentUser?.id
        ) {
            return [];
        }
        const now = Date.now();
        const entry = userCache.peek(userId);
        markSeen(userId);
        const keys = [];
        const add = (kind) => {
            const key = `${kind}:${userId}`;
            if (!explicit && hasGivenUp(key)) {
                return;
            }
            if (
                lookupQueue.enqueue(key, {
                    priority,
                    sticky: explicit,
                    data: { kind, userId }
                })
            ) {
                keys.push(key);
            }
        };
        if (
            fetchGroups.value &&
            !isCacheFresh(entry?.groupFetchedAt, AIRI_GROUP_TTL_MS, now)
        ) {
            add('group');
        }
        if (shareBios.value || explicit) {
            const core = coreProfile(userId);
            if (core) {
                rememberProfile(userId, core, core.$lastFetch);
            } else if (
                !isCacheFresh(entry?.bioFetchedAt, AIRI_BIO_TTL_MS, now)
            ) {
                add('profile');
            }
        }
        return keys;
    }

    function enqueueCurrentPlayers() {
        const playerList = locationStore.lastLocation?.playerList;
        if (!playerList || !isLookupActive()) {
            return;
        }
        // Join order: later joiners get newer entries and are looked up first.
        for (const userId of playerList.keys()) {
            enqueueLookups(userId, AIRI_LOOKUP_PRIORITY.present);
        }
    }

    /**
     * Hook for the game log 'player-joined' event.
     * @param {string} userId
     */
    function handlePlayerJoined(userId) {
        enqueueLookups(userId, AIRI_LOOKUP_PRIORITY.present);
    }

    function getLookupStatus() {
        return {
            ...lookupQueue.stats(),
            cacheSize: userCache.size,
            cacheState: userCacheState,
            fetchGroups: fetchGroups.value,
            shareBios: shareBios.value
        };
    }

    // ── Payloads ───────────────────────────────────────────────

    const groupsLookup = {
        get: (userId) => groupOf(userCache.peek(userId))
    };
    const profileCacheLookup = {
        get: (userId) => userCache.peek(userId)
    };

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
            groupsByUserId: groupsLookup,
            profileCache: profileCacheLookup,
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
            playerCount,
            acceptPerHour: acceptPerHour.value,
            lookups: getLookupStatus(),
            friendBudget: getFriendBudget()
        });
    }

    function getFriendBudget() {
        return computeActionBudget(actionHistory, Date.now(), actionLimits());
    }

    // ── GET /paw/player ────────────────────────────────────────

    /**
     * One player's whitelisted entry from what VRCX knows now.
     * @param {string} userId
     */
    function buildPlayerFor(userId) {
        const entry = locationStore.lastLocation?.playerList?.get?.(userId);
        const extra = userCache.peek(userId);
        return buildPlayerEntry({
            userId,
            entry,
            profile: userStore.cachedUsers.get(userId),
            extra,
            group: groupOf(extra),
            avatarNames: gameLogStore.state?.lastLocationAvatarList,
            shareBios: shareBios.value,
            fetchGroups: fetchGroups.value
        });
    }

    async function runPlayerRequest(userId) {
        if (!enabled.value) {
            return [403, { enabled: false, error: 'disabled' }];
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
        const keys = enqueueLookups(
            userId,
            AIRI_LOOKUP_PRIORITY.explicit,
            true
        );
        // No point waiting through a long pause: answer with what is known.
        if (
            keys.length &&
            lookupQueue.retryAfterSec() * 1000 < PLAYER_WAIT_MS
        ) {
            await Promise.all(
                keys.map((key) => lookupQueue.whenSettled(key, PLAYER_WAIT_MS))
            );
        }
        const pending = keys.some((key) => lookupQueue.has(key));
        /** @type {Record<string, any>} */
        const body = {
            ok: true,
            player: buildPlayerFor(userId),
            inInstance: isPresent(userId),
            pending
        };
        const retryAfterSec = lookupQueue.retryAfterSec();
        if (pending && retryAfterSec) {
            body.retryAfterSec = retryAfterSec;
        }
        return [200, body];
    }

    /**
     * Called by the C# host for GET /paw/player?userId= (after it checked
     * the X-Paw-Token header). Fetches the player's missing profile/group
     * first in line (waits up to 15 s), then answers with what is known.
     * @param {string} userId
     * @returns {Promise<string>} JSON {status, body}
     */
    async function handlePlayerRequest(userId) {
        try {
            const [status, body] = await runPlayerRequest(userId);
            return actionResponse(status, body);
        } catch (err) {
            console.warn('[AiriIntegration] player request failed', err);
            return actionResponse(500, {
                ok: false,
                error: 'internal_error'
            });
        }
    }

    // ── Actions ────────────────────────────────────────────────

    function actionResponse(status, body) {
        return JSON.stringify({ status, body });
    }

    function saveActionHistory() {
        if (actionHistorySaveTimer) {
            return;
        }
        actionHistorySaveTimer = setTimeout(() => {
            actionHistorySaveTimer = null;
            const persisted = pruneActionHistory(
                actionHistory,
                Date.now()
            ).filter((entry) =>
                AIRI_PERSISTED_ACTION_KINDS.includes(entry.kind)
            );
            configRepository
                .setString(CONFIG_KEYS.actionHistory, JSON.stringify(persisted))
                .catch((err) =>
                    console.warn('[AiriIntegration] saving history failed', err)
                );
        }, ACTION_HISTORY_SAVE_DELAY_MS);
    }

    /**
     * Count an action against the rate limits (called right before the
     * VRChat API call that performs it).
     */
    function recordAction(kind, userId) {
        const now = Date.now();
        actionHistory = pruneActionHistory(actionHistory, now);
        actionHistory.push({ kind, userId, at: now });
        if (AIRI_PERSISTED_ACTION_KINDS.includes(kind)) {
            saveActionHistory();
        }
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

    function vrchatRateLimited(retryAfterSec) {
        return [
            429,
            {
                ok: false,
                error: 'vrchat_rate_limited',
                retryAfterSec: Math.max(1, retryAfterSec)
            }
        ];
    }

    function checkLimit(kind, userId) {
        return checkActionRateLimit(
            actionHistory,
            kind,
            userId,
            Date.now(),
            actionLimits()
        );
    }

    async function runFriendStatus(userId) {
        const limit = checkLimit('friend-status', userId);
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
     * Incoming pending friend requests, answered right away from VRCX's
     * notification table (kept current by VRCX's websocket). A full
     * notification refresh runs in the background when the last one is more
     * than 10 minutes old; while it runs, the last complete list answers.
     * Senders in the instance come first, then the oldest requests.
     */
    function runFriendRequests() {
        const limit = checkLimit('friend-requests', '');
        if (!limit.allowed) {
            return rateLimited(limit);
        }
        recordAction('friend-requests', '');
        const notificationStore = useNotificationStore();
        const isLoading = Boolean(notificationStore.isNotificationsLoading);
        if (isLoading && !friendRequestSnapshot) {
            // VRCX marks every request expired while it reloads (e.g. right
            // after login): an answer now would wrongly say "none pending".
            return [503, { ok: false, error: 'loading', retryAfterSec: 10 }];
        }
        let source = notificationStore.notificationTable?.data;
        if (!isLoading) {
            friendRequestSnapshot = Array.isArray(source)
                ? source
                      .filter(
                          (n) => n?.type === 'friendRequest' && !n.$isExpired
                      )
                      .map((n) => ({ ...n }))
                : [];
        } else {
            source = friendRequestSnapshot;
        }
        refreshNotificationsInBackground();
        const friends = useFriendStore().friends;
        const all = buildIncomingFriendRequests(source, {
            currentUserId: userStore.currentUser.id,
            friendIds: {
                has: (id) => friends.has(id) || isRecentlyAccepted(id)
            },
            displayNameFor: cachedDisplayName,
            isPresent,
            limit: Number.MAX_SAFE_INTEGER
        });
        return [
            200,
            {
                ok: true,
                requests: all.slice(0, AIRI_FRIEND_REQUESTS_MAX),
                pendingTotal: all.length,
                stale: isLoading
            }
        ];
    }

    async function runFriendRequest(userId) {
        if (useFriendStore().friends.has(userId)) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        const limit = checkLimit('friend-request', userId);
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

    /**
     * Accept a pending request. With the notification loaded (the usual
     * case for requests listed by GET /paw/friend-requests) this is a single
     * VRChat call and needs no friend-status check first.
     */
    async function runFriendAccept(userId) {
        if (
            useFriendStore().friends.has(userId) ||
            isRecentlyAccepted(userId)
        ) {
            return [200, { ok: false, result: 'already_friends' }];
        }
        const limit = checkLimit('friend-accept', userId);
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
                if (err?.status === 404 || err?.message?.includes('404')) {
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

    /** Seconds left of a pause after VRChat answered 429 (0 when none). */
    function vrchatCooldownSec() {
        const pause = lookupQueue.pauseState();
        return pause.reason === 'rate_limited' ? pause.retryAfterSec : 0;
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
            return runFriendRequests();
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
        const cooldown = vrchatCooldownSec();
        if (cooldown > 0) {
            return vrchatRateLimited(cooldown);
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
            if (isRateLimitError(err)) {
                lookupQueue.reportRateLimit();
                return vrchatRateLimited(vrchatCooldownSec());
            }
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
            const answer = await runAction(kind, userId);
            const status = /** @type {number} */ (answer[0]);
            const body = /** @type {any} */ (answer[1]);
            if (kind === 'friend-requests') {
                const result =
                    status === 200
                        ? `count:${body.requests.length}/${body.pendingTotal}`
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

    // ── Watchers ───────────────────────────────────────────────

    watch(enabled, (isEnabled) => {
        if (isEnabled) {
            if (isSettingsLoaded) {
                loadUserCache();
            }
            enqueueCurrentPlayers();
        } else {
            lookupQueue.clear();
        }
    });

    watch(fetchGroups, (isFetchGroups) => {
        if (isFetchGroups) {
            enqueueCurrentPlayers();
        } else {
            lookupQueue.removeWhere((task) => task.data?.kind === 'group');
        }
    });

    watch(shareBios, (isShareBios) => {
        if (isShareBios) {
            enqueueCurrentPlayers();
        } else {
            lookupQueue.removeWhere(
                (task) => task.data?.kind === 'profile' && !task.sticky
            );
        }
    });

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            if (isLoggedIn) {
                // VRCX refreshes notifications itself right after login.
                notificationsRefreshedAt = Date.now();
                enqueueCurrentPlayers();
            } else {
                lookupQueue.clear();
                lookupGaveUp.clear();
                friendRequestSnapshot = null;
            }
        },
        { flush: 'sync' }
    );

    // A 429 anywhere in VRCX (e.g. core's own profile fetches for joiners)
    // pauses AIRI's lookups and friend actions too.
    onScopeDispose(
        onVrchatRateLimit(() => {
            if (enabled.value) {
                lookupQueue.reportRateLimit();
            }
        })
    );

    // Present players whose lookups were dropped (queue cleared, budget
    // exhausted, or joined while paused) are picked up again.
    setInterval(() => {
        if (isLookupActive() && lookupQueue.size === 0) {
            enqueueCurrentPlayers();
        }
    }, LOOKUP_SWEEP_INTERVAL_MS);

    loadSettings();

    return {
        enabled,
        shareBios,
        fetchGroups,
        actionsEnabled,
        acceptPerHour,
        actionLog,
        requestCount,
        lastRequestAt,
        lastPlayerCount,
        lookupVersion,
        setEnabled,
        setShareBios,
        setFetchGroups,
        setActionsEnabled,
        setAcceptPerHour,
        buildPayload,
        getPlayersJson,
        getStatusJson,
        getLookupStatus,
        getFriendBudget,
        handleActionRequest,
        handlePlayerRequest,
        handlePlayerJoined,
        enqueueCurrentPlayers
    };
});
