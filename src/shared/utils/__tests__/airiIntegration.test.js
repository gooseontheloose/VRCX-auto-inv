import { buildPlayersPayload, sanitizeBio } from '../airiIntegration';

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
