// @ts-nocheck
/**
 * Singleton composable for GroupMonitor shared state.
 * All 5 GroupMonitor pages import from here so audit-log data is fetched ONCE
 * and shared reactively — navigating between pages never re-downloads history.
 */

import { ref, nextTick } from 'vue';
import { request } from '../../services/request';
import sqliteService from '../../services/sqlite';
import {
    auditDbLoadEntries,
    auditDbSaveEntries,
    auditDbLoadMeta,
    auditDbSaveMeta,
    auditDbMigrateFromLocalStorage
} from '../../services/auditLogDb';
import { showUserDialog } from '../../coordinators/userCoordinator';
import { toast } from 'vue-sonner';

// ── Module-level singleton state ──────────────────────────────────────────────
// These refs are created ONCE at import time and shared across all 5 pages.
const selectedGroupId = ref('');
const auditLogs = ref([]);
const auditTotal = ref(0);
const auditGroupMeta = ref(null);
const auditFullyLoaded = ref(false);
const auditLimitReached = ref(false);
const isLoadingAudit = ref(false);
const auditAutoLoading = ref(false);
const isFetchingNewLogs = ref(false);
const auditError = ref('');

const vkEvents = ref([]);
const isLoadingVk = ref(false);

const locationHistory = ref([]);
const isLoadingWorlds = ref(false);

const profileCache = ref(new Map());
const profileLookupInProgress = ref(new Set());
const resolvedUserNames = ref({});

// ── Constants ─────────────────────────────────────────────────────────────────
const auditPageSize = 100;
const API_OFFSET_MAX = 7600;

const AUDIT_LABELS = {
    'group.instance.kick': 'Instance Kicked',
    'group.member.remove': 'Member Removed',
    'group.user.ban': 'User Banned',
    'group.user.unban': 'User Unbanned',
    'group.member.join': 'Member Joined',
    'group.member.leave': 'Member Left',
    'group.member.update': 'Member Updated',
    'group.member.role.assign': 'Role Assigned',
    'group.member.role.remove': 'Role Removed',
    'group.member.role.unassign': 'Role Unassigned',
    'group.role.create': 'Role Created',
    'group.role.update': 'Role Updated',
    'group.role.delete': 'Role Deleted',
    'group.instance.warn': 'Instance Warning',
    'group.invite.create': 'Invite Sent',
    'group.invite.accept': 'Invite Accepted',
    'group.invite.cancel': 'Invite Cancelled',
    'group.invite.decline': 'Invite Declined',
    'group.invite.reject': 'Invite Rejected',
    'group.join.request.create': 'Join Requested',
    'group.request.create': 'Join Requested',
    'group.join.request.accept': 'Join Request Accepted',
    'group.join.request.reject': 'Join Request Rejected',
    'group.join.request.cancel': 'Join Request Cancelled',
    'group.instance.create': 'Instance Created',
    'group.instance.close': 'Instance Closed',
    'group.announcement.create': 'Announcement Posted',
    'group.announcement.delete': 'Announcement Deleted',
    'group.post.create': 'Post Created',
    'group.post.delete': 'Post Deleted',
    'group.gallery.image.add': 'Gallery Image Added',
    'group.gallery.image.remove': 'Gallery Image Removed',
    'group.group.update': 'Group Updated'
};

const _AR = 'bg-red-500/15 text-red-500 border-red-500/30';
const _AG = 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30';
const _AB = 'bg-blue-500/15 text-blue-500 border-blue-500/30';
const _AP = 'bg-purple-500/15 text-purple-500 border-purple-500/30';
const _AA = 'bg-amber-500/15 text-amber-500 border-amber-500/30';
const _AX = 'bg-muted/80 text-muted-foreground border-border';

const AUDIT_BADGE_CLASSES = {
    'group.instance.kick': _AR, 'group.instance.warn': _AA, 'group.member.remove': _AR,
    'group.user.ban': _AR, 'group.role.delete': _AR, 'group.post.delete': _AR,
    'group.announcement.delete': _AR, 'group.join.request.reject': _AR,
    'group.invite.reject': _AR, 'group.gallery.image.remove': _AR,
    'group.member.join': _AG, 'group.user.unban': _AG, 'group.join.request.accept': _AG,
    'group.invite.accept': _AG, 'group.instance.create': _AG, 'group.role.create': _AG,
    'group.post.create': _AG, 'group.announcement.create': _AG, 'group.gallery.image.add': _AG,
    'group.invite.create': _AB, 'group.invite.cancel': _AB, 'group.invite.decline': _AB,
    'group.join.request.create': _AB, 'group.request.create': _AB,
    'group.member.role.assign': _AP, 'group.member.role.remove': _AP,
    'group.member.role.unassign': _AP, 'group.role.update': _AP,
    'group.member.update': _AA, 'group.group.update': _AA, 'group.instance.close': _AA,
};

