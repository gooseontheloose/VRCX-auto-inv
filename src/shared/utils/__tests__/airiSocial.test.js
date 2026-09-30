import { describe, expect, test } from 'vitest';

import {
    AIRI_BOOP_EMOJIS,
    AIRI_SOCIAL_LIMITS,
    boundedText,
    checkSocialLimit,
    classifyLocation,
    cleanText,
    computeSocialBudget,
    createEventRing,
    isValidBoopEmoji,
    isValidNotificationId,
    mapSocialEvent,
    optionalSlot,
    pickMessageSlot,
    pruneSocialHistory,
    socialBackoffMs,
    trollTags,
    worldIdOf
} from '../airiSocial';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const USER_A = 'usr_0f1e2d3c-4b5a-4968-8776-655443322110';
const USER_B = 'usr_11111111-2222-4333-8444-555555555555';
const ME = 'usr_99999999-9999-4999-8999-999999999999';
const WORLD = 'wrld_4cf554b4-430c-4f8f-b53e-1f294eed230b';
const MY_LOCATION = `${WORLD}:12345~hidden(${ME})~region(eu)`;
const OTHER_LOCATION = `${WORLD}:99999~friends(${USER_B})`;
const NOTIFICATION = 'not_0f1e2d3c-4b5a-4968-8776-655443322110';

function entries(kind, key, ...agesMs) {
    return agesMs.map((age) => ({ kind, key, at: NOW - age }));
}

describe('checkSocialLimit', () => {
    test('boop: one per person per 30 minutes', () => {
        const history = entries('boop', USER_A, 29 * MIN);
        const res = checkSocialLimit(history, 'boop', USER_A, NOW);
        expect(res).toMatchObject({ allowed: false, reason: 'user_cooldown', retryAfterSec: 60 });
        expect(checkSocialLimit(history, 'boop', USER_B, NOW).allowed).toBe(true);
        expect(
            checkSocialLimit(entries('boop', USER_A, 31 * MIN), 'boop', USER_A, NOW).allowed
        ).toBe(true);
    });

    test('boop: at most 20 per hour overall', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({
            kind: 'boop',
            key: `k${i}`,
            at: NOW - (i + 1) * MIN
        }));
        const res = checkSocialLimit(history, 'boop', USER_A, NOW);
        expect(res).toMatchObject({ allowed: false, reason: 'hourly_limit' });
        // The oldest (20 min ago) frees up in 40 minutes.
        expect(res.retryAfterSec).toBe(40 * 60);
    });

    test('invite: one per person per hour, 10 per hour', () => {
        expect(
            checkSocialLimit(entries('invite', USER_A, 59 * MIN), 'invite', USER_A, NOW).reason
        ).toBe('user_cooldown');
        const ten = Array.from({ length: 10 }, (_, i) => ({ kind: 'invite', key: `k${i}`, at: NOW - i * MIN }));
        expect(checkSocialLimit(ten, 'invite', USER_A, NOW).reason).toBe('hourly_limit');
    });

    test('inviteRespond: once per notification, 30 per hour', () => {
        const history = entries('inviteRespond', NOTIFICATION, 5 * HOUR);
        expect(checkSocialLimit(history, 'inviteRespond', NOTIFICATION, NOW).reason).toBe(
            'user_cooldown'
        );
        const thirty = Array.from({ length: 30 }, (_, i) => ({ kind: 'inviteRespond', key: `n${i}`, at: NOW - i }));
        expect(checkSocialLimit(thirty, 'inviteRespond', NOTIFICATION, NOW).reason).toBe('hourly_limit');
    });

    test('status: 20 minutes apart and 20 per day', () => {
        const recent = entries('status', '', 19 * MIN);
        const res = checkSocialLimit(recent, 'status', '', NOW);
        expect(res).toMatchObject({ allowed: false, reason: 'too_soon', retryAfterSec: 60 });
        expect(res.nextAllowedAt).toBe(NOW + MIN);
        expect(checkSocialLimit(entries('status', '', 21 * MIN), 'status', '', NOW).allowed).toBe(true);
        const twenty = Array.from({ length: 20 }, (_, i) => ({ kind: 'status', key: '', at: NOW - (i + 1) * HOUR }));
        expect(checkSocialLimit(twenty, 'status', '', NOW).reason).toBe('daily_limit');
    });

    test('note: 60 per hour', () => {
        const sixty = Array.from({ length: 60 }, (_, i) => ({ kind: 'note', key: `u${i}`, at: NOW - i * 1000 }));
        expect(checkSocialLimit(sixty, 'note', USER_A, NOW).reason).toBe('hourly_limit');
        expect(checkSocialLimit(sixty.slice(1), 'note', USER_A, NOW).allowed).toBe(true);
    });

    test('kinds do not share budgets and unknown kinds are refused', () => {
        const history = entries('boop', USER_A, MIN);
        expect(checkSocialLimit(history, 'note', USER_A, NOW).allowed).toBe(true);
        expect(checkSocialLimit([], 'wave', USER_A, NOW)).toMatchObject({ allowed: false, reason: 'unknown_action' });
    });

    test('contract limits', () => {
        expect(AIRI_SOCIAL_LIMITS.boop).toMatchObject({ perHour: 20, perUserWindowMs: 30 * MIN });
        expect(AIRI_SOCIAL_LIMITS.invite).toMatchObject({ perHour: 10, perUserWindowMs: HOUR });
        expect(AIRI_SOCIAL_LIMITS.inviteRespond.perHour).toBe(30);
        expect(AIRI_SOCIAL_LIMITS.status).toMatchObject({ perDay: 20, minIntervalMs: 20 * MIN });
        expect(AIRI_SOCIAL_LIMITS.note.perHour).toBe(60);
    });
});

