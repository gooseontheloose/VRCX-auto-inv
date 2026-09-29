import {
    AIRI_ACTION_LIMITS,
    buildIncomingFriendRequests,
    buildPlayersPayload,
    checkActionRateLimit,
    isValidAiriUserId,
    pruneActionHistory,
    sanitizeBio
} from '../airiIntegration';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function makeProfile(overrides = {}) {
    return {
        id: 'usr_a',
        displayName: 'Alice',
        bio: 'Hi I like cats',
        bioLinks: ['https://example.com/alice'],
        pronouns: 'she/her',
        note: 'private note',
        memo: 'private memo',
        ageVerified: true,
        ageVerificationStatus: '18+',
        currentAvatarImageUrl: 'https://api.vrchat.cloud/file/abc',
        profilePicOverride: 'https://example.com/pic.png',
        userIcon: 'https://example.com/icon.png',
        status: 'active',
        statusDescription: 'vibing',
        tags: ['system_supporter', 'system_trust_veteran'],
        $trustLevel: 'Trusted User',
        $isVRCPlus: true,
        last_platform: 'standalonewindows',
        isFriend: true,
        location: 'wrld_x:123',
        ...overrides
    };
}

function makeInput(overrides = {}) {
    return {
        location: 'wrld_x:123~private(usr_me)',
        worldName: 'The Black Cat',
        playerList: new Map([
            [
                'usr_a',
                {
                    userId: 'usr_a',
                    displayName: 'Alice',
                    joinTime: 1000,
                    lastAvatar: ''
                }
            ]
        ]),
        cachedUsers: new Map([['usr_a', makeProfile()]]),
        avatarNames: new Map([['Alice', 'Cat Girl']]),
        groupsByUserId: new Map([
            [
                'usr_a',
                {
                    groupId: 'grp_1',
                    name: 'Cat Club',
                    shortCode: 'CATS',
                    discriminator: '1234',
                    iconUrl: 'https://example.com/g.png'
                }
            ]
        ]),
        settings: { shareBios: true, fetchGroups: true },
        now: NOW,
        ...overrides
    };
}

describe('sanitizeBio', () => {
    test('returns empty string for non-strings', () => {
        expect(sanitizeBio(undefined)).toBe('');
        expect(sanitizeBio(null)).toBe('');
        expect(sanitizeBio(42)).toBe('');
        expect(sanitizeBio('')).toBe('');
    });

    test('removes URLs and bare domains', () => {
        const out = sanitizeBio(
            'love cats https://twitter.com/foo?x=1 and www.site.net/page also linktr.ee/me ok'
        );
        expect(out).toBe('love cats and also ok');
    });

    test('removes emails and @handles', () => {
        expect(
            sanitizeBio('mail me at foo.bar+x@gmail.com or @cool_user!')
        ).toBe('mail me at or !');
    });

    test('removes labelled social handles', () => {
        const out = sanitizeBio(
            'Discord: kitty.cat | snap - kitty123 insta:@kit ttv=kittylive tiktok @kit2 x: kitx friendly person'
        );
        expect(out).not.toMatch(/kitty\.cat|kitty123|kit2|kittylive|kitx|@kit/);
        expect(out).toContain('friendly person');
    });

    test('removes legacy discord tags and phone numbers', () => {
        const out = sanitizeBio(
            'old tag Kitty#1234 call +1 (555) 123-4567 born 2001 - 2024 ok'
        );
        expect(out).not.toContain('#1234');
        expect(out).not.toContain('555');
        expect(out).toContain('2001 - 2024');
    });

    test('keeps ordinary words that match platform names', () => {
        expect(sanitizeBio('I play steam games and watch twitch streams')).toBe(
            'I play steam games and watch twitch streams'
        );
    });

    test('collapses whitespace including newlines', () => {
        expect(sanitizeBio('  hello\n\n\tworld   again ')).toBe(
            'hello world again'
        );
    });

    test('truncates to 200 characters', () => {
        const out = sanitizeBio('a'.repeat(500));
        expect(out).toHaveLength(200);
    });
});

