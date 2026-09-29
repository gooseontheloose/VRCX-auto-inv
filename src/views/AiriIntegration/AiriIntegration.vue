<template>
    <div class="x-container space-y-3">
        <!-- Header -->
        <div class="flex items-center gap-2">
            <Bot class="size-5 shrink-0 text-primary" />
            <h2 class="text-base font-semibold">{{ t('view.airi_integration.title') }}</h2>
            <Badge :variant="airiStore.enabled ? 'default' : 'secondary'" class="ml-1">
                {{ airiStore.enabled ? t('view.airi_integration.status_on') : t('view.airi_integration.status_off') }}
            </Badge>
        </div>

        <div class="border rounded-lg p-4 space-y-2 text-sm">
            <p class="flex items-start gap-2">
                <ShieldCheck class="size-4 shrink-0 mt-0.5 text-primary" />
                <span>{{ t('view.airi_integration.description') }}</span>
            </p>
            <p class="text-xs text-muted-foreground pl-6">{{ t('view.airi_integration.privacy_note') }}</p>
        </div>

        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <!-- Settings -->
            <div class="border rounded-lg p-4 space-y-3">
                <h3 class="font-semibold flex items-center gap-2">
                    <Settings2 class="size-4 text-primary" /> {{ t('view.airi_integration.settings_header') }}
                </h3>
                <div class="flex items-center justify-between gap-4">
                    <div class="min-w-0">
                        <div class="text-sm font-medium">{{ t('view.airi_integration.enable') }}</div>
                        <div class="text-xs text-muted-foreground">
                            {{ t('view.airi_integration.enable_description') }}
                        </div>
                    </div>
                    <Switch :model-value="airiStore.enabled" @update:modelValue="airiStore.setEnabled" />
                </div>
                <div class="flex items-center justify-between gap-4">
                    <div class="min-w-0">
                        <div class="text-sm font-medium">{{ t('view.airi_integration.share_bios') }}</div>
                        <div class="text-xs text-muted-foreground">
                            {{ t('view.airi_integration.share_bios_description') }}
                        </div>
                    </div>
                    <Switch :model-value="airiStore.shareBios" @update:modelValue="airiStore.setShareBios" />
                </div>
                <div class="flex items-center justify-between gap-4">
                    <div class="min-w-0">
                        <div class="text-sm font-medium">{{ t('view.airi_integration.fetch_groups') }}</div>
                        <div class="text-xs text-muted-foreground">
                            {{ t('view.airi_integration.fetch_groups_description') }}
                        </div>
                    </div>
                    <Switch :model-value="airiStore.fetchGroups" @update:modelValue="airiStore.setFetchGroups" />
                </div>
                <div class="flex items-center justify-between gap-4 border-t pt-3">
                    <div class="min-w-0">
                        <div class="text-sm font-medium">{{ t('view.airi_integration.actions_enable') }}</div>
                        <div class="text-xs text-muted-foreground">
                            {{ t('view.airi_integration.actions_enable_description') }}
                        </div>
                        <div class="text-xs text-muted-foreground mt-1">
                            {{ t('view.airi_integration.actions_token_note') }}
                            <code class="bg-muted px-1 rounded select-all">{{ TOKEN_PATH }}</code>
                        </div>
                        <div v-if="airiStore.actionsEnabled && !airiStore.enabled" class="text-xs text-amber-500 mt-1">
                            {{ t('view.airi_integration.actions_needs_integration') }}
                        </div>
                    </div>
                    <Switch :model-value="airiStore.actionsEnabled" @update:modelValue="airiStore.setActionsEnabled" />
                </div>
            </div>

            <!-- Endpoint + stats -->
            <div class="border rounded-lg p-4 space-y-3">
                <h3 class="font-semibold flex items-center gap-2">
                    <Plug class="size-4 text-primary" /> {{ t('view.airi_integration.endpoint_header') }}
                </h3>
                <div class="flex items-center gap-2">
                    <code class="flex-1 min-w-0 truncate text-xs bg-muted px-2 py-1.5 rounded select-all">{{
                        ENDPOINT_URL
                    }}</code>
                    <Button variant="outline" size="sm" @click="copyEndpoint">
                        <Check v-if="copied" class="size-3.5 mr-1" />
                        <Copy v-else class="size-3.5 mr-1" />
                        {{ copied ? t('view.airi_integration.copied') : t('view.airi_integration.copy') }}
                    </Button>
                </div>
                <p class="text-xs text-muted-foreground">{{ t('view.airi_integration.endpoint_description') }}</p>

                <h3 class="font-semibold flex items-center gap-2 pt-1">
                    <Activity class="size-4 text-primary" /> {{ t('view.airi_integration.stats_header') }}
                </h3>
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div class="bg-muted/30 rounded-md p-3 text-center">
                        <div class="text-2xl font-bold">{{ airiStore.requestCount.toLocaleString() }}</div>
                        <div class="text-xs text-muted-foreground mt-0.5">
                            {{ t('view.airi_integration.stats_requests') }}
                        </div>
                    </div>
                    <div class="bg-muted/30 rounded-md p-3 text-center">
                        <div class="text-2xl font-bold">{{ airiStore.lastPlayerCount }}</div>
                        <div class="text-xs text-muted-foreground mt-0.5">
                            {{ t('view.airi_integration.stats_last_player_count') }}
                        </div>
                    </div>
                </div>
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt class="text-muted-foreground">{{ t('view.airi_integration.stats_last_request') }}</dt>
                    <dd>{{ lastRequestText }}</dd>
                    <dt class="text-muted-foreground">{{ t('view.airi_integration.stats_groups_fetched') }}</dt>
                    <dd>{{ airiStore.groupFetchCount }} / 100</dd>
                </dl>
            </div>
        </div>

        <!-- Recent AIRI actions -->
        <div class="border rounded-lg p-4 space-y-3">
            <h3 class="font-semibold flex items-center gap-2">
                <UserPlus class="size-4 text-primary" /> {{ t('view.airi_integration.actions_recent_header') }}
                <Badge :variant="airiStore.enabled && airiStore.actionsEnabled ? 'default' : 'secondary'" class="ml-1">
                    {{
                        airiStore.enabled && airiStore.actionsEnabled
                            ? t('view.airi_integration.status_on')
                            : t('view.airi_integration.status_off')
                    }}
                </Badge>
            </h3>
            <p class="text-xs text-muted-foreground">{{ t('view.airi_integration.actions_recent_description') }}</p>
            <div v-if="!airiStore.actionLog.length" class="text-sm text-muted-foreground text-center py-3">
                {{ t('view.airi_integration.actions_recent_empty') }}
            </div>
            <div v-else class="border rounded-lg overflow-auto max-h-80">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{{ t('view.airi_integration.column_time') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_action') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_player') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_result') }}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        <TableRow
                            v-for="entry in airiStore.actionLog"
                            :key="`${entry.at}-${entry.kind}-${entry.userId}`">
                            <TableCell class="text-xs whitespace-nowrap">
                                {{ new Date(entry.at).toLocaleString() }}
                            </TableCell>
                            <TableCell class="text-xs">{{ entry.kind }}</TableCell>
                            <TableCell>
                                <div class="font-medium">{{ entry.displayName }}</div>
                                <div class="text-xs text-muted-foreground font-mono">{{ entry.userId }}</div>
                            </TableCell>
                            <TableCell class="text-xs">
                                <Badge :variant="entry.status === 200 ? 'outline' : 'destructive'">
                                    {{ entry.status }}
                                </Badge>
                                {{ entry.result }}
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>
        </div>

        <!-- Live preview -->
        <div class="border rounded-lg p-4 space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
                <h3 class="font-semibold flex items-center gap-2 flex-1 min-w-0">
                    <Eye class="size-4 text-primary" /> {{ t('view.airi_integration.preview_header') }}
                    <span class="text-xs font-normal text-muted-foreground">({{ payload.players.length }})</span>
                </h3>
                <Button variant="ghost" size="sm" @click="showJson = !showJson">
                    <Braces class="size-3.5 mr-1" />
                    {{ showJson ? t('view.airi_integration.hide_json') : t('view.airi_integration.show_json') }}
                </Button>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('view.airi_integration.preview_description') }}</p>
            <p v-if="!airiStore.enabled" class="text-xs text-amber-500">
                {{ t('view.airi_integration.preview_disabled') }}
            </p>
            <p v-if="payload.world" class="text-sm">
                <span class="text-muted-foreground">{{ t('view.airi_integration.preview_world') }}:</span>
                {{ payload.world }}
            </p>

            <pre
                v-if="showJson"
                class="font-mono text-xs border rounded-lg bg-muted/20 p-3 overflow-auto max-h-96 whitespace-pre-wrap break-all"
                >{{ payloadJson }}</pre
            >

            <div v-if="!payload.players.length" class="text-sm text-muted-foreground text-center py-6">
                {{ t('view.airi_integration.preview_empty') }}
            </div>
            <div v-else class="border rounded-lg overflow-auto max-h-[60vh]">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{{ t('view.airi_integration.column_player') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_friend') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_trust') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_platform') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_avatar') }}</TableHead>
                            <TableHead>{{ t('view.airi_integration.column_status') }}</TableHead>
                            <TableHead v-if="airiStore.shareBios">{{
                                t('view.airi_integration.column_bio')
                            }}</TableHead>
                            <TableHead v-if="airiStore.fetchGroups">
                                {{ t('view.airi_integration.column_group') }}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        <TableRow v-for="player in payload.players" :key="player.userId || player.displayName">
                            <TableCell>
                                <div class="font-medium">{{ player.displayName }}</div>
                                <div class="text-xs text-muted-foreground font-mono">{{ player.userId }}</div>
                            </TableCell>
                            <TableCell>
                                {{ player.isFriend ? t('view.airi_integration.yes') : t('view.airi_integration.no') }}
                            </TableCell>
                            <TableCell>
                                {{ player.trustLevel }}
                                <Badge v-if="player.isVRCPlus" variant="outline" class="ml-1">VRC+</Badge>
                            </TableCell>
                            <TableCell>{{ player.platform }}</TableCell>
                            <TableCell>{{ player.avatarName }}</TableCell>
                            <TableCell>
                                <div>{{ player.status }}</div>
                                <div class="text-xs text-muted-foreground">{{ player.statusDescription }}</div>
                            </TableCell>
                            <TableCell v-if="airiStore.shareBios" class="max-w-80 whitespace-normal text-xs">
                                {{ player.bio }}
                            </TableCell>
                            <TableCell v-if="airiStore.fetchGroups">
                                <template v-if="player.representedGroup">
                                    {{ player.representedGroup.name }}
                                    <span class="text-xs text-muted-foreground">{{
                                        player.representedGroup.shortCode
                                    }}</span>
                                </template>
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { Activity, Bot, Braces, Check, Copy, Eye, Plug, Settings2, ShieldCheck, UserPlus } from 'lucide-vue-next';

    import { Badge } from '@/components/ui/badge';
    import { Button } from '@/components/ui/button';
    import { Switch } from '@/components/ui/switch';
    import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
    import { useAiriIntegrationStore } from '@/stores/airiIntegration';

    const ENDPOINT_URL = 'http://127.0.0.1:34582/paw/players';
    const TOKEN_PATH = '%APPDATA%\\VRCX\\paw-airi-token.txt';
    const REFRESH_MS = 2000;

    const { t } = useI18n();
    const airiStore = useAiriIntegrationStore();

    const showJson = ref(false);
    const copied = ref(false);

    // Some source maps (cached users, avatar names) are not deeply reactive,
    // so re-evaluate the preview on a short interval as well.
    const tick = ref(0);
    const refreshTimer = setInterval(() => {
        tick.value++;
    }, REFRESH_MS);
    let copiedTimer = null;

    onBeforeUnmount(() => {
        clearInterval(refreshTimer);
        clearTimeout(copiedTimer);
    });

    const payload = computed(() => {
        void tick.value;
        return airiStore.buildPayload();
    });

    const payloadJson = computed(() => JSON.stringify(payload.value, null, 2));

    const lastRequestText = computed(() => {
        void tick.value;
        if (!airiStore.lastRequestAt) {
            return t('view.airi_integration.stats_never');
        }
        const seconds = Math.max(0, Math.round((Date.now() - airiStore.lastRequestAt) / 1000));
        return `${new Date(airiStore.lastRequestAt).toLocaleTimeString()} (${seconds}s)`;
    });

    function copyEndpoint() {
        navigator.clipboard
            ?.writeText(ENDPOINT_URL)
            .then(() => {
                copied.value = true;
                clearTimeout(copiedTimer);
                copiedTimer = setTimeout(() => {
                    copied.value = false;
                }, 1500);
            })
            .catch((err) => console.error('Copy failed:', err));
    }
</script>
