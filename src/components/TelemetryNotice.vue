<template>
    <p v-if="text" class="m-0 text-xs text-muted-foreground">
        * {{ text.notice }}
        <a class="cursor-pointer underline-offset-2 hover:underline" @click="openExternalLink(PRIVACY_URL)">{{
            text.learnMore
        }}</a>
    </p>
</template>

<script setup>
    import { openExternalLink } from '@/shared/utils';
    import { useTelemetryStore } from '@/stores';

    const PRIVACY_URL = 'https://github.com/gooseontheloose/VRCX-auto-inv/blob/master/PRIVACY.md';

    // Rendered only by builds with the telemetry module; its text ships with that module.
    const text = useTelemetryStore().messages;
</script>
