// Persisted gap list + backfill for the Group Monitor audit cache. The gap
// list lives in the group's IndexedDB meta record (shared by both accounts,
// like the cached entries), so whichever account polls the group fills it.

import {
    auditDbLoadEntries,
    auditDbLoadMeta,
    auditDbLoadNewest,
    auditDbSaveEntries,
    auditDbUpdateMeta
} from '../auditLogDb';
import {
    GAP_PAGE_SIZE,
    MAX_GAP_ATTEMPTS,
    REPAIR_SCAN_VERSION,
    addChecked,
    fillGapStep,
    findCacheHoles,
    gapRetryDelayMs,
    isWindowChecked,
    makeGap,
    mergeGaps
} from './auditGaps';

/**
 * @typedef {object} AuditDb
 * @property {(groupId: string) => Promise<any[]>} loadEntries
 * @property {(groupId: string) => Promise<any[]>} loadNewest
 * @property {(groupId: string, entries: any[]) => Promise<void>} saveEntries
 * @property {(groupId: string) => Promise<any>} loadMeta
 * @property {(groupId: string, fn: (cur: any) => any) => Promise<any>} updateMeta
 */

/** @type {AuditDb} */
export const indexedAuditDb = {
    loadEntries: (groupId) => auditDbLoadEntries(groupId),
    loadNewest: (groupId) => auditDbLoadNewest(groupId),
    saveEntries: (groupId, entries) => auditDbSaveEntries(groupId, entries),
    loadMeta: (groupId) => auditDbLoadMeta(groupId),
    updateMeta: (groupId, fn) => auditDbUpdateMeta(groupId, fn)
};

function sameWindow(a, b) {
    return Boolean(b) && a.after === b.after && a.before === b.before && a.origBefore === b.origBefore;
}

/**
 * Queues a window whose entries were not fetched.
 *
 * @param {AuditDb} db
 * @param {string} groupId
 * @param {{ after: string | null; before: string }} window
 * @param {string} source
 */
export async function recordGap(db, groupId, window, source) {
    if (!window?.before) return;
    await db.updateMeta(groupId, (cur) => ({
        ...(cur ?? {}),
        gaps: mergeGaps(cur?.gaps ?? [], [makeGap(window, source)])
    }));
}

/**
 * One-time scan of an existing cache for holes left by older builds (they
 * fetched only the newest page after every restart). Runs once per group and
 * REPAIR_SCAN_VERSION; later holes are recorded exactly by catch-up.
 *
 * @param {{ db: AuditDb; groupId: string; nowMs?: number; entries?: any[] }} opts
 * @returns {Promise<{ queued: number; skipped: boolean }>}
 */
export async function runRepairScan({ db, groupId, nowMs = Date.now(), entries }) {
    const meta = await db.loadMeta(groupId);
    if ((meta?.repairScanVersion ?? 0) >= REPAIR_SCAN_VERSION) return { queued: 0, skipped: true };
    const rows = entries ?? (await db.loadEntries(groupId));
    const holes = findCacheHoles(rows, { nowMs });
    let queued = 0;
    await db.updateMeta(groupId, (cur) => {
        if ((cur?.repairScanVersion ?? 0) >= REPAIR_SCAN_VERSION) return null;
        const fresh = holes.filter((h) => !isWindowChecked(h, cur?.checked));
        queued = fresh.length;
        return {
            ...(cur ?? {}),
            gaps: mergeGaps(
                cur?.gaps ?? [],
                fresh.map((h) => makeGap(h, 'repair'))
            ),
            repairScanVersion: REPAIR_SCAN_VERSION
        };
    });
    if (queued) console.log(`[GroupMonitor] repair scan queued ${queued} hole(s) for ${groupId}`);
    return { queued, skipped: false };
}

/**
 * Fills queued gaps of one group, newest first, using at most `budget`
 * requests. Stops early when `isPaused()` turns true (VRChat said 429).
 *
 * @param {object} opts
 * @param {AuditDb} opts.db
 * @param {string} opts.groupId
 * @param {(params: { endDate: string; startDate?: string; offset?: number }) => Promise<any[]>} opts.fetchWindow
 * @param {number} opts.budget
 * @param {number} [opts.nowMs]
 * @param {() => boolean} [opts.isPaused]
 * @param {number} [opts.pageSize]
 * @returns {Promise<{ requests: number; fetched: any[]; closed: number; remaining: number; error: any }>}
 */
export async function drainGaps({
    db,
    groupId,
    fetchWindow,
    budget,
    nowMs = Date.now(),
    isPaused = () => false,
    pageSize = GAP_PAGE_SIZE
}) {
    const result = { requests: 0, fetched: [], closed: 0, remaining: 0, error: null };
    const meta = await db.loadMeta(groupId);
    const queue = (meta?.gaps ?? [])
        .filter((g) => !g.nextTryAt || g.nextTryAt <= nowMs)
        .sort((a, b) => Date.parse(b.before) - Date.parse(a.before));
    /** @type {Map<string, any | null>} gap id -> new state (null = closed) */
    const changes = new Map();
    const closedWindows = [];
    const starts = new Map(queue.map((g) => [g.id, g]));
    outer: for (const start of queue) {
        let gap = start;
        while (gap) {
            if (result.requests >= budget || isPaused()) break outer;
            result.requests++;
            let step;
            try {
                step = await fillGapStep({ gap, fetchWindow, pageSize });
                if (step.entries.length) await db.saveEntries(groupId, step.entries);
            } catch (err) {
                result.error = err;
                const status = err?.status;
                if (status === 429) {
                    // rate limited: the store pauses all backfill; the gap
                    // itself did nothing wrong, so it keeps its attempts
                    changes.set(gap.id, { ...gap, nextTryAt: nowMs + gapRetryDelayMs(1) });
                    break outer;
                }
                const attempts = (gap.attempts ?? 0) + 1;
                if (status === 404 && attempts >= MAX_GAP_ATTEMPTS) {
                    console.warn(
                        `[GroupMonitor] giving up on audit gap ${gap.after} → ${gap.before} for ${groupId}:`,
                        err
                    );
                    changes.set(gap.id, null);
                } else {
                    changes.set(gap.id, { ...gap, attempts, nextTryAt: nowMs + gapRetryDelayMs(attempts) });
                }
                break outer;
            }
            result.fetched.push(...step.entries);
            if (step.done) {
                changes.set(gap.id, null);
                closedWindows.push({ after: gap.after, before: gap.origBefore ?? gap.before });
                result.closed++;
                gap = null;
            } else {
                gap = { ...step.next, attempts: 0, nextTryAt: 0 };
                changes.set(gap.id, gap);
            }
        }
    }
    if (changes.size) {
        const stored = await db.updateMeta(groupId, (cur) => {
            let checked = cur?.checked ?? [];
            for (const w of closedWindows) checked = addChecked(checked, w);
            const gaps = [];
            for (const g of cur?.gaps ?? []) {
                const start = starts.get(g.id);
                // untouched here, or widened by a merge meanwhile: keep as stored
                if (!changes.has(g.id) || !sameWindow(g, start)) gaps.push(g);
                else if (changes.get(g.id)) gaps.push(changes.get(g.id));
            }
            return { ...(cur ?? {}), gaps, checked };
        });
        result.remaining = stored?.gaps?.length ?? 0;
    } else {
        result.remaining = meta?.gaps?.length ?? 0;
    }
    return result;
}
