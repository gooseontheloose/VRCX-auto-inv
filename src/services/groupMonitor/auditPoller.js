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
 * @param {object} opts
 * @param {(offset: number) => Promise<{entries: any[], totalCount?: number}>} opts.fetchPage
 * @param {Watermark|null} opts.watermark
 * @param {number} [opts.maxPages]
 * @param {number} [opts.pageSize]
 * @returns {Promise<{newEntries: any[], fetched: any[], watermark: Watermark|null, firstRun: boolean, truncated: boolean, totalCount: number|null}>}
 */
export async function pollAuditLog({
    fetchPage,
    watermark,
    maxPages = AUDIT_MAX_PAGES,
    pageSize = AUDIT_PAGE_SIZE
}) {
    const firstRun = !watermark?.at;
    const fetched = [];
    let reached = false;
    let totalCount = null;
    let exhausted = false;
    // On the very first run we only need page 0 to establish the watermark.
    const pages = firstRun ? 1 : maxPages;
    for (let page = 0; page < pages; page++) {
        const { entries, totalCount: tc } = await fetchPage(page * pageSize);
        if (page === 0 && Number.isFinite(tc)) totalCount = tc;
        fetched.push(...entries);
        if (entries.some((e) => isKnown(e, watermark))) {
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
    const newEntries = firstRun
        ? []
        : unique
              .filter((e) => !isKnown(e, watermark))
              .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return {
        newEntries,
        fetched: unique,
        watermark: advanceWatermark(unique, watermark),
        firstRun,
        truncated: !firstRun && !reached && !exhausted,
        totalCount
    };
}
