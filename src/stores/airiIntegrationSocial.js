import { reactive, ref } from 'vue';

import {
    AIRI_BOOP_FAILURE_COOLDOWN_MS,
    AIRI_FLIRTY_EMOJIS,
    AIRI_NOTE_MAX,
    AIRI_SLOT_CACHE_MS,
    AIRI_SLOT_MESSAGE_MAX,
    AIRI_SOCIAL_KINDS,
    AIRI_SOCIAL_STRIKE_RESET_MS,
    AIRI_STATUS_DESCRIPTION_MAX,
    AIRI_STATUS_VALUES,
    AIRI_USER_READ_TTL_MS,
    AIRI_WORLD_READ_TTL_MS,
    boundedText,
    checkSocialLimit,
    computeSocialBudget,
    createEventRing,
    isInstanceLocation,
    isValidBoopEmoji,
    isValidNotificationId,
    mapSocialEvent,
    optionalSlot,
    pickMessageSlot,
    pruneSocialHistory,
    socialBackoffMs,
    trollTags,
    worldIdOf
} from '../shared/utils/airiSocial';
import { isValidAiriUserId, sanitizeBio } from '../shared/utils/airiIntegration';
import { isRateLimitError } from '../shared/utils/airiLookupQueue';
import {
    inviteMessagesRequest,
    miscRequest,
    notificationRequest,
    userRequest,
    worldRequest
} from '../api';
import { useFriendStore } from './friend';
import { useNotificationStore } from './notification';
import { useWorldStore } from './world';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';

export const SOCIAL_CONFIG_KEYS = Object.freeze({
    enabled: 'PAW_airiIntegration_socialEnabled',
    dryRun: 'PAW_airiIntegration_socialDryRun',
    kinds: 'PAW_airiIntegration_socialKinds',
    history: 'PAW_airiIntegration_socialHistory'
});

/** Social write routes -> kind. Reads: events, user, world. */
export const AIRI_SOCIAL_WRITE_KINDS = Object.freeze([...AIRI_SOCIAL_KINDS]);
export const AIRI_SOCIAL_READ_KINDS = Object.freeze(['events', 'user', 'world']);

const HISTORY_SAVE_DELAY_MS = 1000;
/** Events shown on the AIRI Integration page. */
const RECENT_EVENTS_SHOWN = 30;

/**
 * VRChat social actions for the local AI (Meow Meow): boops, invites,
 * invite replies, her own status, private notes, plus the social event feed
 * and read-only context lookups. Built by the AIRI integration store, which
 * owns the token check, the integration switch and the shared VRChat 429
 * backoff.
 *
 * @param {{
 *   enabled: import('vue').Ref<boolean>,
 *   userStore: any,
 *   locationStore: any,
 *   gameLogStore: any,
 *   vrchatCooldownSec: () => number,
 *   reportRateLimit: () => void,
 *   logAction: (kind: string, userId: string, displayName: string, result: string, status: number) => void,
 *   cachedDisplayName: (userId: string) => string
 * }} deps
 */
