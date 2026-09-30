/**
 * AIRI integration: builds the privacy-filtered player payload that a local
 * AI companion can read from http://127.0.0.1:34582/paw/players.
 *
 * Only whitelisted fields ever leave this module. Anything not explicitly
 * copied below (pronouns, bioLinks, notes, age verification, images, URLs,
 * tokens, ...) is never included.
 */

export const AIRI_PAYLOAD_VERSION = 1;
export const AIRI_BIO_MAX_LENGTH = 200;

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const DOMAIN_RE =
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gg|io|me|tv|ly|co|app|xyz|link|bio|cc|dev|info|uk|de|jp|fm|to|moe|social|lol|page|site|online|store|shop)\b(?:\/\S*)?/gi;
const PATH_DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
const LABELED_HANDLE_RE =
    /\b(?:discord|disc|dc|snapchat|snap|sc|instagram|insta|ig|twitter|twt|tiktok|tik tok|twitch|ttv|telegram|tg|kik|steam|youtube|yt|bluesky|bsky|reddit|facebook|fb|onlyfans|vrchat|vrc|psn|xbox|spotify|tumblr|threads|venmo|cashapp|paypal|ko-fi|kofi|patreon)(?:\s*(?:[:=>|]+|-+>?)\s*@?|\s+@)[^\s,;|]+/gi;
const X_HANDLE_RE = /\bx\s*:\s*@?[^\s,;|]+/gi;
const AT_HANDLE_RE = /(^|[^\w])@[\w.-]{2,}/g;
const DISCORD_TAG_RE = /\b[\w.]{2,32}#\d{4}\b/g;
const YEAR_RANGE_RE = /^\d{4}\s*[-/.]\s*\d{4}$/;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g;

/**
 * @param {string} match
 * @returns {boolean}
 */
function isPhoneNumber(match) {
    if (YEAR_RANGE_RE.test(match.trim())) {
        return false;
    }
    return match.replace(/\D/g, '').length >= 7;
}

/**
 * Remove contact details / links from a bio and shorten it.
 * @param {unknown} bio
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeBio(bio, maxLength = AIRI_BIO_MAX_LENGTH) {
    if (typeof bio !== 'string' || !bio) {
        return '';
    }
    let text = bio
        .replace(EMAIL_RE, ' ')
        .replace(URL_RE, ' ')
        .replace(PATH_DOMAIN_RE, ' ')
        .replace(DOMAIN_RE, ' ')
        .replace(LABELED_HANDLE_RE, ' ')
        .replace(X_HANDLE_RE, ' ')
        .replace(AT_HANDLE_RE, '$1 ')
        .replace(DISCORD_TAG_RE, ' ')
        .replace(PHONE_RE, (match) => (isPhoneNumber(match) ? ' ' : match));
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > maxLength) {
        text = text.slice(0, maxLength).trimEnd();
    }
    return text;
}

/**
 * @param {any} source
 * @returns {any[]}
 */
function toValues(source) {
    if (!source) {
        return [];
    }
    if (source instanceof Map) {
        return Array.from(source.values());
    }
    if (Array.isArray(source)) {
        return source;
    }
    if (typeof source === 'object') {
        return Object.values(source);
    }
    return [];
}

/**
 * @param {any} source
 * @param {string} key
 * @returns {any}
 */
