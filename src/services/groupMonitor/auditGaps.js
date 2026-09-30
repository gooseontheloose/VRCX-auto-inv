// Gap bookkeeping for the Group Monitor audit cache (pure: no API, no storage).
//
// A "gap" is a time window whose entries may be missing from the local cache:
// entries created after `after` and before `before` (ISO strings, `after` null
// means "everything older than before"). Gaps come from
//   - catch-up that ran out of pages before reaching the cached entries, and
//   - the one-time repair scan over existing caches (findCacheHoles).
// They are filled newest first with date-window requests, a page at a time,
// and closed as soon as VRChat returns less than a full page for the window
// (the window is complete, or VRChat no longer keeps entries that old).

export const GAP_PAGE_SIZE = 100;
/** `fullyLoaded` is only trusted when written by this version of the loader. */
export const HISTORY_VERSION = 2;
/** Bump to run the hole scan again on every cached group. */
export const REPAIR_SCAN_VERSION = 1;
/** Offset paging inside one window stops here (the API caps offsets). */
export const MAX_WINDOW_OFFSET = 7500;
/** Closed windows remembered so a re-scan does not queue them again. */
export const MAX_CHECKED = 300;
/**
 * A gap is only given up when VRChat keeps saying the group is gone (404)
 * this many times. Other failures (429, 403 on one account, 5xx, offline)
 * keep the gap and retry with backoff: dropping it would leave a permanent
 * hole, since the poll marker has already moved past it.
 */
export const MAX_GAP_ATTEMPTS = 10;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const HOLE_DEFAULTS = Object.freeze({
    /** Shorter silences are never treated as holes. */
    minGapMs: 4 * HOUR,
    /** ...and a silence must also be this many times the median spacing. */
    factor: 12,
    /** ...and at the group's usual rate hide at least this many entries. */
    minExpected: 10,
    /** Holes older than this are not queued (VRChat keeps ~5-8 weeks). */
    maxAgeMs: 120 * DAY
});

function ms(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : NaN;
}

function iso(t) {
    return new Date(t).toISOString();
}

/**
 * The history loader only trusts `fullyLoaded` it wrote itself; flags from
 * older builds were set on fetch errors and short caches.
 *
 * @param {any} meta
 */
export function isHistoryComplete(meta) {
    return meta?.fullyLoaded === true && (meta.historyVersion ?? 0) >= HISTORY_VERSION;
}

/**
 * Newest entries as a poll marker: {at, ids} of every entry sharing the
 * newest created_at, or null.
 *
 * @param {{ id: string; created_at: string }[]} entries
 * @returns {{ at: string; ids: string[] } | null}
 */
export function newestMark(entries) {
    let at = '';
    let atMs = -Infinity;
    let ids = [];
    for (const e of entries ?? []) {
        const t = ms(e?.created_at);
        if (!Number.isFinite(t) || e.id == null) continue;
        if (t > atMs) {
            atMs = t;
            at = e.created_at;
            ids = [e.id];
        } else if (t === atMs) {
            ids.push(e.id);
        }
    }
    return at ? { at, ids } : null;
}

/**
 * @param {{ after: string | null; before: string }} window
 * @param {string} source
 */
export function makeGap(window, source) {
    // `before` is the oldest entry that was fetched (or cached). Entries
    // sharing its millisecond may sit on the next, unfetched page, so the
    // window ends 1 ms later: it holds whether VRChat treats endDate as
    // inclusive or exclusive (duplicates are harmless).
    const before = Number.isFinite(ms(window.before)) ? iso(ms(window.before) + 1) : window.before;
    return {
        id: `gap-${ms(before)}-${Math.random().toString(36).slice(2, 8)}`,
        after: window.after ?? null,
        before,
        origBefore: before,
        offset: 0,
        attempts: 0,
        source
    };
}

/**
 * Adds gaps to a list, merging overlapping windows. Newest first.
 *
 * @param {any[]} gaps
 * @param {any[]} added
 */
export function mergeGaps(gaps, added) {
    const all = [...(gaps ?? []), ...(added ?? [])]
        .filter((g) => g && Number.isFinite(ms(g.before)))
        .map((g) => ({ ...g, _a: g.after ? ms(g.after) : -Infinity, _b: ms(g.before) }))
        .sort((x, y) => y._b - x._b);
    const out = [];
    for (const g of all) {
        const last = out[out.length - 1];
        if (last && g._b >= last._a) {
            // overlaps the newer window: widen it and restart its paging
            if (g._a < last._a) {
                last._a = g._a;
                last.after = g.after;
            }
            last.offset = 0;
            continue;
        }
        out.push({ ...g });
    }
    return out.map(({ _a, _b, ...g }) => g);
}

/**
 * True when the window was already fetched and closed before.
 *
 * @param {{ after: string | null; before: string }} window
 * @param {{ after: string | null; before: string }[]} [checked]
 */
