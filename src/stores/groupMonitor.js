import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import * as workerTimers from 'worker-timers';

import {
    auditDbLoadEntries,
    auditDbLoadMeta,
    auditDbSaveEntries
} from '../services/auditLogDb';
import {
    pollAuditLog,
    AUDIT_PAGE_SIZE
} from '../services/groupMonitor/auditPoller';
import {
    CRASH_DEFAULTS,
    crashCutoffIso,
    detectCrashSessions,
    ownLeaveTimesFromVisits
} from '../services/groupMonitor/crashDetector';
import { createDeliveryQueue } from '../services/groupMonitor/deliveryQueue';
import {
    isValidDiscordWebhookUrl,
    postDiscordWebhook
} from '../services/groupMonitor/discord';
import {
    DEFAULT_EVENT_FILTER,
    LEADERBOARD_TYPES,
    WEBHOOK_TYPES,
    buildAuditEventEmbed,
    buildAuditSummaryEmbed,
    buildCrashAlertPayload,
    buildLeaderboardPayload,
    buildTestPayload,
    categoryOf,
    groupVoteKicks,
    isVoteKickType
} from '../services/groupMonitor/payloads';
import monitorStorage from '../services/groupMonitor/storage';
import { request } from '../services/request';
import sqliteService from '../services/sqlite';
import { watchState } from '../services/watchState';
import { useGroupStore } from './group';
import { useLocationStore } from './location';
import { useUserStore } from './user';

/** How often the worker wakes up to flush the delivery queue. */
export const TICK_MS = 5_000;
/** How often monitored groups are polled / crash-checked / schedules evaluated. */
export const CYCLE_MS = 60_000;
/** Max per-event posts per webhook per poll (catch-up included); the rest is summarised. */
export const CATCH_UP_CAP = 20;
const LOG_LIMIT = 50;
const RECENT_CRASH_LIMIT = 20;
const GROUP_ID_RE = /^grp_[0-9a-f-]{36}$/i;
const AUDIT_PERM = 'group-audit-view';

const LEGACY_WEBHOOKS_KEY = 'gm-webhooks-v1';
const LEGACY_LASTSENT_KEY = 'gm-webhook-lastsent';
const LEGACY_MIGRATED_KEY = 'gm-webhooks-v1:migrated-to';

function configKey(userId) {
    return `gm:${userId}:config`;
}
function runtimeKey(userId) {
    return `gm:${userId}:runtime`;
}