function lookup(source, key) {
    if (!source || typeof key !== 'string' || !key) {
        return undefined;
    }
    if (typeof source.get === 'function') {
        return source.get(key);
    }
    if (typeof source === 'object') {
        return Object.prototype.hasOwnProperty.call(source, key)
            ? source[key]
            : undefined;
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * @param {any} group
 * @returns {{name: string, shortCode: string} | null}
 */
function pickGroup(group) {
    if (!group || typeof group !== 'object') {
        return null;
    }
    const name = str(group.name);
    if (!name) {
        return null;
    }
    return { name, shortCode: str(group.shortCode) };
}

/**
 * VRC+ from a cached profile (its tags) or, for players VRCX has no full
 * profile for, from the AIRI lookup cache. Profile icons are free for
 * everyone since VRChat 2026.3.1, so the "system_supporter" tag is the only
 * reliable VRC+ signal.
 * @param {any} profile core cachedUsers entry
 * @param {any} extra AIRI lookup cache entry ({isVRCPlus?: boolean|null})
 * @returns {{isVRCPlus: boolean, vrcPlusKnown: boolean}}
 */
function vrcPlusOf(profile, extra) {
    if (Array.isArray(profile?.tags)) {
        return {
            isVRCPlus:
                typeof profile.$isVRCPlus === 'boolean'
                    ? profile.$isVRCPlus
                    : profile.tags.includes('system_supporter'),
            vrcPlusKnown: true
        };
    }
    if (typeof extra?.isVRCPlus === 'boolean') {
        return { isVRCPlus: extra.isVRCPlus, vrcPlusKnown: true };
    }
    return { isVRCPlus: Boolean(profile?.$isVRCPlus), vrcPlusKnown: false };
}

/**
 * One whitelisted player entry.
 * @param {{
 *   userId: string,
 *   entry?: any,
 *   profile?: any,
 *   extra?: any,
 *   group?: any,
 *   avatarNames?: Map<string, string> | Record<string, string>,
 *   shareBios?: boolean,
 *   fetchGroups?: boolean
 * }} params
 * @returns {Record<string, any>}
 */
export function buildPlayerEntry({
    userId,
    entry,
    profile,
    extra,
    group,
    avatarNames,
    shareBios = false,
    fetchGroups = false
}) {
    const displayName = str(entry?.displayName) || str(profile?.displayName);
    const avatarName = lookup(avatarNames, displayName);
    const vrcPlus = vrcPlusOf(profile, extra);

    /** @type {Record<string, any>} */
    const player = {
        userId: str(userId),
        displayName,
        joinTime:
            typeof entry?.joinTime === 'number' &&
            Number.isFinite(entry.joinTime)
                ? entry.joinTime
                : null,
        isFriend: Boolean(profile?.isFriend),
        trustLevel: str(profile?.$trustLevel),
        isVRCPlus: vrcPlus.isVRCPlus,
        vrcPlusKnown: vrcPlus.vrcPlusKnown,
        platform: str(profile?.last_platform),
        avatarName: str(avatarName),
        status: str(profile?.status),
        statusDescription: str(profile?.statusDescription)
    };
    if (shareBios) {
        player.bio = sanitizeBio(str(profile?.bio) || str(extra?.bio));
    }
    if (fetchGroups) {
        const picked = pickGroup(group);
        if (picked) {
            player.representedGroup = picked;
        }
    }
    return player;
}

/**
 * Build the JSON-safe payload shared with the local AI companion.
 * @param {{
 *   location?: string,
 *   worldName?: string,
 *   playerList?: Map<string, any> | any[] | Record<string, any>,
 *   cachedUsers?: Map<string, any> | Record<string, any>,
 *   avatarNames?: Map<string, string> | Record<string, string>,
 *   groupsByUserId?: Map<string, any> | Record<string, any>,
 *   profileCache?: Map<string, any> | Record<string, any>,
 *   settings?: { shareBios?: boolean, fetchGroups?: boolean },
 *   now?: number
 * }} params
 */
export function buildPlayersPayload({
    location,
    worldName,
    playerList,
    cachedUsers,
    avatarNames,
    groupsByUserId,
    profileCache,
    settings,
    now
} = {}) {
    const shareBios = Boolean(settings?.shareBios);
    const fetchGroups = Boolean(settings?.fetchGroups);

    const players = toValues(playerList)
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => {
            const userId = str(entry.userId);
            return buildPlayerEntry({
                userId,
                entry,
                profile: lookup(cachedUsers, userId),
                extra: lookup(profileCache, userId),
                group: lookup(groupsByUserId, userId),
                avatarNames,
                shareBios,
                fetchGroups
            });
        });

    return {
        version: AIRI_PAYLOAD_VERSION,
        location: str(location),
        world: str(worldName),
        generatedAt: new Date(
            typeof now === 'number' ? now : Date.now()
        ).toISOString(),
        players
    };
}

// ── AIRI actions (friend requests) ────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const AIRI_ACTION_KINDS = Object.freeze([
    'friend-request',
    'friend-accept',
    'friend-status',
    'friend-requests'
]);

