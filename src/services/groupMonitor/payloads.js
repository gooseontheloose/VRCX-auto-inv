// Discord payload builders for the background Group Monitor service.
// Leaderboards are computed from the full (unfiltered) audit history of the
// webhook's own group with a fixed "count desc" sort, so what gets posted no
// longer depends on which page is open or how its table is sorted/filtered.

export const FOOTER = 'PAW Inviter - VRCX';

export const LEADERBOARD_TYPES = Object.freeze([
    'kick-board',
    'most-kicked',
    'ban-board',
    'most-banned',
    'warn-board',
    'most-warned',
    'snitch-report',
    'vk-targets',
    'invite-board'
]);

export const WEBHOOK_TYPES = Object.freeze([
    ...LEADERBOARD_TYPES,
    'audit-events',
    'crash-alert'
]);

/** Categories a per-event ("audit-events") webhook can subscribe to. */
export const AUDIT_EVENT_CATEGORIES = Object.freeze({
    kick: ['group.instance.kick', 'group.member.remove'],
    ban: ['group.user.ban', 'group.user.unban'],
    warn: ['group.instance.warn'],
    member: [
        'group.member.join',
        'group.member.leave',
        'group.invite.accept',
        'group.join.request.accept',
        'group.join.request.create',
        'group.request.create',
        'group.join.request.reject'
    ],
    role: [
        'group.member.role.assign',
        'group.member.role.remove',
        'group.member.role.unassign',
        'group.role.create',
        'group.role.update',
        'group.role.delete'
    ]
});

export const DEFAULT_EVENT_FILTER = Object.freeze(['kick', 'ban', 'warn']);

const EVENT_LABELS = {
    'group.instance.kick': 'Instance Kick',
    'group.member.remove': 'Member Removed',
    'group.user.ban': 'User Banned',
    'group.user.unban': 'User Unbanned',
    'group.instance.warn': 'Instance Warning',
    'group.member.join': 'Member Joined',
    'group.member.leave': 'Member Left',
    'group.invite.accept': 'Invite Accepted',
    'group.join.request.accept': 'Join Request Accepted',
    'group.join.request.create': 'Join Requested',
    'group.request.create': 'Join Requested',
    'group.join.request.reject': 'Join Request Rejected',
    'group.member.role.assign': 'Role Assigned',
    'group.member.role.remove': 'Role Removed',
    'group.member.role.unassign': 'Role Unassigned',
    'group.role.create': 'Role Created',
    'group.role.update': 'Role Updated',
    'group.role.delete': 'Role Deleted'
};

const EVENT_COLORS = {
    kick: 0xe67e22,
    ban: 0xe74c3c,
    warn: 0xf1c40f,
    member: 0x2ecc71,
    role: 0x9b59b6
};

/**
 * @param {string} eventType
 * @returns {string|null}
 */
export function categoryOf(eventType) {
    for (const [cat, types] of Object.entries(AUDIT_EVENT_CATEGORIES)) {
        if (types.includes(eventType)) return cat;
    }
    return null;
}

export function hexToDiscordColor(hex) {
    const n = parseInt(String(hex ?? '#5865f2').replace('#', ''), 16);
    return Number.isFinite(n) ? n : 0x5865f2;
}

// ── name helpers (no API calls: only data already in the entry) ──────────────
function parseActorFromDescription(desc) {
    if (!desc) return null;
    const byM = desc.match(/ by (.+?)\.?\s*$/i);
    if (byM) return byM[1].trim();
    const m = desc.match(/^(.+?) has /);
    return m ? m[1].trim() : null;
}

function parseTargetFromDescription(desc) {
    if (!desc) return null;
    let m = desc.match(/has issued an instance kick for (.+?)\.?\s*$/i);
    if (m) return m[1].trim();
    m = desc.match(/^User (.+?) has been /i);
    if (m) return m[1].trim();
    m = desc.match(/\bfor (.+?)\.?\s*$/i);
    if (m) return m[1].trim();
    m = desc.match(/(?:permanently )?(?:banned|removed|kicked) (.+?) from/i);
    if (m) return m[1].trim();
    return null;
}

function goodName(n) {
    return n && !String(n).startsWith('usr_') ? n : null;
}

export function actorName(e) {
    return (
        goodName(e.actorDisplayName) ||
        parseActorFromDescription(e.description) ||
        e.actorDisplayName ||
        '—'
    );
}

export function targetName(e) {
    return (
        goodName(e.targetDisplayName) ||
        parseTargetFromDescription(e.description) ||
        e.targetDisplayName ||
        '—'
    );
}

