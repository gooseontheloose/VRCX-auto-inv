import { describe, expect, test } from 'vitest';

import { createGameLogClientTracker } from '../gameLogClients';

const auth = (fileName, userId) => ({ type: 'user-authenticated', fileName, userId });
const closed = (fileName) => ({ type: 'log-closed', fileName });
const event = (fileName) => ({ type: 'player-joined', fileName });

describe('createGameLogClientTracker', () => {
    test('observe only consumes the bookkeeping events', () => {
        const tracker = createGameLogClientTracker();
        expect(tracker.observe(auth('a.txt', 'usr_a'))).toBe(true);
        expect(tracker.observe(closed('a.txt'))).toBe(true);
        expect(tracker.observe(event('a.txt'))).toBe(false);
        expect(tracker.observe({ type: 'log-closed' })).toBe(true);
    });

    test("drops another account's events only while your own client is open", () => {
        const tracker = createGameLogClientTracker();
        tracker.observe(auth('main.txt', 'usr_main'));
        tracker.observe(auth('alt.txt', 'usr_alt'));
        expect(tracker.isFromOtherClient(event('alt.txt'), 'usr_main')).toBe(true);
        expect(tracker.isFromOtherClient(event('main.txt'), 'usr_main')).toBe(false);

        tracker.observe(closed('main.txt'));
        expect(tracker.isFromOtherClient(event('alt.txt'), 'usr_main')).toBe(false);

        // a newer session of your own client takes over again
        tracker.observe(auth('main2.txt', 'usr_main'));
        expect(tracker.isFromOtherClient(event('alt.txt'), 'usr_main')).toBe(true);
    });

    test('unknown files, unknown user or no fileName are never dropped', () => {
        const tracker = createGameLogClientTracker();
        tracker.observe(auth('main.txt', 'usr_main'));
        expect(tracker.isFromOtherClient(event('unknown.txt'), 'usr_main')).toBe(false);
        expect(tracker.isFromOtherClient({ type: 'player-joined' }, 'usr_main')).toBe(false);
        tracker.observe(auth('alt.txt', 'usr_alt'));
        expect(tracker.isFromOtherClient(event('alt.txt'), undefined)).toBe(false);
    });

    test('closed flag survives a replayed auth event (backlog replays after a pre-scan)', () => {
        const tracker = createGameLogClientTracker();
        tracker.observe(auth('main.txt', 'usr_main'));
        tracker.observe(closed('main.txt'));
        tracker.observe(auth('main.txt', 'usr_main'));
        expect(tracker.isClientOpen('usr_main')).toBe(false);
    });
});