/**
 * Limits enforced by VRCX for actions requested by the local AI.
 * perUser: at most one action of that kind per userId within the window.
 */
export const AIRI_ACTION_LIMITS = Object.freeze({
    'friend-request': Object.freeze({
        perHour: 10,
        perDay: 30,
        perUserWindowMs: DAY_MS
    }),
    'friend-accept': Object.freeze({ perHour: 60 }),
    'friend-status': Object.freeze({ perHour: 120 }),
    'friend-requests': Object.freeze({ perHour: 120 })
});

/** Choices for the "accepts per hour" setting (friend-accept perHour). */
export const AIRI_ACCEPT_PER_HOUR_OPTIONS = Object.freeze([30, 60, 90, 120]);
export const AIRI_ACCEPT_PER_HOUR_DEFAULT =
    AIRI_ACTION_LIMITS['friend-accept'].perHour;

/**
 * Only these kinds are written to the config file. The others only guard
 * against request loops while VRCX runs and stay in memory.
 */
export const AIRI_PERSISTED_ACTION_KINDS = Object.freeze([
    'friend-request',
    'friend-accept'
]);

/**
 * @param {unknown} value
 * @returns {number} a valid accepts-per-hour choice
 */
export function normalizeAcceptPerHour(value) {
    const n = Number(value);
    return AIRI_ACCEPT_PER_HOUR_OPTIONS.includes(n)
        ? n
        : AIRI_ACCEPT_PER_HOUR_DEFAULT;
}

/**
 * The action limits with the user's accepts-per-hour setting applied.
 * @param {{acceptPerHour?: number}} [overrides]
 */
export function resolveActionLimits(overrides = {}) {
    return Object.freeze({
        ...AIRI_ACTION_LIMITS,
        'friend-accept': Object.freeze({
            ...AIRI_ACTION_LIMITS['friend-accept'],
            perHour: normalizeAcceptPerHour(overrides.acceptPerHour)
        })
    });
}

/** Max entries returned by GET /paw/friend-requests. */
export const AIRI_FRIEND_REQUESTS_MAX = 50;

const USER_ID_RE =
    /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Strict VRChat user id check: "usr_" followed by a lowercase UUID.
 * @param {unknown} userId
 * @returns {boolean}
 */
export function isValidAiriUserId(userId) {
    return typeof userId === 'string' && USER_ID_RE.test(userId);
}

/**
 * Keep only well-formed history entries from the last 24 hours.
 * @param {unknown} history
 * @param {number} now
 * @returns {{kind: string, userId: string, at: number}[]}
 */
export function pruneActionHistory(history, now) {
    if (!Array.isArray(history)) {
        return [];
    }
    return history.filter(
        (entry) =>
            entry &&
            typeof entry === 'object' &&
            AIRI_ACTION_KINDS.includes(entry.kind) &&
            typeof entry.userId === 'string' &&
            typeof entry.at === 'number' &&
            Number.isFinite(entry.at) &&
            entry.at <= now &&
            now - entry.at < DAY_MS
    );
}

/**
 * @param {number[]} times ascending
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 * @returns {number} seconds until a slot frees up, 0 when under the limit
 */
function retryAfterSec(times, limit, windowMs, now) {
    if (times.length < limit) {
        return 0;
    }
    const freesAt = times[times.length - limit] + windowMs;
    return Math.max(1, Math.ceil((freesAt - now) / 1000));
}

/**
 * Decide whether an action may be performed now. Does not record anything.
 * @param {{kind: string, userId: string, at: number}[]} history
 * @param {string} kind
 * @param {string} userId
 * @param {number} now
 * @param {Record<string, {perHour?: number, perDay?: number, perUserWindowMs?: number}>} [allLimits]
 * @returns {{allowed: true} | {allowed: false, reason: string, retryAfterSec: number}}
 */
