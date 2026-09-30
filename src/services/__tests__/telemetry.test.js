import { describe, expect, test, vi } from 'vitest';

import * as telemetry from '../telemetry';
import * as stub from '../telemetryStub';

describe('telemetry plug-in point (stub build)', () => {
    test('resolves to the no-op stub', () => {
        expect(__PAW_TELEMETRY__).toBe(false);
        expect(telemetry.available).toBe(false);
        expect(telemetry.messages).toBeNull();
        expect(telemetry.countUsage).toBe(stub.countUsage);
    });

    test('the stub has the module API and sends nothing', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no')));
        expect(Object.keys(stub).sort()).toEqual(
            ['available', 'countUsage', 'getInstallId', 'isEnabled', 'messages', 'setEnabled', 'start'].sort()
        );
        await expect(stub.start({})).resolves.toBeUndefined();
        await expect(stub.setEnabled(true)).resolves.toBeUndefined();
        expect(stub.isEnabled()).toBe(false);
        await expect(stub.getInstallId()).resolves.toBe('');
        expect(stub.countUsage('invitesSent', 3)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});