describe('buildPlayersPayload', () => {
    test('builds the envelope', () => {
        const payload = buildPlayersPayload(makeInput());
        expect(payload.version).toBe(1);
        expect(payload.location).toBe('wrld_x:123~private(usr_me)');
        expect(payload.world).toBe('The Black Cat');
        expect(payload.generatedAt).toBe(new Date(NOW).toISOString());
        expect(payload.players).toHaveLength(1);
    });

    test('only includes whitelisted fields', () => {
        const [player] = buildPlayersPayload(makeInput()).players;
        expect(player).toEqual({
            userId: 'usr_a',
            displayName: 'Alice',
            joinTime: 1000,
            isFriend: true,
            trustLevel: 'Trusted User',
            isVRCPlus: true,
            platform: 'standalonewindows',
            avatarName: 'Cat Girl',
            status: 'active',
            statusDescription: 'vibing',
            bio: 'Hi I like cats',
            representedGroup: { name: 'Cat Club', shortCode: 'CATS' }
        });
        const json = JSON.stringify(player);
        expect(json).not.toMatch(
            /pronouns|she\/her|bioLinks|note|memo|age|http|tags|location/i
        );
    });

    test('result is JSON round-trippable', () => {
        const payload = buildPlayersPayload(makeInput());
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });

    test('sanitizes bios', () => {
        const input = makeInput({
            cachedUsers: new Map([
                [
                    'usr_a',
                    makeProfile({
                        bio: 'cat lover\ndiscord: alice.cat https://x.com/alice'
                    })
                ]
            ])
        });
        const [player] = buildPlayersPayload(input).players;
        expect(player.bio).toBe('cat lover');
    });

    test('omits bio when shareBios is disabled', () => {
        const [player] = buildPlayersPayload(
            makeInput({ settings: { shareBios: false, fetchGroups: true } })
        ).players;
        expect(player).not.toHaveProperty('bio');
        expect(player.representedGroup).toEqual({
            name: 'Cat Club',
            shortCode: 'CATS'
        });
    });

    test('omits represented group when fetchGroups is disabled', () => {
        const [player] = buildPlayersPayload(
            makeInput({ settings: { shareBios: true, fetchGroups: false } })
        ).players;
        expect(player).not.toHaveProperty('representedGroup');
    });

    test('defaults to not sharing bios or groups without settings', () => {
        const [player] = buildPlayersPayload(
            makeInput({ settings: undefined })
        ).players;
        expect(player).not.toHaveProperty('bio');
        expect(player).not.toHaveProperty('representedGroup');
    });

    test('omits represented group when unknown or empty', () => {
        const [player] = buildPlayersPayload(
            makeInput({ groupsByUserId: new Map([['usr_a', {}]]) })
        ).players;
        expect(player).not.toHaveProperty('representedGroup');
    });

    test('handles players without a cached profile', () => {
        const input = makeInput({
            playerList: new Map([
                ['usr_b', { userId: 'usr_b', displayName: 'Bob', joinTime: 5 }]
            ]),
            avatarNames: new Map()
        });
        const [player] = buildPlayersPayload(input).players;
        expect(player).toEqual({
            userId: 'usr_b',
            displayName: 'Bob',
            joinTime: 5,
            isFriend: false,
            trustLevel: '',
            isVRCPlus: false,
            platform: '',
            avatarName: '',
            status: '',
            statusDescription: '',
            bio: ''
        });
    });

    test('handles missing/empty inputs', () => {
        const payload = buildPlayersPayload({ now: NOW });
        expect(payload).toEqual({
            version: 1,
            location: '',
            world: '',
            generatedAt: new Date(NOW).toISOString(),
            players: []
        });
        expect(buildPlayersPayload().players).toEqual([]);
    });

    test('accepts plain objects and arrays', () => {
        const payload = buildPlayersPayload({
            playerList: [{ userId: 'usr_a', displayName: 'Alice' }, null],
            cachedUsers: { usr_a: makeProfile() },
            avatarNames: { Alice: 'Cat Girl' },
            settings: {}
        });
        expect(payload.players).toHaveLength(1);
        expect(payload.players[0].avatarName).toBe('Cat Girl');
        expect(payload.players[0].joinTime).toBeNull();
    });
});

const USER_A = 'usr_0f1e2d3c-4b5a-4968-8776-655443322110';
const USER_B = 'usr_11111111-2222-4333-8444-555555555555';
const HOUR = 60 * 60 * 1000;

