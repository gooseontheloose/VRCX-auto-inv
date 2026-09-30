import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    configRepository: {
        getString: vi.fn(),
        setString: vi.fn()
    },
    changeLogRemoveLinks: vi.fn((value) => value),
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        warning: vi.fn()
    }
}));

vi.mock('../../services/config', () => ({
    default: mocks.configRepository
}));

vi.mock('../../shared/utils', () => ({
    changeLogRemoveLinks: (...args) => mocks.changeLogRemoveLinks(...args)
}));

vi.mock('vue-sonner', () => ({
    // toast() itself announces an available update
    toast: Object.assign(vi.fn(), mocks.toast)
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({
        t: (key) => key,
        locale: require('vue').ref('en')
    })
}));

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

import { AUTO_UPDATE_MIGRATION_KEY, FORK_SETUP_ASSET_RE, useVRCXUpdaterStore } from '../vrcxUpdater';

describe('useVRCXUpdaterStore.setAutoUpdateVRCX', () => {
    beforeEach(async () => {
        mocks.configRepository.getString.mockImplementation((key, defaultValue) => {
            if (key === 'VRCX_autoUpdateVRCX') {
                return Promise.resolve('Off');
            }
            if (key === 'VRCX_id') {
                return Promise.resolve('test-vrcx-id');
            }
            if (key === 'VRCX_lastVRCXVersion') {
                return Promise.resolve('2026.1.0');
            }
            return Promise.resolve(defaultValue ?? '');
        });
        mocks.configRepository.setString.mockResolvedValue(undefined);

        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('2026.1.0')
        };

        setActivePinia(createPinia());
        useVRCXUpdaterStore();
        await flushPromises();
        vi.clearAllMocks();
    });

    test('sets autoUpdateVRCX to Off, clears pending flag, and persists config', async () => {
        const store = useVRCXUpdaterStore();
        store.pendingVRCXUpdate = true;

        await store.setAutoUpdateVRCX('Off');

        expect(store.autoUpdateVRCX).toBe('Off');
        expect(store.pendingVRCXUpdate).toBe(false);
        expect(mocks.configRepository.setString).toHaveBeenCalledWith('VRCX_autoUpdateVRCX', 'Off');
    });

    test('updates autoUpdateVRCX for non-Off values and keeps pending flag', async () => {
        const store = useVRCXUpdaterStore();
        store.pendingVRCXUpdate = true;

        await store.setAutoUpdateVRCX('Notify');

        expect(store.autoUpdateVRCX).toBe('Notify');
        expect(store.pendingVRCXUpdate).toBe(true);
        expect(mocks.configRepository.setString).toHaveBeenCalledWith('VRCX_autoUpdateVRCX', 'Notify');
    });
});

// A config store backed by a Map, so a "launch" is a fresh store over the same data.
function useConfig(initial = {}) {
    const data = new Map(Object.entries(initial));
    mocks.configRepository.getString.mockImplementation((key, defaultValue) =>
        Promise.resolve(data.has(key) ? data.get(key) : (defaultValue ?? ''))
    );
    mocks.configRepository.setString.mockImplementation((key, value) => {
        data.set(key, value);
        return Promise.resolve();
    });
    return data;
}

async function launch() {
    setActivePinia(createPinia());
    const store = useVRCXUpdaterStore();
    await flushPromises();
    await flushPromises();
    return store;
}

describe('auto-update default and the one-time 2.3.0 switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('PAW Inviter - VRCX 2.3.0'),
            DownloadUpdate: vi.fn().mockResolvedValue(undefined),
            CheckUpdateProgress: vi.fn().mockResolvedValue(0)
        };
        // no network: every update check answers "nothing newer"
        globalThis.webApiService = {
            execute: vi.fn().mockResolvedValue({ status: 200, data: '{}' })
        };
    });

    test('fresh install defaults to Auto Download', async () => {
        const data = useConfig();
        const store = await launch();
        expect(store.autoUpdateVRCX).toBe('Auto Download');
        expect(data.get('VRCX_autoUpdateVRCX')).toBe('Auto Download');
        expect(data.get(AUTO_UPDATE_MIGRATION_KEY)).toBeTruthy();
    });

    test.each(['Notify', 'Off', 'Auto Install', 'Auto Download'])(
        'an existing "%s" setting is switched to Auto Download once',
        async (previous) => {
            const data = useConfig({ VRCX_autoUpdateVRCX: previous, VRCX_lastVRCXVersion: 'PAW Inviter - VRCX 2.3.0' });
            const store = await launch();
            expect(store.autoUpdateVRCX).toBe('Auto Download');
            expect(data.get('VRCX_autoUpdateVRCX')).toBe('Auto Download');
            expect(data.get(AUTO_UPDATE_MIGRATION_KEY)).toBeTruthy();
        }
    );

    test('the second launch does not override again, and a later choice sticks', async () => {
        const data = useConfig({ VRCX_autoUpdateVRCX: 'Notify', VRCX_lastVRCXVersion: 'PAW Inviter - VRCX 2.3.0' });
        let store = await launch();
        expect(store.autoUpdateVRCX).toBe('Auto Download');

        await store.setAutoUpdateVRCX('Off');
        expect(data.get('VRCX_autoUpdateVRCX')).toBe('Off');

        mocks.configRepository.setString.mockClear();
        store = await launch();
        expect(store.autoUpdateVRCX).toBe('Off');
        expect(mocks.configRepository.setString).not.toHaveBeenCalledWith('VRCX_autoUpdateVRCX', expect.anything());

        await store.setAutoUpdateVRCX('Notify');
        store = await launch();
        expect(store.autoUpdateVRCX).toBe('Notify');
    });

    test('a legacy "Auto Install" value after the switch still means Auto Download', async () => {
        useConfig({ VRCX_autoUpdateVRCX: 'Auto Install', [AUTO_UPDATE_MIGRATION_KEY]: 'true' });
        const store = await launch();
        expect(store.autoUpdateVRCX).toBe('Auto Download');
    });
});

