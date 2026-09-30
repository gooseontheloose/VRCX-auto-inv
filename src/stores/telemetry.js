import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

import {
    available as moduleAvailable,
    countUsage,
    getInstallId as moduleGetInstallId,
    messages,
    setEnabled as moduleSetEnabled,
    start
} from '../services/telemetry';
import { useAiriIntegrationStore } from './airiIntegration';
import { useAppearanceSettingsStore } from './settings/appearance';
import { useGroupInviteStore } from './groupInvite';
import { useGroupMonitorStore } from './groupMonitor';
import { useVRCXUpdaterStore } from './vrcxUpdater';

import configRepository from '../services/config';

import * as workerTimers from 'worker-timers';

/**
 * Anonymous usage stats. Everything that talks to a server lives in the telemetry module
 * behind `@paw/telemetry`; builds without it (the default) get a no-op stub, show no switch
 * and no notice, and send nothing. This store only hands the module the app state it may read.
 */
export const useTelemetryStore = defineStore('Telemetry', () => {
    /** Compile-time: the build includes the real module. */
    const available = __PAW_TELEMETRY__ && moduleAvailable;
    const enabled = ref(false);

    if (available) {
        const vrcxUpdaterStore = useVRCXUpdaterStore();
        const appearanceSettingsStore = useAppearanceSettingsStore();
        const groupInviteStore = useGroupInviteStore();
        const groupMonitorStore = useGroupMonitorStore();
        const airiIntegrationStore = useAiriIntegrationStore();

        watch(
            () => groupInviteStore.autoInviteEnabled,
            (value) => {
                if (value) countUsage('autoInviterSessions');
            }
        );

        /** On/off flags only. */
        const getFeatures = () => {
            const monitorLoaded = groupMonitorStore.settingsLoaded === true;
            const webhooks = Array.isArray(groupMonitorStore.webhooks) ? groupMonitorStore.webhooks : [];
            const polled = Array.isArray(groupMonitorStore.polledGroupIds) ? groupMonitorStore.polledGroupIds : [];
            return {
                autoInviter: groupInviteStore.autoInviteEnabled === true,
                groupMonitorBackground: monitorLoaded && groupMonitorStore.enabled === true && polled.length > 0,
                groupWebhooks: monitorLoaded && webhooks.some((w) => w?.enabled === true),
                airiIntegration: airiIntegrationStore.enabled === true,
                airiActions: airiIntegrationStore.enabled === true && airiIntegrationStore.actionsEnabled === true,
                autoUpdateMode: vrcxUpdaterStore.autoUpdateVRCX
            };
        };

        start({
            config: configRepository,
            timers: workerTimers,
            getAppVersion: () => vrcxUpdaterStore.appVersion,
            getLocale: () => appearanceSettingsStore.appLanguage,
            getFeatures,
            platform: navigator.platform || navigator.userAgent,
            isElectron: LINUX,
            onEnabledChange: (value) => {
                enabled.value = value;
            }
        })?.catch?.(() => {});
    }

    /**
     * Settings switch.
     *
     * @param {boolean} value
     */
    async function setEnabled(value) {
        if (!available) return;
        await moduleSetEnabled(Boolean(value));
    }

    /**
     * This install's random ID, for a "delete my data" request ('' in builds without the module
     * or before the first ping).
     *
     * @returns {Promise<string>}
     */
    async function getInstallId() {
        if (!available) return '';
        try {
            return (await moduleGetInstallId()) || '';
        } catch {
            return '';
        }
    }

    return {
        available,
        messages: available ? messages : null,
        enabled,
        setEnabled,
        getInstallId
    };
});