function auditLabel(t) { return AUDIT_LABELS[t] ?? t; }
function auditBadgeClass(t) { return AUDIT_BADGE_CLASSES[t] ?? _AX; }

// ── Internal helpers ──────────────────────────────────────────────────────────
let autoLoadAbort = false;

function mergeAuditEntries(existing, incoming) {
    const ids = new Set(existing.map((e) => e.id));
    const novel = incoming.filter((e) => !ids.has(e.id));
    return [...novel, ...existing];
}

function oldestAuditDate() {
    if (!auditLogs.value.length) return null;
    return auditLogs.value.reduce(
        (min, e) => (!min || e.created_at < min ? e.created_at : min), null
    );
}

function sortRows(rows, col, dir) {
    return [...rows].sort((a, b) => {
        const av = a[col] ?? '';
        const bv = b[col] ?? '';
        const cmp = (typeof av === 'number' && typeof bv === 'number')
            ? av - bv
            : String(av).localeCompare(String(bv));
        return dir === 'desc' ? -cmp : cmp;
    });
}

function toggleSort(colRef, dirRef, col) {
    if (colRef.value === col) dirRef.value = dirRef.value === 'asc' ? 'desc' : 'asc';
    else { colRef.value = col; dirRef.value = 'desc'; }
}

function parseKickTarget(description) {
    if (!description) return null;
    const m = description.match(/has issued an instance kick for (.+?)\.?\s*$/i);
    return m ? m[1].trim() : null;
}

function parseTargetFromDescription(desc) {
    if (!desc) return null;
    let m = desc.match(/^User (.+?) has been /i);
    if (m) return m[1].trim();
    m = desc.match(/\bfor (.+?)\.?\s*$/i);
    if (m) return m[1].trim();
    m = desc.match(/(?:permanently )?(?:banned|removed|kicked) (.+?) from/i);
    if (m) return m[1].trim();
    return null;
}

function parseActorFromDescription(desc) {
    if (!desc) return null;
    const byM = desc.match(/ by (.+?)\.?\s*$/i);
    if (byM) return byM[1].trim();
    const m = desc.match(/^(.+?) has /);
    return m ? m[1].trim() : null;
}

function resolveName(displayName, id) {
    if (displayName && !displayName.startsWith('usr_')) return displayName;
    if (id && resolvedUserNames.value[id]) return resolvedUserNames.value[id];
    return null;
}

function resolveKickTarget(r) {
    return r.targetDisplayName || parseKickTarget(r.description) || resolvedUserNames.value[r.targetId] || null;
}

function resolveAuditActor(entry) {
    if (entry.actorDisplayName && !entry.actorDisplayName.startsWith('usr_')) return entry.actorDisplayName;
    if (entry.actorId && resolvedUserNames.value[entry.actorId]) return resolvedUserNames.value[entry.actorId];
    return parseActorFromDescription(entry.description) || null;
}

function resolveAuditTarget(entry) {
    if (entry.targetDisplayName && !entry.targetDisplayName.startsWith('usr_')) return entry.targetDisplayName;
    if (entry.targetId && resolvedUserNames.value[entry.targetId]) return resolvedUserNames.value[entry.targetId];
    return parseTargetFromDescription(entry.description) || null;
}

// ── Name resolution queue ─────────────────────────────────────────────────────
let _nameQueue = [];
let _nameTimer = null;

function _processNameQueue() {
    const userId = _nameQueue.shift();
    if (!userId) { clearInterval(_nameTimer); _nameTimer = null; return; }
    request(`users/${userId}`, { method: 'GET' })
        .then((d) => {
            if (d?.displayName) resolvedUserNames.value = { ...resolvedUserNames.value, [userId]: d.displayName };
        })
        .catch(() => {});
}

function queueNameResolution(userId) {
    if (!userId || !userId.startsWith('usr_') || userId in resolvedUserNames.value) return;
    resolvedUserNames.value[userId] = null;
    _nameQueue.push(userId);
    if (!_nameTimer) _nameTimer = setInterval(_processNameQueue, 700);
}

