/**
 * AIRI social actions: pure helpers for the /paw social routes (boops,
 * invites, invite replies, her own status, private notes) and the social
 * event feed (GET /paw/events).
 *
 * Design rule: every outward action reacts to something a person did, or is
 * rare and ambient. These helpers enforce VRCX's side of that: per-kind
 * budgets, per-person cooldowns, target filters and sanitized text.
 */

import { photonEmojis } from '../constants/photon';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const AIRI_SOCIAL_KINDS = Object.freeze([
    'boop',
    'invite',
    'inviteRespond',
    'status',
    'note'
]);

/**
 * Internal budgets that are not social actions themselves but pace the
 * VRChat calls behind them.
 * - inviteMessage: rewriting one of her invite/response message slots
 * - read: profile/mutuals/world fetches made for GET /paw/user and /paw/world
 */
export const AIRI_SOCIAL_INTERNAL_KINDS = Object.freeze([
    'inviteMessage',
    'read'
]);

/**
 * VRCX's own limits for social actions (on top of VRChat's 429s).
 * perUserWindowMs: at most one action of the kind per key (userId, or
 * notificationId for inviteRespond) within the window.
 * minIntervalMs: at most one action of the kind within the window.
 */
export const AIRI_SOCIAL_LIMITS = Object.freeze({
    boop: Object.freeze({ perHour: 20, perUserWindowMs: 30 * MINUTE_MS }),
    invite: Object.freeze({ perHour: 10, perUserWindowMs: HOUR_MS }),
    inviteRespond: Object.freeze({ perHour: 30, perUserWindowMs: DAY_MS }),
    status: Object.freeze({ perDay: 20, minIntervalMs: 20 * MINUTE_MS }),
    note: Object.freeze({ perHour: 60 }),
    inviteMessage: Object.freeze({ minIntervalMs: 10 * MINUTE_MS }),
    read: Object.freeze({ perHour: 60 })
});

const ALL_KINDS = [...AIRI_SOCIAL_KINDS, ...AIRI_SOCIAL_INTERNAL_KINDS];

/** Escalating pause of all social writes after VRChat answers 429. */
export const AIRI_SOCIAL_BACKOFF_MS = Object.freeze([
    MINUTE_MS,
    10 * MINUTE_MS,
    HOUR_MS
]);
/** Strikes are forgotten after this long without another 429. */
export const AIRI_SOCIAL_STRIKE_RESET_MS = 6 * HOUR_MS;

/**
 * @param {number} strikes consecutive 429s (1 = first)
 * @returns {number}
 */
export function socialBackoffMs(strikes) {
    const index = Math.min(
        AIRI_SOCIAL_BACKOFF_MS.length - 1,
        Math.max(0, strikes - 1)
    );
    return AIRI_SOCIAL_BACKOFF_MS[index];
}

export const AIRI_STATUS_VALUES = Object.freeze([
    'active',
    'join me',
    'ask me',
    'busy'
]);
export const AIRI_STATUS_DESCRIPTION_MAX = 32;
export const AIRI_SLOT_MESSAGE_MAX = 64;
export const AIRI_NOTE_MAX = 256;
export const AIRI_SLOT_COUNT = 12;
/**
 * Slots 0-3 of every message collection stay as Oliver wrote them (canned
 * fallbacks). Only these slots are rewritten with personalized text.
 */
export const AIRI_REWRITABLE_SLOTS = Object.freeze([4, 5, 6, 7, 8, 9, 10, 11]);
/** Invite slot lists are fetched again after this long. */
export const AIRI_SLOT_CACHE_MS = 5 * MINUTE_MS;
/** Events kept for GET /paw/events. */
export const AIRI_EVENT_RING_MAX = 500;
/** A boop VRChat refused (boops off, not friends) is not retried for this long. */
export const AIRI_BOOP_FAILURE_COOLDOWN_MS = DAY_MS;
/** /paw/user profile and mutual counts are fetched again after this long. */
export const AIRI_USER_READ_TTL_MS = DAY_MS;
/** /paw/world data is fetched again after this long. */
export const AIRI_WORLD_READ_TTL_MS = 6 * HOUR_MS;