describe('history and budget', () => {
    test('prune drops old, future and malformed entries', () => {
        const history = [
            { kind: 'boop', key: USER_A, at: NOW - DAY - 1 },
            { kind: 'boop', key: USER_A, at: NOW + 1 },
            { kind: 'boop', key: 5, at: NOW },
            { kind: 'hug', key: USER_A, at: NOW },
            null,
            { kind: 'note', key: USER_A, at: NOW - HOUR }
        ];
        expect(pruneSocialHistory(history, NOW)).toEqual([{ kind: 'note', key: USER_A, at: NOW - HOUR }]);
        expect(pruneSocialHistory('nope', NOW)).toEqual([]);
    });

    test('budget per kind with next allowed time', () => {
        const history = [...entries('boop', USER_A, MIN, 2 * HOUR), ...entries('status', '', 5 * MIN)];
        const budget = computeSocialBudget(history, NOW);
        expect(Object.keys(budget)).toEqual(['boop', 'invite', 'inviteRespond', 'status', 'note']);
        expect(budget.boop).toMatchObject({ usedHour: 1, perHour: 20, remainingHour: 19, usedDay: 2, perDay: null });
        expect(budget.status).toMatchObject({ usedDay: 1, perDay: 20, remainingDay: 19, nextAllowedAt: NOW + 15 * MIN });
        expect(budget.note.nextAllowedAt).toBe(0);
    });

    test('backoff escalates 1 min, 10 min, 1 h', () => {
        expect([1, 2, 3, 4].map(socialBackoffMs)).toEqual([MIN, 10 * MIN, HOUR, HOUR]);
    });
});

describe('validation helpers', () => {
    test('boop emojis are the default ones', () => {
        expect(AIRI_BOOP_EMOJIS).toContain('default_hand_wave');
        expect(AIRI_BOOP_EMOJIS).toContain('default_zzz');
        expect(AIRI_BOOP_EMOJIS).toContain('default_blushing');
        expect(isValidBoopEmoji('default_heart')).toBe(true);
        expect(isValidBoopEmoji('file_123')).toBe(false);
        expect(isValidBoopEmoji('default_nope')).toBe(false);
    });

    test('notification ids', () => {
        expect(isValidNotificationId(NOTIFICATION)).toBe(true);
        expect(isValidNotificationId('not_x')).toBe(false);
        expect(isValidNotificationId(`${NOTIFICATION}"`)).toBe(false);
    });

    test('text is cleaned and bounded', () => {
        expect(cleanText('  hi\n\tthere\u202e ')).toBe('hi there');
        expect(boundedText(undefined, 5)).toEqual({ ok: true, value: undefined });
        expect(boundedText('hello', 5)).toEqual({ ok: true, value: 'hello' });
        expect(boundedText('hello!', 5)).toEqual({ ok: false });
        expect(boundedText('   ', 5)).toEqual({ ok: false });
        expect(boundedText('   ', 5, true)).toEqual({ ok: true, value: '' });
        expect(boundedText(42, 5)).toEqual({ ok: false });
    });

    test('slots are 0-11', () => {
        expect(optionalSlot(undefined)).toEqual({ ok: true, value: undefined });
        expect(optionalSlot(11)).toEqual({ ok: true, value: 11 });
        expect(optionalSlot(12).ok).toBe(false);
        expect(optionalSlot(1.5).ok).toBe(false);
        expect(optionalSlot('3').ok).toBe(false);
    });

    test('troll tags', () => {
        expect(trollTags(['system_troll'])).toEqual({ troll: true, probableTroll: false });
        expect(trollTags(['system_probable_troll'])).toEqual({ troll: false, probableTroll: true });
        expect(trollTags(undefined)).toEqual({ troll: false, probableTroll: false });
    });
});