// ── Profile dialog ────────────────────────────────────────────────────────────
async function openProfileById(userId) {
    if (!userId) return;
    showUserDialog(userId);
}

async function openProfileByName(displayName) {
    if (!displayName) return;
    if (profileCache.value.has(displayName)) {
        const uid = profileCache.value.get(displayName);
        if (uid) showUserDialog(uid);
        else toast.info(`No profile found for "${displayName}"`);
        return;
    }
    if (profileLookupInProgress.value.has(displayName)) return;
    profileLookupInProgress.value.add(displayName);
    try {
        const data = await request('users', { method: 'GET', params: { search: displayName, n: 1, fuzzy: false } });
        const users = Array.isArray(data) ? data : data?.results ?? [];
        const match = users.find((u) => u.displayName?.toLowerCase() === displayName.toLowerCase()) ?? users[0];
        if (match?.id) {
            profileCache.value.set(displayName, match.id);
            showUserDialog(match.id);
        } else {
            profileCache.value.set(displayName, null);
            toast.info(`Could not find profile for "${displayName}"`);
        }
    } catch (err) {
        console.error('[GroupMonitor] Profile lookup failed:', err);
        toast.error('Profile lookup failed');
    } finally {
        profileLookupInProgress.value.delete(displayName);
    }
}

// ── Audit log fetch helpers ───────────────────────────────────────────────────
async function dbSaveAuditBatch(groupId, novelEntries, total, fullyLoaded = false) {
    try {
        if (novelEntries.length) await auditDbSaveEntries(groupId, novelEntries);
        await auditDbSaveMeta(groupId, { total, fullyLoaded, savedAt: Date.now() });
    } catch (err) { console.warn('[GroupMonitor] IndexedDB save failed:', err); }
}

async function fetchAuditPage(groupId, page) {
    const data = await request(`groups/${groupId}/auditLogs`, {
        method: 'GET',
        params: { n: auditPageSize, offset: page * auditPageSize }
    });
    const entries = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    return { entries, totalCount: data?.totalCount ?? entries.length };
}

async function fetchAuditBefore(groupId, beforeDate) {
    const data = await request(`groups/${groupId}/auditLogs`, {
        method: 'GET',
        params: { n: auditPageSize, endDate: beforeDate }
    });
    const entries = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    return entries;
}

// ── Background auto-loaders ───────────────────────────────────────────────────
async function autoLoadAuditByDate(groupId) {
    auditLimitReached.value = true;
    console.debug('[GroupMonitor] Switching to date-based audit fetch past offset limit');
    while (true) {
        if (autoLoadAbort || selectedGroupId.value !== groupId) break;
        if (auditTotal.value > 0 && auditLogs.value.length >= auditTotal.value) break;
        const oldest = oldestAuditDate();
        if (!oldest) break;
        await new Promise((r) => setTimeout(r, 2000));
        if (autoLoadAbort || selectedGroupId.value !== groupId) break;
        try {
            const entries = await fetchAuditBefore(groupId, oldest);
            const novel = entries.filter((e) => e.created_at < oldest && !auditLogs.value.find((x) => x.id === e.id));
            if (novel.length === 0) break;
            auditLogs.value = mergeAuditEntries(auditLogs.value, novel);
            await dbSaveAuditBatch(groupId, novel, auditTotal.value, false);
        } catch (err) {
            console.error('[GroupMonitor] Date-based audit fetch error:', err);
            break;
        }
    }
    if (selectedGroupId.value === groupId) {
        auditAutoLoading.value = false;
        auditFullyLoaded.value = true;
        await dbSaveAuditBatch(groupId, [], auditTotal.value, true);
        console.debug('[GroupMonitor] Audit history fully loaded:', auditLogs.value.length, 'entries');
    }
}

