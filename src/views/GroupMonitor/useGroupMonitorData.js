// @ts-nocheck
/**
 * Singleton composable for GroupMonitor shared state.
 * All 5 GroupMonitor pages import from here so audit-log data is fetched ONCE
 * and shared reactively — navigating between pages never re-downloads history.
 */

import { ref, computed, watch } from 'vue';
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
import { watchState } from '../../services/watchState';
import { useGroupMonitorStore } from '../../stores/groupMonitor';
import { useUserStore } from '../../stores/user';
import { HISTORY_VERSION, isHistoryComplete, newestMark } from '../../services/groupMonitor/auditGaps';
import { pollAuditLog } from '../../services/groupMonitor/auditPoller';
import { drainGaps, indexedAuditDb, recordGap, runRepairScan } from '../../services/groupMonitor/gapBackfill';

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

// Webhooks, crash alerts and background polling live in the groupMonitor
// Pinia store (src/stores/groupMonitor.js), which runs from login regardless
// of which page is open. This module only holds what the pages display.

// ── Group audit permission cache ──────────────────────────────────────────────
const groupAuditPermIds = ref(new Set());    // groupIds where user has group-audit-view
const groupsWithCachedData = ref(new Set()); // groupIds that have local IDB audit data
const groupPermCheckDone = ref(false);