/** Boop emojis that read as flirty: only for targets whose age is verified 18+. */
export const AIRI_FLIRTY_EMOJIS = Object.freeze([
    'default_kiss',
    'default_in_love'
]);

/**
 * Same mapping as VRCX's boop dialog: "Hand Wave" -> "default_hand_wave".
 * @param {string} name
 * @returns {string}
 */
export function emojiIdFromName(name) {
    return `default_${name.replace(/ /g, '_').toLowerCase()}`;
}

/** Every default (free) boop emoji. */
export const AIRI_BOOP_EMOJIS = Object.freeze(photonEmojis.map(emojiIdFromName));

/**
 * @param {unknown} emojiId
 * @returns {boolean}
 */
export function isValidBoopEmoji(emojiId) {
    return typeof emojiId === 'string' && AIRI_BOOP_EMOJIS.includes(emojiId);
}

const NOTIFICATION_ID_RE =
    /^not_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {unknown} notificationId
 * @returns {boolean}
 */
export function isValidNotificationId(notificationId) {
    return (
        typeof notificationId === 'string' &&
        NOTIFICATION_ID_RE.test(notificationId)
    );
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Trim text and collapse control characters / line breaks into spaces.
 * @param {unknown} value
 * @returns {string|null} null when not a string
 */
export function cleanText(value) {
    if (typeof value !== 'string') {
        return null;
    }
    return value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate optional bounded text: undefined stays undefined, anything else
 * must clean to a string of at most `max` characters.
 * @param {unknown} value
 * @param {number} max
 * @param {boolean} [allowEmpty]
 * @returns {{ok: true, value: string|undefined} | {ok: false}}
 */
export function boundedText(value, max, allowEmpty = false) {
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    const text = cleanText(value);
    if (text === null || text.length > max || (!allowEmpty && !text)) {
        return { ok: false };
    }
    return { ok: true, value: text };
}

/**
 * @param {unknown} value
 * @returns {{ok: true, value: number|undefined} | {ok: false}}
 */
export function optionalSlot(value) {
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= AIRI_SLOT_COUNT
    ) {
        return { ok: false };
    }
    return { ok: true, value };
}

/**
 * Keep only well-formed social history entries from the last 24 hours.
 * @param {unknown} history
 * @param {number} now
 * @returns {{kind: string, key: string, at: number}[]}
 */
export function pruneSocialHistory(history, now) {
    if (!Array.isArray(history)) {
        return [];
    }
    return history.filter(
        (entry) =>
            entry &&
            typeof entry === 'object' &&
            ALL_KINDS.includes(entry.kind) &&
            typeof entry.key === 'string' &&
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
 * @returns {number} ms until a slot frees up, 0 when under the limit
 */
function waitMs(times, limit, windowMs, now) {
    if (times.length < limit) {
        return 0;
    }
    return Math.max(1, times[times.length - limit] + windowMs - now);
}

/**
 * Decide whether a social action may run now. Does not record anything.
 * @param {{kind: string, key: string, at: number}[]} history
 * @param {string} kind
 * @param {string} key userId, notificationId, or '' for global kinds
 * @param {number} now
 * @param {Record<string, any>} [limits]
 * @returns {{allowed: boolean, reason: string, retryAfterSec: number, nextAllowedAt: number}}
 *   reason '' and retryAfterSec/nextAllowedAt 0 when allowed
 */
export function checkSocialLimit(
    history,
    kind,
    key,
    now,
    limits = AIRI_SOCIAL_LIMITS
) {
    const limit = limits[kind];
    if (!limit) {
        return {
            allowed: false,
            reason: 'unknown_action',
            retryAfterSec: 0,
            nextAllowedAt: 0
        };
    }
    const entries = pruneSocialHistory(history, now).filter(
        (entry) => entry.kind === kind
    );
    const times = entries.map((entry) => entry.at).sort((a, b) => a - b);
    /** @param {string} reason @param {number} ms */
    const deny = (reason, ms) => ({
        allowed: false,
        reason,
        retryAfterSec: Math.max(1, Math.ceil(ms / 1000)),
        nextAllowedAt: now + ms
    });
    if (limit.minIntervalMs && times.length) {
        const since = now - times[times.length - 1];
        if (since < limit.minIntervalMs) {
            return deny('too_soon', limit.minIntervalMs - since);
        }
    }
    if (limit.perUserWindowMs) {
        const last = entries
            .filter((entry) => entry.key === key)
            .reduce((max, entry) => Math.max(max, entry.at), -Infinity);
        if (last !== -Infinity && now - last < limit.perUserWindowMs) {
            return deny('user_cooldown', last + limit.perUserWindowMs - now);
        }
    }
    if (limit.perDay) {
        const ms = waitMs(times, limit.perDay, DAY_MS, now);
        if (ms) {
            return deny('daily_limit', ms);
        }
    }
    if (limit.perHour) {
        const hourTimes = times.filter((at) => now - at < HOUR_MS);
        const ms = waitMs(hourTimes, limit.perHour, HOUR_MS, now);
        if (ms) {
            return deny('hourly_limit', ms);
        }
    }
    return { allowed: true, reason: '', retryAfterSec: 0, nextAllowedAt: 0 };
}

/**
 * Budget per social kind for /paw/status and the AIRI Integration page.
 * @param {{kind: string, key: string, at: number}[]} history
 * @param {number} now
 * @param {Record<string, any>} [limits]
 * @returns {Record<string, {usedHour: number, perHour: number|null, remainingHour: number|null, usedDay: number, perDay: number|null, remainingDay: number|null, nextAllowedAt: number}>}
 */
export function computeSocialBudget(
    history,
    now,
    limits = AIRI_SOCIAL_LIMITS
) {
    const entries = pruneSocialHistory(history, now);
    /** @type {Record<string, any>} */
    const budget = {};
    for (const kind of AIRI_SOCIAL_KINDS) {
        const limit = limits[kind] ?? {};
        const ofKind = entries.filter((entry) => entry.kind === kind);
        const usedHour = ofKind.filter(
            (entry) => now - entry.at < HOUR_MS
        ).length;
        const usedDay = ofKind.length;
        let nextAllowedAt = 0;
        if (limit.minIntervalMs || limit.perDay || limit.perHour) {
            const check = checkSocialLimit(
                history,
                kind,
                // A key never used: only global limits count here.
                '\u0000',
                now,
                limits
            );
            nextAllowedAt = check.allowed ? 0 : check.nextAllowedAt;
        }
        budget[kind] = {
            usedHour,
            perHour: limit.perHour ?? null,
            remainingHour: limit.perHour
                ? Math.max(0, limit.perHour - usedHour)
                : null,
            usedDay,
            perDay: limit.perDay ?? null,
            remainingDay: limit.perDay
                ? Math.max(0, limit.perDay - usedDay)
                : null,
            nextAllowedAt
        };
    }
    return budget;
}

/**
 * @param {unknown} tags
 * @returns {{troll: boolean, probableTroll: boolean}}
 */
export function trollTags(tags) {
    const list = Array.isArray(tags) ? tags : [];
    return {
        troll: list.includes('system_troll'),
        probableTroll: list.includes('system_probable_troll')
    };
}

/**
 * @param {unknown} location
 * @returns {boolean} a joinable world instance location
 */
export function isInstanceLocation(location) {
    return (
        typeof location === 'string' &&
        /^wrld_[0-9a-f-]{36}:[^\s]+$/.test(location)
    );
}

/**
 * Where a friend is, relative to her, without exposing other instances' ids.
 * @param {unknown} location
 * @param {unknown} travelingTo
 * @param {unknown} myLocation her current instance
 * @returns {'same-instance'|'private'|'other'|'offline'}
 */
export function classifyLocation(location, travelingTo, myLocation) {
    const mine = isInstanceLocation(myLocation) ? myLocation : '';
    if (mine && (location === mine || travelingTo === mine)) {
        return 'same-instance';
    }
    const where = location === 'traveling' ? travelingTo : location;
    if (typeof where !== 'string' || !where || where === 'offline') {
        return 'offline';
    }
    if (where === 'private' || where.startsWith('traveling')) {
        return 'private';
    }
    return isInstanceLocation(where) ? 'other' : 'private';
}

/**
 * @param {unknown} location
 * @returns {string} the world id of an instance location, or ''
 */
export function worldIdOf(location) {
    return isInstanceLocation(location)
        ? /** @type {string} */ (location).split(':')[0]
        : '';
}

const USER_ID_RE =
    /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Map one VRChat websocket message to a social event for GET /paw/events,
 * or null when it is not one. The result never carries another instance's
 * id: locations are only classified.
 * @param {string} type websocket message type
 * @param {any} content parsed websocket content
 * @param {{
 *   myLocation?: string,
 *   myWorldName?: string,
 *   currentUserId?: string,
 *   displayNameFor?: (userId: string) => string,
 *   worldNameFor?: (worldId: string) => string
 * }} [ctx]
 * @returns {Record<string, any> | null}
 */
export function mapSocialEvent(type, content, ctx = {}) {
    if (!content || typeof content !== 'object') {
        return null;
    }
    const nameFor = (userId) =>
        typeof ctx.displayNameFor === 'function'
            ? str(ctx.displayNameFor(userId))
            : '';
    const whereOf = (location, travelingTo) => {
        const where = classifyLocation(location, travelingTo, ctx.myLocation);
        /** @type {Record<string, any>} */
        const out = { location: where };
        if (where === 'same-instance') {
            if (ctx.myWorldName) {
                out.worldName = ctx.myWorldName;
            }
        } else if (where === 'other' && typeof ctx.worldNameFor === 'function') {
            const worldName = str(
                ctx.worldNameFor(
                    worldIdOf(location === 'traveling' ? travelingTo : location)
                )
            );
            if (worldName) {
                out.worldName = worldName;
            }
        }
        return out;
    };
    /** @type {Record<string, any> | null} */
    let event = null;
    switch (type) {
        case 'notification':
        case 'notification-v2': {
            const userId = str(content.senderUserId);
            const displayName =
                cleanText(content.senderUsername) || nameFor(userId);
            const notificationId = str(content.id);
            const details =
                content.details && typeof content.details === 'object'
                    ? content.details
                    : {};
            switch (content.type) {
                case 'boop': {
                    const emojiId = str(details.emojiId);
                    event = {
                        type: 'boop',
                        userId,
                        displayName,
                        notificationId,
                        emojiId: isValidBoopEmoji(emojiId)
                            ? emojiId
                            : emojiId
                              ? 'custom'
                              : ''
                    };
                    break;
                }
                case 'invite': {
                    event = {
                        type: 'invite',
                        userId,
                        displayName,
                        notificationId,
                        location: 'other'
                    };
                    const worldName = cleanText(details.worldName);
                    if (worldName) {
                        event.worldName = worldName.slice(0, 100);
                    }
                    if (
                        isInstanceLocation(ctx.myLocation) &&
                        details.worldId === ctx.myLocation
                    ) {
                        event.location = 'same-instance';
                    }
                    break;
                }
                case 'requestInvite':
                    event = {
                        type: 'requestInvite',
                        userId,
                        displayName,
                        notificationId
                    };
                    break;
                case 'inviteResponse':
                case 'requestInviteResponse': {
                    event = {
                        type: 'inviteResponse',
                        userId,
                        displayName,
                        notificationId
                    };
                    const message = cleanText(details.responseMessage);
                    if (message) {
                        event.message = message.slice(0, AIRI_SLOT_MESSAGE_MAX);
                    }
                    break;
                }
                default:
                    return null;
            }
            break;
        }
        case 'friend-online':
        case 'friend-location': {
            const userId = str(content.userId);
            event = {
                type,
                userId,
                displayName:
                    cleanText(content.user?.displayName) || nameFor(userId),
                ...whereOf(content.location, content.travelingToLocation)
            };
            break;
        }
        case 'friend-offline': {
            const userId = str(content.userId);
            event = {
                type,
                userId,
                displayName: nameFor(userId),
                location: 'offline'
            };
            break;
        }
        case 'friend-add':
        case 'friend-delete': {
            const userId = str(content.userId);
            event = {
                type,
                userId,
                displayName:
                    cleanText(content.user?.displayName) || nameFor(userId)
            };
            break;
        }
        default:
            return null;
    }
    if (!USER_ID_RE.test(event.userId) || event.userId === ctx.currentUserId) {
        return null;
    }
    if (event.notificationId !== undefined && !event.notificationId) {
        delete event.notificationId;
    }
    if (event.emojiId === '') {
        delete event.emojiId;
    }
    return event;
}

/**
 * Bounded, sequence-numbered event buffer.
 * @param {number} [max]
 */
export function createEventRing(max = AIRI_EVENT_RING_MAX) {
    /** @type {Record<string, any>[]} */
    let events = [];
    let seq = 0;
    return {
        /**
         * @param {Record<string, any>} event
         * @param {number} [at]
         */
        push(event, at = Date.now()) {
            seq++;
            const entry = {
                seq,
                at: new Date(at).toISOString(),
                ...event
            };
            events.push(entry);
            if (events.length > max) {
                events = events.slice(events.length - max);
            }
            return entry;
        },
        /**
         * Events with seq > after. A cursor from before a restart (after >
         * seq) starts over from the oldest event kept.
         * @param {number} after
         */
        after(after) {
            const from =
                Number.isFinite(after) && after >= 0 && after <= seq ? after : 0;
            return events.filter((event) => event.seq > from);
        },
        /** @param {number} n */
        latest(n) {
            return events.slice(-Math.max(0, n)).reverse();
        },
        get seq() {
            return seq;
        },
        get size() {
            return events.length;
        },
        clear() {
            events = [];
        }
    };
}

/**
 * @typedef {{slot: number, message: string, remainingCooldownMinutes?: number, canBeUpdated?: boolean, updatedAt?: string}} InviteSlot
 */

/**
 * @param {InviteSlot} slot
 * @param {number} elapsedMs since the slot list was fetched
 * @returns {number} ms until the slot can be rewritten
 */
function slotCooldownMs(slot, elapsedMs) {
    const minutes = Number(slot?.remainingCooldownMinutes) || 0;
    return Math.max(0, minutes * MINUTE_MS - Math.max(0, elapsedMs));
}

/**
 * Choose the message slot for a personalized line.
 * - a slot that already holds exactly this text is used as is;
 * - otherwise the preferred slot, when it can be rewritten now;
 * - otherwise the least recently updated rewritable slot (4-11);
 * - otherwise none, with the time until one frees up.
 * @param {{
 *   slots: InviteSlot[],
 *   message: string,
 *   preferredSlot?: number,
 *   elapsedMs?: number
 * }} params
 * @returns {{slot: number|null, edit?: boolean, retryAfterSec?: number}}
 *   slot null (with retryAfterSec) when no slot can take the text now
 */
export function pickMessageSlot({ slots, message, preferredSlot, elapsedMs = 0 }) {
    const list = Array.isArray(slots)
        ? slots.filter(
              (s) =>
                  s &&
                  typeof s === 'object' &&
                  Number.isInteger(s.slot) &&
                  s.slot >= 0 &&
                  s.slot < AIRI_SLOT_COUNT
          )
        : [];
    const same = list.find((s) => s.message === message);
    if (same) {
        return { slot: same.slot, edit: false };
    }
    const writable = (s) =>
        s.canBeUpdated !== false && slotCooldownMs(s, elapsedMs) === 0;
    if (preferredSlot !== undefined) {
        const preferred = list.find((s) => s.slot === preferredSlot);
        if (preferred && writable(preferred)) {
            return { slot: preferred.slot, edit: true };
        }
    }
    const pool = list.filter((s) => AIRI_REWRITABLE_SLOTS.includes(s.slot));
    const free = pool
        .filter(writable)
        .sort(
            (a, b) =>
                (Date.parse(a.updatedAt ?? '') || 0) -
                    (Date.parse(b.updatedAt ?? '') || 0) || a.slot - b.slot
        );
    if (free.length) {
        return { slot: free[0].slot, edit: true };
    }
    const waits = pool.map((s) => slotCooldownMs(s, elapsedMs)).filter((ms) => ms > 0);
    const wait = waits.length ? Math.min(...waits) : 60 * MINUTE_MS;
    return { slot: null, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) };
}