async function autoLoadAuditPages(groupId, startPage, total) {
    auditAutoLoading.value = true;
    const maxOffsetPage = Math.floor(API_OFFSET_MAX / auditPageSize);
    const totalPages = Math.min(Math.ceil(total / auditPageSize), maxOffsetPage + 1);
    for (let page = startPage; page <= maxOffsetPage && page < totalPages; page++) {
        if (autoLoadAbort || selectedGroupId.value !== groupId) break;
        await new Promise((r) => setTimeout(r, 1500));
        if (autoLoadAbort || selectedGroupId.value !== groupId) break;
        try {
            const { entries } = await fetchAuditPage(groupId, page);
            if (entries.length === 0) break;
            auditLogs.value = mergeAuditEntries(auditLogs.value, entries);
            await dbSaveAuditBatch(groupId, entries, auditTotal.value, false);
        } catch (err) {
            console.error('[GroupMonitor] Auto-load page error:', err);
            break;
        }
    }
    if (selectedGroupId.value === groupId) {
        if (auditLogs.value.length > API_OFFSET_MAX) {
            autoLoadAuditByDate(groupId);
            return;
        }
        auditAutoLoading.value = false;
        auditFullyLoaded.value = true;
        await dbSaveAuditBatch(groupId, [], auditTotal.value, true);
    }
}

// ── Core load functions ───────────────────────────────────────────────────────
async function pollNewAuditLogs() {
    const groupId = selectedGroupId.value;
    if (!groupId || isFetchingNewLogs.value || auditAutoLoading.value) return;
    isFetchingNewLogs.value = true;
    try {
        const { entries, totalCount } = await fetchAuditPage(groupId, 0);
        if (entries.length > 0) {
            const before = auditLogs.value.length;
            auditLogs.value = mergeAuditEntries(auditLogs.value, entries);
            auditTotal.value = totalCount;
            if (auditLogs.value.length !== before) {
                const novel = entries.filter((e) => !auditLogs.value.slice(entries.length).find((x) => x.id === e.id));
                await dbSaveAuditBatch(groupId, novel.length ? novel : entries, totalCount, auditFullyLoaded.value);
            }
        }
    } catch { /* silent - poll failures are non-fatal */ }
    finally { isFetchingNewLogs.value = false; }
}

async function loadAuditLogs(groupId) {
    if (!groupId) return;
    autoLoadAbort = false;
    auditError.value = '';
    const meta = auditGroupMeta.value;
    isLoadingAudit.value = true;
    try {
        const { entries, totalCount } = await fetchAuditPage(groupId, 0);
        auditTotal.value = totalCount;
        const before = auditLogs.value.length;
        auditLogs.value = mergeAuditEntries(auditLogs.value, entries);
        const changed = auditLogs.value.length !== before;

        if (auditLogs.value.length >= totalCount) {
            if (!meta?.fullyLoaded || changed) {
                auditFullyLoaded.value = true;
                await dbSaveAuditBatch(groupId, changed ? entries : [], totalCount, true);
            }
            return;
        }

        if (changed) {
            await dbSaveAuditBatch(groupId, entries, auditTotal.value, meta?.fullyLoaded ?? false);
        }

        if (meta?.fullyLoaded) return;

        if (auditLogs.value.length > API_OFFSET_MAX) {
            auditAutoLoading.value = true;
            autoLoadAuditByDate(groupId);
            return;
        }

        const nextPage = Math.ceil(auditLogs.value.length / auditPageSize);
        autoLoadAuditPages(groupId, nextPage, totalCount);
    } catch (err) {
        console.error('[GroupMonitor] Audit load error:', err);
        if (!auditLogs.value.length) auditError.value = err?.message ?? 'Failed to load audit logs';
    } finally {
        isLoadingAudit.value = false;
    }
}

async function loadVoteKickHistory() {
    isLoadingVk.value = true;
    console.debug('[GroupMonitor] Loading vote-to-kick history from gamelog_event');
    try {
        const events = [];
        await sqliteService.execute(
            (row) => {
                const data = String(row[2] ?? '');
                const ini = data.match(/initiated against (.+) by (.+?)(?:,|$)/);
                if (ini) { events.push({ type: 'initiation', target: ini[1].trim(), initiator: ini[2].trim(), at: row[1] }); return; }
                const suc = data.match(/Vote to kick (.+) by (.+?) succeeded/);
                if (suc) events.push({ type: 'success', target: suc[1].trim(), initiator: suc[2].trim(), at: row[1] });
            },
            `SELECT id, created_at, data FROM gamelog_event WHERE data LIKE '%vote kick%' ORDER BY created_at DESC`
        );
        vkEvents.value = events;
        console.debug('[GroupMonitor] Vote-kick events loaded:', events.length);
    } catch (err) {
        console.error('[GroupMonitor] Vote-kick error:', err);
        vkEvents.value = [];
    } finally {
        isLoadingVk.value = false;
    }
}

