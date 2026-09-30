<template>
    <template v-if="text">
        <SettingsItem :label="text.toggleLabel" :description="text.toggleDescription" toggle>
            <Switch :model-value="enabled" :ariaLabel="text.toggleLabel" @update:modelValue="setEnabled" />
        </SettingsItem>
        <TelemetryNotice />
    </template>
</template>

<script setup>
    import { Switch } from '@/components/ui/switch';
    import { storeToRefs } from 'pinia';

    import TelemetryNotice from '@/components/TelemetryNotice.vue';
    import { useTelemetryStore } from '@/stores';

    import SettingsItem from './SettingsItem.vue';

    // Loaded only by builds with the telemetry module (see SystemTab.vue); its text ships with that module.
    const telemetryStore = useTelemetryStore();
    const text = telemetryStore.messages;
    const { enabled } = storeToRefs(telemetryStore);
    const { setEnabled } = telemetryStore;
</script>
