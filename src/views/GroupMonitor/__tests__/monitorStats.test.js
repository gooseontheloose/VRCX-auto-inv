import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { kickEntries, leaderboardRows } from '../../../services/groupMonitor/payloads';
import { attributeVoteKicks, dayOfWeek, localMonth, membersOverTimeFrom, topWorldsFrom } from '../monitorStats';

describe('local day buckets', () => {
    let tz;
    beforeAll(() => {
        tz = process.env.TZ;
        process.env.TZ = 'America/New_York';
    });
    afterAll(() => {
        if (tz === undefined) delete process.env.TZ;
        else process.env.TZ = tz;
    });

    test('an entry at 02:00 UTC counts on the previous local day (Monday 09-28 in New York)', () => {
        const res = membersOverTimeFrom([{ eventType: 'group.member.join', created_at: '2026-09-29T02:00:00.000Z' }]);
        expect(res.dates).toEqual(['2026-09-28']);
        expect(res.joins).toEqual([1]);
        expect(dayOfWeek(res.dates[0])).toBe(1); // Monday, not Sunday
    });

    test('every day between first and last is present, including across DST', () => {
        const res = membersOverTimeFrom([
            { eventType: 'group.member.join', created_at: '2026-10-30T15:00:00.000Z' },
            { eventType: 'group.member.leave', created_at: '2026-11-03T15:00:00.000Z' }
        ]);
        expect(res.dates).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
        expect(res.leaves).toEqual([0, 0, 0, 0, 1]);
        expect(res.net).toEqual([1, 1, 1, 1, 0]);
    });

    test('day of week of a plain date is the local weekday', () => {
        expect(dayOfWeek('2026-09-29')).toBe(2); // Tuesday
        expect(localMonth('2026-10-01T02:00:00.000Z')).toBe('2026-09');
    });
});

describe('vote kicks and worlds use milliseconds', () => {
    const visit = { created_at: '2026-09-29T10:00:00.000Z', time: 3_600_000, worldName: 'Club' };

    test('a vote kick 2 h into a 1 h visit is not attributed to the group', () => {
        const res = attributeVoteKicks(
            [
                { type: 'initiation', target: 'A', at: '2026-09-29T10:30:00.000Z' },
                { type: 'initiation', target: 'B', at: '2026-09-29T12:00:00.000Z' }
            ],
            [visit],
            Date.parse('2026-09-30T00:00:00Z')
        );
        expect(res.map((e) => e.target)).toEqual(['A']);
        expect(res[0].worldName).toBe('Club');
    });

    test('a visit still going on (no duration yet) counts until now', () => {
        const res = attributeVoteKicks(
            [{ type: 'initiation', target: 'A', at: '2026-09-29T15:00:00.000Z' }],
            [{ ...visit, time: 0 }],
            Date.parse('2026-09-29T16:00:00Z')
        );
        expect(res).toHaveLength(1);
    });

    test('a 3,600,000 ms visit is one hour of world time', () => {
        const [w] = topWorldsFrom([visit, { ...visit, time: 1_800_000 }]);
        expect(w).toEqual({ name: 'Club', visits: 2, totalTime: 5400, avgTime: 2700 });
    });
});

describe('kick boards', () => {
    const e = (id, eventType, extra = {}) => ({
        id,
        eventType,
        created_at: '2026-09-29T10:00:00.000Z',
        actorId: 'usr_mod',
        actorDisplayName: 'Mod',
        ...extra
    });

    test('group removals count as kicks, except self-removal and the removal part of a ban', () => {
        const entries = [
            e('1', 'group.instance.kick', { targetId: 'usr_a' }),
            e('2', 'group.member.remove', {
                targetId: 'usr_b',
                description: 'User Bee was removed from the group by Mod'
            }),
            e('3', 'group.member.remove', { targetId: 'usr_c' }),
            e('4', 'group.user.ban', { targetId: 'usr_c', created_at: '2026-09-29T10:01:00.000Z' }),
            e('5', 'group.member.remove', { targetId: 'usr_mod' }),
            e('6', 'group.member.leave', { targetId: 'usr_d' })
        ];
        expect(kickEntries(entries).map((r) => r.id)).toEqual(['1', '2']);
        const board = leaderboardRows('most-kicked', { auditEntries: entries });
        expect(board.map((r) => r.name)).toContain('Bee');
    });
});