// Load permission cache synchronously from localStorage (so the dropdown isn't empty on first render)
;(function loadGroupPermCache() {
    try {
        const p = localStorage.getItem('gm-group-audit-perms');
        if (p) groupAuditPermIds.value = new Set(JSON.parse(p));
        const d = localStorage.getItem('gm-group-audit-data-ids');
        if (d) groupsWithCachedData.value = new Set(JSON.parse(d));
    } catch {
        // corrupt cache: start empty, it is rebuilt on the next group load
    }
})();

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
    'group.request.accept': 'Join Request Accepted',
    'group.request.reject': 'Join Request Rejected',
    'group.request.block': 'Join Request Blocked',
    'group.request.cancel': 'Join Request Cancelled',
    'group.instance.create': 'Instance Created',
    'group.instance.close': 'Instance Closed',
    'group.announcement.create': 'Announcement Posted',
    'group.announcement.delete': 'Announcement Deleted',
    'group.post.create': 'Post Created',
    'group.post.delete': 'Post Deleted',
    'group.gallery.image.add': 'Gallery Image Added',
    'group.gallery.image.remove': 'Gallery Image Removed',
    'group.group.update': 'Group Updated',
    'group.update': 'Group Updated',
    'group.create': 'Group Created',
    'group.member.user.update': 'Member Settings Updated',
    'group.instance.announcement': 'Instance Announcement',
    'group.transfer.start': 'Ownership Transfer Started',
    'group.transfer.accept': 'Ownership Transfer Accepted'
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
    'group.request.reject': _AR, 'group.request.block': _AR, 'group.request.accept': _AG,
    'group.request.cancel': _AB, 'group.create': _AG, 'group.update': _AA,
    'group.member.user.update': _AA, 'group.instance.announcement': _AB,
    'group.transfer.start': _AP, 'group.transfer.accept': _AP,
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
    let m = desc.match(/^User (.+?) (?:has been|was) /i);
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
    return r.targetDisplayName || parseKickTarget(r.description) || resolvedUserNames.value[r.targetId]
        || parseTargetFromDescription(r.description) || null;
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
async function dbSaveAuditBatch(groupId, novelEntries, total, fullyLoaded = false, extra = {}) {
    let entriesSaved = true;
    try {
        if (novelEntries.length) await auditDbSaveEntries(groupId, novelEntries);
    } catch (err) {
        console.warn('[GroupMonitor] IndexedDB entries save failed:', err);
        entriesSaved = false;
    }
    // Never set fullyLoaded=true if entries failed to persist — it would leave the
    // DB with meta claiming full history but no actual rows on next open.
    const metaFullyLoaded = fullyLoaded && (entriesSaved || novelEntries.length === 0);
    const meta = { total, fullyLoaded: metaFullyLoaded, savedAt: Date.now(), ...extra };
    if (metaFullyLoaded) meta.historyVersion = HISTORY_VERSION;
    try {
        await auditDbSaveMeta(groupId, meta);
    } catch (err) {
        console.warn('[GroupMonitor] IndexedDB meta save failed:', err);
    }
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

async function fetchAuditWindow(groupId, params) {
    const data = await request(`groups/${groupId}/auditLogs`, {
        method: 'GET',
        params: { n: auditPageSize, ...params },
        silentErrors: true
    });
    return Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isAborted(groupId) {
    return autoLoadAbort || selectedGroupId.value !== groupId;
}

// ── Background auto-loaders ───────────────────────────────────────────────────
// History is only marked complete when VRChat itself says there is nothing
// older (a date page with fewer entries than asked for). Errors, aborts and
// pages without progress leave it incomplete, so the next open resumes.
async function finishHistory(groupId) {
    if (selectedGroupId.value !== groupId) return;
    auditAutoLoading.value = false;
    auditFullyLoaded.value = true;
    await dbSaveAuditBatch(groupId, [], auditTotal.value, true, { lastError: null });
    console.debug('[GroupMonitor] Audit history fully loaded:', auditLogs.value.length, 'entries');
}

async function stopHistory(groupId, reason) {
    if (selectedGroupId.value !== groupId) return;
    auditAutoLoading.value = false;
    auditFullyLoaded.value = false;
    const lastError = typeof reason === 'string' ? reason : (reason?.message ?? String(reason));
    console.warn('[GroupMonitor] Audit history load stopped, resumes next time:', lastError);
    await dbSaveAuditBatch(groupId, [], auditTotal.value, false, { lastError });
}

async function autoLoadAuditByDate(groupId) {
    auditAutoLoading.value = true;
    auditLimitReached.value = true;
    console.debug('[GroupMonitor] Fetching older audit entries by date');
    while (true) {
        if (isAborted(groupId)) break;
        const oldest = oldestAuditDate();
        if (!oldest) {
            // nothing cached and page 0 was empty: the group has no audit log yet
            await finishHistory(groupId);
            return;
        }
        await sleep(1000);
        if (isAborted(groupId)) break;
        let entries;
        try {
            entries = await fetchAuditBefore(groupId, oldest);
        } catch (err) {
            await stopHistory(groupId, err);
            return;
        }
        if (isAborted(groupId)) break;
        const known = new Set(auditLogs.value.map((e) => e.id));
        const novel = entries.filter((e) => e?.id != null && !known.has(e.id));
        if (novel.length) {
            auditLogs.value = mergeAuditEntries(auditLogs.value, novel);
            await dbSaveAuditBatch(groupId, novel, auditTotal.value, false);
        }
        if (entries.length < auditPageSize) {
            await finishHistory(groupId);
            return;
        }
        if (!novel.length) {
            await stopHistory(groupId, 'no older entries returned for a full page');
            return;
        }
    }
    if (selectedGroupId.value === groupId) auditAutoLoading.value = false;
}

async function autoLoadAuditPages(groupId, startPage, total) {
    auditAutoLoading.value = true;
    const maxOffsetPage = Math.floor(API_OFFSET_MAX / auditPageSize);
    const totalPages = Math.min(Math.ceil(total / auditPageSize), maxOffsetPage + 1);
    for (let page = startPage; page <= maxOffsetPage && page < totalPages; page++) {
        if (isAborted(groupId)) break;
        await sleep(800);
        if (isAborted(groupId)) break;
        try {
            const { entries } = await fetchAuditPage(groupId, page);
            if (entries.length === 0) break;
            auditLogs.value = mergeAuditEntries(auditLogs.value, entries);
            await dbSaveAuditBatch(groupId, entries, auditTotal.value, false);
        } catch (err) {
            await stopHistory(groupId, err);
            return;
        }
    }
    if (isAborted(groupId)) {
        if (selectedGroupId.value === groupId) auditAutoLoading.value = false;
        return;
    }
    // The offset pages ran out (end of the list, the offset cap, or an empty
    // page): confirm the end by date before calling the history complete.
    await autoLoadAuditByDate(groupId);
}

// ── Gap catch-up / backfill ───────────────────────────────────────────────────
const PAGE_CATCHUP_MAX_PAGES = 30;
const PAGE_CATCHUP_DELAY_MS = 800;
const POLL_CATCHUP_MAX_PAGES = 5;
/** Gap requests per 60 s refresh while the background service is not polling this group. */
const PAGE_GAP_BUDGET = 2;
const _repairScanned = new Set();
// Thrown to stop a catch-up when the group changes: returning an empty page
// instead would look like the end of the log and hide the unfetched window.
const CATCH_UP_ABORTED = new Error('catch-up aborted');

function _backgroundPaused() {
    try {
        return Date.now() < (useGroupMonitorStore().backfillPausedUntil ?? 0);
    } catch {
        return false;
    }
}

/**
 * Pages back from the newest entry until it reaches the newest cached entry
 * (paced). Whatever could not be fetched within the page budget is queued as
 * a gap for backfill.
 */
async function catchUpToCache(groupId, maxPages) {
    const cacheMark = auditLogs.value.length ? newestMark(auditLogs.value) : null;
    const res = await pollAuditLog({
        fetchPage: async (offset) => {
            if (offset > 0) {
                await sleep(PAGE_CATCHUP_DELAY_MS);
                if (isAborted(groupId)) throw CATCH_UP_ABORTED;
            }
            return fetchAuditPage(groupId, offset / auditPageSize);
        },
        watermark: null,
        cacheMark,
        maxPages
    });
    if (res.gap) {
        await recordGap(indexedAuditDb, groupId, res.gap, 'catch-up').catch((err) =>
            console.warn('[GroupMonitor] could not queue audit gap:', err)
        );
    }
    return res;
}

/** Fills queued gaps of the selected group when the background service does not. */
async function drainPageGaps(groupId) {
    if (_backgroundPaused()) return;
    try {
        if (!_repairScanned.has(groupId) && auditLogs.value.length) {
            _repairScanned.add(groupId);
            await runRepairScan({ db: indexedAuditDb, groupId, entries: auditLogs.value });
        }
        const res = await drainGaps({
            db: indexedAuditDb,
            groupId,
            fetchWindow: (params) => fetchAuditWindow(groupId, params),
            budget: PAGE_GAP_BUDGET,
            isPaused: _backgroundPaused
        });
        if (res.fetched.length) mergeFetchedEntries(groupId, res.fetched, null);
    } catch (err) {
        console.debug('[GroupMonitor] gap backfill failed (non-fatal):', err);
    }
}

// ── Core load functions ───────────────────────────────────────────────────────
async function pollNewAuditLogs({ force = false } = {}) {
    const groupId = selectedGroupId.value;
    if (!groupId || isFetchingNewLogs.value || isLoadingAudit.value) return;
    // The background service already polls monitored groups (and fills their
    // gaps) and pushes the entries here (see _attachBackgroundFeed); don't hit
    // the API twice.
    if (!force && _backgroundPolls(groupId)) return;
    isFetchingNewLogs.value = true;
    try {
        const res = await catchUpToCache(groupId, POLL_CATCHUP_MAX_PAGES);
        mergeFetchedEntries(groupId, res.fetched, res.totalCount);
        if (!_backgroundPolls(groupId) && !auditAutoLoading.value) await drainPageGaps(groupId);
    } catch (err) {
        if (err !== CATCH_UP_ABORTED) console.debug('[GroupMonitor] poll failed (non-fatal):', err);
    } finally {
        isFetchingNewLogs.value = false;
    }
}

function mergeFetchedEntries(groupId, entries, totalCount) {
    if (groupId !== selectedGroupId.value || !entries?.length) return;
    const known = new Set(auditLogs.value.map((e) => e.id));
    const novel = entries.filter((e) => !known.has(e.id));
    if (Number.isFinite(totalCount)) auditTotal.value = Math.max(auditTotal.value, totalCount);
    if (!novel.length) return;
    auditLogs.value = [...novel, ...auditLogs.value];
    dbSaveAuditBatch(groupId, novel, auditTotal.value, auditFullyLoaded.value);
}

function _backgroundPolls(groupId) {
    try {
        return useGroupMonitorStore().isPollingGroup(groupId);
    } catch {
        return false;
    }
}

let _feedAttached = false;
// Entries pushed by the background service while the history backfill runs are
// merged (deduped by id) once it finishes, so none go missing until a reload.
let _feedBuffer = [];
watch([auditAutoLoading, isLoadingAudit], ([autoLoading, loading]) => {
    if (autoLoading || loading || !_feedBuffer.length) return;
    const buffered = _feedBuffer;
    _feedBuffer = [];
    for (const b of buffered) mergeFetchedEntries(b.groupId, b.entries, b.totalCount);
});
function _attachBackgroundFeed() {
    if (_feedAttached) return;
    try {
        useGroupMonitorStore().onAuditEntries((groupId, entries, totalCount) => {
            // don't race the history backfill's own merge/meta bookkeeping
            if (auditAutoLoading.value || isLoadingAudit.value) {
                if (groupId === selectedGroupId.value) _feedBuffer.push({ groupId, entries, totalCount });
                return;
            }
            mergeFetchedEntries(groupId, entries, totalCount);
        });
        _feedAttached = true;
    } catch (err) {
        console.warn('[GroupMonitor] could not attach to background feed:', err);
    }
}

async function loadAuditLogs(groupId) {
    if (!groupId) return;
    autoLoadAbort = false;
    auditError.value = '';
    const meta = auditGroupMeta.value;
    const hadCache = auditLogs.value.length > 0;
    let history = null;
    isLoadingAudit.value = true;
    try {
        // No "cache length >= totalCount" shortcut: totalCount only counts what
        // VRChat still keeps, and a cache can be larger than that with holes.
        const res = await catchUpToCache(groupId, PAGE_CATCHUP_MAX_PAGES);
        if (selectedGroupId.value !== groupId) return;
        if (Number.isFinite(res.totalCount)) auditTotal.value = res.totalCount;
        const known = new Set(auditLogs.value.map((e) => e.id));
        const novel = res.fetched.filter((e) => !known.has(e.id));
        if (novel.length) {
            auditLogs.value = mergeAuditEntries(auditLogs.value, novel);
            await dbSaveAuditBatch(groupId, novel, auditTotal.value, isHistoryComplete(meta));
        }
        if (!isHistoryComplete(meta)) history = hadCache ? 'date' : 'offset';
    } catch (err) {
        if (err === CATCH_UP_ABORTED) return;
        console.error('[GroupMonitor] Audit load error:', err);
        if (!auditLogs.value.length) auditError.value = err?.message ?? 'Failed to load audit logs';
    } finally {
        isLoadingAudit.value = false;
    }
    // Older history: a fresh cache pages by offset; an existing one resumes
    // from its oldest entry by date (offsets shift as VRChat drops old entries).
    if (history === 'offset') {
        const nextPage = Math.ceil(auditLogs.value.length / auditPageSize);
        autoLoadAuditPages(groupId, Math.max(1, nextPage), auditTotal.value);
    } else if (history === 'date') {
        autoLoadAuditByDate(groupId);
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

let _locationLoadedAt = 0;
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
        if (selectedGroupId.value !== groupId) return;
        locationHistory.value = rows;
        _locationLoadedAt = Date.now();
        console.debug('[GroupMonitor] Location rows:', rows.length);
    } catch (err) {
        console.error('[GroupMonitor] Location history error:', err);
        locationHistory.value = [];
    } finally {
        isLoadingWorlds.value = false;
    }
}

function _currentUserId() {
    try {
        return useUserStore().currentUser?.id ?? '';
    } catch {
        return '';
    }
}

/** Last group opened in Group Monitor on this account (falls back to the pre-2.3 global key). */
function lastViewedGroupId() {
    try {
        const uid = _currentUserId();
        return (uid && localStorage.getItem(`gm-group-id:${uid}`)) || localStorage.getItem('gm-group-id') || '';
    } catch {
        return '';
    }
}

function _rememberViewedGroup(id) {
    try {
        const uid = _currentUserId();
        if (uid) localStorage.setItem(`gm-group-id:${uid}`, id);
        localStorage.setItem('gm-group-id', id);
    } catch {
        // storage blocked: only the per-session selection is lost
    }
    try {
        useGroupMonitorStore().noteViewedGroup(id);
    } catch {
        // store not ready (tests): background polling picks it up next login
    }
}

async function handleGroupChange(id) {
    if (!id) return;
    _rememberViewedGroup(id);

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

    const [cachedEntries, cachedMetaRaw] = await Promise.all([
        auditDbLoadEntries(id).catch(() => []),
        auditDbLoadMeta(id).catch(() => null)
    ]);
    if (selectedGroupId.value !== id) return;

    let cachedMeta = cachedMetaRaw;
    // One-time reset: builds before 2.3 marked history "fully loaded" after
    // fetch errors and at the offset cap. Only this loader's flag is trusted;
    // the history walk resumes from the oldest cached entry.
    if (cachedMeta?.fullyLoaded && !isHistoryComplete(cachedMeta)) {
        cachedMeta = { ...cachedMeta, fullyLoaded: false };
        auditDbSaveMeta(id, { fullyLoaded: false }).catch(() => {});
    }
    auditGroupMeta.value = cachedMeta;

    if (cachedEntries.length) {
        auditLogs.value = cachedEntries;
        auditTotal.value = cachedMeta?.total ?? cachedEntries.length;
        if (isHistoryComplete(cachedMeta)) auditFullyLoaded.value = true;
        markGroupHasData(id);
    }

    console.debug('[GroupMonitor] Group selected:', id,
        '— DB entries:', cachedEntries.length,
        isHistoryComplete(cachedMeta) ? '(fully cached)' : '(cache incomplete)');

    await Promise.all([loadAuditLogs(id), loadLocationHistory(id)]);
    if (auditLogs.value.length) markGroupHasData(id);
}

function refreshAll() {
    loadVoteKickHistory();
    if (selectedGroupId.value) {
        loadLocationHistory(selectedGroupId.value);
        pollNewAuditLogs({ force: true });
    }
}

// ── Singleton UI refresh timer ────────────────────────────────────────────────
// Reference-counted display refresh for the page being viewed. Webhooks and
// alerts do NOT depend on this; they run from the groupMonitor store.
let _mountCount = 0;
let _pollInterval = null;
let _vkPollInterval = null;

/** Minute ticker: time-window filters ("last 7 days") recompute with it. */
const nowTick = ref(Date.now());

function _refreshTick() {
    nowTick.value = Date.now();
    pollNewAuditLogs();
}

function _slowRefresh() {
    loadVoteKickHistory();
    if (selectedGroupId.value) loadLocationHistory(selectedGroupId.value);
}

function startPolling() {
    _mountCount++;
    _attachBackgroundFeed();
    if (_pollInterval) return;
    _pollInterval = setInterval(_refreshTick, 60_000);
    _vkPollInterval = setInterval(_slowRefresh, 90_000);
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

/**
 * KeepAlive brings a page back with whatever it computed when it was left:
 * refresh the time window and the SQLite-backed data if they are stale.
 */
function onPageActivated() {
    nowTick.value = Date.now();
    if (!selectedGroupId.value) return;
    if (Date.now() - _locationLoadedAt > 60_000) _slowRefresh();
    pollNewAuditLogs();
}

// Account switch / logout: drop the previous account's view state so the next
// account never sees (or re-uses) it. Pages remount after login because
// MainLayout is v-if'd on isLoggedIn.
watch(
    () => watchState.isLoggedIn,
    (loggedIn) => {
        if (loggedIn) return;
        autoLoadAbort = true;
        selectedGroupId.value = '';
        auditLogs.value = [];
        auditTotal.value = 0;
        auditGroupMeta.value = null;
        auditFullyLoaded.value = false;
        auditLimitReached.value = false;
        auditAutoLoading.value = false;
        auditError.value = '';
        vkEvents.value = [];
        locationHistory.value = [];
        resolvedUserNames.value = {};
        profileCache.value = new Map();
        _nameQueue = [];
    }
)

// ── Warn leaderboards (derived from auditLogs singleton) ─────────────────────
const warnLeaderboard = computed(() => {
    const warns = auditLogs.value.filter((r) => r.eventType === 'group.instance.warn');
    const map = new Map();
    for (const w of warns) {
        const actorId = w.actorId || null;
        let actorName = (actorId && resolvedUserNames.value[actorId]) || w.actorDisplayName || '—';
        const key = actorId ?? actorName;
        if (!map.has(key)) map.set(key, { actor: actorName, id: actorId, count: 0 });
        else if (actorId && resolvedUserNames.value[actorId]) map.get(key).actor = resolvedUserNames.value[actorId];
        map.get(key).count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
});

const mostWarnedLeaderboard = computed(() => {
    const warns = auditLogs.value.filter((r) => r.eventType === 'group.instance.warn');
    const map = new Map();
    for (const w of warns) {
        const targetId = w.targetId || null;
        let targetName = (targetId && resolvedUserNames.value[targetId]) || w.targetDisplayName || '—';
        const key = targetId ?? targetName;
        if (!map.has(key)) map.set(key, { target: targetName, id: targetId, count: 0 });
        else if (targetId && resolvedUserNames.value[targetId]) map.get(key).target = resolvedUserNames.value[targetId];
        map.get(key).count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
});

// ── Group audit permission helpers ────────────────────────────────────────────
function updateGroupAuditPerms(groups) {
    const PERM = 'group-audit-view';
    const ids = new Set();
    for (const g of groups) {
        if (g.myMember?.permissions?.includes('*') || g.myMember?.permissions?.includes(PERM)) {
            ids.add(g.id);
        }
    }
    groupAuditPermIds.value = ids;
    groupPermCheckDone.value = true;
    try { localStorage.setItem('gm-group-audit-perms', JSON.stringify([...ids])); } catch { /* storage full/blocked: cache only */ }
}

function markGroupHasData(groupId) {
    if (groupsWithCachedData.value.has(groupId)) return;
    groupsWithCachedData.value = new Set([...groupsWithCachedData.value, groupId]);
    try { localStorage.setItem('gm-group-audit-data-ids', JSON.stringify([...groupsWithCachedData.value])); } catch { /* storage full/blocked: cache only */ }
}

function isGroupPermLost(groupId) {
    return groupsWithCachedData.value.has(groupId) && !groupAuditPermIds.value.has(groupId);
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
        onPageActivated,
        lastViewedGroupId,
        nowTick,
        openProfileById,
        openProfileByName,
        // polling lifecycle
        startPolling,
        stopPolling,
        // warn leaderboards
        warnLeaderboard,
        mostWarnedLeaderboard,
        // group permission cache
        groupAuditPermIds,
        groupsWithCachedData,
        groupPermCheckDone,
        updateGroupAuditPerms,
        isGroupPermLost,
    };
}
