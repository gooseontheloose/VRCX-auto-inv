import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../services/config', () => ({
    default: { getString: vi.fn(), setString: vi.fn(), getBool: vi.fn(), setBool: vi.fn() }
}));

// Store dependencies are only touched when the module is present; keep the import graph small.
vi.mock('../vrcxUpdater', () => ({ useVRCXUpdaterStore: vi.fn() }));
vi.mock('../settings/appearance', () => ({ useAppearanceSettingsStore: vi.fn() }));
vi.mock('../groupInvite', () => ({ useGroupInviteStore: vi.fn() }));
vi.mock('../groupMonitor', () => ({ useGroupMonitorStore: vi.fn() }));
vi.mock('../airiIntegration', () => ({ useAiriIntegrationStore: vi.fn() }));

import configRepository from '../../services/config';
import { useGroupInviteStore } from '../groupInvite';
import { useTelemetryStore } from '../telemetry';

describe('useTelemetryStore without the telemetry module', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    test('is unavailable, off, and touches neither config nor network', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const store = useTelemetryStore();
        expect(store.available).toBe(false);
        expect(store.messages).toBeNull();
        expect(store.enabled).toBe(false);
        await store.setEnabled(true);
        expect(store.enabled).toBe(false);
        await expect(store.getInstallId()).resolves.toBe('');
        expect(configRepository.getBool).not.toHaveBeenCalled();
        expect(configRepository.setBool).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(useGroupInviteStore).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});