// ── leaderboards ──────────────────────────────────────────────────────────────
function countBy(entries, eventType, keyFn, nameFn) {
    const map = new Map();
    for (const e of entries) {
        if (e.eventType !== eventType) continue;
        const { key, name } = { key: keyFn(e), name: nameFn(e) };
        if (!map.has(key)) map.set(key, { name, count: 0 });
        const row = map.get(key);
        row.count++;
        if (row.name === '—' && name !== '—') row.name = name;
    }
    return [...map.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
}

function actorBoard(entries, eventType) {
    return countBy(
        entries,
        eventType,
        (e) => e.actorId || actorName(e),
        actorName
    );
}

function targetBoard(entries, eventType) {
    return countBy(
        entries,
        eventType,
        (e) => e.targetId || targetName(e),
        targetName
    );
}

function inviteBoard(entries) {
    const inviteTypes = new Set(['group.invite.create', 'group.invite.send']);
    const joinTimes = new Map();
    for (const j of entries) {
        if (j.eventType !== 'group.member.join') continue;
        for (const k of [j.targetId, targetName(j)]) {
            if (!k || k === '—') continue;
            if (!joinTimes.has(k)) joinTimes.set(k, []);
            joinTimes.get(k).push(j.created_at);
        }
    }
    const map = new Map();
    for (const inv of entries) {
        if (!inviteTypes.has(inv.eventType)) continue;
        const key = inv.actorId || actorName(inv);
        if (!map.has(key))
            map.set(key, { name: actorName(inv), invites: 0, converts: 0 });
        const row = map.get(key);
        row.invites++;
        const converted = [inv.targetId, targetName(inv)].some(
            (k) =>
                k &&
                k !== '—' &&
                (joinTimes.get(k) ?? []).some((t) => t >= inv.created_at)
        );
        if (converted) row.converts++;
    }
    return [...map.values()]
        .map((r) => ({
            ...r,
            count: r.invites,
            rate: r.invites ? Math.round((r.converts / r.invites) * 100) : 0
        }))
        .sort((a, b) => b.invites - a.invites || a.name.localeCompare(b.name));
}

/**
 * Vote-kick events that happened while you were in one of the group's
 * instances. gamelog_location.time is in milliseconds.
 */
export function groupVoteKicks(vkEvents, visits, nowMs = Date.now()) {
    if (!vkEvents?.length || !visits?.length) return [];
    const ranges = visits
        .map((v) => {
            const start = Date.parse(v.created_at);
            const dur = Number(v.time) || 0;
            return { start, end: dur > 0 ? start + dur : nowMs };
        })
        .filter((r) => Number.isFinite(r.start));
    return vkEvents.filter((ev) => {
        const t = Date.parse(ev.at);
        return ranges.some((r) => t >= r.start && t <= r.end);
    });
}

function vkBoards(events) {
    const targets = new Map();
    const snitches = new Map();
    for (const ev of events) {
        if (!targets.has(ev.target))
            targets.set(ev.target, { name: ev.target, count: 0 });
        if (ev.type === 'initiation') targets.get(ev.target).count++;
        const ini = ev.initiator?.trim();
        if (ini) {
            if (!snitches.has(ini)) snitches.set(ini, { name: ini, count: 0 });
            if (ev.type === 'initiation') snitches.get(ini).count++;
        }
    }
    const sort = (m) =>
        [...m.values()]
            .filter((r) => r.count > 0)
            .sort((a, b) => b.count - a.count);
    return { targets: sort(targets), snitches: sort(snitches) };
}

const LEADERBOARD_META = {
    'kick-board': {
        title: 'Top Kickers',
        subtitle:
            'Who has issued the most instance kicks. Players are temporarily removed from the instance for 1 hour but remain in the group.'
    },
    'most-kicked': {
        title: 'Most Kicked',
        subtitle:
            'Who has been instance kicked the most. These players were removed from instances the most times.'
    },
    'ban-board': {
        title: 'Top Banners',
        subtitle:
            'Who has issued the most group bans. These moderators have removed the most members from the group permanently.'
    },
    'most-banned': {
        title: 'Most Banned',
        subtitle:
            'Who has been banned from the group the most times. These players have the most ban events on record.'
    },
    'warn-board': {
        title: 'Top Warners',
        subtitle: 'Who has issued the most instance warnings to players.'
    },
    'most-warned': {
        title: 'Most Warned',
        subtitle: 'Who has received the most instance warnings.'
    },
    'snitch-report': {
        title: 'Top Snitches',
        subtitle:
            'Who has started the most vote-kicks against other players in group instances.'
    },
    'vk-targets': {
        title: 'Most Vote-Kicked',
        subtitle:
            'Who has had the most vote-kicks initiated against them. These are the most targeted players.'
    },
    'invite-board': {
        title: 'Top Inviters',
        subtitle:
            'Who has sent the most group invites and their join conversion rate.'
    }
};

export function leaderboardTitle(type) {
    return LEADERBOARD_META[type]?.title ?? type;
}

/**
 * Rows for a leaderboard type, count-desc.
 * @param {string} type
 * @param {{auditEntries?: any[], vkEvents?: any[]}} data
 * @returns {Array<{name: string, count: number, label?: string}>|null}
 */
export function leaderboardRows(type, data) {
    const entries = data.auditEntries ?? [];
    switch (type) {
        case 'kick-board':
            return actorBoard(entries, 'group.instance.kick');
        case 'most-kicked':
            return targetBoard(entries, 'group.instance.kick');
        case 'ban-board':
            return actorBoard(entries, 'group.user.ban');
        case 'most-banned':
            return targetBoard(entries, 'group.user.ban');
        case 'warn-board':
            return actorBoard(entries, 'group.instance.warn');
        case 'most-warned':
            return targetBoard(entries, 'group.instance.warn');
        case 'snitch-report':
            return vkBoards(data.vkEvents ?? []).snitches;
        case 'vk-targets':
            return vkBoards(data.vkEvents ?? []).targets;
        case 'invite-board':
            return inviteBoard(entries).map((r) => ({
                ...r,
                label: `${r.invites} invites · ${r.converts} joined · ${r.rate}%`
            }));
        default:
            return null;
    }
}

export function isVoteKickType(type) {
    return type === 'snitch-report' || type === 'vk-targets';
}

/**
 * @param {{type: string, color?: string}} webhook
 * @param {string} groupName
 * @param {{auditEntries?: any[], vkEvents?: any[]}} data
 * @param {number} nowMs
 */
export function buildLeaderboardPayload(
    webhook,
    groupName,
    data,
    nowMs = Date.now()
) {
    const meta = LEADERBOARD_META[webhook.type];
    const rows = leaderboardRows(webhook.type, data);
    if (!meta || !rows) return null;
    const lines = rows
        .slice(0, 25)
        .map((r, i) => `${i + 1}. ${r.name} — ${r.label ?? r.count}`);
    return {
        embeds: [
            {
                title: `${meta.title} — ${groupName}`,
                description: `*${meta.subtitle}*\n\n${lines.join('\n') || 'No data yet.'}`,
                color: hexToDiscordColor(webhook.color),
                footer: { text: FOOTER },
                timestamp: new Date(nowMs).toISOString()
            }
        ]
    };
}

/**
 * Embed for a single audit entry (the service posts one message per entry).
 * @param {any} entry
 * @param {string} groupName
 * @param {{color?: string}} webhook
 */
export function buildAuditEventEmbed(entry, groupName, webhook) {
    const cat = categoryOf(entry.eventType);
    const label = EVENT_LABELS[entry.eventType] ?? entry.eventType;
    const fields = [];
    const actor = actorName(entry);
    const target = targetName(entry);
    if (actor && actor !== '—')
        fields.push({ name: 'By', value: actor, inline: true });
    if (target && target !== '—')
        fields.push({ name: 'Target', value: target, inline: true });
    return {
        title: `${label} — ${groupName}`,
        description: entry.description || undefined,
        color:
            webhook?.color && webhook.color !== '#5865f2'
                ? hexToDiscordColor(webhook.color)
                : (EVENT_COLORS[cat] ?? 0x5865f2),
        fields,
        footer: { text: FOOTER },
        timestamp: entry.created_at
    };
}

export function buildAuditSummaryEmbed(
    extraCount,
    groupName,
    { catchUp = false, truncated = false } = {}
) {
    const n = truncated ? `${extraCount}+` : String(extraCount);
    const when = catchUp ? 'while VRCX was closed' : 'at once';
    return {
        title: `+${n} more event${extraCount === 1 && !truncated ? '' : 's'} — ${groupName}`,
        description: `${n} more matching audit events happened ${when} and were not posted individually. Open Group Monitor → Audit Log to see them.`,
        color: 0x95a5a6,
        footer: { text: FOOTER }
    };
}

export function buildCrashAlertPayload(session, groupName) {
    const color =
        session.severity === 'high'
            ? 0xe74c3c
            : session.severity === 'medium'
              ? 0xf39c12
              : 0x3498db;
    const when = Date.parse(session.startAt);
    return {
        embeds: [
            {
                title: `⚠️ Instance Crash Detected — ${groupName}`,
                description: `${session.count} players left within ${session.windowSeconds}s`,
                color,
                fields: [
                    {
                        name: 'Time',
                        value: Number.isFinite(when)
                            ? `<t:${Math.floor(when / 1000)}:f>`
                            : String(session.startAt),
                        inline: true
                    },
                    {
                        name: 'Count',
                        value: String(session.count),
                        inline: true
                    },
                    {
                        name: 'Severity',
                        value: String(session.severity).toUpperCase(),
                        inline: true
                    },
                    {
                        name: 'Players',
                        value:
                            session.players.slice(0, 40).join(', ') ||
                            'Unknown',
                        inline: false
                    }
                ],
                footer: { text: FOOTER },
                timestamp: new Date(
                    Number.isFinite(when) ? when : Date.now()
                ).toISOString()
            }
        ]
    };
}

export function buildTestPayload(webhook, groupName, nowMs = Date.now()) {
    return {
        embeds: [
            {
                title: '🧪 Test message — PAW Inviter',
                description: `This is a **test** from Group Monitor for the webhook "${webhook.name}" (${webhook.type}) on ${groupName}. No action is needed.`,
                color: hexToDiscordColor(webhook.color),
                footer: { text: FOOTER },
                timestamp: new Date(nowMs).toISOString()
            }
        ]
    };
}