function readLocalJson(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function readLocal(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function defaultGroupSettings() {
    return {
        monitored: true,
        crashEnabled: false,
        crashThreshold: CRASH_DEFAULTS.threshold,
        crashWindowSec: CRASH_DEFAULTS.windowSec
    };
}

function normaliseWebhook(w, fallbackGroupId = '') {
    const type = WEBHOOK_TYPES.includes(w?.type) ? w.type : 'kick-board';
    return {
        id: String(
            w?.id ||
                `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        ),
        name: String(w?.name || type),
        url: String(w?.url || '').trim(),
        groupId: String(w?.groupId || fallbackGroupId || ''),
        groupName: w?.groupName ? String(w.groupName) : '',
        type,
        eventFilter:
            Array.isArray(w?.eventFilter) && w.eventFilter.length
                ? [...w.eventFilter]
                : [...DEFAULT_EVENT_FILTER],
        intervalMinutes: Math.max(
            0,
            Math.min(10080, Number(w?.intervalMinutes) || 0)
        ),
        color: typeof w?.color === 'string' ? w.color : '#5865f2',
        enabled: w?.enabled !== false
    };
}

/**
 * Runs Group Monitor in the background for the logged-in account: audit
 * polling, per-event and scheduled webhooks, crash alerts and one persisted
 * delivery queue. Created at boot by createGlobalStores(), started/stopped by
 * login state, never by the Group Monitor pages.
 */
export const useGroupMonitorStore = defineStore('GroupMonitor', () => {
    const userStore = useUserStore();
    const groupStore = useGroupStore();
    const locationStore = useLocationStore();

    // ── persisted per-account config ─────────────────────────────────────────
    const activeUserId = ref('');
    const enabled = ref(true);
    const webhooks = ref([]);
    /** @type {import('vue').Ref<Record<string, ReturnType<typeof defaultGroupSettings>>>} */
    const groupSettings = ref({});
    // runtime bookkeeping (persisted separately, not user-editable)
    const lastSent = ref({});
    const watermarks = ref({});
    const crashAlertedUntil = ref({});

    // ── status for the UI ────────────────────────────────────────────────────
    const serviceState = ref('stopped'); // stopped | starting | waiting | running | paused
    const lastCycleAt = ref(0);
    const pollStatus = ref({}); // groupId -> { at, ok, error, newCount }
    const webhookState = ref({}); // webhookId -> { lastSuccessAt, lastError, lastErrorStatus, lastAttemptAt, sending }
    const queueStats = ref({ pending: 0, dead: 0, byWebhook: {} });
    const deliveryLog = ref([]);
    const recentCrashes = ref([]);
    const settingsLoaded = ref(false);

    let generation = 0;
    let timerHandle = null;
    let nextCycleAt = 0;
    let cycling = null;
    const catchUpDone = new Set();
    const listeners = new Set();

    const queue = createDeliveryQueue({
        storage: monitorStorage,
        post: (url, payload) => postDiscordWebhook(url, payload),
        resolveWebhook: (id) => webhooks.value.find((w) => w.id === id) ?? null,
        onEvent: onQueueEvent
    });

    // ── helpers ──────────────────────────────────────────────────────────────
    function groupName(groupId) {
        const g = groupStore.currentUserGroups.get(groupId);
        if (g?.name) return g.name;
        const wh = webhooks.value.find(
            (w) => w.groupId === groupId && w.groupName
        );
        return (
            wh?.groupName ||
            (groupId ? `Group ${groupId.slice(-6)}` : 'Unknown Group')
        );
    }

    function isMember(groupId) {
        return groupStore.currentUserGroups.has(groupId);
    }

    function hasAuditPermission(groupId) {
        const perms =
            groupStore.currentUserGroups.get(groupId)?.myMember?.permissions;
        return (
            Array.isArray(perms) &&
            (perms.includes('*') || perms.includes(AUDIT_PERM))
        );
    }

    function getGroupSettings(groupId) {
        return {
            ...defaultGroupSettings(),
            monitored: false,
            ...(groupSettings.value[groupId] ?? {})
        };
    }

    /** Groups whose audit log the service polls. */
    const polledGroupIds = computed(() => {
        const ids = new Set();
        for (const [gid, s] of Object.entries(groupSettings.value))
            if (s.monitored) ids.add(gid);
        for (const w of webhooks.value)
            if (w.enabled && w.groupId && w.type === 'audit-events')
                ids.add(w.groupId);
        return [...ids].filter((gid) => GROUP_ID_RE.test(gid));
    });

    function isPollingGroup(groupId) {
        return (
            serviceState.value === 'running' &&
            polledGroupIds.value.includes(groupId) &&
            hasAuditPermission(groupId)
        );
    }

    function setWebhookState(id, patch) {
        webhookState.value = {
            ...webhookState.value,
            [id]: { ...(webhookState.value[id] ?? {}), ...patch }
        };
    }

    function refreshQueueStats() {
        const byWebhook = {};
        for (const w of webhooks.value) byWebhook[w.id] = queue.stats(w.id);
        queueStats.value = { ...queue.stats(), byWebhook };
    }

    function pushLog(entry) {
        deliveryLog.value = [entry, ...deliveryLog.value].slice(0, LOG_LIMIT);
        const uid = activeUserId.value;
        if (!uid) return;
        monitorStorage
            .appendLog({ ...entry, userId: uid })
            .then(() => monitorStorage.pruneLog(uid, 200))
            .catch(() => {});
    }

    function onQueueEvent({ type, item, result }) {
        const now = Date.now();
        if (type === 'sending') {
            setWebhookState(item.webhookId, {
                sending: true,
                lastAttemptAt: now
            });
        } else if (type === 'sent') {
            setWebhookState(item.webhookId, {
                sending: false,
                lastSuccessAt: now,
                lastError: null,
                lastErrorStatus: null
            });
            pushLog({
                at: now,
                webhookId: item.webhookId,
                eventId: item.eventId,
                status: 'sent',
                httpStatus: result?.status ?? 0,
                message: ''
            });
        } else if (
            type === 'failed' ||
            type === 'rate_limited' ||
            type === 'dead' ||
            type === 'dropped'
        ) {
            setWebhookState(item.webhookId, {
                sending: false,
                lastError: result?.error ?? item.lastError ?? type,
                lastErrorStatus: result?.status ?? null,
                lastErrorAt: now
            });
            pushLog({
                at: now,
                webhookId: item.webhookId,
                eventId: item.eventId,
                status: type,
                httpStatus: result?.status ?? 0,
                message: result?.error ?? item.lastError ?? ''
            });
            if (type === 'dead') {
                console.warn(
                    `[GroupMonitor] webhook delivery gave up (${item.eventId}):`,
                    item.lastError
                );
            }
        }
        refreshQueueStats();
    }

    // ── persistence ──────────────────────────────────────────────────────────
    async function saveConfig() {
        const uid = activeUserId.value;
        if (!uid || !settingsLoaded.value) return;
        try {
            await monitorStorage.setKv(configKey(uid), {
                version: 1,
                enabled: enabled.value,
                webhooks: webhooks.value,
                groupSettings: groupSettings.value
            });
        } catch (err) {
            console.error('[GroupMonitor] failed to save settings:', err);
        }
    }

    async function saveRuntime() {
        const uid = activeUserId.value;
        if (!uid || !settingsLoaded.value) return;
        try {
            await monitorStorage.setKv(runtimeKey(uid), {
                lastSent: lastSent.value,
                watermarks: watermarks.value,
                crashAlertedUntil: crashAlertedUntil.value
            });
        } catch (err) {
            console.warn('[GroupMonitor] failed to save runtime state:', err);
        }
    }

    /**
     * Pre-2.2 builds kept one global webhook list (paw_settings gm-webhooks-v1)
     * plus localStorage flags. The first account to log in adopts it once.
     */
    async function migrateLegacy(userId) {
        const migratedTo = await monitorStorage.getKv(LEGACY_MIGRATED_KEY);
        if (migratedTo) return null;
        let legacy = await monitorStorage.getKv(LEGACY_WEBHOOKS_KEY);
        if (!Array.isArray(legacy)) legacy = readLocalJson(LEGACY_WEBHOOKS_KEY);
        const legacyLastSent =
            (await monitorStorage.getKv(LEGACY_LASTSENT_KEY)) ??
            readLocalJson(LEGACY_LASTSENT_KEY) ??
            {};
        const legacyGroup =
            readLocal('gm-monitored-group') || readLocal('gm-group-id') || '';
        const legacyCrash = readLocal('gm-monitor-crash') === '1';
        if (!Array.isArray(legacy) && !legacyGroup) return null;
        const hooks = (Array.isArray(legacy) ? legacy : []).map((w) =>
            normaliseWebhook(w, legacyGroup)
        );
        const gs = {};
        if (legacyGroup)
            gs[legacyGroup] = {
                ...defaultGroupSettings(),
                crashEnabled: legacyCrash
            };
        await monitorStorage.setKv(LEGACY_MIGRATED_KEY, userId);
        console.log(
            `[GroupMonitor] migrated ${hooks.length} legacy webhook(s) to account ${userId}`
        );
        return {
            config: {
                version: 1,
                enabled: true,
                webhooks: hooks,
                groupSettings: gs
            },
            runtime: {
                lastSent:
                    typeof legacyLastSent === 'object' ? legacyLastSent : {}
            }
        };
    }

    async function loadSettings(userId) {
        let config = await monitorStorage.getKv(configKey(userId));
        let runtime = await monitorStorage.getKv(runtimeKey(userId));
        if (!config) {
            const migrated = await migrateLegacy(userId);
            if (migrated) {
                config = migrated.config;
                runtime = { ...(runtime ?? {}), ...migrated.runtime };
                await monitorStorage.setKv(configKey(userId), config);
                await monitorStorage.setKv(runtimeKey(userId), runtime);
            }
        }
        return {
            enabled: config?.enabled !== false,
            webhooks: Array.isArray(config?.webhooks)
                ? config.webhooks.map((w) => normaliseWebhook(w))
                : [],
            groupSettings:
                config?.groupSettings &&
                typeof config.groupSettings === 'object'
                    ? config.groupSettings
                    : {},
            lastSent: runtime?.lastSent ?? {},
            watermarks: runtime?.watermarks ?? {},
            crashAlertedUntil: runtime?.crashAlertedUntil ?? {}
        };
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    function clearTimer() {
        if (timerHandle !== null) {
            workerTimers.clearInterval(timerHandle);
            timerHandle = null;
        }
    }

    function ensureTimer() {
        if (timerHandle !== null) return;
        timerHandle = workerTimers.setInterval(() => {
            tick();
        }, TICK_MS);
    }

    function resetState() {
        activeUserId.value = '';
        enabled.value = true;
        webhooks.value = [];
        groupSettings.value = {};
        lastSent.value = {};
        watermarks.value = {};
        crashAlertedUntil.value = {};
        pollStatus.value = {};
        webhookState.value = {};
        queueStats.value = { pending: 0, dead: 0, byWebhook: {} };
        deliveryLog.value = [];
        recentCrashes.value = [];
        lastCycleAt.value = 0;
        settingsLoaded.value = false;
        catchUpDone.clear();
        nextCycleAt = 0;
        cycling = null;
    }

    function stop() {
        generation++;
        clearTimer();
        queue.reset();
        resetState();
        serviceState.value = 'stopped';
    }

    async function start(userId) {
        stop();
        const gen = generation;
        activeUserId.value = userId;
        serviceState.value = 'starting';
        try {
            await monitorStorage.init();
            const s = await loadSettings(userId);
            if (gen !== generation) return;
            enabled.value = s.enabled;
            webhooks.value = s.webhooks;
            groupSettings.value = s.groupSettings;
            lastSent.value = s.lastSent;
            watermarks.value = s.watermarks;
            crashAlertedUntil.value = s.crashAlertedUntil;
            settingsLoaded.value = true;
            await queue.load(userId);
            const log = await monitorStorage
                .loadLog(userId, LOG_LIMIT)
                .catch(() => []);
            if (gen !== generation) return;
            deliveryLog.value = log;
            refreshQueueStats();
        } catch (err) {
            if (gen !== generation) return;
            // Don't run (or save!) on defaults: that could overwrite the real
            // config. Retry shortly instead.
            console.error(
                '[GroupMonitor] failed to start background service, retrying in 30s:',
                err
            );
            serviceState.value = 'stopped';
            workerTimers.setTimeout(() => {
                if (gen === generation) start(userId);
            }, 30_000);
            return;
        }
        if (gen !== generation) return;
        serviceState.value = enabled.value
            ? groupStore.currentUserGroupsInit
                ? 'running'
                : 'waiting'
            : 'paused';
        ensureTimer();
        nextCycleAt = 0;
        tick();
    }

    function syncWithLogin() {
        const loggedIn = watchState.isLoggedIn;
        const uid = userStore.currentUser?.id ?? '';
        if (!loggedIn || !uid) {
            if (serviceState.value !== 'stopped' || activeUserId.value) stop();
            return;
        }
        if (uid !== activeUserId.value) start(uid);
    }

    watch(
        () => [watchState.isLoggedIn, userStore.currentUser?.id],
        syncWithLogin,
        { flush: 'sync', immediate: true }
    );

    watch(
        () => groupStore.currentUserGroupsInit,
        (ready) => {
            if (!ready || !activeUserId.value || !settingsLoaded.value) return;
            if (enabled.value && serviceState.value === 'waiting')
                serviceState.value = 'running';
            nextCycleAt = 0;
            tick();
        }
    );

    // ── worker ───────────────────────────────────────────────────────────────
    function tick() {
        if (!activeUserId.value || !settingsLoaded.value)
            return Promise.resolve();
        const work = [];
        work.push(queue.processDue().then(refreshQueueStats));
        const now = Date.now();
        if (enabled.value && now >= nextCycleAt && !cycling) {
            nextCycleAt = now + CYCLE_MS;
            work.push(runCycle());
        }
        return Promise.all(work).catch((err) =>
            console.error('[GroupMonitor] tick failed:', err)
        );
    }

    function runCycle() {
        if (cycling) return cycling;
        const gen = generation;
        const run = (async () => {
            await null; // yield so `cycling` is assigned before this can finish
            try {
                if (!groupStore.currentUserGroupsInit) {
                    serviceState.value = 'waiting';
                    nextCycleAt = 0; // retry on the next tick
                    return;
                }
                serviceState.value = 'running';
                for (const gid of polledGroupIds.value) {
                    if (gen !== generation) return;
                    await pollGroup(gid, gen);
                }
                for (const [gid, s] of Object.entries(groupSettings.value)) {
                    if (gen !== generation) return;
                    if (s.crashEnabled) await checkCrashes(gid, gen);
                }
                if (gen !== generation) return;
                await runSchedules(gen);
                if (gen !== generation) return;
                lastCycleAt.value = Date.now();
                await saveRuntime();
                await queue.processDue();
                refreshQueueStats();
            } catch (err) {
                console.error('[GroupMonitor] cycle failed:', err);
            } finally {
                if (cycling === run) cycling = null;
            }
        })();
        cycling = run;
        return run;
    }

    // ── audit polling + per-event webhooks ───────────────────────────────────
    async function fetchAuditPage(groupId, offset) {
        const data = await request(`groups/${groupId}/auditLogs`, {
            method: 'GET',
            params: { n: AUDIT_PAGE_SIZE, offset }
        });
        const entries = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data)
              ? data
              : [];
        return { entries, totalCount: data?.totalCount ?? entries.length };
    }

    async function pollGroup(groupId, gen) {
        if (!hasAuditPermission(groupId)) {
            pollStatus.value = {
                ...pollStatus.value,
                [groupId]: {
                    at: Date.now(),
                    ok: false,
                    error: 'No audit-log permission for this group on this account',
                    newCount: 0
                }
            };
            return;
        }
        const catchUp = !catchUpDone.has(groupId);
        try {
            const res = await pollAuditLog({
                fetchPage: (offset) => fetchAuditPage(groupId, offset),
                watermark: watermarks.value[groupId] ?? null
            });
            if (gen !== generation) return;
            catchUpDone.add(groupId);
            watermarks.value = {
                ...watermarks.value,
                [groupId]: res.watermark
            };
            if (res.fetched.length) {
                auditDbSaveEntries(groupId, res.fetched).catch((err) =>
                    console.warn(
                        '[GroupMonitor] failed to cache audit entries:',
                        err
                    )
                );
                for (const cb of listeners) {
                    try {
                        cb(groupId, res.fetched, res.totalCount);
                    } catch (err) {
                        console.error(
                            '[GroupMonitor] audit listener failed:',
                            err
                        );
                    }
                }
            }
            pollStatus.value = {
                ...pollStatus.value,
                [groupId]: {
                    at: Date.now(),
                    ok: true,
                    error: null,
                    newCount: res.newEntries.length
                }
            };
            if (res.newEntries.length)
                await enqueueAuditEvents(
                    groupId,
                    res.newEntries,
                    { catchUp, truncated: res.truncated },
                    gen
                );
        } catch (err) {
            if (gen !== generation) return;
            const msg =
                typeof err === 'string' ? err : (err?.message ?? 'Poll failed');
            console.warn(
                `[GroupMonitor] audit poll failed for ${groupId}:`,
                msg
            );
            pollStatus.value = {
                ...pollStatus.value,
                [groupId]: {
                    at: Date.now(),
                    ok: false,
                    error: msg,
                    newCount: 0
                }
            };
        }
    }

    async function enqueueAuditEvents(
        groupId,
        entries,
        { catchUp, truncated },
        gen
    ) {
        const name = groupName(groupId);
        const hooks = webhooks.value.filter(
            (w) =>
                w.enabled && w.type === 'audit-events' && w.groupId === groupId
        );
        for (const wh of hooks) {
            const filter = new Set(wh.eventFilter ?? DEFAULT_EVENT_FILTER);
            const matching = entries.filter((e) =>
                filter.has(categoryOf(e.eventType))
            );
            if (!matching.length) continue;
            // newest events are the interesting ones when we have to cut
            const send = matching.slice(-CATCH_UP_CAP);
            const overflow = matching.length - send.length;
            if (overflow > 0 || truncated) {
                const last = matching[matching.length - 1];
                await queue.enqueue({
                    webhookId: wh.id,
                    eventId: `audit-summary:${groupId}:${last.id}`,
                    payload: {
                        embeds: [
                            buildAuditSummaryEmbed(overflow, name, {
                                catchUp,
                                truncated
                            })
                        ]
                    }
                });
            }
            for (const entry of send) {
                if (gen !== generation) return;
                await queue.enqueue({
                    webhookId: wh.id,
                    eventId: `audit:${entry.id}`,
                    payload: { embeds: [buildAuditEventEmbed(entry, name, wh)] }
                });
            }
        }
        refreshQueueStats();
    }

    // ── crash detection ──────────────────────────────────────────────────────
    async function queryCrashData(groupId, now) {
        const pattern = `%${groupId}%`;
        const leaves = [];
        await sqliteService.execute(
            (row) =>
                leaves.push({
                    at: row[0],
                    displayName: row[1],
                    location: row[2]
                }),
            `SELECT created_at, display_name, location FROM gamelog_join_leave WHERE type = 'OnPlayerLeft' AND location LIKE @pattern AND created_at >= @cutoff ORDER BY created_at ASC LIMIT 5000`,
            { '@pattern': pattern, '@cutoff': crashCutoffIso(now) }
        );
        const visits = [];
        await sqliteService.execute(
            (row) =>
                visits.push({
                    created_at: row[0],
                    location: row[1],
                    time: Number(row[2]) || 0
                }),
            `SELECT created_at, location, time FROM gamelog_location WHERE location LIKE @pattern AND created_at >= @since ORDER BY created_at DESC LIMIT 200`,
            {
                '@pattern': pattern,
                '@since': new Date(now - 24 * 3600_000).toISOString()
            }
        );
        return { leaves, visits };
    }

    async function checkCrashes(groupId, gen) {
        if (!GROUP_ID_RE.test(groupId) || !isMember(groupId)) return;
        const s = getGroupSettings(groupId);
        const now = Date.now();
        try {
            const { leaves, visits } = await queryCrashData(groupId, now);
            if (gen !== generation) return;
            const sessions = detectCrashSessions(leaves, {
                groupId,
                nowMs: now,
                threshold: s.crashThreshold,
                windowSec: s.crashWindowSec,
                ownLeaveTimes: ownLeaveTimesFromVisits(visits),
                currentLocation: locationStore.lastLocation?.location ?? ''
            });
            for (const session of sessions) {
                const key = `${groupId}|${session.location}`;
                const until = crashAlertedUntil.value[key];
                if (until && session.startAt <= until) continue;
                crashAlertedUntil.value = {
                    ...crashAlertedUntil.value,
                    [key]: session.endAt
                };
                recentCrashes.value = [
                    { ...session, detectedAt: now },
                    ...recentCrashes.value
                ].slice(0, RECENT_CRASH_LIMIT);
                const hooks = webhooks.value.filter(
                    (w) =>
                        w.enabled &&
                        w.type === 'crash-alert' &&
                        w.groupId === groupId
                );
                const payload = buildCrashAlertPayload(
                    session,
                    groupName(groupId)
                );
                for (const wh of hooks) {
                    await queue.enqueue({
                        webhookId: wh.id,
                        eventId: session.id,
                        payload
                    });
                }
            }
        } catch (err) {
            console.warn(
                `[GroupMonitor] crash check failed for ${groupId}:`,
                err
            );
        }
    }

    // ── scheduled leaderboards ───────────────────────────────────────────────
    async function loadVoteKickData(groupId) {
        const vkEvents = [];
        await sqliteService.execute((row) => {
            const data = String(row[1] ?? '');
            const ini = data.match(/initiated against (.+) by (.+?)(?:,|$)/);
            if (ini) {
                vkEvents.push({
                    type: 'initiation',
                    target: ini[1].trim(),
                    initiator: ini[2].trim(),
                    at: row[0]
                });
                return;
            }
            const suc = data.match(/Vote to kick (.+) by (.+?) succeeded/);
            if (suc)
                vkEvents.push({
                    type: 'success',
                    target: suc[1].trim(),
                    initiator: suc[2].trim(),
                    at: row[0]
                });
        }, `SELECT created_at, data FROM gamelog_event WHERE data LIKE '%vote kick%' ORDER BY created_at DESC`);
        const visits = [];
        await sqliteService.execute(
            (row) =>
                visits.push({ created_at: row[0], time: Number(row[1]) || 0 }),
            `SELECT created_at, time FROM gamelog_location WHERE location LIKE @pattern ORDER BY created_at DESC LIMIT 2000`,
            { '@pattern': `%${groupId}%` }
        );
        return groupVoteKicks(vkEvents, visits);
    }

    /**
     * @returns {Promise<{payload: object|null, error?: string}>}
     */
    async function buildScheduledPayload(wh, now = Date.now()) {
        if (!wh.groupId)
            return {
                payload: null,
                error: 'No group selected for this webhook'
            };
        if (groupStore.currentUserGroupsInit && !isMember(wh.groupId)) {
            return {
                payload: null,
                error: 'This account is not a member of the webhook group'
            };
        }
        const name = groupName(wh.groupId);
        if (isVoteKickType(wh.type)) {
            const vkEvents = await loadVoteKickData(wh.groupId);
            return {
                payload: buildLeaderboardPayload(wh, name, { vkEvents }, now)
            };
        }
        const auditEntries = await auditDbLoadEntries(wh.groupId).catch(
            () => []
        );
        if (!auditEntries.length) {
            return {
                payload: null,
                error: 'No audit history cached for this group yet'
            };
        }
        const payload = buildLeaderboardPayload(
            wh,
            name,
            { auditEntries },
            now
        );
        const meta = await auditDbLoadMeta(wh.groupId).catch(() => null);
        if (payload && !meta?.fullyLoaded) {
            payload.embeds[0].footer.text += ` · partial history (${auditEntries.length} entries) — open Group Monitor once to load all`;
        }
        return { payload };
    }

    async function runSchedules(gen) {
        const now = Date.now();
        for (const wh of webhooks.value) {
            if (gen !== generation) return;
            if (
                !wh.enabled ||
                !wh.intervalMinutes ||
                !LEADERBOARD_TYPES.includes(wh.type)
            )
                continue;
            const intervalMs = wh.intervalMinutes * 60_000;
            const slot = Math.floor(now / intervalMs);
            const last = Number(lastSent.value[wh.id]) || 0;
            if (last && Math.floor(last / intervalMs) >= slot) continue;
            try {
                const { payload, error } = await buildScheduledPayload(wh, now);
                if (gen !== generation) return;
                if (!payload) {
                    // Not consumed: retried next cycle once data is there.
                    setWebhookState(wh.id, {
                        lastError: error,
                        lastErrorStatus: null,
                        lastErrorAt: now
                    });
                    continue;
                }
                // A missed slot (VRCX closed) collapses into this single post.
                await queue.enqueue({
                    webhookId: wh.id,
                    eventId: `schedule:${wh.id}:${slot * intervalMs}`,
                    payload
                });
                lastSent.value = { ...lastSent.value, [wh.id]: now };
            } catch (err) {
                console.warn(
                    `[GroupMonitor] scheduled post for ${wh.id} failed to build:`,
                    err
                );
                setWebhookState(wh.id, {
                    lastError: err?.message ?? String(err),
                    lastErrorAt: now
                });
            }
        }
    }

    // ── actions for the UI ───────────────────────────────────────────────────
    function kick() {
        return queue.processDue().then(refreshQueueStats);
    }

    async function setEnabled(value) {
        enabled.value = Boolean(value);
        await saveConfig();
        if (!activeUserId.value) return;
        if (enabled.value) {
            serviceState.value = groupStore.currentUserGroupsInit
                ? 'running'
                : 'waiting';
            nextCycleAt = 0;
            tick();
        } else {
            serviceState.value = 'paused';
        }
    }

    /**
     * @returns {Promise<{ok: boolean, error?: string, webhook?: object}>}
     */
    async function addWebhook(input) {
        if (!activeUserId.value) return { ok: false, error: 'not_logged_in' };
        if (!isValidDiscordWebhookUrl(input?.url))
            return { ok: false, error: 'invalid_url' };
        if (!input?.groupId) return { ok: false, error: 'no_group' };
        const wh = normaliseWebhook({
            ...input,
            id: `wh-${Date.now()}`,
            groupName: groupName(input.groupId),
            enabled: true
        });
        webhooks.value = [...webhooks.value, wh];
        if (!groupSettings.value[wh.groupId]) {
            groupSettings.value = {
                ...groupSettings.value,
                [wh.groupId]: defaultGroupSettings()
            };
        }
        await saveConfig();
        refreshQueueStats();
        return { ok: true, webhook: wh };
    }

    async function updateWebhook(id, patch) {
        const current = webhooks.value.find((w) => w.id === id);
        if (!current) return { ok: false, error: 'not_found' };
        if (patch.url !== undefined && !isValidDiscordWebhookUrl(patch.url))
            return { ok: false, error: 'invalid_url' };
        const next = normaliseWebhook({ ...current, ...patch, id });
        if (patch.groupId !== undefined)
            next.groupName = groupName(next.groupId);
        webhooks.value = webhooks.value.map((w) => (w.id === id ? next : w));
        await saveConfig();
        if (next.enabled && !current.enabled) kick();
        return { ok: true, webhook: next };
    }

    async function removeWebhook(id) {
        webhooks.value = webhooks.value.filter((w) => w.id !== id);
        const ws = { ...webhookState.value };
        delete ws[id];
        webhookState.value = ws;
        const ls = { ...lastSent.value };
        delete ls[id];
        lastSent.value = ls;
        await queue.dropWebhook(id);
        await saveConfig();
        await saveRuntime();
        refreshQueueStats();
    }

    async function testWebhook(id) {
        const wh = webhooks.value.find((w) => w.id === id);
        if (!wh) return { ok: false, error: 'not_found' };
        const res = await queue.enqueue({
            webhookId: id,
            eventId: `test:${Date.now()}`,
            payload: buildTestPayload(wh, groupName(wh.groupId)),
            dedupe: false,
            force: true
        });
        await kick();
        return { ok: res.queued };
    }

    async function sendNow(id) {
        const wh = webhooks.value.find((w) => w.id === id);
        if (!wh) return { ok: false, error: 'not_found' };
        if (!LEADERBOARD_TYPES.includes(wh.type))
            return { ok: false, error: 'not_a_leaderboard' };
        const { payload, error } = await buildScheduledPayload(wh);
        if (!payload) return { ok: false, error };
        const res = await queue.enqueue({
            webhookId: id,
            eventId: `manual:${Date.now()}`,
            payload,
            dedupe: false,
            force: true
        });
        await kick();
        return { ok: res.queued };
    }

    /** Manual "send" of a crash session from the Crash page. */
    async function sendCrashSession(session, groupId) {
        const hooks = webhooks.value.filter(
            (w) =>
                w.enabled && w.type === 'crash-alert' && w.groupId === groupId
        );
        if (!hooks.length) return { ok: false, error: 'no_crash_webhooks' };
        const payload = buildCrashAlertPayload(
            { ...session, windowSeconds: session.windowSeconds },
            groupName(groupId)
        );
        for (const wh of hooks) {
            await queue.enqueue({
                webhookId: wh.id,
                eventId: `manual-crash:${session.startAt}:${Date.now()}`,
                payload,
                dedupe: false
            });
        }
        await kick();
        return { ok: true, count: hooks.length };
    }

    async function setGroupSettings(groupId, patch) {
        if (!groupId) return;
        const next = { ...getGroupSettings(groupId), ...patch };
        next.crashThreshold = Math.max(
            2,
            Math.min(
                50,
                Number(next.crashThreshold) || CRASH_DEFAULTS.threshold
            )
        );
        next.crashWindowSec = Math.max(
            10,
            Math.min(
                600,
                Number(next.crashWindowSec) || CRASH_DEFAULTS.windowSec
            )
        );
        groupSettings.value = { ...groupSettings.value, [groupId]: next };
        await saveConfig();
    }

    async function retryDead(webhookId = null) {
        await queue.retryDead(webhookId);
        await kick();
    }

    async function clearDead(webhookId = null) {
        await queue.clearDead(webhookId);
        refreshQueueStats();
    }

    /**
     * Subscribe to audit entries fetched by the background poller.
     * @param {(groupId: string, entries: any[], totalCount: number|null) => void} cb
     * @returns {() => void} unsubscribe
     */
    function onAuditEntries(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    return {
        activeUserId,
        enabled,
        webhooks,
        groupSettings,
        lastSent,
        serviceState,
        lastCycleAt,
        pollStatus,
        webhookState,
        queueStats,
        deliveryLog,
        recentCrashes,
        settingsLoaded,
        polledGroupIds,
        isPollingGroup,
        hasAuditPermission,
        getGroupSettings,
        setGroupSettings,
        setEnabled,
        addWebhook,
        updateWebhook,
        removeWebhook,
        testWebhook,
        sendNow,
        sendCrashSession,
        retryDead,
        clearDead,
        onAuditEntries,
        // exposed for tests / diagnostics
        tick,
        runCycle,
        start,
        stop,
        _hasTimer: () => timerHandle !== null
    };
});
