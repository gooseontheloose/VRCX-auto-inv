// Watermark-based audit log poller. Fetches newest pages until it reaches the
// last entry it already reported (bounded by maxPages) and returns only the
// entries that are new since then, oldest first.

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_MAX_PAGES = 5;

/**
 * @typedef {{at: string, ids: string[]}} Watermark
 */

function isKnown(entry, wm) {
    if (!wm?.at) return false;
    if (entry.created_at < wm.at) return true;
    return entry.created_at === wm.at && wm.ids.includes(entry.id);
}

/**
 * @param {Array<{id: string, created_at: string}>} entries
 * @param {Watermark|null} prev
 * @returns {Watermark|null}
 */
export function advanceWatermark(entries, prev) {
    let at = prev?.at ?? '';
    let ids = new Set(prev?.ids ?? []);
    for (const e of entries) {
        if (!e?.created_at || e.id == null) continue;
        if (e.created_at > at) {
            at = e.created_at;
            ids = new Set([e.id]);
        } else if (e.created_at === at) {
            ids.add(e.id);
        }
    }
    return at ? { at, ids: [...ids] } : (prev ?? null);
}

/**
 * Pages back from the newest entry until it reaches `watermark` (the last
 * entry this account reported) or, when this account has no watermark yet,
 * `cacheMark` (the newest cached entry), bounded by maxPages. When it runs out
 * of pages first, `gap` is the window it could not fetch and that is not
 * already cached (it starts at the newer of watermark and cacheMark); the
 * caller must queue it for backfill before moving the watermark past it.
 * @param {object} opts
 * @param {(offset: number) => Promise<{entries: any[], totalCount?: number}>} opts.fetchPage
 * @param {Watermark|null} opts.watermark
 * @param {Watermark|null} [opts.cacheMark]
 * @param {number} [opts.maxPages]
 * @param {number} [opts.pageSize]
 * @returns {Promise<{newEntries: any[], fetched: any[], watermark: Watermark|null, firstRun: boolean, truncated: boolean, gap: {after: string, before: string}|null, totalCount: number|null}>}
 */
export async function pollAuditLog({
    fetchPage,
    watermark,
    cacheMark = null,
    maxPages = AUDIT_MAX_PAGES,
    pageSize = AUDIT_PAGE_SIZE
}) {
    const firstRun = !watermark?.at;
    const stopMark = firstRun ? (cacheMark?.at ? cacheMark : null) : watermark;
    const fetched = [];
    let reached = false;
    let totalCount = null;
    let exhausted = false;
    // With nothing to page back to, page 0 is enough to set the watermark.
    const pages = stopMark ? maxPages : 1;
    for (let page = 0; page < pages; page++) {
        const { entries, totalCount: tc } = await fetchPage(page * pageSize);
        if (page === 0 && Number.isFinite(tc)) totalCount = tc;
        fetched.push(...entries);
        if (entries.some((e) => isKnown(e, stopMark))) {
            reached = true;
            break;
        }
        if (entries.length < pageSize) {
            exhausted = true;
            break;
        }
    }
    const seen = new Set();
    const unique = fetched.filter(
        (e) => e?.id != null && !seen.has(e.id) && seen.add(e.id)
    );
    // Posting only starts after this account set its own watermark: a first
    // run never floods webhooks with what the cache already had.
    const newEntries = firstRun
        ? []
        : unique
              .filter((e) => !isKnown(e, watermark))
              .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const truncated = Boolean(stopMark) && !reached && !exhausted;
    let gap = null;
    if (truncated && unique.length) {
        const oldest = unique.reduce((m, e) =>
            e.created_at < m.created_at ? e : m
        );
        // Entries up to the newest cached one are already in the shared
        // cache (whoever cached them queued their own gaps), so a stale
        // per-account watermark does not re-download them.
        const after =
            cacheMark?.at && cacheMark.at > stopMark.at
                ? cacheMark.at
                : stopMark.at;
        if (after < oldest.created_at) {
            gap = { after, before: oldest.created_at };
        }
    }
    return {
        newEntries,
        fetched: unique,
        watermark: advanceWatermark(unique, watermark),
        firstRun,
        truncated,
        gap,
        totalCount
    };
}
