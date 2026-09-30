// Crash spike detection over gamelog_join_leave "OnPlayerLeft" rows.
//
// Fixes over the old per-page detector:
//  - the cutoff is an ISO string (created_at is ISO-8601 with a 'T', so the
//    old datetime('now', ...) comparison matched the whole UTC day);
//  - the configured window (seconds) is used, not the threshold;
//  - the batch VRCX writes for every remaining player when *you* leave an
//    instance (runLastLocationResetFlow) is excluded, so leaving a group
//    instance no longer looks like a crash;
//  - sessions have a stable id so they can be deduped.

export const CRASH_DEFAULTS = Object.freeze({
    threshold: 5,
    windowSec: 60,
    /** only look this far back */
    lookbackMs: 15 * 60_000,
    /** ignore leaves this recent so the self-leave bookkeeping has settled */
    settleMs: 10_000,
    /** leaves within this distance of your own leave belong to that batch */
    selfLeaveSlackMs: 3_000
});

/**
 * @param {number} nowMs
 * @param {number} [lookbackMs]
 * @returns {string} ISO cutoff comparable with gamelog created_at strings
 */
export function crashCutoffIso(nowMs, lookbackMs = CRASH_DEFAULTS.lookbackMs) {
    return new Date(nowMs - lookbackMs).toISOString();
}

/**
 * Own leave times per location from gamelog_location rows: a visit that
 * started at created_at and lasted `time` ms ended at created_at + time.
 * @param {Array<{created_at: string, location: string, time: number}>} visits
 * @returns {Map<string, number[]>}
 */
export function ownLeaveTimesFromVisits(visits) {
    const map = new Map();
    for (const v of visits ?? []) {
        const start = Date.parse(v.created_at);
        const dur = Number(v.time) || 0;
        if (!Number.isFinite(start) || dur <= 0) continue;
        if (!map.has(v.location)) map.set(v.location, []);
        map.get(v.location).push(start + dur);
    }
    return map;
}

function severityFor(count, threshold) {
    if (count >= threshold * 3) return 'high';
    if (count >= threshold * 1.5) return 'medium';
    return 'low';
}

/**
 * @param {Array<{at: string, displayName?: string, location: string}>} leaves
 * @param {object} opts
 * @param {string} opts.groupId
 * @param {number} opts.nowMs
 * @param {number} [opts.threshold]
 * @param {number} [opts.windowSec]
 * @param {Map<string, number[]>} [opts.ownLeaveTimes]
 * @param {string} [opts.currentLocation] location you are in right now (never self-left)
 * @param {number} [opts.lookbackMs]
 * @param {number} [opts.settleMs]
 * @returns {Array<{id: string, groupId: string, location: string, startAt: string, endAt: string, count: number, windowSeconds: number, severity: string, players: string[]}>}
 */
export function detectCrashSessions(leaves, opts) {
    const threshold = Math.max(
        2,
        Number(opts.threshold) || CRASH_DEFAULTS.threshold
    );
    const windowSec = Math.max(
        5,
        Number(opts.windowSec) || CRASH_DEFAULTS.windowSec
    );
    const windowMs = windowSec * 1000;
    const lookbackMs = opts.lookbackMs ?? CRASH_DEFAULTS.lookbackMs;
    const settleMs = opts.settleMs ?? CRASH_DEFAULTS.settleMs;
    const slack = CRASH_DEFAULTS.selfLeaveSlackMs;
    const own = opts.ownLeaveTimes ?? new Map();
    const minMs = opts.nowMs - lookbackMs;
    const maxMs = opts.nowMs - settleMs;

    const byLocation = new Map();
    for (const l of leaves ?? []) {
        const t = Date.parse(l.at);
        if (!Number.isFinite(t) || t < minMs || t > maxMs) continue;
        const loc = l.location ?? '';
        const mine = own.get(loc);
        if (
            mine?.some(
                (leaveAt) => t >= leaveAt - slack && t <= leaveAt + slack
            )
        )
            continue;
        if (!byLocation.has(loc)) byLocation.set(loc, []);
        byLocation.get(loc).push({ ...l, t });
    }

    const sessions = [];
    for (const [location, evs] of byLocation) {
        evs.sort((a, b) => a.t - b.t);
        // A same-timestamp batch covering >= threshold players in a location
        // you are no longer in, with no own-leave record yet, is the self-leave
        // batch whose gamelog_location update has not landed. Skip it.
        if (location !== opts.currentLocation && !own.has(location)) {
            const last = evs[evs.length - 1];
            const sameStamp = evs.filter((e) => e.at === last.at);
            if (
                sameStamp.length >= threshold &&
                sameStamp.length === evs.length
            )
                continue;
        }
        let i = 0;
        while (i < evs.length) {
            let j = i;
            while (j < evs.length && evs[j].t - evs[i].t <= windowMs) j++;
            const count = j - i;
            if (count >= threshold) {
                const win = evs.slice(i, j);
                sessions.push({
                    id: `crash:${opts.groupId}:${location}:${evs[i].at}`,
                    groupId: opts.groupId,
                    location,
                    startAt: evs[i].at,
                    endAt: evs[j - 1].at,
                    count,
                    windowSeconds: windowSec,
                    severity: severityFor(count, threshold),
                    players: win.map((e) => e.displayName).filter(Boolean)
                });
                i = j;
            } else {
                i++;
            }
        }
    }
    sessions.sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
    return sessions;
}
