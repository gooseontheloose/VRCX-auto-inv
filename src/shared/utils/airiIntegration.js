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
