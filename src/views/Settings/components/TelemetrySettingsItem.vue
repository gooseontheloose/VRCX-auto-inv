<template>
    <template v-if="text">
        <SettingsItem :label="text.toggleLabel" :description="text.toggleDescription" toggle>
            <button
                v-if="text.copyInstallId"
                type="button"
                class="cursor-pointer whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:underline"
                @click.prevent.stop="copyInstallId">
                {{ text.copyInstallId }}
            </button>
            <Switch :model-value="enabled" :ariaLabel="text.toggleLabel" @update:modelValue="setEnabled" />
        </SettingsItem>
        <TelemetryNotice />
    </template>
</template>

<script setup>
    import { Switch } from '@/components/ui/switch';
    import { storeToRefs } from 'pinia';
    import { toast } from 'vue-sonner';

    import TelemetryNotice from '@/components/TelemetryNotice.vue';
    import { copyToClipboard } from '@/shared/utils';
    import { useTelemetryStore } from '@/stores';

    import SettingsItem from './SettingsItem.vue';

    // Loaded only by builds with the telemetry module (see SystemTab.vue); its text ships with that module.
    const telemetryStore = useTelemetryStore();
    const text = telemetryStore.messages;
    const { enabled } = storeToRefs(telemetryStore);
    const { setEnabled } = telemetryStore;

    // For a "delete my data" request (see PRIVACY.md). Rendered inside the switch's <label>,
    // so the click must not toggle the switch.
    async function copyInstallId() {
        const id = await telemetryStore.getInstallId();
        if (!id) {
            toast.info(text.noInstallId);
            return;
        }
        copyToClipboard(id, text.installIdCopied);
    }
</script>