describe('locations', () => {
    test('classify relative to her instance', () => {
        expect(classifyLocation(MY_LOCATION, '', MY_LOCATION)).toBe('same-instance');
        expect(classifyLocation('traveling', MY_LOCATION, MY_LOCATION)).toBe('same-instance');
        expect(classifyLocation(OTHER_LOCATION, '', MY_LOCATION)).toBe('other');
        expect(classifyLocation('private', '', MY_LOCATION)).toBe('private');
        expect(classifyLocation('traveling', 'traveling', MY_LOCATION)).toBe('private');
        expect(classifyLocation('offline', '', MY_LOCATION)).toBe('offline');
        expect(classifyLocation('', '', MY_LOCATION)).toBe('offline');
        // Not in an instance herself: nobody is "same-instance".
        expect(classifyLocation(OTHER_LOCATION, '', 'offline')).toBe('other');
        expect(worldIdOf(OTHER_LOCATION)).toBe(WORLD);
        expect(worldIdOf('private')).toBe('');
    });
});

describe('mapSocialEvent', () => {
    const ctx = {
        myLocation: MY_LOCATION,
        myWorldName: 'The Club',
        currentUserId: ME,
        displayNameFor: (id) => (id === USER_A ? 'Alice' : ''),
        worldNameFor: (id) => (id === WORLD ? 'Somewhere' : '')
    };

    test('v2 boop with a default emoji', () => {
        const event = mapSocialEvent(
            'notification-v2',
            { id: NOTIFICATION, type: 'boop', senderUserId: USER_A, details: { emojiId: 'default_heart' } },
            ctx
        );
        expect(event).toEqual({
            type: 'boop',
            userId: USER_A,
            displayName: 'Alice',
            notificationId: NOTIFICATION,
            emojiId: 'default_heart'
        });
    });

    test('custom emoji ids are not passed on', () => {
        const event = mapSocialEvent(
            'notification-v2',
            { type: 'boop', senderUserId: USER_A, details: { emojiId: 'file_abc' } },
            ctx
        );
        expect(event.emojiId).toBe('custom');
        expect(event).not.toHaveProperty('notificationId');
    });

    test('invites never expose the instance id', () => {
        const event = mapSocialEvent(
            'notification',
            {
                id: NOTIFICATION,
                type: 'invite',
                senderUserId: USER_A,
                senderUsername: 'Alice',
                details: { worldId: OTHER_LOCATION, worldName: 'Somewhere' }
            },
            ctx
        );
        expect(event).toEqual({
            type: 'invite',
            userId: USER_A,
            displayName: 'Alice',
            notificationId: NOTIFICATION,
            location: 'other',
            worldName: 'Somewhere'
        });
        expect(JSON.stringify(event)).not.toContain('99999');
    });

    test('invite requests and responses', () => {
        expect(
            mapSocialEvent('notification', { id: NOTIFICATION, type: 'requestInvite', senderUserId: USER_A }, ctx)
        ).toMatchObject({ type: 'requestInvite', notificationId: NOTIFICATION });
        expect(
            mapSocialEvent(
                'notification',
                {
                    id: NOTIFICATION,
                    type: 'inviteResponse',
                    senderUserId: USER_A,
                    details: { responseMessage: 'omw!\n' }
                },
                ctx
            )
        ).toMatchObject({ type: 'inviteResponse', message: 'omw!' });
        expect(
            mapSocialEvent('notification', { type: 'friendRequest', senderUserId: USER_A }, ctx)
        ).toBeNull();
    });

    test('friend presence', () => {
        expect(
            mapSocialEvent(
                'friend-location',
                { userId: USER_A, location: 'traveling', travelingToLocation: MY_LOCATION, user: { displayName: 'Al' } },
                ctx
            )
        ).toEqual({
            type: 'friend-location',
            userId: USER_A,
            displayName: 'Al',
            location: 'same-instance',
            worldName: 'The Club'
        });
        const other = mapSocialEvent('friend-online', { userId: USER_A, location: OTHER_LOCATION }, ctx);
        expect(other).toEqual({
            type: 'friend-online',
            userId: USER_A,
            displayName: 'Alice',
            location: 'other',
            worldName: 'Somewhere'
        });
        expect(JSON.stringify(other)).not.toContain(OTHER_LOCATION);
        expect(mapSocialEvent('friend-offline', { userId: USER_A }, ctx)).toMatchObject({ location: 'offline' });
        expect(mapSocialEvent('friend-add', { userId: USER_A, user: { displayName: 'Al' } }, ctx)).toEqual({
            type: 'friend-add',
            userId: USER_A,
            displayName: 'Al'
        });
        expect(mapSocialEvent('friend-delete', { userId: USER_A }, ctx)).toMatchObject({ type: 'friend-delete' });
    });

    test('ignores other types, bad ids and herself', () => {
        expect(mapSocialEvent('friend-update', { userId: USER_A }, ctx)).toBeNull();
        expect(mapSocialEvent('friend-online', { userId: 'usr_bad' }, ctx)).toBeNull();
        expect(mapSocialEvent('friend-online', { userId: ME }, ctx)).toBeNull();
        expect(mapSocialEvent('notification', null, ctx)).toBeNull();
    });
});