export function createAiriSocial(deps) {
    const {
        enabled,
        userStore,
        locationStore,
        gameLogStore,
        vrchatCooldownSec,
        reportRateLimit,
        logAction,
        cachedDisplayName
    } = deps;

    // ── Settings ───────────────────────────────────────────────
    /** "Allow AIRI social actions": every social write needs it (default off). */
    const socialEnabled = ref(false);
    /** Validate, check limits and log, but never call VRChat. */
    const socialDryRun = ref(false);
    /** Per-kind switches under the master switch (each on by default). */
    const socialKinds = reactive(
        Object.fromEntries(AIRI_SOCIAL_KINDS.map((kind) => [kind, true]))
    );
    let isLoaded = false;

    // ── State ──────────────────────────────────────────────────
    /** {kind, key, at}[] of the last 24 h, persisted. */
    let history = [];
    let historySaveTimer = null;
    /** @type {Promise<any>} */
    let chain = Promise.resolve();
    /** Escalating social pause after VRChat 429s. */
    let pauseUntil = 0;
    let strikes = 0;
    let lastStrikeAt = 0;
    /** notificationIds already answered (in memory; also in history). */
    const responded = new Set();
    /** userId -> time a boop to them failed (boops off / not friends). */
    const boopFailedAt = new Map();
    /** message type -> {slots, fetchedAt} */
    const slotCache = new Map();
    /** userId -> {at, friends?, groups?} */
    const mutualCache = new Map();
    /** userId -> time we fetched their user object */
    const userFetchedAt = new Map();
    /** worldId -> {at, world} */
    const worldCache = new Map();
    /** userId -> last location class sent as friend-location */
    const lastLocationClass = new Map();
    const events = createEventRing();
    /** Bumped on every event / action (the page re-renders on it). */
    const socialVersion = ref(0);

    async function loadSocialSettings() {
        const [enabledConfig, dryRunConfig, kindsConfig, historyConfig] =
            await Promise.all([
                configRepository.getBool(SOCIAL_CONFIG_KEYS.enabled, false),
                configRepository.getBool(SOCIAL_CONFIG_KEYS.dryRun, false),
                configRepository.getString(SOCIAL_CONFIG_KEYS.kinds, '{}'),
                configRepository.getString(SOCIAL_CONFIG_KEYS.history, '[]')
            ]);
        socialEnabled.value = Boolean(enabledConfig);
        socialDryRun.value = Boolean(dryRunConfig);
        try {
            const kinds = JSON.parse(kindsConfig || '{}');
            for (const kind of AIRI_SOCIAL_KINDS) {
                if (typeof kinds?.[kind] === 'boolean') {
                    socialKinds[kind] = kinds[kind];
                }
            }
        } catch {
            // keep defaults
        }
        try {
            history = pruneSocialHistory(
                JSON.parse(historyConfig || '[]'),
                Date.now()
            );
        } catch {
            history = [];
        }
        for (const entry of history) {
            if (entry.kind === 'inviteRespond') {
                responded.add(entry.key);
            }
        }
        isLoaded = true;
    }

    function setSocialEnabled(value) {
        socialEnabled.value = Boolean(value);
        if (isLoaded) {
            configRepository.setBool(
                SOCIAL_CONFIG_KEYS.enabled,
                socialEnabled.value
            );
        }
    }

    function setSocialDryRun(value) {
        socialDryRun.value = Boolean(value);
        if (isLoaded) {
            configRepository.setBool(
                SOCIAL_CONFIG_KEYS.dryRun,
                socialDryRun.value
            );
        }
    }

    /**
     * @param {string} kind
     * @param {boolean} value
     */
    function setSocialKindEnabled(kind, value) {
        if (!AIRI_SOCIAL_KINDS.includes(kind)) {
            return;
        }
        socialKinds[kind] = Boolean(value);
        if (isLoaded) {
            configRepository.setString(
                SOCIAL_CONFIG_KEYS.kinds,
                JSON.stringify({ ...socialKinds })
            );
        }
    }

    // ── History / limits ───────────────────────────────────────

    function saveHistory() {
        if (historySaveTimer) {
            return;
        }
        historySaveTimer = setTimeout(() => {
            historySaveTimer = null;
            configRepository
                .setString(
                    SOCIAL_CONFIG_KEYS.history,
                    JSON.stringify(pruneSocialHistory(history, Date.now()))
                )
                .catch((err) =>
                    console.warn(
                        '[AiriIntegration] saving social history failed',
                        err
                    )
                );
        }, HISTORY_SAVE_DELAY_MS);
    }

    /**
     * @param {string} kind
     * @param {string} key
     */
    function record(kind, key) {
        const now = Date.now();
        history = pruneSocialHistory(history, now);
        history.push({ kind, key, at: now });
        saveHistory();
    }

    /**
     * @param {string} kind
     * @param {string} key
     */
    function check(kind, key) {
        return checkSocialLimit(history, kind, key, Date.now());
    }

    function getSocialBudget() {
        return computeSocialBudget(history, Date.now());
    }

    /** A VRChat 429 anywhere: pause social writes 1 min, then 10 min, then 1 h. */
    function onRateLimit() {
        const now = Date.now();
        if (now - lastStrikeAt > AIRI_SOCIAL_STRIKE_RESET_MS) {
            strikes = 0;
        }
        // One burst of 429s (several calls failing together) is one strike.
        if (now < pauseUntil && now - lastStrikeAt < 5000) {
            return;
        }
        strikes++;
        lastStrikeAt = now;
        pauseUntil = Math.max(pauseUntil, now + socialBackoffMs(strikes));
        socialVersion.value++;
        console.warn(
            `[AiriIntegration] VRChat rate limit: social actions paused until ${new Date(pauseUntil).toISOString()} (strike ${strikes})`
        );
    }

    /** @returns {number} seconds until social writes may run again */
    function socialPauseSec() {
        const own = Math.max(0, Math.ceil((pauseUntil - Date.now()) / 1000));
        return Math.max(own, vrchatCooldownSec());
    }

    function getSocialPause() {
        const retryAfterSec = socialPauseSec();
        return {
            paused: retryAfterSec > 0,
            retryAfterSec,
            strikes
        };
    }

    // ── Responses ──────────────────────────────────────────────

    /** @returns {[number, Record<string, any>]} */
    function localLimited(limit, result = 'rate_limited') {
        return [
            429,
            {
                ok: false,
                result,
                reason: limit.reason,
                scope: 'local',
                retryAfterSec: limit.retryAfterSec,
                nextAllowedAt: new Date(limit.nextAllowedAt).toISOString()
            }
        ];
    }

    /** @returns {[number, Record<string, any>]} */
    function vrchatLimited(retryAfterSec) {
        return [
            429,
            {
                ok: false,
                result: 'rate_limited',
                reason: 'vrchat_rate_limited',
                error: 'vrchat_rate_limited',
                scope: 'vrchat',
                retryAfterSec: Math.max(1, retryAfterSec)
            }
        ];
    }

    /** @returns {[number, Record<string, any>]} */
    function refused(result, extra = {}) {
        return [200, { ok: false, result, ...extra }];
    }

    /** @returns {[number, Record<string, any>]} */
    function badRequest(error) {
        return [400, { ok: false, error }];
    }

    /** @returns {[number, Record<string, any>]} */
    function dryRun(wouldBe, extra = {}) {
        return [200, { ok: true, result: 'dry_run', wouldBe, ...extra }];
    }

    // ── Targets ────────────────────────────────────────────────

    function friendStore() {
        return useFriendStore();
    }

    function isFriend(userId) {
        return Boolean(friendStore().friends?.has?.(userId));
    }

    /**
     * Filters shared by boops and invites. Only friends; never troll-tagged
     * users; not people who set themselves busy.
     * @param {string} userId
     * @returns {string} refusal result, or '' when the target is fine
     */
    function targetRefusal(userId) {
        if (!isFriend(userId)) {
            return 'not_friends';
        }
        const ref = userStore.cachedUsers.get(userId);
        const tags = trollTags(ref?.tags);
        if (tags.troll || tags.probableTroll) {
            return 'target_blocked';
        }
        if (ref?.status === 'busy') {
            return 'target_busy';
        }
        return '';
    }

    /**
     * The user's age verification status, fetching their user object once a
     * day when VRCX only has a friend-list entry without it.
     * @param {string} userId
     * @param {boolean} allowFetch
     * @returns {Promise<string>}
     */
    async function ageStatusOf(userId, allowFetch) {
        const cached = userStore.cachedUsers.get(userId);
        if (cached?.ageVerificationStatus) {
            return String(cached.ageVerificationStatus);
        }
        if (allowFetch && (await fetchUserIfStale(userId))) {
            return String(
                userStore.cachedUsers.get(userId)?.ageVerificationStatus ?? ''
            );
        }
        return '';
    }

    /**
     * @param {string} userId
     * @returns {Promise<boolean>} fetched now
     */
    async function fetchUserIfStale(userId) {
        const at = userFetchedAt.get(userId) ?? 0;
        if (Date.now() - at < AIRI_USER_READ_TTL_MS) {
            return false;
        }
        if (vrchatCooldownSec() > 0 || !check('read', '').allowed) {
            return false;
        }
        record('read', '');
        userFetchedAt.set(userId, Date.now());
        try {
            await userRequest.getUser({ userId });
            return true;
        } catch (err) {
            if (isRateLimitError(err)) {
                reportRateLimit();
            }
            return false;
        }
    }

    // ── Invite message slots ───────────────────────────────────

    /**
     * @param {'message'|'response'|'requestResponse'} type
     * @returns {Promise<{slots: any[], fetchedAt: number} | null>}
     */
    async function getSlots(type) {
        const cached = slotCache.get(type);
        if (cached && Date.now() - cached.fetchedAt < AIRI_SLOT_CACHE_MS) {
            return cached;
        }
        if (!check('read', '').allowed) {
            return cached ?? null;
        }
        record('read', '');
        const args = await inviteMessagesRequest.refreshInviteMessageTableData(
            type,
            { silentErrors: true }
        );
        const entry = {
            slots: Array.isArray(args?.json) ? args.json : [],
            fetchedAt: Date.now()
        };
        slotCache.set(type, entry);
        return entry;
    }

    /**
     * Put a personalized line into one of her message slots (or find one
     * that already holds it), respecting VRChat's 60-minute slot cooldown and
     * VRCX's one-edit-per-10-minutes pace.
     * @param {'message'|'response'|'requestResponse'} type
     * @param {string|undefined} message
     * @param {number|undefined} preferredSlot
     * @returns {Promise<{slot: number|undefined, applied: boolean, skipped?: string} | {slot: null, retryAfterSec: number}>}
     */
    async function applyMessage(type, message, preferredSlot) {
        if (!message) {
            return { slot: preferredSlot, applied: false };
        }
        const cached = await getSlots(type);
        let pick = cached
            ? pickMessageSlot({
                  slots: cached.slots,
                  message,
                  preferredSlot,
                  elapsedMs: Date.now() - cached.fetchedAt
              })
            : { slot: null, retryAfterSec: 60 };
        if (pick.slot !== null && pick.edit) {
            const pace = check('inviteMessage', '');
            if (pace.allowed) {
                record('inviteMessage', '');
                const args = await inviteMessagesRequest.editInviteMessage(
                    { message },
                    type,
                    pick.slot,
                    { silentErrors: true }
                );
                const slots = Array.isArray(args?.json) ? args.json : null;
                if (slots) {
                    slotCache.set(type, { slots, fetchedAt: Date.now() });
                }
                const written = slots?.find((s) => s?.slot === pick.slot);
                if (written?.message === message) {
                    return { slot: pick.slot, applied: true };
                }
                pick = { slot: null, retryAfterSec: 60 };
            } else {
                pick = { slot: null, retryAfterSec: pace.retryAfterSec };
            }
        } else if (pick.slot !== null) {
            return { slot: pick.slot, applied: true };
        }
        if (preferredSlot !== undefined) {
            // The requested slot's stored text goes out instead.
            return {
                slot: preferredSlot,
                applied: false,
                skipped: 'slot_cooldown'
            };
        }
        return { slot: null, retryAfterSec: pick.retryAfterSec };
    }

    // ── Her current instance ───────────────────────────────────

    function currentInstance() {
        const last = locationStore.lastLocation;
        let location = last?.location;
        if (location === 'traveling') {
            location = locationStore.lastLocationDestination;
        }
        if (!isInstanceLocation(location)) {
            return null;
        }
        const worldId = worldIdOf(location);
        const worldName =
            (location === last?.location && last?.name) ||
            worldNameFor(worldId) ||
            '';
        return { location, worldId, worldName };
    }

    function worldNameFor(worldId) {
        if (!worldId) {
            return '';
        }
        const own = worldCache.get(worldId)?.world?.name;
        if (own) {
            return own;
        }
        try {
            const name = useWorldStore().cachedWorlds?.get?.(worldId)?.name;
            return typeof name === 'string' ? name : '';
        } catch {
            return '';
        }
    }

    // ── Writes ─────────────────────────────────────────────────

    /**
     * @param {Record<string, any>} body
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runBoop(body) {
        const { userId } = body;
        if (!isValidAiriUserId(userId)) {
            return badRequest('invalid_user_id');
        }
        if (userId === userStore.currentUser.id) {
            return badRequest('self_not_allowed');
        }
        const emojiId = body.emojiId;
        if (
            emojiId !== undefined &&
            emojiId !== null &&
            !isValidBoopEmoji(emojiId)
        ) {
            return badRequest('invalid_emoji');
        }
        const refusal = targetRefusal(userId);
        if (refusal) {
            return refused(refusal);
        }
        const failedAt = boopFailedAt.get(userId);
        if (
            failedAt !== undefined &&
            Date.now() - failedAt < AIRI_BOOP_FAILURE_COOLDOWN_MS
        ) {
            return refused('boop_unavailable', {
                retryAfterSec: Math.ceil(
                    (failedAt + AIRI_BOOP_FAILURE_COOLDOWN_MS - Date.now()) /
                        1000
                )
            });
        }
        const limit = check('boop', userId);
        if (!limit.allowed) {
            return localLimited(limit);
        }
        if (AIRI_FLIRTY_EMOJIS.includes(emojiId)) {
            const age = await ageStatusOf(userId, !socialDryRun.value);
            if (age !== '18+') {
                return refused('age_gate', { ageVerificationStatus: age });
            }
        }
        if (socialDryRun.value) {
            return dryRun('booped');
        }
        record('boop', userId);
        /** @type {{userId: string, emojiId?: string}} */
        const params = { userId };
        if (emojiId) {
            params.emojiId = emojiId;
        }
        try {
            await miscRequest.sendBoop(/** @type {any} */ (params), {
                silentErrors: true
            });
        } catch (err) {
            const status = /** @type {any} */ (err)?.status;
            if (status === 400 || status === 403 || status === 404) {
                boopFailedAt.set(userId, Date.now());
                return refused(status === 403 ? 'not_friends' : 'boop_failed', {
                    vrchatStatus: status
                });
            }
            throw err;
        }
        return [200, { ok: true, result: 'booped' }];
    }

    /**
     * @param {Record<string, any>} body
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runInvite(body) {
        const { userId } = body;
        if (!isValidAiriUserId(userId)) {
            return badRequest('invalid_user_id');
        }
        if (userId === userStore.currentUser.id) {
            return badRequest('self_not_allowed');
        }
        const slot = optionalSlot(body.messageSlot);
        if (!slot.ok) {
            return badRequest('invalid_message_slot');
        }
        const message = boundedText(body.message, AIRI_SLOT_MESSAGE_MAX);
        if (!message.ok) {
            return badRequest('invalid_message');
        }
        const refusal = targetRefusal(userId);
        if (refusal) {
            return refused(refusal);
        }
        const instance = currentInstance();
        if (!instance) {
            return refused('not_in_instance');
        }
        const limit = check('invite', userId);
        if (!limit.allowed) {
            return localLimited(limit);
        }
        if (body.flirty === true) {
            const age = await ageStatusOf(userId, !socialDryRun.value);
            if (age !== '18+') {
                return refused('age_gate', { ageVerificationStatus: age });
            }
        }
        if (socialDryRun.value) {
            return dryRun('invited', { worldName: instance.worldName });
        }
        const chosen = await applyMessage('message', message.value, slot.value);
        if (chosen.slot === null) {
            return [
                200,
                {
                    ok: false,
                    result: 'slot_cooldown',
                    retryAfterSec: /** @type {any} */ (chosen).retryAfterSec
                }
            ];
        }
        record('invite', userId);
        /** @type {Record<string, any>} */
        const params = {
            instanceId: instance.location,
            worldId: instance.location,
            worldName: instance.worldName
        };
        if (chosen.slot !== undefined) {
            params.messageSlot = chosen.slot;
        }
        try {
            await notificationRequest.sendInvite(params, userId, {
                silentErrors: true
            });
        } catch (err) {
            if (/** @type {any} */ (err)?.status === 403) {
                return refused('not_friends', { vrchatStatus: 403 });
            }
            throw err;
        }
        /** @type {Record<string, any>} */
        const answer = {
            ok: true,
            result: 'invited',
            worldName: instance.worldName,
            messageApplied: Boolean(/** @type {any} */ (chosen).applied)
        };
        if (chosen.slot !== undefined) {
            answer.messageSlot = chosen.slot;
        }
        if (/** @type {any} */ (chosen).skipped) {
            answer.messageSkipped = /** @type {any} */ (chosen).skipped;
        }
        return [200, answer];
    }

    function findNotification(notificationId) {
        const data = useNotificationStore().notificationTable?.data;
        return Array.isArray(data)
            ? data.find((n) => n?.id === notificationId)
            : undefined;
    }

    /**
     * @param {Record<string, any>} body
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runInviteRespond(body) {
        const { notificationId } = body;
        if (!isValidNotificationId(notificationId)) {
            return badRequest('invalid_notification_id');
        }
        const slot = optionalSlot(body.responseSlot);
        if (!slot.ok) {
            return badRequest('invalid_response_slot');
        }
        const message = boundedText(body.message, AIRI_SLOT_MESSAGE_MAX);
        if (!message.ok) {
            return badRequest('invalid_message');
        }
        if (responded.has(notificationId)) {
            return refused('already_responded');
        }
        const notification = findNotification(notificationId);
        if (
            !notification ||
            (notification.type !== 'invite' &&
                notification.type !== 'requestInvite')
        ) {
            return refused('not_found');
        }
        const senderId = notification.senderUserId;
        const tags = trollTags(userStore.cachedUsers.get(senderId)?.tags);
        if (tags.troll || tags.probableTroll) {
            return refused('target_blocked');
        }
        const perNotification = check('inviteRespond', notificationId);
        if (!perNotification.allowed) {
            return perNotification.reason === 'user_cooldown'
                ? refused('already_responded')
                : localLimited(perNotification);
        }
        if (socialDryRun.value) {
            return dryRun('responded');
        }
        const type =
            notification.type === 'invite' ? 'response' : 'requestResponse';
        const chosen = await applyMessage(type, message.value, slot.value);
        if (chosen.slot === null) {
            return [
                200,
                {
                    ok: false,
                    result: 'slot_cooldown',
                    retryAfterSec: /** @type {any} */ (chosen).retryAfterSec
                }
            ];
        }
        record('inviteRespond', notificationId);
        responded.add(notificationId);
        try {
            await notificationRequest.sendInviteResponse(
                { responseSlot: chosen.slot ?? 0, rsvp: true },
                notificationId,
                { silentErrors: true }
            );
        } catch (err) {
            const status = /** @type {any} */ (err)?.status;
            if (status === 400) {
                return refused('already_responded', { vrchatStatus: 400 });
            }
            if (status === 404) {
                return refused('not_found', { vrchatStatus: 404 });
            }
            throw err;
        }
        // Same clean-up as VRCX's own reply dialog.
        notificationRequest
            .hideNotification({ notificationId }, { silentErrors: true })
            .then(() =>
                useNotificationStore().handleNotificationHide(notificationId)
            )
            .catch(() => {});
        return [
            200,
            {
                ok: true,
                result: 'responded',
                responseSlot: chosen.slot ?? 0,
                messageApplied: Boolean(/** @type {any} */ (chosen).applied),
                userId: senderId
            }
        ];
    }

    /**
     * @param {Record<string, any>} body
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runStatus(body) {
        const status = body.status;
        if (
            status !== undefined &&
            status !== null &&
            !AIRI_STATUS_VALUES.includes(status)
        ) {
            return badRequest('invalid_status');
        }
        const description = boundedText(
            body.statusDescription,
            AIRI_STATUS_DESCRIPTION_MAX,
            true
        );
        if (!description.ok) {
            return badRequest('invalid_status_description');
        }
        if (
            (status === undefined || status === null) &&
            description.value === undefined
        ) {
            return badRequest('nothing_to_update');
        }
        const me = userStore.currentUser;
        /** @type {Record<string, any>} */
        const params = {};
        if (status && status !== me.status) {
            params.status = status;
        }
        if (
            description.value !== undefined &&
            description.value !== (me.statusDescription ?? '')
        ) {
            params.statusDescription = description.value;
        }
        const limit = check('status', '');
        const nextAllowedAt = limit.allowed
            ? null
            : new Date(limit.nextAllowedAt).toISOString();
        if (!Object.keys(params).length) {
            return [200, { ok: true, result: 'unchanged', nextAllowedAt }];
        }
        if (!limit.allowed) {
            return localLimited(
                limit,
                limit.reason === 'too_soon' ? 'too_soon' : 'rate_limited'
            );
        }
        if (socialDryRun.value) {
            return dryRun('updated', { nextAllowedAt: null });
        }
        record('status', '');
        await userRequest.saveCurrentUser(params);
        const next = check('status', '');
        return [
            200,
            {
                ok: true,
                result: 'updated',
                nextAllowedAt: next.allowed
                    ? null
                    : new Date(next.nextAllowedAt).toISOString()
            }
        ];
    }

    /**
     * @param {Record<string, any>} body
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runNote(body) {
        const { userId } = body;
        if (!isValidAiriUserId(userId)) {
            return badRequest('invalid_user_id');
        }
        if (userId === userStore.currentUser.id) {
            return badRequest('self_not_allowed');
        }
        if (body.note === undefined || body.note === null) {
            return badRequest('invalid_note');
        }
        const note = boundedText(body.note, AIRI_NOTE_MAX, true);
        if (!note.ok) {
            return badRequest('invalid_note');
        }
        const ref = userStore.cachedUsers.get(userId);
        if (typeof ref?.note === 'string' && ref.note === note.value) {
            return [200, { ok: true, result: 'unchanged' }];
        }
        const limit = check('note', userId);
        if (!limit.allowed) {
            return localLimited(limit);
        }
        if (socialDryRun.value) {
            return dryRun('saved');
        }
        record('note', userId);
        const args = await miscRequest.saveNote(
            { targetUserId: userId, note: note.value },
            { silentErrors: true }
        );
        if (ref && typeof args?.json?.note === 'string') {
            ref.note = args.json.note;
        }
        return [200, { ok: true, result: 'saved' }];
    }

    // ── Reads ──────────────────────────────────────────────────

    /**
     * @param {Record<string, any>} query
     * @returns {[number, Record<string, any>]}
     */
    function runEvents(query) {
        const after = Number(query.after);
        return [
            200,
            {
                ok: true,
                seq: events.seq,
                events: events.after(Number.isFinite(after) ? after : 0)
            }
        ];
    }

    /**
     * @param {Record<string, any>} query
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runUser(query) {
        const { userId } = query;
        if (!isValidAiriUserId(userId)) {
            return badRequest('invalid_user_id');
        }
        if (userId === userStore.currentUser.id) {
            return badRequest('self_not_allowed');
        }
        let ref = userStore.cachedUsers.get(userId);
        if (!ref?.ageVerificationStatus || !Array.isArray(ref?.tags)) {
            await fetchUserIfStale(userId);
            ref = userStore.cachedUsers.get(userId);
        }
        const displayName =
            (typeof ref?.displayName === 'string' && ref.displayName) ||
            cachedDisplayName(userId);
        /** @type {Record<string, any>} */
        const user = {
            userId,
            displayName,
            isFriend: isFriend(userId),
            ageVerificationStatus:
                typeof ref?.ageVerificationStatus === 'string'
                    ? ref.ageVerificationStatus
                    : '',
            tags: trollTags(ref?.tags)
        };
        const mutuals = await mutualCounts(userId);
        if (mutuals) {
            if (typeof mutuals.friends === 'number') {
                user.mutualFriendsCount = mutuals.friends;
            }
            if (typeof mutuals.groups === 'number') {
                user.mutualGroupsCount = mutuals.groups;
            }
        }
        const avatarName = avatarNameOf(userId, displayName);
        if (avatarName) {
            user.avatarName = avatarName;
        }
        if (Array.isArray(ref?.bioLinks)) {
            user.bioLinksCount = ref.bioLinks.length;
        }
        return [200, { ok: true, user }];
    }

    function avatarNameOf(userId, displayName) {
        const list = gameLogStore.state?.lastLocationAvatarList;
        const fromLog =
            displayName && typeof list?.get === 'function'
                ? list.get(displayName)
                : undefined;
        if (typeof fromLog === 'string' && fromLog) {
            return fromLog;
        }
        const profile = userStore.cachedProfiles?.get?.(userId);
        return typeof profile?.currentAvatarName === 'string'
            ? profile.currentAvatarName
            : '';
    }

    /**
     * Mutual friend/group counts, once a day per user. Skipped when she opted
     * out of shared connections herself.
     * @param {string} userId
     */
    async function mutualCounts(userId) {
        if (userStore.currentUser?.hasSharedConnectionsOptOut) {
            return null;
        }
        const cached = mutualCache.get(userId);
        if (cached && Date.now() - cached.at < AIRI_USER_READ_TTL_MS) {
            return cached;
        }
        if (vrchatCooldownSec() > 0 || !check('read', '').allowed) {
            return cached ?? null;
        }
        record('read', '');
        try {
            const args = await userRequest.getMutualCounts(
                { userId },
                { silentErrors: true }
            );
            const entry = {
                at: Date.now(),
                friends: args?.json?.friends,
                groups: args?.json?.groups
            };
            mutualCache.set(userId, entry);
            return entry;
        } catch (err) {
            if (isRateLimitError(err)) {
                reportRateLimit();
            }
            // Private or opted out: remember that for a day.
            mutualCache.set(userId, { at: Date.now() });
            return null;
        }
    }

    /** @returns {Promise<[number, Record<string, any>]>} */
    function runWorld() {
        const instance = currentInstance();
        if (!instance) {
            return Promise.resolve(refused('not_in_instance'));
        }
        return worldInfo(instance.worldId).then((world) => {
            if (!world) {
                return [
                    200,
                    {
                        ok: true,
                        world: { name: instance.worldName },
                        partial: true
                    }
                ];
            }
            return [200, { ok: true, world }];
        });
    }

    /** @param {string} worldId */
    async function worldInfo(worldId) {
        const cached = worldCache.get(worldId);
        if (cached && Date.now() - cached.at < AIRI_WORLD_READ_TTL_MS) {
            return cached.world;
        }
        let source = null;
        try {
            const core = useWorldStore().cachedWorlds?.get?.(worldId);
            if (core && typeof core.name === 'string' && core.name) {
                source = core;
            }
        } catch {
            // world store unavailable
        }
        if (
            !source &&
            vrchatCooldownSec() === 0 &&
            check('read', '').allowed
        ) {
            record('read', '');
            try {
                const args = await worldRequest.getWorld({ worldId });
                source = args?.json ?? null;
            } catch (err) {
                if (isRateLimitError(err)) {
                    reportRateLimit();
                }
            }
        }
        if (!source) {
            return cached?.world ?? null;
        }
        const world = {
            name: typeof source.name === 'string' ? source.name : '',
            authorName:
                typeof source.authorName === 'string' ? source.authorName : '',
            visits: Number(source.visits) || 0,
            favorites: Number(source.favorites) || 0,
            capacity: Number(source.capacity) || 0,
            tags: Array.isArray(source.tags)
                ? source.tags
                      .filter(
                          (tag) =>
                              typeof tag === 'string' &&
                              tag.startsWith('author_tag_')
                      )
                      .map((tag) => tag.slice('author_tag_'.length))
                      .slice(0, 20)
                : [],
            description: sanitizeBio(source.description, 300)
        };
        worldCache.set(worldId, { at: Date.now(), world });
        return world;
    }

    // ── Dispatch ───────────────────────────────────────────────

    /**
     * @param {string} kind
     * @param {Record<string, any>} payload
     * @returns {Promise<[number, Record<string, any>]>}
     */
    async function runSocial(kind, payload) {
        if (!enabled.value) {
            return [403, { enabled: false, error: 'disabled' }];
        }
        const isRead = AIRI_SOCIAL_READ_KINDS.includes(kind);
        if (!isRead && !AIRI_SOCIAL_WRITE_KINDS.includes(kind)) {
            return [404, { ok: false, error: 'not_found' }];
        }
        if (!isRead && !socialEnabled.value) {
            return [
                403,
                {
                    enabled: true,
                    socialEnabled: false,
                    error: 'social_disabled'
                }
            ];
        }
        if (!isRead && !socialKinds[kind]) {
            return [
                403,
                { enabled: true, socialEnabled: true, error: 'kind_disabled', kind }
            ];
        }
        if (kind === 'events') {
            return runEvents(payload);
        }
        if (!watchState.isLoggedIn || !userStore.currentUser?.id) {
            return [503, { ok: false, error: 'not_logged_in' }];
        }
        if (!isRead) {
            const pause = socialPauseSec();
            if (pause > 0) {
                return vrchatLimited(pause);
            }
        }
        try {
            switch (kind) {
                case 'boop':
                    return await runBoop(payload);
                case 'invite':
                    return await runInvite(payload);
                case 'inviteRespond':
                    return await runInviteRespond(payload);
                case 'status':
                    return await runStatus(payload);
                case 'note':
                    return await runNote(payload);
                case 'user':
                    return await runUser(payload);
                default:
                    return await runWorld();
            }
        } catch (err) {
            if (isRateLimitError(err)) {
                reportRateLimit();
                onRateLimit();
                return vrchatLimited(socialPauseSec());
            }
            return [
                502,
                {
                    ok: false,
                    error: 'vrchat_error',
                    message: String(
                        /** @type {any} */ (err)?.message ?? err
                    ).slice(0, 200)
                }
            ];
        }
    }

    /**
     * Called by the C# host for the social routes (after it checked the
     * X-Paw-Token header). Writes run one at a time.
     * @param {string} kind boop | invite | inviteRespond | status | note | events | user | world
     * @param {string} payloadJson request body (POST) or query (GET) as JSON
     * @returns {Promise<string>} JSON {status, body}
     */
    function handleSocialRequest(kind, payloadJson) {
        let payload;
        try {
            payload = JSON.parse(payloadJson);
        } catch {
            payload = null;
        }
        const respond = (status, body) => JSON.stringify({ status, body });
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return Promise.resolve(
                respond(400, { ok: false, error: 'invalid_body' })
            );
        }
        if (AIRI_SOCIAL_READ_KINDS.includes(kind)) {
            return runSocial(kind, payload)
                .catch((err) => {
                    console.warn('[AiriIntegration] social read failed', err);
                    return /** @type {[number, Record<string, any>]} */ ([
                        500,
                        { ok: false, error: 'internal_error' }
                    ]);
                })
                .then(([status, body]) => respond(status, body));
        }
        const run = chain.then(async () => {
            /** @type {[number, Record<string, any>]} */
            let answer;
            try {
                answer = await runSocial(kind, payload);
            } catch (err) {
                console.warn('[AiriIntegration] social action failed', err);
                answer = [500, { ok: false, error: 'internal_error' }];
            }
            const [status, body] = answer;
            const target =
                kind === 'inviteRespond'
                    ? String(
                          body.userId ??
                              (isValidNotificationId(payload.notificationId)
                                  ? findNotification(payload.notificationId)
                                        ?.senderUserId
                                  : '') ??
                              ''
                      )
                    : kind === 'status'
                      ? 'self'
                      : isValidAiriUserId(payload.userId)
                        ? payload.userId
                        : 'invalid';
            let result = body.result || body.error || 'ok';
            if (body.reason) {
                result += `:${body.reason}`;
            }
            if (kind === 'status' && status === 200 && body.result !== 'unchanged') {
                result += ` ${JSON.stringify({
                    status: payload.status,
                    statusDescription: payload.statusDescription
                })}`;
            }
            logAction(
                `social:${kind}`,
                target,
                isValidAiriUserId(target) ? cachedDisplayName(target) : '',
                result,
                status
            );
            socialVersion.value++;
            return respond(status, body);
        });
        chain = run.catch(() => {});
        return run;
    }

    // ── Events ─────────────────────────────────────────────────

    /**
     * Websocket hook: turn a VRChat websocket message into a social event.
     * Only while the integration is on and she is logged in.
     * @param {string} type
     * @param {any} content
     */
    function recordSocketEvent(type, content) {
        if (!enabled.value || !watchState.isLoggedIn) {
            return;
        }
        const last = locationStore.lastLocation;
        const myLocation =
            last?.location === 'traveling'
                ? locationStore.lastLocationDestination
                : last?.location;
        const event = mapSocialEvent(type, content, {
            myLocation,
            myWorldName: last?.name,
            currentUserId: userStore.currentUser?.id,
            displayNameFor: cachedDisplayName,
            worldNameFor
        });
        if (!event) {
            return;
        }
        if (event.type === 'friend-location') {
            // Location pings repeat a lot: keep changes only.
            const key = `${event.location}|${event.worldName ?? ''}`;
            if (lastLocationClass.get(event.userId) === key) {
                return;
            }
            lastLocationClass.set(event.userId, key);
        } else if (
            event.type === 'friend-online' ||
            event.type === 'friend-offline'
        ) {
            lastLocationClass.set(
                event.userId,
                `${event.location}|${event.worldName ?? ''}`
            );
        }
        events.push(event);
        socialVersion.value++;
    }

    function recentEvents() {
        return events.latest(RECENT_EVENTS_SHOWN);
    }

    function clearSession() {
        events.clear();
        lastLocationClass.clear();
        slotCache.clear();
        mutualCache.clear();
        userFetchedAt.clear();
        boopFailedAt.clear();
    }

    function getSocialStatus() {
        return {
            socialEnabled: enabled.value && socialEnabled.value,
            socialDryRun: socialDryRun.value,
            socialKinds: { ...socialKinds },
            socialPause: getSocialPause(),
            socialBudget: getSocialBudget(),
            eventsSeq: events.seq
        };
    }

    return {
        socialEnabled,
        socialDryRun,
        socialKinds,
        socialVersion,
        loadSocialSettings,
        setSocialEnabled,
        setSocialDryRun,
        setSocialKindEnabled,
        handleSocialRequest,
        recordSocketEvent,
        recentEvents,
        getSocialBudget,
        getSocialPause,
        getSocialStatus,
        onRateLimit,
        clearSession
    };
}