describe('fork release asset', () => {
    const release = {
        name: 'PAW Inviter - VRCX 2.4.0',
        published_at: '2026-10-01T00:00:00Z',
        body: 'notes',
        assets: [
            {
                name: 'PAWInviter_2.4.0.zip',
                state: 'uploaded',
                content_type: 'application/zip',
                browser_download_url: 'https://example.invalid/zip',
                size: 1
            },
            {
                name: 'VRCX_20261001_Setup.exe',
                state: 'uploaded',
                content_type: 'application/x-msdownload',
                browser_download_url: 'https://example.invalid/upstream.exe',
                size: 2
            },
            {
                name: 'PAWInviter_2.4.0_Setup.exe',
                state: 'uploaded',
                content_type: 'application/octet-stream',
                browser_download_url: 'https://example.invalid/PAWInviter_2.4.0_Setup.exe',
                digest: 'sha256:ABCDEF',
                size: 123456
            }
        ]
    };

    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('PAW Inviter - VRCX 2.3.0'),
            DownloadUpdate: vi.fn().mockResolvedValue(undefined),
            CheckUpdateProgress: vi.fn().mockResolvedValue(0)
        };
        globalThis.webApiService = {
            execute: vi.fn().mockResolvedValue({ status: 200, data: JSON.stringify(release) })
        };
    });

    test('only the PAWInviter_X.Y.Z_Setup.exe the release workflow uploads counts', () => {
        expect(FORK_SETUP_ASSET_RE.test('PAWInviter_2.3.0_Setup.exe')).toBe(true);
        expect(FORK_SETUP_ASSET_RE.test('VRCX_20261001_Setup.exe')).toBe(false);
        expect(FORK_SETUP_ASSET_RE.test('PAWInviter_2.3.0.zip')).toBe(false);
    });

    test('Auto Download fetches the fork installer (Update.cs installs it on the next start)', async () => {
        useConfig({ [AUTO_UPDATE_MIGRATION_KEY]: 'true', VRCX_autoUpdateVRCX: 'Auto Download' });
        const store = await launch();
        await flushPromises();
        expect(globalThis.webApiService.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://api.github.com/repos/gooseontheloose/VRCX-auto-inv/releases/latest'
            })
        );
        expect(globalThis.AppApi.DownloadUpdate).toHaveBeenCalledWith(
            'https://example.invalid/PAWInviter_2.4.0_Setup.exe',
            'ABCDEF',
            123456
        );
        expect(store.pendingVRCXInstall).toBe('PAW Inviter - VRCX 2.4.0');
    });

    test('Notify does not download', async () => {
        useConfig({ [AUTO_UPDATE_MIGRATION_KEY]: 'true', VRCX_autoUpdateVRCX: 'Notify' });
        const store = await launch();
        await flushPromises();
        expect(store.pendingVRCXUpdate).toBe(true);
        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
    });

    test('a build without a version number never auto-updates', async () => {
        globalThis.AppApi.GetVersion.mockResolvedValue('PAW Inviter - VRCX Nightly Build');
        useConfig({ [AUTO_UPDATE_MIGRATION_KEY]: 'true', VRCX_autoUpdateVRCX: 'Auto Download' });
        await launch();
        await flushPromises();
        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
    });
});

describe('update file on disk (Dotnet/Update.cs)', () => {
    // %AppData%\VRCX is shared with upstream VRCX and older fork builds, which
    // run any "update.exe" there unchecked. The download and the install on
    // start must use the same fork-only file names.
    test('download, pending check and install use the fork-only file names', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(__dirname, '../../../Dotnet/Update.cs'), 'utf8');
        expect(src).toContain('"PAWInviter_update.exe"');
        expect(src).toContain('"PAWInviter_tempDownload"');
        expect(src).toContain('"PAWInviter_Setup"');
        expect(src).not.toMatch(/"update\.exe"|"tempDownload"|"VRCX_Setup(\.exe)?"/);
        // the only writer and the readers all go through UpdateExecutable
        expect(src).toMatch(/File\.Move\(TempDownload, UpdateExecutable\)/);
        expect(src).toMatch(/File\.Move\(UpdateExecutable, VrcxSetupExecutable\)/);
        expect(src).toMatch(/FileVersionInfo\.GetVersionInfo\(UpdateExecutable\)/);
        const cef = fs.readFileSync(path.resolve(__dirname, '../../../Dotnet/AppApi/Cef/AppApiCef.cs'), 'utf8');
        expect(cef).toMatch(/CheckForUpdateExe\(\)\s*\{[^}]*Update\.IsUpdateForThisInstall\(\)/);
    });
});