describe('event ring', () => {
    test('sequence numbers, cursor and bound', () => {
        const ring = createEventRing(3);
        for (let i = 0; i < 5; i++) {
            ring.push({ type: 'boop', userId: USER_A, n: i }, NOW + i);
        }
        expect(ring.seq).toBe(5);
        expect(ring.size).toBe(3);
        expect(ring.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
        expect(ring.after(4).map((e) => e.seq)).toEqual([5]);
        expect(ring.after(5)).toEqual([]);
        // A cursor from before a VRCX restart starts over.
        expect(ring.after(99).map((e) => e.seq)).toEqual([3, 4, 5]);
        expect(ring.after(0)[0].at).toBe(new Date(NOW + 2).toISOString());
        expect(ring.latest(2).map((e) => e.seq)).toEqual([5, 4]);
    });
});

describe('pickMessageSlot', () => {
    const slots = Array.from({ length: 12 }, (_, slot) => ({
        slot,
        message: `line ${slot}`,
        remainingCooldownMinutes: 0,
        canBeUpdated: true,
        updatedAt: new Date(NOW - (20 - slot) * HOUR).toISOString()
    }));

    test('reuses a slot that already has the text', () => {
        expect(pickMessageSlot({ slots, message: 'line 2' })).toEqual({ slot: 2, edit: false });
    });

    test('rewrites the preferred slot when it is free', () => {
        expect(pickMessageSlot({ slots, message: 'hiii Sam', preferredSlot: 1 })).toEqual({ slot: 1, edit: true });
    });

    test('otherwise the least recently updated rewritable slot (never 0-3)', () => {
        expect(pickMessageSlot({ slots, message: 'hiii Sam' })).toEqual({ slot: 4, edit: true });
        const cooling = slots.map((s) => (s.slot === 4 ? { ...s, remainingCooldownMinutes: 30 } : s));
        expect(pickMessageSlot({ slots: cooling, message: 'hiii Sam' })).toEqual({ slot: 5, edit: true });
    });

    test('a preferred slot on cooldown falls back to a free one', () => {
        const cooling = slots.map((s) => (s.slot === 1 ? { ...s, remainingCooldownMinutes: 30 } : s));
        expect(pickMessageSlot({ slots: cooling, message: 'x', preferredSlot: 1 })).toEqual({ slot: 4, edit: true });
    });

    test('none free: tells when the first frees up (cooldown counts down since fetch)', () => {
        const allCooling = slots.map((s) => ({ ...s, remainingCooldownMinutes: 30 + s.slot }));
        expect(pickMessageSlot({ slots: allCooling, message: 'x', elapsedMs: 10 * MIN })).toEqual({
            slot: null,
            retryAfterSec: 24 * 60
        });
        const locked = slots.map((s) => ({ ...s, canBeUpdated: false }));
        expect(pickMessageSlot({ slots: locked, message: 'x' })).toMatchObject({ slot: null });
        expect(pickMessageSlot({ slots: allCooling, message: 'x', elapsedMs: 40 * MIN })).toEqual({
            slot: 4,
            edit: true
        });
    });
});
