<script setup>
    import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
    import * as echarts from 'echarts';
    import dayjs from 'dayjs';

    import {
        BarChart3,
        RefreshCw,
        Users,
        Shield,
        Globe,
        Gavel,
        Webhook,
        ChevronDown,
        ChevronUp,
        ChevronsUpDown,
        Search,
        Download,
        AlertTriangle,
        TrendingUp,
        Clock,
        Calendar,
        Filter,
        CircleOff
    } from 'lucide-vue-next';

    import { request } from '../../services/request';
    import sqliteService from '../../services/sqlite';
    import { useGroupStore } from '../../stores/group';
    import { Button } from '@/components/ui/button';
    import { Badge } from '@/components/ui/badge';
    import { Input } from '@/components/ui/input';
    import {
        Tabs,
        TabsContent,
        TabsList,
        TabsTrigger
    } from '@/components/ui/tabs';
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue
    } from '@/components/ui/select';

    const groupStore = useGroupStore();

    // ── group selector ───────────────────────────────────────────────────────
    const selectedGroupId = ref('');
    const groups = computed(() => Array.from(groupStore.currentUserGroups.values()));
    const selectedGroup = computed(() => groups.value.find((g) => g.id === selectedGroupId.value) ?? null);

    // ── tab + filter state ────────────────────────────────────────────────────
    const activeTab = ref('audit');
    const auditDateDays = ref(30);
    const auditSearch = ref('');
    const auditTypeFilter = ref('all');
    const memberSearch = ref('');
    const sortAuditCol = ref('created_at');
    const sortAuditDir = ref('desc');
    const sortKickCol = ref('count');
    const sortKickDir = ref('desc');
    const sortVoteCol = ref('initiated');
    const sortVoteDir = ref('desc');
    const voteKickSuccessOnly = ref(false);
    const sortWorldCol = ref('visits');
    const sortWorldDir = ref('desc');

    // ── data state ────────────────────────────────────────────────────────────
    const auditLogs = ref([]);
    const auditTotal = ref(0);
    const auditPage = ref(0);
    const auditPageSize = 100;
    const isLoadingAudit = ref(false);
    const auditError = ref('');

    const members = ref([]);
    const isLoadingMembers = ref(false);

    const voteKickRaw = ref([]);
    const isLoadingVoteKick = ref(false);

    const locationHistory = ref([]);
    const isLoadingWorlds = ref(false);

    // ── chart refs ────────────────────────────────────────────────────────────
    const kickChartRef = ref(null);
    const worldChartRef = ref(null);
    let kickChart = null;
    let worldChart = null;

    // ── date cutoff helper ────────────────────────────────────────────────────
    function cutoffDate(days) {
        if (!days) return null;
        return dayjs().subtract(days, 'day').toISOString();
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return dayjs(iso).format('YYYY-MM-DD HH:mm');
    }

    function fmtDuration(seconds) {
        if (!seconds || seconds < 0) return '—';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    // ── audit log ─────────────────────────────────────────────────────────────
    const AUDIT_EVENT_LABELS = {
        'group.member.remove': 'Member Removed',
        'group.user.ban': 'User Banned',
        'group.user.unban': 'User Unbanned',
        'group.member.role.assign': 'Role Assigned',
        'group.member.role.remove': 'Role Removed',
        'group.announcement.create': 'Announcement',
        'group.group.update': 'Group Updated',
        'group.instance.create': 'Instance Created',
        'group.member.join': 'Member Joined',
        'group.member.leave': 'Member Left'
    };

    function auditLabel(eventType) {
        return AUDIT_EVENT_LABELS[eventType] ?? eventType;
    }

    function auditVariant(eventType) {
        if (eventType === 'group.member.remove' || eventType === 'group.user.ban') return 'destructive';
        if (eventType === 'group.member.role.assign') return 'default';
        if (eventType === 'group.member.join') return 'secondary';
        return 'outline';
    }

    async function loadAuditLogs(groupId, page = 0) {
        if (!groupId) return;
        isLoadingAudit.value = true;
        auditError.value = '';
        console.debug('[GroupMonitor] Loading audit logs for', groupId, 'page', page);
        try {
            const data = await request(`groups/${groupId}/auditLogs`, {
                method: 'GET',
                params: { n: auditPageSize, offset: page * auditPageSize }
            });
            if (page === 0) auditLogs.value = [];
            const entries = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
            auditLogs.value.push(...entries);
            auditTotal.value = data?.totalCount ?? entries.length;
            auditPage.value = page;
            console.debug('[GroupMonitor] Loaded', entries.length, 'audit entries, total', auditTotal.value);
            await nextTick();
            renderKickChart();
        } catch (err) {
            console.error('[GroupMonitor] Audit log error:', err);
            auditError.value = err?.message ?? 'Failed to load audit logs';
        } finally {
            isLoadingAudit.value = false;
        }
    }

    async function loadMoreAudit() {
        await loadAuditLogs(selectedGroupId.value, auditPage.value + 1);
    }

    const filteredAuditLogs = computed(() => {
        let rows = auditLogs.value;

        // date filter
        const cutoff = cutoffDate(auditDateDays.value);
        if (cutoff) rows = rows.filter((r) => r.created_at >= cutoff);

        // type filter
        if (auditTypeFilter.value !== 'all') {
            const typeMap = {
                remove: 'group.member.remove',
                ban: 'group.user.ban',
                role: ['group.member.role.assign', 'group.member.role.remove']
            };
            const target = typeMap[auditTypeFilter.value];
            if (Array.isArray(target)) {
                rows = rows.filter((r) => target.includes(r.eventType));
            } else {
                rows = rows.filter((r) => r.eventType === target);
            }
        }

        // text search
        const q = auditSearch.value.toLowerCase().trim();
        if (q) {
            rows = rows.filter(
                (r) =>
                    r.actorDisplayName?.toLowerCase().includes(q) ||
                    r.targetDisplayName?.toLowerCase().includes(q) ||
                    r.description?.toLowerCase().includes(q)
            );
        }

        return sortRows(rows, sortAuditCol.value, sortAuditDir.value);
    });

    // ── kick leaderboard ──────────────────────────────────────────────────────
    const kickLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) => {
            if (r.eventType !== 'group.member.remove') return false;
            if (cutoff && r.created_at < cutoff) return false;
            return true;
        });
        const map = new Map();
        for (const r of rows) {
            const actor = r.actorDisplayName || r.actorId || 'Unknown';
            if (!map.has(actor)) map.set(actor, { actor, count: 0, targets: [] });
            const entry = map.get(actor);
            entry.count++;
            entry.targets.push({ name: r.targetDisplayName || r.targetId, at: r.created_at });
        }
        const arr = Array.from(map.values());
        return sortRows(arr, sortKickCol.value, sortKickDir.value);
    });

    // ── members ───────────────────────────────────────────────────────────────
    async function loadMembers(groupId) {
        if (!groupId) return;
        isLoadingMembers.value = true;
        console.debug('[GroupMonitor] Loading members for', groupId);
        try {
            const data = await request(`groups/${groupId}/members`, {
                method: 'GET',
                params: { n: 100 }
            });
            members.value = Array.isArray(data) ? data : data?.results ?? [];
            console.debug('[GroupMonitor] Loaded', members.value.length, 'members');
        } catch (err) {
            console.error('[GroupMonitor] Members error:', err);
            members.value = [];
        } finally {
            isLoadingMembers.value = false;
        }
    }

    const filteredMembers = computed(() => {
        const q = memberSearch.value.toLowerCase().trim();
        let rows = members.value;
        if (q) {
            rows = rows.filter((m) => m.user?.displayName?.toLowerCase().includes(q));
        }
        return rows;
    });

    // ── vote-to-kick (SQLite gamelog_event) ───────────────────────────────────
    async function loadVoteKickHistory() {
        isLoadingVoteKick.value = true;
        console.debug('[GroupMonitor] Loading vote-to-kick history from gamelog_event');
        try {
            const initiations = [];
            const successes = [];
            await sqliteService.execute(
                (row) => {
                    const data = row[2] ?? '';
                    if (data.includes('vote kick has been initiated against')) {
                        // "[ModerationManager] A vote kick has been initiated against {name}, do you agree?"
                        const m = data.match(/initiated against (.+?)(?:,|$)/);
                        if (m) initiations.push({ name: m[1].trim(), at: row[1] });
                    } else if (data.includes('Vote to kick') && data.includes('succeeded')) {
                        // "[ModerationManager] Vote to kick {name} succeeded"
                        const m = data.match(/Vote to kick (.+?) succeeded/);
                        if (m) successes.push({ name: m[1].trim(), at: row[1] });
                    }
                },
                `SELECT id, created_at, data FROM gamelog_event WHERE data LIKE '%vote kick%' ORDER BY created_at DESC`
            );
            console.debug('[GroupMonitor] Found', initiations.length, 'initiations,', successes.length, 'successes');

            // aggregate by target name
            const map = new Map();
            for (const { name, at } of initiations) {
                if (!map.has(name)) map.set(name, { name, initiated: 0, succeeded: 0, lastAt: at });
                const e = map.get(name);
                e.initiated++;
                if (at > e.lastAt) e.lastAt = at;
            }
            for (const { name, at } of successes) {
                if (!map.has(name)) map.set(name, { name, initiated: 0, succeeded: 0, lastAt: at });
                map.get(name).succeeded++;
            }
            voteKickRaw.value = Array.from(map.values());
        } catch (err) {
            console.error('[GroupMonitor] Vote-kick error:', err);
            voteKickRaw.value = [];
        } finally {
            isLoadingVoteKick.value = false;
        }
    }

    const voteKickLeaderboard = computed(() => {
        let rows = [...voteKickRaw.value];
        if (voteKickSuccessOnly.value) rows = rows.filter((r) => r.succeeded > 0);
        return sortRows(rows, sortVoteCol.value, sortVoteDir.value);
    });

    // ── world / location history (SQLite gamelog_location) ────────────────────
    async function loadLocationHistory(groupId) {
        if (!groupId) return;
        isLoadingWorlds.value = true;
        console.debug('[GroupMonitor] Loading location history for', groupId);
        try {
            const rows = [];
            await sqliteService.execute(
                (row) => {
                    rows.push({
                        created_at: row[1],
                        location: row[2],
                        worldId: row[3],
                        worldName: row[4],
                        time: row[5] ?? 0,
                        groupName: row[6]
                    });
                },
                `SELECT * FROM gamelog_location WHERE location LIKE '%${groupId}%' ORDER BY created_at DESC LIMIT 2000`
            );
            locationHistory.value = rows;
            console.debug('[GroupMonitor] Loaded', rows.length, 'location entries');
            await nextTick();
            renderWorldChart();
        } catch (err) {
            console.error('[GroupMonitor] Location history error:', err);
            locationHistory.value = [];
        } finally {
            isLoadingWorlds.value = false;
        }
    }

    const topWorlds = computed(() => {
        const map = new Map();
        for (const row of locationHistory.value) {
            const name = row.worldName || row.worldId || 'Unknown World';
            if (!map.has(name)) map.set(name, { name, visits: 0, totalTime: 0 });
            const e = map.get(name);
            e.visits++;
            e.totalTime += Number(row.time) || 0;
        }
        const arr = Array.from(map.values()).map((e) => ({
            ...e,
            avgTime: e.visits > 0 ? Math.round(e.totalTime / e.visits) : 0
        }));
        return sortRows(arr, sortWorldCol.value, sortWorldDir.value);
    });

    // ── sorting helper ────────────────────────────────────────────────────────
    function sortRows(rows, col, dir) {
        return [...rows].sort((a, b) => {
            const av = a[col] ?? '';
            const bv = b[col] ?? '';
            let cmp = 0;
            if (typeof av === 'number' && typeof bv === 'number') {
                cmp = av - bv;
            } else {
                cmp = String(av).localeCompare(String(bv));
            }
            return dir === 'desc' ? -cmp : cmp;
        });
    }

    function toggleSort(colRef, dirRef, col) {
        if (colRef.value === col) {
            dirRef.value = dirRef.value === 'asc' ? 'desc' : 'asc';
        } else {
            colRef.value = col;
            dirRef.value = 'desc';
        }
    }

    function sortIcon(colRef, dirRef, col) {
        if (colRef.value !== col) return 'neutral';
        return dirRef.value;
    }

    // ── charts ────────────────────────────────────────────────────────────────
    function renderKickChart() {
        if (!kickChartRef.value) return;
        if (!kickChart) kickChart = echarts.init(kickChartRef.value, null, { renderer: 'svg' });

        const cutoff = cutoffDate(auditDateDays.value);
        const kicks = auditLogs.value.filter(
            (r) => r.eventType === 'group.member.remove' && (!cutoff || r.created_at >= cutoff)
        );

        const byMonth = new Map();
        for (const r of kicks) {
            const key = dayjs(r.created_at).format('YYYY-MM');
            byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
        }
        const sortedKeys = Array.from(byMonth.keys()).sort();
        const option = {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: sortedKeys, axisLabel: { color: '#888' } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#888' } },
            series: [
                {
                    name: 'Removals',
                    type: 'bar',
                    data: sortedKeys.map((k) => byMonth.get(k)),
                    itemStyle: { color: '#ef4444', borderRadius: [4, 4, 0, 0] }
                }
            ],
            grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true }
        };
        kickChart.setOption(option);
    }

    function renderWorldChart() {
        if (!worldChartRef.value) return;
        if (!worldChart) worldChart = echarts.init(worldChartRef.value, null, { renderer: 'svg' });

        const top = topWorlds.value.slice(0, 10);
        const option = {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            xAxis: { type: 'value', axisLabel: { color: '#888' } },
            yAxis: {
                type: 'category',
                data: top.map((w) => w.name).reverse(),
                axisLabel: {
                    color: '#888',
                    formatter: (v) => (v.length > 20 ? v.slice(0, 18) + '…' : v),
                    width: 140,
                    overflow: 'truncate'
                }
            },
            series: [
                {
                    name: 'Visits',
                    type: 'bar',
                    data: top.map((w) => w.visits).reverse(),
                    itemStyle: { color: '#3b82f6', borderRadius: [0, 4, 4, 0] }
                }
            ],
            grid: { left: '2%', right: '6%', bottom: '3%', containLabel: true }
        };
        worldChart.setOption(option);
    }

    // ── export helpers ────────────────────────────────────────────────────────
    function exportCsv(rows, filename) {
        if (!rows.length) return;
        const keys = Object.keys(rows[0]);
        const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── group selection + load-all ────────────────────────────────────────────
    async function handleGroupChange(id) {
        selectedGroupId.value = id;
        auditLogs.value = [];
        members.value = [];
        locationHistory.value = [];
        console.debug('[GroupMonitor] Group selected:', id);
        await Promise.all([
            loadAuditLogs(id, 0),
            loadMembers(id),
            loadLocationHistory(id)
        ]);
    }

    function refreshAll() {
        if (!selectedGroupId.value) return;
        handleGroupChange(selectedGroupId.value);
        loadVoteKickHistory();
    }

    // ── chart resize ──────────────────────────────────────────────────────────
    function onResize() {
        kickChart?.resize();
        worldChart?.resize();
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    onMounted(() => {
        console.debug('[GroupMonitor] Mounted, loading vote-kick history');
        loadVoteKickHistory();
        window.addEventListener('resize', onResize);
        if (groups.value.length > 0) {
            handleGroupChange(groups.value[0].id);
        }
    });

    onBeforeUnmount(() => {
        window.removeEventListener('resize', onResize);
        kickChart?.dispose();
        worldChart?.dispose();
    });

    // re-render charts when tab becomes active
    watch(activeTab, async (tab) => {
        await nextTick();
        if (tab === 'audit') renderKickChart();
        if (tab === 'worlds') renderWorldChart();
    });

    // re-render kick chart when date range changes
    watch(auditDateDays, () => {
        renderKickChart();
        renderWorldChart();
    });

    // ── stat cards ────────────────────────────────────────────────────────────
    const totalRemovals = computed(
        () => auditLogs.value.filter((r) => r.eventType === 'group.member.remove').length
    );
    const totalBans = computed(
        () => auditLogs.value.filter((r) => r.eventType === 'group.user.ban').length
    );
    const totalVoteKickInitiated = computed(
        () => voteKickRaw.value.reduce((s, r) => s + r.initiated, 0)
    );
</script>

<template>
    <div class="x-container pt-10 pb-16 space-y-5 max-w-[1200px] mx-auto">
        <!-- ── header ── -->
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
                <BarChart3 class="size-5 text-primary" />
                <h1 class="text-lg font-semibold">Ultimate Group Monitor</h1>
            </div>
            <div class="flex items-center gap-2">
                <!-- group selector -->
                <Select :model-value="selectedGroupId" @update:model-value="handleGroupChange">
                    <SelectTrigger class="w-64">
                        <SelectValue placeholder="Select a group…" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="g in groups" :key="g.id" :value="g.id">
                            {{ g.name }}
                        </SelectItem>
                        <div v-if="groups.length === 0" class="px-3 py-2 text-sm text-muted-foreground">
                            No groups found
                        </div>
                    </SelectContent>
                </Select>
                <!-- date range -->
                <Select :model-value="String(auditDateDays)" @update:model-value="(v) => (auditDateDays = Number(v) || null)">
                    <SelectTrigger class="w-36">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="30">Last 30 days</SelectItem>
                        <SelectItem value="180">Last 6 months</SelectItem>
                        <SelectItem value="365">Last 12 months</SelectItem>
                        <SelectItem value="0">All time</SelectItem>
                    </SelectContent>
                </Select>
                <Button variant="outline" size="icon" :disabled="!selectedGroupId || isLoadingAudit" @click="refreshAll">
                    <RefreshCw :class="{ 'animate-spin': isLoadingAudit }" class="size-4" />
                </Button>
            </div>
        </div>

        <!-- ── no group selected ── -->
        <div v-if="!selectedGroupId" class="flex flex-col items-center justify-center mt-20 gap-3 text-muted-foreground">
            <CircleOff class="size-10 opacity-40" />
            <p class="text-sm">Select a group to load analytics.</p>
        </div>

        <template v-else>
            <!-- ── stat cards ── -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="rounded-lg border bg-card px-4 py-3 flex items-center gap-3">
                    <Users class="size-5 text-primary shrink-0" />
                    <div>
                        <div class="text-xl font-bold">{{ members.length }}</div>
                        <div class="text-xs text-muted-foreground">Members</div>
                    </div>
                </div>
                <div class="rounded-lg border bg-card px-4 py-3 flex items-center gap-3">
                    <Shield class="size-5 text-destructive shrink-0" />
                    <div>
                        <div class="text-xl font-bold">{{ totalRemovals }}</div>
                        <div class="text-xs text-muted-foreground">Removals logged</div>
                    </div>
                </div>
                <div class="rounded-lg border bg-card px-4 py-3 flex items-center gap-3">
                    <Gavel class="size-5 text-yellow-500 shrink-0" />
                    <div>
                        <div class="text-xl font-bold">{{ totalVoteKickInitiated }}</div>
                        <div class="text-xs text-muted-foreground">Vote-kicks seen</div>
                    </div>
                </div>
                <div class="rounded-lg border bg-card px-4 py-3 flex items-center gap-3">
                    <Globe class="size-5 text-blue-500 shrink-0" />
                    <div>
                        <div class="text-xl font-bold">{{ topWorlds.length }}</div>
                        <div class="text-xs text-muted-foreground">Worlds visited</div>
                    </div>
                </div>
            </div>

            <!-- ── error banner ── -->
            <div v-if="auditError" class="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
                <AlertTriangle class="size-4 shrink-0" />
                {{ auditError }}
            </div>

            <!-- ── tabs ── -->
            <Tabs v-model="activeTab" class="w-full">
                <TabsList class="mb-4">
                    <TabsTrigger value="audit">
                        <Shield class="size-3.5 mr-1.5" />
                        Audit Log
                    </TabsTrigger>
                    <TabsTrigger value="kicks">
                        <TrendingUp class="size-3.5 mr-1.5" />
                        Kick Board
                    </TabsTrigger>
                    <TabsTrigger value="votekick">
                        <Gavel class="size-3.5 mr-1.5" />
                        Vote-to-Kick
                    </TabsTrigger>
                    <TabsTrigger value="members">
                        <Users class="size-3.5 mr-1.5" />
                        Members
                    </TabsTrigger>
                    <TabsTrigger value="worlds">
                        <Globe class="size-3.5 mr-1.5" />
                        Top Worlds
                    </TabsTrigger>
                    <TabsTrigger value="webhook">
                        <Webhook class="size-3.5 mr-1.5" />
                        Webhook
                    </TabsTrigger>
                </TabsList>

                <!-- ══ AUDIT LOG TAB ══ -->
                <TabsContent value="audit" class="space-y-3">
                    <!-- kick chart -->
                    <div class="rounded-lg border bg-card p-4">
                        <div class="text-sm font-medium mb-3 text-muted-foreground">Member Removals Over Time</div>
                        <div v-if="isLoadingAudit" class="flex items-center justify-center h-40">
                            <RefreshCw class="size-5 animate-spin text-muted-foreground" />
                        </div>
                        <div v-else ref="kickChartRef" class="w-full h-48" />
                    </div>

                    <!-- filters -->
                    <div class="flex items-center gap-2 flex-wrap">
                        <div class="relative flex-1 min-w-48">
                            <Search class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input v-model="auditSearch" placeholder="Search actor, target, description…" class="pl-8 h-8 text-sm" />
                        </div>
                        <Select v-model="auditTypeFilter">
                            <SelectTrigger class="w-40 h-8 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All events</SelectItem>
                                <SelectItem value="remove">Removals only</SelectItem>
                                <SelectItem value="ban">Bans only</SelectItem>
                                <SelectItem value="role">Role changes</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button variant="outline" size="sm" class="h-8" @click="exportCsv(filteredAuditLogs, 'group-audit-log.csv')">
                            <Download class="size-3.5 mr-1" />
                            Export
                        </Button>
                    </div>

                    <!-- table -->
                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortAuditCol, sortAuditDir, 'created_at')">
                                        <span class="flex items-center gap-1">
                                            Time
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Event</th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortAuditCol, sortAuditDir, 'actorDisplayName')">
                                        <span class="flex items-center gap-1">
                                            Actor
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortAuditCol, sortAuditDir, 'targetDisplayName')">
                                        <span class="flex items-center gap-1">
                                            Target
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Description</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingAudit">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground">
                                        <RefreshCw class="size-4 animate-spin inline mr-2" />Loading…
                                    </td>
                                </tr>
                                <tr v-else-if="filteredAuditLogs.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">
                                        No audit log entries found for the selected filters.
                                    </td>
                                </tr>
                                <template v-else>
                                    <tr
                                        v-for="entry in filteredAuditLogs"
                                        :key="entry.id"
                                        class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                        <td class="px-3 py-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                                            {{ fmtDate(entry.created_at) }}
                                        </td>
                                        <td class="px-3 py-2">
                                            <Badge :variant="auditVariant(entry.eventType)" class="text-xs whitespace-nowrap">
                                                {{ auditLabel(entry.eventType) }}
                                            </Badge>
                                        </td>
                                        <td class="px-3 py-2 text-sm font-medium">
                                            {{ entry.actorDisplayName || entry.actorId || '—' }}
                                        </td>
                                        <td class="px-3 py-2 text-sm">
                                            {{ entry.targetDisplayName || entry.targetId || '—' }}
                                        </td>
                                        <td class="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
                                            {{ entry.description || '—' }}
                                        </td>
                                    </tr>
                                </template>
                            </tbody>
                        </table>
                    </div>

                    <!-- load more -->
                    <div v-if="auditLogs.length < auditTotal" class="flex justify-center">
                        <Button variant="outline" size="sm" :disabled="isLoadingAudit" @click="loadMoreAudit">
                            <RefreshCw v-if="isLoadingAudit" class="size-3.5 mr-1.5 animate-spin" />
                            Load more ({{ auditLogs.length }} / {{ auditTotal }})
                        </Button>
                    </div>
                </TabsContent>

                <!-- ══ KICK LEADERBOARD TAB ══ -->
                <TabsContent value="kicks" class="space-y-3">
                    <div class="flex items-center justify-between">
                        <p class="text-sm text-muted-foreground">
                            Members removed from the group via the audit log.
                            <span class="font-medium text-foreground">{{ kickLeaderboard.length }}</span>
                            unique actors.
                        </p>
                        <Button variant="outline" size="sm" @click="exportCsv(kickLeaderboard, 'kick-leaderboard.csv')">
                            <Download class="size-3.5 mr-1" />
                            Export
                        </Button>
                    </div>

                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortKickCol, sortKickDir, 'actor')">
                                        <span class="flex items-center gap-1">
                                            Actor
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortKickCol, sortKickDir, 'count')">
                                        <span class="flex items-center gap-1">
                                            Removals
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Most Recent Target</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="kickLeaderboard.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">
                                        No member removals found in the loaded audit log.
                                    </td>
                                </tr>
                                <tr
                                    v-for="(row, i) in kickLeaderboard"
                                    :key="row.actor"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        {{ i + 1 }}
                                    </td>
                                    <td class="px-3 py-2 font-medium">{{ row.actor }}</td>
                                    <td class="px-3 py-2">
                                        <Badge variant="destructive" class="text-xs">{{ row.count }}</Badge>
                                    </td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        {{ row.targets[0]?.name ?? '—' }}
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        {{ fmtDate(row.targets[0]?.at) }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ VOTE-TO-KICK TAB ══ -->
                <TabsContent value="votekick" class="space-y-3">
                    <!-- header row -->
                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Vote-to-Kick Leaderboard</p>
                            <p class="text-xs text-muted-foreground mt-0.5">
                                Ranked by who has had the most vote-kicks initiated against them.
                                From your local game log — only events from lobbies you were in.
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <!-- successful-only toggle -->
                            <Button
                                :variant="voteKickSuccessOnly ? 'default' : 'outline'"
                                size="sm"
                                class="h-8 text-xs"
                                @click="voteKickSuccessOnly = !voteKickSuccessOnly">
                                <Shield class="size-3.5 mr-1" />
                                {{ voteKickSuccessOnly ? 'Successful only' : 'All events' }}
                            </Button>
                            <Button variant="outline" size="sm" class="h-8" :disabled="isLoadingVoteKick" @click="loadVoteKickHistory">
                                <RefreshCw :class="{ 'animate-spin': isLoadingVoteKick }" class="size-3.5 mr-1" />
                                Reload
                            </Button>
                            <Button variant="outline" size="sm" class="h-8" @click="exportCsv(voteKickLeaderboard, 'votekick-leaderboard.csv')">
                                <Download class="size-3.5 mr-1" />
                                Export
                            </Button>
                        </div>
                    </div>

                    <!-- info banner -->
                    <div class="rounded-lg border bg-yellow-500/5 border-yellow-500/20 px-4 py-2.5 text-xs text-muted-foreground flex items-start gap-2">
                        <AlertTriangle class="size-3.5 text-yellow-500 mt-0.5 shrink-0" />
                        <span>
                            VRChat's game log records <strong>who was targeted</strong> by a vote-kick, but
                            <strong>not who initiated it</strong> — that info is never written to the log.
                            The table below ranks players by how often they were targeted.
                            "Succeeded" = the log also recorded a
                            <code class="bg-muted px-1 rounded">Vote to kick … succeeded</code> message for that person.
                        </span>
                    </div>

                    <!-- main target leaderboard -->
                    <div class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                Target Leaderboard — Most Vote-Kicked
                            </span>
                            <span class="text-xs text-muted-foreground">
                                {{ voteKickLeaderboard.length }} player{{ voteKickLeaderboard.length !== 1 ? 's' : '' }}
                                <template v-if="voteKickSuccessOnly">(successful kicks only)</template>
                            </span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortVoteCol, sortVoteDir, 'name')">
                                        <span class="flex items-center gap-1">
                                            Player (target)
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortVoteCol, sortVoteDir, 'initiated')">
                                        <span class="flex items-center gap-1">
                                            Votes Started
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortVoteCol, sortVoteDir, 'succeeded')">
                                        <span class="flex items-center gap-1">
                                            Succeeded
                                            <ChevronsUpDown class="size-3 opacity-50" />
                                        </span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Success Rate</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Event</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingVoteKick">
                                    <td colspan="6" class="text-center py-10 text-muted-foreground">
                                        <RefreshCw class="size-4 animate-spin inline mr-2" />Loading game log…
                                    </td>
                                </tr>
                                <tr v-else-if="voteKickLeaderboard.length === 0">
                                    <td colspan="6" class="text-center py-10 text-muted-foreground text-sm">
                                        <span v-if="voteKickSuccessOnly">No successful vote-kicks in the game log. <button class="underline" @click="voteKickSuccessOnly = false">Show all events</button></span>
                                        <span v-else>No vote-to-kick events found in your local game log.</span>
                                    </td>
                                </tr>
                                <tr
                                    v-for="(row, i) in voteKickLeaderboard"
                                    :key="row.name"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums font-bold">{{ i + 1 }}</td>
                                    <td class="px-3 py-2 font-medium">{{ row.name }}</td>
                                    <td class="px-3 py-2">
                                        <Badge variant="outline" class="text-xs tabular-nums">{{ row.initiated }}</Badge>
                                    </td>
                                    <td class="px-3 py-2">
                                        <Badge v-if="row.succeeded > 0" variant="destructive" class="text-xs tabular-nums">
                                            {{ row.succeeded }}
                                        </Badge>
                                        <span v-else class="text-xs text-muted-foreground">—</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <template v-if="row.initiated > 0">
                                            {{ Math.round((row.succeeded / row.initiated) * 100) }}%
                                        </template>
                                        <template v-else>—</template>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        {{ fmtDate(row.lastAt) }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- initiator note -->
                    <div class="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
                        <strong>Initiator leaderboard:</strong> Not possible from the game log — VRChat only writes the
                        <em>target's</em> name to the log when a vote-kick starts. Who initiated it is never logged.
                        The closest proxy is the Kick Board tab, which shows who has removed the most members from the
                        group itself via the audit log.
                    </div>
                </TabsContent>

                <!-- ══ MEMBERS TAB ══ -->
                <TabsContent value="members" class="space-y-3">
                    <div class="flex items-center gap-2">
                        <div class="relative flex-1 max-w-xs">
                            <Search class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input v-model="memberSearch" placeholder="Search members…" class="pl-8 h-8 text-sm" />
                        </div>
                        <span class="text-sm text-muted-foreground">{{ filteredMembers.length }} member{{ filteredMembers.length !== 1 ? 's' : '' }}</span>
                    </div>

                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Display Name</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Role</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Joined</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingMembers">
                                    <td colspan="4" class="text-center py-10 text-muted-foreground">
                                        <RefreshCw class="size-4 animate-spin inline mr-2" />Loading members…
                                    </td>
                                </tr>
                                <tr v-else-if="filteredMembers.length === 0">
                                    <td colspan="4" class="text-center py-10 text-muted-foreground text-sm">
                                        No members found.
                                    </td>
                                </tr>
                                <tr
                                    v-for="m in filteredMembers"
                                    :key="m.userId"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 font-medium">
                                        {{ m.user?.displayName ?? m.userId ?? '—' }}
                                    </td>
                                    <td class="px-3 py-2">
                                        <div class="flex flex-wrap gap-1">
                                            <Badge
                                                v-for="role in (m.roleIds ?? []).slice(0, 3)"
                                                :key="role"
                                                variant="secondary"
                                                class="text-xs">
                                                {{ role }}
                                            </Badge>
                                        </div>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        {{ fmtDate(m.joinedAt) }}
                                    </td>
                                    <td class="px-3 py-2">
                                        <Badge v-if="m.isRepresenting" variant="default" class="text-xs">Representing</Badge>
                                        <span v-else class="text-xs text-muted-foreground">—</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ TOP WORLDS TAB ══ -->
                <TabsContent value="worlds" class="space-y-3">
                    <!-- chart -->
                    <div class="rounded-lg border bg-card p-4">
                        <div class="text-sm font-medium mb-3 text-muted-foreground">Top 10 Worlds by Visit Count</div>
                        <div v-if="isLoadingWorlds" class="flex items-center justify-center h-52">
                            <RefreshCw class="size-5 animate-spin text-muted-foreground" />
                        </div>
                        <div v-else-if="topWorlds.length === 0" class="flex items-center justify-center h-32 text-muted-foreground text-sm">
                            No location history found for this group.
                        </div>
                        <div v-else ref="worldChartRef" class="w-full h-64" />
                    </div>

                    <!-- table -->
                    <div class="flex items-center justify-between">
                        <p class="text-sm text-muted-foreground">Instance visits from your local game log where the group was the host.</p>
                        <Button variant="outline" size="sm" @click="exportCsv(topWorlds, 'top-worlds.csv')">
                            <Download class="size-3.5 mr-1" />
                            Export
                        </Button>
                    </div>
                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortWorldCol, sortWorldDir, 'name')">
                                        <span class="flex items-center gap-1">World<ChevronsUpDown class="size-3 opacity-50" /></span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortWorldCol, sortWorldDir, 'visits')">
                                        <span class="flex items-center gap-1">Visits<ChevronsUpDown class="size-3 opacity-50" /></span>
                                    </th>
                                    <th
                                        class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground"
                                        @click="toggleSort(sortWorldCol, sortWorldDir, 'totalTime')">
                                        <span class="flex items-center gap-1">Total Time<ChevronsUpDown class="size-3 opacity-50" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Avg Session</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingWorlds">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground">
                                        <RefreshCw class="size-4 animate-spin inline mr-2" />Loading location history…
                                    </td>
                                </tr>
                                <tr v-else-if="topWorlds.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">
                                        No world visit history found for this group.
                                    </td>
                                </tr>
                                <tr
                                    v-for="(w, i) in topWorlds"
                                    :key="w.name"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">{{ i + 1 }}</td>
                                    <td class="px-3 py-2 font-medium">{{ w.name }}</td>
                                    <td class="px-3 py-2">
                                        <Badge variant="secondary" class="text-xs">{{ w.visits }}</Badge>
                                    </td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        {{ fmtDuration(w.totalTime) }}
                                    </td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        {{ fmtDuration(w.avgTime) }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ WEBHOOK PLACEHOLDER TAB ══ -->
                <TabsContent value="webhook" class="space-y-4">
                    <div class="rounded-lg border border-dashed bg-muted/20 p-8 flex flex-col items-center gap-4 text-center">
                        <Webhook class="size-10 text-muted-foreground opacity-40" />
                        <div>
                            <p class="text-sm font-medium">Discord Webhook Integration</p>
                            <p class="text-xs text-muted-foreground mt-1 max-w-sm">
                                Coming soon. Will send safe, analytics-only notifications to a Discord channel —
                                instance summaries, member joins/leaves, and moderation events.
                                No automation; read-only reporting.
                            </p>
                        </div>
                    </div>

                    <!-- preview of future fields, all disabled -->
                    <fieldset disabled class="space-y-3 opacity-40 pointer-events-none select-none">
                        <div class="space-y-1.5">
                            <label class="text-sm font-medium">Webhook URL</label>
                            <Input placeholder="https://discord.com/api/webhooks/…" />
                        </div>
                        <div class="flex flex-col gap-2 text-sm">
                            <label class="flex items-center gap-2">
                                <input type="checkbox" class="rounded" /> Notify on member join
                            </label>
                            <label class="flex items-center gap-2">
                                <input type="checkbox" class="rounded" /> Notify on member leave / removal
                            </label>
                            <label class="flex items-center gap-2">
                                <input type="checkbox" class="rounded" /> Post daily instance summary
                            </label>
                        </div>
                        <Button variant="default" class="w-full" disabled>Save Webhook Settings</Button>
                    </fieldset>
                </TabsContent>
            </Tabs>
        </template>
    </div>
</template>