export function checkActionRateLimit(
    history,
    kind,
    userId,
    now,
    allLimits = AIRI_ACTION_LIMITS
) {
    const limits = allLimits[kind];
    if (!limits) {
        return { allowed: false, reason: 'unknown_action', retryAfterSec: 0 };
    }
    const entries = pruneActionHistory(history, now).filter(
        (entry) => entry.kind === kind
    );
    if (limits.perUserWindowMs) {
        const last = entries
            .filter(
                (entry) =>
                    entry.userId === userId &&
                    now - entry.at < limits.perUserWindowMs
            )
            .reduce((max, entry) => Math.max(max, entry.at), -Infinity);
        if (last !== -Infinity) {
            return {
                allowed: false,
                reason: 'user_cooldown',
                retryAfterSec: Math.max(
                    1,
                    Math.ceil((last + limits.perUserWindowMs - now) / 1000)
                )
            };
        }
    }
    const times = entries.map((entry) => entry.at).sort((a, b) => a - b);
    if (limits.perDay) {
        const wait = retryAfterSec(times, limits.perDay, DAY_MS, now);
        if (wait) {
            return {
                allowed: false,
                reason: 'daily_limit',
                retryAfterSec: wait
            };
        }
    }
    if (limits.perHour) {
        const hourTimes = times.filter((at) => now - at < HOUR_MS);
        const wait = retryAfterSec(hourTimes, limits.perHour, HOUR_MS, now);
        if (wait) {
            return {
                allowed: false,
                reason: 'hourly_limit',
                retryAfterSec: wait
            };
        }
    }
    return { allowed: true };
}

/**
 * Remaining friend-action budget per kind (for /paw/status and the page).
 * @param {{kind: string, userId: string, at: number}[]} history
 * @param {number} now
 * @param {Record<string, {perHour?: number, perDay?: number}>} [allLimits]
 * @returns {Record<string, {usedHour: number, perHour: number|null, remainingHour: number|null, usedDay: number, perDay: number|null, remainingDay: number|null}>}
 */
export function computeActionBudget(
    history,
    now,
    allLimits = AIRI_ACTION_LIMITS
) {
    const entries = pruneActionHistory(history, now);
    /** @type {Record<string, any>} */
    const budget = {};
    for (const kind of AIRI_ACTION_KINDS) {
        const limits = allLimits[kind] ?? {};
        const ofKind = entries.filter((entry) => entry.kind === kind);
        const usedHour = ofKind.filter(
            (entry) => now - entry.at < HOUR_MS
        ).length;
        const usedDay = ofKind.length;
        budget[kind] = {
            usedHour,
            perHour: limits.perHour ?? null,
            remainingHour: limits.perHour
                ? Math.max(0, limits.perHour - usedHour)
                : null,
            usedDay,
            perDay: limits.perDay ?? null,
            remainingDay: limits.perDay
                ? Math.max(0, limits.perDay - usedDay)
                : null
        };
    }
    return budget;
}

/**
 * Incoming pending friend requests from VRCX's notification table
 * (type "friendRequest", filled by VRCX's own notification refresh and
 * websocket). One entry per sender, capped.
 *
 * Order: newest first by default. With `isPresent`, senders in the current
 * instance come first, then everyone else, each group oldest first (so a
 * backlog is worked through fairly), and every entry carries `inLobby`.
 * @param {unknown} notifications notificationTable.data
 * @param {object} [options]
 * @param {string} [options.currentUserId] requests sent by this user are skipped
 * @param {{has: (userId: string) => boolean}} [options.friendIds] senders already friends are skipped
 * @param {(userId: string) => string} [options.displayNameFor] fallback name lookup
 * @param {(userId: string) => boolean} [options.isPresent] sender is in the current instance
 * @param {number} [options.limit]
 * @returns {{userId: string, displayName: string, createdAt: string|null, inLobby?: boolean}[]}
 */
