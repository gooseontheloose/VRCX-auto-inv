import { describe, expect, test, vi } from 'vitest';

import { forwardAiriSocialEvent, onAiriSocialEvent } from '../airiSocialEvents';

describe('airiSocialEvents', () => {
    test('forwards social websocket types only', () => {
        const listener = vi.fn();
        const off = onAiriSocialEvent(listener);
        for (const type of [
            'notification',
            'notification-v2',
            'friend-online',
            'friend-offline',
            'friend-location',
            'friend-add',
            'friend-delete'
        ]) {
            forwardAiriSocialEvent(type, { userId: 'x' });
        }
        forwardAiriSocialEvent('friend-update', {});
        forwardAiriSocialEvent('user-location', {});
        forwardAiriSocialEvent('group-joined', {});
        expect(listener).toHaveBeenCalledTimes(7);
        off();
        forwardAiriSocialEvent('friend-online', {});
        expect(listener).toHaveBeenCalledTimes(7);
    });

    test('a failing listener does not break the websocket pipeline', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const good = vi.fn();
        const offBad = onAiriSocialEvent(() => {
            throw new Error('boom');
        });
        const offGood = onAiriSocialEvent(good);
        expect(() => forwardAiriSocialEvent('friend-online', {})).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
        offBad();
        offGood();
    });
});