async function loadLocationHistory(groupId) {
    if (!groupId) return;
    isLoadingWorlds.value = true;
    console.debug('[GroupMonitor] Loading location history for', groupId);
    try {
        const rows = [];
        await sqliteService.execute(
            (row) => rows.push({
                created_at: row[1], location: row[2], worldId: row[3],
                worldName: row[4], time: row[5] ?? 0
            }),
            `SELECT * FROM gamelog_location WHERE location LIKE '%${groupId}%' ORDER BY created_at DESC LIMIT 2000`
        );
        locationHistory.value = rows;
        console.debug('[GroupMonitor] Location rows:', rows.length);
    } catch (err) {
        console.error('[GroupMonitor] Location history error:', err);
        locationHistory.value = [];
    } finally {
        isLoadingWorlds.value = false;
    }
}

async function handleGroupChange(id) {
    if (!id) return;
    localStorage.setItem('gm-group-id', id);

    // Skip if this group is already loaded in memory this session
    if (id === selectedGroupId.value && auditLogs.value.length > 0) return;

    autoLoadAbort = true;
    await new Promise((r) => setTimeout(r, 50));
    autoLoadAbort = false;
    selectedGroupId.value = id;

    auditLogs.value = [];
    auditGroupMeta.value = null;
    locationHistory.value = [];
    auditLimitReached.value = false;
    auditFullyLoaded.value = false;

    await auditDbMigrateFromLocalStorage(id);

    const [cachedEntries, cachedMeta] = await Promise.all([
        auditDbLoadEntries(id).catch(() => []),
        auditDbLoadMeta(id).catch(() => null)
    ]);

    auditGroupMeta.value = cachedMeta;

    if (cachedEntries.length) {
        auditLogs.value = cachedEntries;
        auditTotal.value = cachedMeta?.total ?? cachedEntries.length;
        if (cachedMeta?.fullyLoaded) auditFullyLoaded.value = true;
    }

    console.debug('[GroupMonitor] Group selected:', id,
        '— DB entries:', cachedEntries.length,
        cachedMeta?.fullyLoaded ? '(fully cached)' : '(cache incomplete)');

    await Promise.all([loadAuditLogs(id), loadLocationHistory(id)]);
}

function refreshAll() {
    loadVoteKickHistory();
    if (selectedGroupId.value) {
        loadLocationHistory(selectedGroupId.value);
        pollNewAuditLogs();
    }
}

// ── Singleton polling timer ───────────────────────────────────────────────────
// Reference-counted so polling runs only while at least one GM page is mounted.
let _mountCount = 0;
let _pollInterval = null;
let _vkPollInterval = null;

function startPolling() {
    _mountCount++;
    if (_pollInterval) return;
    _pollInterval = setInterval(pollNewAuditLogs, 60_000);
    _vkPollInterval = setInterval(loadVoteKickHistory, 90_000);
}

function stopPolling() {
    _mountCount = Math.max(0, _mountCount - 1);
    if (_mountCount > 0) return;
    clearInterval(_pollInterval);
    clearInterval(_vkPollInterval);
    _pollInterval = null;
    _vkPollInterval = null;
    autoLoadAbort = true;
}

// ── Public API ────────────────────────────────────────────────────────────────
export function useGroupMonitorData() {
    return {
        // state
        selectedGroupId,
        auditLogs,
        auditTotal,
        auditGroupMeta,
        auditFullyLoaded,
        auditLimitReached,
        isLoadingAudit,
        auditAutoLoading,
        isFetchingNewLogs,
        auditError,
        vkEvents,
        isLoadingVk,
        locationHistory,
        isLoadingWorlds,
        profileCache,
        profileLookupInProgress,
        resolvedUserNames,
        // constants
        auditPageSize,
        API_OFFSET_MAX,
        AUDIT_LABELS,
        AUDIT_BADGE_CLASSES,
        // helpers
        auditLabel,
        auditBadgeClass,
        sortRows,
        toggleSort,
        mergeAuditEntries,
        parseKickTarget,
        parseTargetFromDescription,
        parseActorFromDescription,
        resolveName,
        resolveKickTarget,
        resolveAuditActor,
        resolveAuditTarget,
        queueNameResolution,
        // functions
        handleGroupChange,
        loadAuditLogs,
        pollNewAuditLogs,
        loadVoteKickHistory,
        loadLocationHistory,
        refreshAll,
        openProfileById,
        openProfileByName,
        // polling lifecycle
        startPolling,
        stopPolling,
    };
}
