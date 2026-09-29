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
 * Build the JSON-safe payload shared with the local AI companion.
 * @param {{
 *   location?: string,
 *   worldName?: string,
 *   playerList?: Map<string, any> | any[] | Record<string, any>,
 *   cachedUsers?: Map<string, any> | Record<string, any>,
 *   avatarNames?: Map<string, string> | Record<string, string>,
 *   groupsByUserId?: Map<string, any> | Record<string, any>,
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
    settings,
    now
} = {}) {
    const shareBios = Boolean(settings?.shareBios);
    const fetchGroups = Boolean(settings?.fetchGroups);

    const players = toValues(playerList)
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => {
            const userId = str(entry.userId);
            const profile = lookup(cachedUsers, userId);
            const displayName =
                str(entry.displayName) || str(profile?.displayName);
            const avatarName = lookup(avatarNames, displayName);

            /** @type {Record<string, any>} */
            const player = {
                userId,
                displayName,
                joinTime:
                    typeof entry.joinTime === 'number' &&
                    Number.isFinite(entry.joinTime)
                        ? entry.joinTime
                        : null,
                isFriend: Boolean(profile?.isFriend),
                trustLevel: str(profile?.$trustLevel),
                isVRCPlus: Boolean(profile?.$isVRCPlus),
                platform: str(profile?.last_platform),
                avatarName: str(avatarName),
                status: str(profile?.status),
                statusDescription: str(profile?.statusDescription)
            };
            if (shareBios) {
                player.bio = sanitizeBio(profile?.bio);
            }
            if (fetchGroups) {
                const group = pickGroup(lookup(groupsByUserId, userId));
                if (group) {
                    player.representedGroup = group;
                }
            }
            return player;
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
    'friend-status'
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
    'friend-accept': Object.freeze({ perHour: 30 }),
    'friend-status': Object.freeze({ perHour: 120 })
});

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
 * @returns {{allowed: true} | {allowed: false, reason: string, retryAfterSec: number}}
 */
export function checkActionRateLimit(history, kind, userId, now) {
    const limits = AIRI_ACTION_LIMITS[kind];
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