export function buildIncomingFriendRequests(notifications, options = {}) {
    const {
        currentUserId = '',
        friendIds = null,
        displayNameFor = null,
        isPresent = null,
        limit = AIRI_FRIEND_REQUESTS_MAX
    } = options;
    if (!Array.isArray(notifications)) {
        return [];
    }
    const bySender = new Map();
    for (const n of notifications) {
        if (
            !n ||
            typeof n !== 'object' ||
            n.type !== 'friendRequest' ||
            n.$isExpired ||
            !isValidAiriUserId(n.senderUserId) ||
            n.senderUserId === currentUserId ||
            friendIds?.has(n.senderUserId)
        ) {
            continue;
        }
        const parsed = Date.parse(n.created_at ?? n.createdAt);
        const ts = Number.isFinite(parsed) ? parsed : null;
        const prev = bySender.get(n.senderUserId);
        if (prev && (prev.ts ?? 0) >= (ts ?? 0)) {
            continue;
        }
        let displayName =
            typeof n.senderUsername === 'string' ? n.senderUsername : '';
        if (!displayName && typeof displayNameFor === 'function') {
            displayName = str(displayNameFor(n.senderUserId));
        }
        bySender.set(n.senderUserId, {
            ts,
            entry: {
                userId: n.senderUserId,
                displayName: str(displayName),
                createdAt: ts === null ? null : new Date(ts).toISOString()
            }
        });
    }
    const items = [...bySender.values()];
    if (typeof isPresent === 'function') {
        for (const item of items) {
            item.entry.inLobby = Boolean(isPresent(item.entry.userId));
        }
        // Unknown dates sort last within their group.
        const oldest = (item) => item.ts ?? Number.MAX_SAFE_INTEGER;
        items.sort(
            (a, b) =>
                Number(b.entry.inLobby) - Number(a.entry.inLobby) ||
                oldest(a) - oldest(b)
        );
    } else {
        items.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    }
    return items.slice(0, Math.max(0, limit)).map((item) => item.entry);
}

// ── AIRI lookup cache (represented group / bio) ──────────────

/** Represented groups are fetched again after this long. */
export const AIRI_GROUP_TTL_MS = 5 * DAY_MS;
/** Bios (and the VRC+ flag fetched with them) are fetched again after this long. */
export const AIRI_BIO_TTL_MS = DAY_MS;
/** Entries kept in memory (least recently used are evicted first). */
export const AIRI_USER_CACHE_MAX = 20000;
/** Rows kept in the database table. */
export const AIRI_USER_CACHE_DB_MAX = 50000;
/** Rows not seen for this long are deleted from the database. */
export const AIRI_USER_CACHE_DB_MAX_AGE_MS = 90 * DAY_MS;

/**
 * @param {number|null|undefined} fetchedAt
 * @param {number} ttlMs
 * @param {number} now
 * @returns {boolean}
 */
export function isCacheFresh(fetchedAt, ttlMs, now) {
    return (
        typeof fetchedAt === 'number' &&
        fetchedAt > 0 &&
        fetchedAt <= now &&
        now - fetchedAt < ttlMs
    );
}

/**
 * Small LRU map: get() refreshes an entry, set() evicts the least recently
 * used entries above `max`.
 * @param {number} max
 */
export function createLruMap(max) {
    /** @type {Map<string, any>} */
    const map = new Map();
    return {
        /** @param {string} key */
        get(key) {
            const value = map.get(key);
            if (value !== undefined) {
                map.delete(key);
                map.set(key, value);
            }
            return value;
        },
        /**
         * Read without refreshing the entry.
         * @param {string} key
         */
        peek(key) {
            return map.get(key);
        },
        /**
         * @param {string} key
         * @param {any} value
         */
        set(key, value) {
            map.delete(key);
            map.set(key, value);
            while (map.size > max) {
                map.delete(map.keys().next().value);
            }
        },
        /** @param {string} key */
        has(key) {
            return map.has(key);
        },
        /** @param {string} key */
        delete(key) {
            return map.delete(key);
        },
        clear() {
            map.clear();
        },
        get size() {
            return map.size;
        }
    };
}
