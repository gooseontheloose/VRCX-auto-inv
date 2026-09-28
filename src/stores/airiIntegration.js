import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { buildPlayersPayload } from '../shared/utils/airiIntegration';
import { queryRequest, userRequest } from '../api';
import { useGameLogStore } from './gameLog';
import { useLocationStore } from './location';
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
    fetchGroups: 'PAW_airiIntegration_fetchGroups'
};

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
        const [enabledConfig, shareBiosConfig, fetchGroupsConfig] =
            await Promise.all([
                configRepository.getBool(CONFIG_KEYS.enabled, false),
                configRepository.getBool(CONFIG_KEYS.shareBios, true),
                configRepository.getBool(CONFIG_KEYS.fetchGroups, false)
            ]);
        enabled.value = Boolean(enabledConfig);
        shareBios.value = Boolean(shareBiosConfig);
        fetchGroups.value = Boolean(fetchGroupsConfig);
        isSettingsLoaded = true;
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
        return JSON.stringify({ enabled: enabled.value, playerCount });
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
        buildPayload,
        getPlayersJson,
        getStatusJson,
        handlePlayerJoined,
        enqueueCurrentPlayers
    };
});
