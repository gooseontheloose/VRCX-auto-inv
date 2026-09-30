// Pure helpers shared by the Group Monitor pages (every page used to carry its
// own copy of these computeds).
import dayjs from 'dayjs';

/**
 * Local calendar day of an ISO timestamp (YYYY-MM-DD in the user's time zone).
 *
 * @param {string} iso
 */
export function localDay(iso) {
    return dayjs(iso).format('YYYY-MM-DD');
}

/**
 * Local calendar month of an ISO timestamp (YYYY-MM).
 *
 * @param {string} iso
 */
export function localMonth(iso) {
    return dayjs(iso).format('YYYY-MM');
}

/**
 * Day of week (0 = Sunday) of a local YYYY-MM-DD day. `new Date('YYYY-MM-DD')`
 * parses as UTC midnight, which is the previous day west of UTC.
 *
 * @param {string} ymd
 */
export function dayOfWeek(ymd) {
    return dayjs(ymd).day();
}

const JOIN_TYPES = new Set(['group.member.join', 'group.invite.accept']);
const LEAVE_TYPES = new Set(['group.member.leave', 'group.member.remove', 'group.user.ban']);

/**
 * Joins / leaves per local day, every day from the first to the last one with
 * data, and a running net (never below 0).
 *
 * @param {{ eventType: string; created_at: string }[]} entries
 */
export function membersOverTimeFrom(entries) {
    const empty = { dates: [], joins: [], leaves: [], net: [] };
    const dayMap = new Map();
    for (const r of entries) {
        const isJoin = JOIN_TYPES.has(r.eventType);
        if (!isJoin && !LEAVE_TYPES.has(r.eventType)) continue;
        const day = localDay(r.created_at);
        if (!dayMap.has(day)) dayMap.set(day, { joins: 0, leaves: 0 });
        if (isJoin) dayMap.get(day).joins++;
        else dayMap.get(day).leaves++;
    }
    const keys = [...dayMap.keys()].sort();
    if (!keys.length) return empty;

    const allDays = [];
    const last = dayjs(keys[keys.length - 1]);
    for (let cur = dayjs(keys[0]); !cur.isAfter(last, 'day'); cur = cur.add(1, 'day')) {
        allDays.push(cur.format('YYYY-MM-DD'));
    }

    let running = 0;
    const joins = [];
    const leaves = [];
    const net = [];
    for (const day of allDays) {
        const { joins: j = 0, leaves: l = 0 } = dayMap.get(day) ?? {};
        running += j - l;
        joins.push(j);
        leaves.push(l);
        net.push(Math.max(0, running));
    }
    return { dates: allDays, joins, leaves, net };
}

/**
 * Vote-kick events that happened while you were in one of the group's
 * instances, tagged with that instance's world. gamelog_location.time is in
 * milliseconds; a visit without a duration is still going on.
 *
 * @param {{ at: string }[]} vkEvents
 * @param {{ created_at: string; time?: number; worldName?: string }[]} visits
 * @param {number} [nowMs]
 */
export function attributeVoteKicks(vkEvents, visits, nowMs = Date.now()) {
    if (!visits?.length || !vkEvents?.length) return [];
    const ranges = visits
        .map((loc) => {
            const startMs = new Date(loc.created_at).getTime();
            const dur = Number(loc.time) || 0;
            return {
                startMs,
                endMs: dur > 0 ? startMs + dur : nowMs,
                worldName: loc.worldName || 'Unknown World'
            };
        })
        .filter((r) => Number.isFinite(r.startMs));
    return vkEvents
        .map((ev) => {
            const evMs = new Date(ev.at).getTime();
            const range = ranges.find((r) => evMs >= r.startMs && evMs <= r.endMs);
            return range ? { ...ev, worldName: range.worldName } : null;
        })
        .filter(Boolean);
}

/**
 * Visits and time per world. gamelog_location.time is in milliseconds; the
 * result is in seconds (what fmtDuration takes).
 *
 * @param {{ worldName?: string; time?: number }[]} visits
 * @returns {{ name: string; visits: number; totalTime: number; avgTime: number }[]}
 */
export function topWorldsFrom(visits) {
    const map = new Map();
    for (const row of visits) {
        const name = row.worldName || 'Unknown World';
        if (!map.has(name)) map.set(name, { name, visits: 0, totalMs: 0 });
        const e = map.get(name);
        e.visits++;
        e.totalMs += Number(row.time) || 0;
    }
    return Array.from(map.values()).map((e) => ({
        name: e.name,
        visits: e.visits,
        totalTime: Math.round(e.totalMs / 1000),
        avgTime: e.visits > 0 ? Math.round(e.totalMs / e.visits / 1000) : 0
    }));
}
