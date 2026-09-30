// Test helpers: an in-memory stand-in for the IndexedDB audit cache and a fake
// VRChat audit-log endpoint (newest first, offset + startDate/endDate).
import { vi } from 'vitest';

export function createMemoryAuditDb() {
    const entries = new Map(); // groupId -> Map(id -> entry)
    const meta = new Map();
    const rows = (gid) => {
        if (!entries.has(gid)) entries.set(gid, new Map());
        return entries.get(gid);
    };
    return {
        entries,
        meta,
        all(gid) {
            return [...rows(gid).values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        },
        seed(gid, list) {
            for (const e of list) rows(gid).set(e.id, { ...e, groupId: gid });
        },
        loadEntries: vi.fn(async (gid) => [...rows(gid).values()]),
        loadNewest: vi.fn(async (gid) => {
            const list = [...rows(gid).values()];
            const max = list.reduce((m, e) => (e.created_at > m ? e.created_at : m), '');
            return list.filter((e) => e.created_at === max);
        }),
        saveEntries: vi.fn(async (gid, list) => {
            for (const e of list) rows(gid).set(e.id, { ...e, groupId: gid });
        }),
        loadMeta: vi.fn(async (gid) => (meta.has(gid) ? structuredClone(meta.get(gid)) : null)),
        updateMeta: vi.fn(async (gid, fn) => {
            const next = fn(meta.has(gid) ? structuredClone(meta.get(gid)) : null);
            if (next) meta.set(gid, { ...next, groupId: gid });
            return meta.has(gid) ? structuredClone(meta.get(gid)) : null;
        })
    };
}

/**
 * @param {any[]} all Newest first
 * @param {{ retentionFromMs?: number; endInclusive?: boolean; pageSize?: number }} [opts]
 */
export function createAuditServer(all, { retentionFromMs = -Infinity, endInclusive = false, pageSize = 100 } = {}) {
    const visible = () => all.filter((e) => Date.parse(e.created_at) >= retentionFromMs);
    const server = {
        all,
        requests: [],
        fail: null,
        fetchWindow: vi.fn(async ({ endDate, startDate, offset = 0 }) => {
            server.requests.push({ endDate, startDate, offset });
            if (server.fail) throw server.fail;
            const end = endDate ? Date.parse(endDate) : Infinity;
            const start = startDate ? Date.parse(startDate) : -Infinity;
            return visible()
                .filter((e) => {
                    const t = Date.parse(e.created_at);
                    return (endInclusive ? t <= end : t < end) && t >= start;
                })
                .slice(offset, offset + pageSize);
        }),
        fetchPage: vi.fn(async (offset) => {
            server.requests.push({ offset });
            if (server.fail) throw server.fail;
            const list = visible();
            return { entries: list.slice(offset, offset + pageSize), totalCount: list.length };
        })
    };
    return server;
}

const TYPES = ['group.invite.create', 'group.member.join', 'group.instance.kick'];

/**
 * A steady audit log: one entry every `stepMin` minutes from `fromIso` to
 * `toIso`, every 30th a join request. Newest first.
 */
export function steadyLog(fromIso, toIso, stepMin = 6, prefix = 'gaud') {
    const out = [];
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    let i = 0;
    for (let t = from; t <= to; t += stepMin * 60_000, i++) {
        out.push({
            id: `${prefix}_${String(i).padStart(7, '0')}`,
            created_at: new Date(t).toISOString(),
            eventType: i % 30 === 0 ? 'group.request.create' : TYPES[i % 3],
            actorId: 'usr_mod',
            targetId: `usr_${i % 500}`
        });
    }
    return out.reverse();
}

export function utcDay(iso) {
    return iso.slice(0, 10);
}