function sentTo(userIds, at, kind = 'friend-request') {
    return userIds.map((userId, i) => ({
        kind,
        userId,
        at: typeof at === 'function' ? at(i) : at
    }));
}

function uniqueUsers(count) {
    return Array.from(
        { length: count },
        (_, i) => `usr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
}

describe('isValidAiriUserId', () => {
    test('accepts usr_ + lowercase uuid', () => {
        expect(isValidAiriUserId(USER_A)).toBe(true);
        expect(isValidAiriUserId(USER_B)).toBe(true);
    });

    test('rejects everything else', () => {
        for (const value of [
            undefined,
            null,
            42,
            {},
            '',
            'usr_',
            'usr_a',
            USER_A.toUpperCase(),
            USER_A.replace('usr_', 'grp_'),
            `${USER_A} `,
            ` ${USER_A}`,
            `${USER_A}\n`,
            `${USER_A}x`,
            USER_A.replace(/-/g, ''),
            'usr_0f1e2d3c-4b5a-4968-8776-65544332211g',
            "usr_0f1e2d3c-4b5a-4968-8776-655443322110');alert(1)//",
            '8JoV9XEdpo'
        ]) {
            expect(isValidAiriUserId(value)).toBe(false);
        }
    });
});

describe('pruneActionHistory', () => {
    test('drops malformed, future and older-than-24h entries', () => {
        const history = [
            { kind: 'friend-request', userId: USER_A, at: NOW - HOUR },
            { kind: 'friend-request', userId: USER_A, at: NOW - 25 * HOUR },
            { kind: 'friend-request', userId: USER_A, at: NOW + 1000 },
            { kind: 'nope', userId: USER_A, at: NOW },
            { kind: 'friend-accept', userId: 5, at: NOW },
            { kind: 'friend-accept', userId: USER_B, at: 'x' },
            null
        ];
        expect(pruneActionHistory(history, NOW)).toEqual([history[0]]);
        expect(pruneActionHistory('nope', NOW)).toEqual([]);
    });
});

describe('checkActionRateLimit', () => {
    test('allows the first request', () => {
        expect(checkActionRateLimit([], 'friend-request', USER_A, NOW)).toEqual(
            { allowed: true }
        );
    });

    test('only one friend request per user per 24 hours', () => {
        const history = sentTo([USER_A], NOW - 23 * HOUR);
        const result = checkActionRateLimit(
            history,
            'friend-request',
            USER_A,
            NOW
        );
        expect(result).toEqual({
            allowed: false,
            reason: 'user_cooldown',
            retryAfterSec: 3600
        });
        expect(
            checkActionRateLimit(history, 'friend-request', USER_B, NOW).allowed
        ).toBe(true);
        expect(
            checkActionRateLimit(
                sentTo([USER_A], NOW - 24 * HOUR),
                'friend-request',
                USER_A,
                NOW
            ).allowed
        ).toBe(true);
    });

    test('max 10 friend requests per hour', () => {
        const nine = sentTo(uniqueUsers(9), (i) => NOW - 50 * 60 * 1000 + i);
        expect(
            checkActionRateLimit(nine, 'friend-request', USER_A, NOW).allowed
        ).toBe(true);
        const ten = sentTo(uniqueUsers(10), (i) => NOW - 50 * 60 * 1000 + i);
        const result = checkActionRateLimit(ten, 'friend-request', USER_A, NOW);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('hourly_limit');
        expect(result.retryAfterSec).toBe(600);
    });

    test('max 30 friend requests per day', () => {
        // 30 requests spread over the last 20 hours, at most 2 per hour.
        const history = sentTo(
            uniqueUsers(30),
            (i) => NOW - 20 * HOUR + i * 40 * 60 * 1000
        );
        const hourly = history.filter((e) => NOW - e.at < HOUR).length;
        expect(hourly).toBeLessThan(
            AIRI_ACTION_LIMITS['friend-request'].perHour
        );
        const result = checkActionRateLimit(
            history,
            'friend-request',
            USER_A,
            NOW
        );
        expect(result).toEqual({
            allowed: false,
            reason: 'daily_limit',
            retryAfterSec: 4 * 3600
        });
    });

    test('accepts: max 30 per hour, no per-user cooldown', () => {
        const users = uniqueUsers(29);
        const accepts = sentTo(users, NOW - 1000, 'friend-accept');
        expect(
            checkActionRateLimit(accepts, 'friend-accept', users[0], NOW)
                .allowed
        ).toBe(true);
        const full = sentTo(uniqueUsers(30), NOW - 1000, 'friend-accept');
        expect(
            checkActionRateLimit(full, 'friend-accept', USER_A, NOW).reason
        ).toBe('hourly_limit');
    });

    test('kinds are counted separately', () => {
        const accepts = sentTo(uniqueUsers(30), NOW - 1000, 'friend-accept');
        expect(
            checkActionRateLimit(accepts, 'friend-request', USER_A, NOW).allowed
        ).toBe(true);
    });

    test('unknown kinds are refused', () => {
        expect(checkActionRateLimit([], 'unfriend', USER_A, NOW).allowed).toBe(
            false
        );
    });
});

describe('buildIncomingFriendRequests', () => {
    const ME = 'usr_99999999-9999-4999-8999-999999999999';

    function fr(senderUserId, createdAt, extra = {}) {
        return {
            id: `frq_${senderUserId}_${createdAt}`,
            type: 'friendRequest',
            senderUserId,
            senderUsername: `name ${senderUserId.slice(4, 8)}`,
            created_at: createdAt,
            ...extra
        };
    }

    test('returns incoming friend requests newest first', () => {
        const result = buildIncomingFriendRequests([
            fr(USER_A, '2026-01-01T10:00:00.000Z'),
            fr(USER_B, '2026-01-02T10:00:00.000Z')
        ]);
        expect(result).toEqual([
            {
                userId: USER_B,
                displayName: 'name 1111',
                createdAt: '2026-01-02T10:00:00.000Z'
            },
            {
                userId: USER_A,
                displayName: 'name 0f1e',
                createdAt: '2026-01-01T10:00:00.000Z'
            }
        ]);
    });

    test('skips other types, expired, self, friends and invalid ids', () => {
        const friendId = 'usr_22222222-2222-4222-8222-222222222222';
        const result = buildIncomingFriendRequests(
            [
                fr(USER_A, '2026-01-01T10:00:00.000Z', { type: 'invite' }),
                fr(USER_A, '2026-01-01T10:00:00.000Z', {
                    type: 'ignoredFriendRequest'
                }),
                fr(USER_A, '2026-01-01T10:00:00.000Z', { $isExpired: true }),
                fr(ME, '2026-01-01T10:00:00.000Z'),
                fr(friendId, '2026-01-01T10:00:00.000Z'),
                fr('usr_bad', '2026-01-01T10:00:00.000Z'),
                null,
                fr(USER_B, '2026-01-01T10:00:00.000Z')
            ],
            { currentUserId: ME, friendIds: new Set([friendId]) }
        );
        expect(result.map((r) => r.userId)).toEqual([USER_B]);
        expect(buildIncomingFriendRequests('nope')).toEqual([]);
    });

    test('one entry per sender (newest) and a name fallback', () => {
        const result = buildIncomingFriendRequests(
            [
                fr(USER_A, '2026-01-01T10:00:00.000Z'),
                fr(USER_A, '2026-01-03T10:00:00.000Z', { senderUsername: '' }),
                fr(USER_B, 'not a date')
            ],
            { displayNameFor: (id) => (id === USER_A ? 'Alice' : '') }
        );
        expect(result).toEqual([
            {
                userId: USER_A,
                displayName: 'Alice',
                createdAt: '2026-01-03T10:00:00.000Z'
            },
            { userId: USER_B, displayName: 'name 1111', createdAt: null }
        ]);
    });

    test('caps at 50', () => {
        const users = uniqueUsers(60);
        const result = buildIncomingFriendRequests(
            users.map((id, i) => fr(id, new Date(NOW + i * 1000).toISOString()))
        );
        expect(result).toHaveLength(50);
        expect(result[0].userId).toBe(users[59]);
    });

    test('has its own hourly limit of 120', () => {
        const history = Array.from({ length: 120 }, (_, i) => ({
            kind: 'friend-requests',
            userId: '',
            at: NOW - 1000 - i
        }));
        expect(
            checkActionRateLimit(history, 'friend-requests', '', NOW).reason
        ).toBe('hourly_limit');
        expect(
            checkActionRateLimit(history, 'friend-status', USER_A, NOW).allowed
        ).toBe(true);
    });
});
