import { describe, expect, test } from 'vitest';

import {
    crashCutoffIso,
    detectCrashSessions,
    ownLeaveTimesFromVisits
} from '../crashDetector';

const G = 'grp_00000000-0000-0000-0000-000000000001';
const LOC = `wrld_x:123~group(${G})~groupAccessType(public)`;
const NOW = Date.parse('2026-09-29T12:00:00.000Z');

// LogWatcher writes created_at as ISO-8601 with milliseconds and 'Z'.
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const leave = (msAgo, name, location = LOC) => ({
    at: iso(msAgo),
    displayName: name,
    location
});

describe('crashCutoffIso', () => {
    test('is comparable with gamelog created_at strings', () => {
        const cutoff = crashCutoffIso(NOW, 15 * 60_000);
        expect(cutoff).toBe('2026-09-29T11:45:00.000Z');
        // earlier the same UTC day must NOT pass (old datetime() bug let it through)
        expect('2026-09-29T08:00:00.000Z' >= cutoff).toBe(false);
        expect('2026-09-29T11:50:00.000Z' >= cutoff).toBe(true);
        // what the old query compared against
        const oldCutoff = '2026-09-29 11:50:00';
        expect('2026-09-29T08:00:00.000Z' >= oldCutoff).toBe(true);
    });
});

describe('detectCrashSessions', () => {
    test('flags a spike inside the configured window (seconds, not threshold)', () => {
        // 5 leaves spread over 40s: old code used a 5s window and missed this
        const leaves = [0, 10, 20, 30, 40].map((s, i) =>
            leave(120_000 + s * 1000, `p${i}`)
        );
        const sessions = detectCrashSessions(leaves, {
            groupId: G,
            nowMs: NOW,
            threshold: 5,
            windowSec: 60
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            count: 5,
            location: LOC,
            windowSeconds: 60,
            severity: 'low',
            id: `crash:${G}:${LOC}:${iso(160_000)}`
        });
    });

    test('ignores leaves outside the window', () => {
        const leaves = [0, 70, 140, 210, 280].map((s, i) =>
            leave(60_000 + s * 1000, `p${i}`)
        );
        expect(
            detectCrashSessions(leaves, {
                groupId: G,
                nowMs: NOW,
                threshold: 5,
                windowSec: 60
            })
        ).toEqual([]);
    });

    test('ignores rows older than the lookback and too-recent rows', () => {
        const old = [0, 1, 2, 3, 4].map((s) =>
            leave(20 * 60_000 + s * 1000, `o${s}`)
        );
        const fresh = [0, 1, 2, 3, 4].map((s) => leave(s * 1000, `f${s}`));
        expect(
            detectCrashSessions([...old, ...fresh], { groupId: G, nowMs: NOW })
        ).toEqual([]);
    });

    test('excludes the batch written when you leave the instance yourself', () => {
        // you joined 30 min ago and left 2 min ago; VRCX wrote one OnPlayerLeft
        // for all 8 remaining players at your leave time
        const leftAt = NOW - 120_000;
        const visits = [
            {
                created_at: new Date(leftAt - 30 * 60_000).toISOString(),
                location: LOC,
                time: 30 * 60_000
            }
        ];
        const batch = Array.from({ length: 8 }, (_, i) => ({
            at: new Date(leftAt).toISOString(),
            displayName: `p${i}`,
            location: LOC
        }));
        const sessions = detectCrashSessions(batch, {
            groupId: G,
            nowMs: NOW,
            ownLeaveTimes: ownLeaveTimesFromVisits(visits)
        });
        expect(sessions).toEqual([]);
    });

    test('same-timestamp batch is still skipped before the visit time is written', () => {
        const batch = Array.from({ length: 8 }, (_, i) =>
            leave(60_000, `p${i}`)
        );
        expect(
            detectCrashSessions(batch, {
                groupId: G,
                nowMs: NOW,
                currentLocation: ''
            })
        ).toEqual([]);
    });

    test('a real crash before your own leave is still reported', () => {
        const leftAt = NOW - 60_000;
        const visits = [
            {
                created_at: new Date(leftAt - 600_000).toISOString(),
                location: LOC,
                time: 600_000
            }
        ];
        const crash = [0, 2, 3, 5, 8, 9].map((s, i) =>
            leave(300_000 - s * 1000, `c${i}`)
        );
        const batch = Array.from({ length: 4 }, (_, i) => ({
            at: new Date(leftAt).toISOString(),
            displayName: `r${i}`,
            location: LOC
        }));
        const sessions = detectCrashSessions([...crash, ...batch], {
            groupId: G,
            nowMs: NOW,
            ownLeaveTimes: ownLeaveTimesFromVisits(visits)
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].count).toBe(6);
        expect(sessions[0].players).not.toContain('r0');
    });

    test('severity scales with count', () => {
        const leaves = Array.from({ length: 15 }, (_, i) =>
            leave(200_000 + i * 1000, `p${i}`)
        );
        const [s] = detectCrashSessions(leaves, {
            groupId: G,
            nowMs: NOW,
            threshold: 5,
            windowSec: 60
        });
        expect(s.severity).toBe('high');
    });
});