export function isWindowChecked(window, checked) {
    const a = window.after ? ms(window.after) : -Infinity;
    const b = ms(window.before);
    return (checked ?? []).some((c) => {
        const ca = c.after ? ms(c.after) : -Infinity;
        return ca <= a && ms(c.before) >= b;
    });
}

/**
 * Remembers a closed window, newest first, capped.
 *
 * @param {any[]} checked
 * @param {{ after: string | null; before: string }} window
 */
export function addChecked(checked, window) {
    return [{ after: window.after ?? null, before: window.before }, ...(checked ?? [])]
        .sort((x, y) => ms(y.before) - ms(x.before))
        .slice(0, MAX_CHECKED);
}

/**
 * Finds silences in a cached audit log that are far too long for the group's
 * usual rate: every span between two consecutive cached entries longer than
 * max(minGapMs, factor x median spacing) that should hold at least
 * minExpected entries. A run of days with zero events between days that have
 * events is always such a span. Returns windows newest first.
 *
 * A window found here may be a genuinely quiet period: filling it costs one
 * request, which comes back short, and it is then closed and remembered.
 *
 * @param {{ created_at: string }[]} entries
 * @param {{ nowMs?: number; minGapMs?: number; factor?: number; minExpected?: number; maxAgeMs?: number }} [opts]
 * @returns {{ after: string; before: string; expected: number }[]}
 */
export function findCacheHoles(entries, opts = {}) {
    const { nowMs = Date.now(), minGapMs, factor, minExpected, maxAgeMs } = { ...HOLE_DEFAULTS, ...opts };
    const rows = (entries ?? [])
        .map((e) => ({ at: e?.created_at, t: ms(e?.created_at) }))
        .filter((r) => Number.isFinite(r.t))
        .sort((a, b) => a.t - b.t);
    if (rows.length < 20) return [];
    const diffs = [];
    for (let i = 1; i < rows.length; i++) diffs.push(rows[i].t - rows[i - 1].t);
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const span = rows[rows.length - 1].t - rows[0].t;
    if (span <= 0) return [];
    const rate = (rows.length - 1) / span;
    const threshold = Math.max(minGapMs, factor * median);
    const holes = [];
    for (let i = 1; i < rows.length; i++) {
        const d = diffs[i - 1];
        if (d <= threshold || d * rate < minExpected) continue;
        if (rows[i].t < nowMs - maxAgeMs) continue;
        holes.push({ after: rows[i - 1].at, before: rows[i].at, expected: Math.round(d * rate) });
    }
    return holes.reverse();
}

/**
 * Fetches one page of a gap window. `fetchWindow` gets
 * {endDate, startDate?, offset?} and returns entries newest first.
 *
 * Returns `done` when the window is complete: less than a full page came back
 * (including an empty page once VRChat no longer keeps entries that old), or
 * the page reached back past `after`. Otherwise `next` is the gap narrowed to
 * what is still unfetched.
 *
 * @param {{
 *     gap: any;
 *     fetchWindow: (params: { endDate: string; startDate?: string; offset?: number }) => Promise<any[]>;
 *     pageSize?: number;
 * }} opts
 * @returns {Promise<{ entries: any[]; done: boolean; reason?: string; next?: any }>}
 */
export async function fillGapStep({ gap, fetchWindow, pageSize = GAP_PAGE_SIZE }) {
    const params = { endDate: gap.before };
    if (gap.after) params.startDate = gap.after;
    if (gap.offset) params.offset = gap.offset;
    const entries = (await fetchWindow(params)) ?? [];
    const afterMs = gap.after ? ms(gap.after) : -Infinity;
    const times = entries.map((e) => ms(e?.created_at)).filter(Number.isFinite);
    if (entries.length < pageSize) {
        return { entries, done: true, reason: entries.length ? 'filled' : 'empty' };
    }
    if (times.some((t) => t <= afterMs)) {
        return { entries, done: true, reason: 'filled' };
    }
    // +1 ms so entries sharing the oldest timestamp are fetched again (dupes
    // are harmless) whether VRChat treats endDate as inclusive or not.
    const nextBefore = Math.min(...times) + 1;
    if (times.length && nextBefore < ms(gap.before)) {
        return { entries, done: false, next: { ...gap, before: iso(nextBefore), offset: 0 } };
    }
    // no progress by date (a full page within one millisecond, or the API
    // ignored the dates): page on by offset inside the same window
    const offset = (gap.offset ?? 0) + pageSize;
    if (offset > MAX_WINDOW_OFFSET) return { entries, done: true, reason: 'stuck' };
    return { entries, done: false, next: { ...gap, offset } };
}

/**
 * Minutes to wait before retrying a gap that failed `attempts` times.
 *
 * @param {number} attempts
 */
export function gapRetryDelayMs(attempts) {
    return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}
