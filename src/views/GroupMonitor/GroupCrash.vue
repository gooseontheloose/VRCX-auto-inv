<script setup>
    import { ref, computed, watch, onMounted, onActivated, onBeforeUnmount, nextTick } from 'vue';
    import { useRoute } from 'vue-router';
    import * as echarts from 'echarts';
    import dayjs from 'dayjs';
    import { toast } from 'vue-sonner';

    import {
        BarChart3,
        RefreshCw,
        Shield,
        Globe,
        Gavel,
        Webhook,
        ChevronsUpDown,
        Search,
        Download,
        AlertTriangle,
        TrendingUp,
        Clock,
        CircleOff,
        ExternalLink,
        Filter,
        ChevronDown,
        ChevronRight,
        Trophy,
        Target,
        UserX,
        Flame,
        CheckCircle2,
        XCircle,
        List,
        ScrollText,
        Bell,
        BellOff,
        Send,
        Plus,
        Trash2,
        Activity,
        Zap
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
    import { useGroupMonitorData } from './useGroupMonitorData';
    import { attributeVoteKicks, dayOfWeek, localMonth, membersOverTimeFrom, topWorldsFrom } from './monitorStats';
    import { kickEntries } from '../../services/groupMonitor/payloads';
    import { useI18n } from 'vue-i18n';
    import { useGroupMonitorStore } from '../../stores/groupMonitor';
    import { detectCrashSessions, ownLeaveTimesFromVisits } from '../../services/groupMonitor/crashDetector';

    // ── Shared singleton state from composable ────────────────────────────────
    const {
        selectedGroupId,
        auditLogs,
        auditTotal,
        auditGroupMeta,
        auditFullyLoaded,
        auditLimitReached,
        isLoadingAudit,
        auditAutoLoading,
        isFetchingNewLogs,
        auditError,
        vkEvents,
        isLoadingVk,
        locationHistory,
        isLoadingWorlds,
        profileCache,
        profileLookupInProgress,
        resolvedUserNames,
        auditPageSize,
        API_OFFSET_MAX,
        AUDIT_LABELS,
        AUDIT_BADGE_CLASSES,
        auditLabel,
        auditBadgeClass,
        sortRows,
        toggleSort,
        mergeAuditEntries,
        parseKickTarget,
        parseTargetFromDescription,
        parseActorFromDescription,
        resolveName,
        resolveKickTarget,
        resolveAuditActor,
        resolveAuditTarget,
        queueNameResolution,
        handleGroupChange,
        loadAuditLogs,
        pollNewAuditLogs,
        loadVoteKickHistory,
        loadLocationHistory,
        refreshAll,
        onPageActivated,
        lastViewedGroupId,
        nowTick,
        openProfileById,
        openProfileByName,
        startPolling,
        stopPolling,
        warnLeaderboard,
        mostWarnedLeaderboard,
        groupAuditPermIds,
        groupsWithCachedData,
        groupPermCheckDone,
        updateGroupAuditPerms,
        isGroupPermLost,
    } = useGroupMonitorData();

    const groupStore = useGroupStore();
    const _route = useRoute();

    // ── group selector ───────────────────────────────────────────────────────
    const allGroups = computed(() => Array.from(groupStore.currentUserGroups.values()));
    watch(allGroups, (gs) => { if (gs.length) updateGroupAuditPerms(gs); }, { immediate: true });
    const auditCapableGroups = computed(() => {
        const all = allGroups.value;
        if (!groupPermCheckDone.value || (!groupAuditPermIds.value.size && !groupsWithCachedData.value.size)) return all;
        const f = all.filter((g) => groupAuditPermIds.value.has(g.id) || groupsWithCachedData.value.has(g.id));
        return f.length > 0 ? f : all;
    });
    const groups = auditCapableGroups;
    const selectedGroup = computed(() => allGroups.value.find((g) => g.id === selectedGroupId.value) ?? null);

    // ── warn leaderboard sort state ───────────────────────────────────────────
    const warnView = ref('warners');
    const sortWarnCol = ref('count');
    const sortWarnDir = ref('desc');
    const sortWarnedCol = ref('count');
    const sortWarnedDir = ref('desc');
    const sortedWarnLeaderboard = computed(() => sortRows([...warnLeaderboard.value], sortWarnCol.value, sortWarnDir.value));
    const sortedMostWarnedLeaderboard = computed(() => sortRows([...mostWarnedLeaderboard.value], sortWarnedCol.value, sortWarnedDir.value));

    // ── route → tab mapping ───────────────────────────────────────────────────
    const ROUTE_TAB_MAP = {
        'group-monitor-audit':    'audit',
        'group-monitor-members':  'members',
        'group-monitor-crash':    'crash',
        'group-monitor-webhooks': 'webhook',
        'group-monitor-overview': 'kicks'
    };

    // Derived page title shown in the header
    const PAGE_TITLES = {
        'group-monitor-audit':    'Audit Log',
        'group-monitor-members':  'Group Members',
        'group-monitor-crash':    'Crash Detection',
        'group-monitor-webhooks': 'Webhooks',
        'group-monitor-overview': 'Group Monitor'
    };
    const pageTitle = computed(() => PAGE_TITLES[_route.name] ?? 'Group Monitor');

    // ── tab + filter state ────────────────────────────────────────────────────
    const activeTab = ref(ROUTE_TAB_MAP[_route.name] ?? 'kicks');
    const auditDateDays = ref(0); // default all-time — caching makes it free
    const auditSearch = ref('');
    const auditTypeFilter = ref('all');
    const sortAuditCol = ref('created_at');
    const sortAuditDir = ref('desc');
    const sortKickCol = ref('count');
    const sortKickDir = ref('desc');
    const sortKickedCol = ref('count');
    const sortKickedDir = ref('desc');
    const kickView = ref('kickers'); // 'kickers' | 'kicked'
    const sortBanCol = ref('count');
    const sortBanDir = ref('desc');
    const sortBannedCol = ref('count');
    const sortBannedDir = ref('desc');
    const banView = ref('banners'); // 'banners' | 'banned'

    // vote-to-kick state
    const vkSearch = ref('');
    const vkDateDays = ref(0);
    const vkSuccessFilter = ref('all'); // 'all' | 'success' | 'failed'
    const sortVkCol = ref('initiated');
    const sortVkDir = ref('desc');
    const sortSnitchCol = ref('initiated');
    const sortSnitchDir = ref('desc');
    const vkView = ref('targets'); // 'targets' | 'snitches' | 'logs'
    const expandedTarget = ref(null);

    // worlds state
    const sortWorldCol = ref('visits');
    const sortWorldDir = ref('desc');

    // audit table pagination (client-side display only — all data is in memory)
    const auditDisplayPage = ref(0);
    const auditPageSizeDisplay = ref(25);

    // group vk log state
    const vkLogSearch = ref('');

    // ── chart refs ────────────────────────────────────────────────────────────
    const membersChartRef = ref(null);
    let membersChart = null;

    // ── helpers ───────────────────────────────────────────────────────────────
    function cutoffDate(days) {
        if (!days) return null;
        return dayjs(nowTick.value).subtract(days, 'day').toISOString();
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return dayjs(iso).format('YYYY-MM-DD HH:mm');
    }

    function fmtDateShort(iso) {
        if (!iso) return '—';
        return dayjs(iso).format('MMM D, YYYY');
    }

    function fmtDuration(seconds) {
        if (!seconds || seconds < 0) return '—';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function pct(num, den) {
        if (!den) return 0;
        return Math.round((num / den) * 100);
    }

    // reset display page when group changes or filters change
    watch(selectedGroupId, () => { auditDisplayPage.value = 0; });
    watch([auditSearch, auditTypeFilter, auditDateDays, sortAuditCol, sortAuditDir, auditPageSizeDisplay], () => {
        auditDisplayPage.value = 0;
    });

    // ── audit log ─────────────────────────────────────────────────────────────

    // all unique event types seen in the loaded audit log (for dynamic filter dropdown)
    const auditEventTypes = computed(() => {
        const types = new Set(auditLogs.value.map((r) => r.eventType).filter(Boolean));
        return Array.from(types).sort();
    });

    const filteredAuditLogs = computed(() => {
        let rows = auditLogs.value;
        const cutoff = cutoffDate(auditDateDays.value);
        if (cutoff) rows = rows.filter((r) => r.created_at >= cutoff);
        if (auditTypeFilter.value !== 'all') {
            rows = rows.filter((r) => r.eventType === auditTypeFilter.value);
        }
        const q = auditSearch.value.toLowerCase().trim();
        if (q) {
            rows = rows.filter((r) =>
                r.actorDisplayName?.toLowerCase().includes(q) ||
                r.targetDisplayName?.toLowerCase().includes(q) ||
                r.description?.toLowerCase().includes(q)
            );
        }
        return sortRows(rows, sortAuditCol.value, sortAuditDir.value);
    });

    const pagedAuditLogs = computed(() => {
        const start = auditDisplayPage.value * auditPageSizeDisplay.value;
        return filteredAuditLogs.value.slice(start, start + auditPageSizeDisplay.value);
    });

    // Queue background name resolution for any audit log entry on the current page
    // that has an ID but no display name. Names arrive reactively and update the table.
    watch(pagedAuditLogs, (entries) => {
        for (const e of entries) {
            if (e.actorId && !e.actorDisplayName) queueNameResolution(e.actorId);
            if (e.targetId && !e.targetDisplayName) queueNameResolution(e.targetId);
        }
    }, { immediate: true });

    const auditTotalPages = computed(() =>
        Math.max(1, Math.ceil(filteredAuditLogs.value.length / auditPageSizeDisplay.value))
    );

    // ── Name resolution helpers ───────────────────────────────────────────────

    // Queue background name resolution for kick/ban events with missing display names.
    watch(auditLogs, (logs) => {
        for (const r of logs) {
            if ((r.eventType === 'group.instance.kick' || r.eventType === 'group.user.ban')) {
                if (r.actorId && !r.actorDisplayName) queueNameResolution(r.actorId);
                if (r.targetId && !r.targetDisplayName) queueNameResolution(r.targetId);
            }
        }
    }, { immediate: true });

    // ── invite leaderboard ────────────────────────────────────────────────────
    const inviteLeaderboard = computed(() => {
        const inviteTypes = new Set(['group.invite.create', 'group.invite.send']);
        const invites = auditLogs.value.filter((r) => inviteTypes.has(r.eventType));
        const joins   = auditLogs.value.filter((r) => r.eventType === 'group.member.join');

        const joinTimeById   = new Map();
        const joinTimeByName = new Map();
        for (const j of joins) {
            if (j.targetId) {
                if (!joinTimeById.has(j.targetId)) joinTimeById.set(j.targetId, []);
                joinTimeById.get(j.targetId).push(j.created_at);
            }
            const name = resolveAuditTarget(j);
            if (name && name !== '—') {
                if (!joinTimeByName.has(name)) joinTimeByName.set(name, []);
                joinTimeByName.get(name).push(j.created_at);
            }
        }

        const map = new Map();
        for (const inv of invites) {
            const actorId   = inv.actorId || null;
            const actorName = resolveAuditActor(inv) || '—';
            const key       = actorId ?? actorName;

            if (!map.has(key)) {
                map.set(key, { actor: actorName, actorId, invites: 0, converts: 0, lastAt: inv.created_at, invitees: [] });
            }
            const e = map.get(key);
            if (inv.actorDisplayName) e.actor = inv.actorDisplayName;
            e.invites++;
            if (inv.created_at > e.lastAt) e.lastAt = inv.created_at;

            const inviteeId   = inv.targetId;
            const inviteeName = resolveAuditTarget(inv);
            let converted = false;
            if (inviteeId && joinTimeById.has(inviteeId)) {
                converted = joinTimeById.get(inviteeId).some((t) => t >= inv.created_at);
            }
            if (!converted && inviteeName && inviteeName !== '—' && joinTimeByName.has(inviteeName)) {
                converted = joinTimeByName.get(inviteeName).some((t) => t >= inv.created_at);
            }
            if (converted) e.converts++;
            e.invitees.push({ name: inviteeName || '—', id: inviteeId, at: inv.created_at, converted });
        }

        return sortRows(
            Array.from(map.values()).map((r) => ({ ...r, rate: r.invites > 0 ? Math.round(r.converts / r.invites * 100) : 0 })),
            sortInviteCol.value, sortInviteDir.value
        );
    });

    // members invite leaderboard sort
    const membersView = ref('leaderboard'); // 'leaderboard' | 'overtime' | 'analysis'
    const sortInviteCol = ref('invites');
    const sortInviteDir = ref('desc');
    const expandedInviter = ref(null);

    // ── members over time ─────────────────────────────────────────────────────
    const membersOverTime = computed(() => membersOverTimeFrom(auditLogs.value));

    // ── invite analytics summary ──────────────────────────────────────────────
    const inviteStats = computed(() => {
        const lb           = inviteLeaderboard.value;
        const totalInvites = lb.reduce((s, r) => s + r.invites, 0);
        const totalJoined  = lb.reduce((s, r) => s + r.converts, 0);
        const overallRate  = totalInvites > 0 ? Math.round(totalJoined / totalInvites * 100) : 0;
        const topByRate    = [...lb].filter((r) => r.invites >= 3).sort((a, b) => b.rate - a.rate)[0] ?? null;
        const topByVolume  = lb[0] ?? null;

        const byMonth = new Map();
        for (const r of auditLogs.value.filter((r) => r.eventType === 'group.invite.create' || r.eventType === 'group.invite.send')) {
            const m = localMonth(r.created_at);
            byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
        }
        const trendMonths = [...byMonth.keys()].sort();
        const trendCounts = trendMonths.map((m) => byMonth.get(m));

        const convBuckets = { '0%': 0, '1–25%': 0, '26–50%': 0, '51–75%': 0, '76–100%': 0 };
        for (const r of lb) {
            if (r.rate === 0) convBuckets['0%']++;
            else if (r.rate <= 25) convBuckets['1–25%']++;
            else if (r.rate <= 50) convBuckets['26–50%']++;
            else if (r.rate <= 75) convBuckets['51–75%']++;
            else convBuckets['76–100%']++;
        }

        const avgInvites = lb.length > 0 ? (totalInvites / lb.length).toFixed(1) : '0';
        const neverConverted = lb.reduce((s, r) => s + r.invitees.filter((i) => !i.converted).length, 0);

        return { totalInvites, totalJoined, overallRate, topByRate, topByVolume, trendMonths, trendCounts, convBuckets, avgInvites, neverConverted, totalInviters: lb.length };
    });

    // ── kick / ban leaderboards ───────────────────────────────────────────────
    const kickLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = kickEntries(auditLogs.value).filter((r) => !cutoff || r.created_at >= cutoff);
        const map = new Map();
        for (const r of rows) {
            const actorId = r.actorId || null;
            const key = actorId ?? r.actorDisplayName ?? '?';
            const actorName = r.actorDisplayName
                || (actorId && resolvedUserNames.value[actorId])
                || parseActorFromDescription(r.description)
                || '—';
            if (!map.has(key)) map.set(key, { actor: actorName, actorId, count: 0, targets: [] });
            else if (r.actorDisplayName) map.get(key).actor = r.actorDisplayName;
            const e = map.get(key);
            e.count++;
            e.targets.push({ name: resolveKickTarget(r) || '—', id: r.targetId, at: r.created_at });
        }
        return sortRows(Array.from(map.values()), sortKickCol.value, sortKickDir.value);
    });

    const kickedLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = kickEntries(auditLogs.value).filter((r) => !cutoff || r.created_at >= cutoff);
        const map = new Map();
        for (const r of rows) {
            const targetId = r.targetId || null;
            const target = resolveKickTarget(r) || (targetId && resolvedUserNames.value[targetId]) || '—';
            const key = targetId ?? target;
            if (!map.has(key)) map.set(key, { target, targetId, count: 0, actors: [] });
            else if (r.targetDisplayName) map.get(key).target = r.targetDisplayName;
            const e = map.get(key);
            e.count++;
            const actorName = r.actorDisplayName
                || (r.actorId && resolvedUserNames.value[r.actorId])
                || parseActorFromDescription(r.description)
                || '—';
            e.actors.push({ name: actorName, id: r.actorId, at: r.created_at });
        }
        return sortRows(Array.from(map.values()), sortKickedCol.value, sortKickedDir.value);
    });

    const banLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.user.ban' && (!cutoff || r.created_at >= cutoff)
        );
        const map = new Map();
        for (const r of rows) {
            const actorId = r.actorId || null;
            const key = actorId ?? r.actorDisplayName ?? '?';
            const actorName = r.actorDisplayName
                || (actorId && resolvedUserNames.value[actorId])
                || parseActorFromDescription(r.description)
                || '—';
            if (!map.has(key)) map.set(key, { actor: actorName, actorId, count: 0, targets: [] });
            else if (r.actorDisplayName) map.get(key).actor = r.actorDisplayName;
            const e = map.get(key);
            e.count++;
            const tgtName = r.targetDisplayName
                || (r.targetId && resolvedUserNames.value[r.targetId])
                || parseTargetFromDescription(r.description)
                || '—';
            e.targets.push({ name: tgtName, id: r.targetId, at: r.created_at });
        }
        return sortRows(Array.from(map.values()), sortBanCol.value, sortBanDir.value);
    });

    const bannedLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.user.ban' && (!cutoff || r.created_at >= cutoff)
        );
        const map = new Map();
        for (const r of rows) {
            const targetId = r.targetId || null;
            const key = targetId ?? r.targetDisplayName ?? '?';
            const targetName = r.targetDisplayName
                || (targetId && resolvedUserNames.value[targetId])
                || parseTargetFromDescription(r.description)
                || '—';
            if (!map.has(key)) map.set(key, { target: targetName, targetId, count: 0, actors: [] });
            else if (r.targetDisplayName) map.get(key).target = r.targetDisplayName;
            const e = map.get(key);
            e.count++;
            const actorName = r.actorDisplayName
                || (r.actorId && resolvedUserNames.value[r.actorId])
                || parseActorFromDescription(r.description)
                || '—';
            e.actors.push({ name: actorName, id: r.actorId, at: r.created_at });
        }
        return sortRows(Array.from(map.values()), sortBannedCol.value, sortBannedDir.value);
    });

    // ── vote-to-kick ──────────────────────────────────────────────────────────
    const groupVkEvents = computed(() =>
        attributeVoteKicks(vkEvents.value, locationHistory.value, nowTick.value)
    );

    const filteredVkEvents = computed(() => {
        let evs = groupVkEvents.value;
        const cutoff = cutoffDate(vkDateDays.value);
        if (cutoff) evs = evs.filter((e) => e.at >= cutoff);
        const q = vkSearch.value.toLowerCase().trim();
        if (q) evs = evs.filter((e) =>
            e.target.toLowerCase().includes(q) || (e.initiator || '').toLowerCase().includes(q)
        );
        return evs;
    });

    const vkTargetLeaderboard = computed(() => {
        const map = new Map();
        for (const ev of filteredVkEvents.value) {
            if (!map.has(ev.target)) {
                map.set(ev.target, { name: ev.target, initiated: 0, succeeded: 0, lastAt: ev.at, events: [] });
            }
            const e = map.get(ev.target);
            if (ev.type === 'initiation') e.initiated++;
            if (ev.type === 'success') e.succeeded++;
            if (ev.at > e.lastAt) e.lastAt = ev.at;
            e.events.push(ev);
        }

        let rows = Array.from(map.values());
        if (vkSuccessFilter.value === 'success') rows = rows.filter((r) => r.succeeded > 0);
        if (vkSuccessFilter.value === 'failed') rows = rows.filter((r) => r.succeeded === 0 && r.initiated > 0);
        return sortRows(rows, sortVkCol.value, sortVkDir.value);
    });

    const vkSnitchLeaderboard = computed(() => {
        const map = new Map();
        const src = groupVkEvents.value;
        for (const ev of src) {
            const initiator = ev.initiator?.trim();
            if (!initiator) continue;
            if (!map.has(initiator)) {
                map.set(initiator, { name: initiator, initiated: 0, succeeded: 0, lastAt: ev.at, events: [] });
            }
            const e = map.get(initiator);
            if (ev.type === 'initiation') e.initiated++;
            if (ev.type === 'success') e.succeeded++;
            if (ev.at > e.lastAt) e.lastAt = ev.at;
            e.events.push(ev);
        }
        return sortRows(Array.from(map.values()), sortSnitchCol.value, sortSnitchDir.value);
    });

    const vkStats = computed(() => {
        const evs = filteredVkEvents.value;
        const initiations = evs.filter((e) => e.type === 'initiation');
        const successes = evs.filter((e) => e.type === 'success');
        const uniqueTargets = new Set(initiations.map((e) => e.target)).size;
        const topTarget = vkTargetLeaderboard.value[0] ?? null;
        return {
            totalInitiations: initiations.length,
            totalSuccesses: successes.length,
            uniqueTargets,
            overallSuccessRate: pct(successes.length, initiations.length),
            topTarget: topTarget?.name ?? '—',
            topTargetCount: topTarget?.initiated ?? 0
        };
    });

    const groupVkLogs = computed(() => {
        const q = vkLogSearch.value.toLowerCase().trim();
        const evs = groupVkEvents.value;
        const filtered = q
            ? evs.filter((e) => e.target.toLowerCase().includes(q) || (e.initiator || '').toLowerCase().includes(q))
            : evs;
        return [...filtered].sort((a, b) => (a.at < b.at ? 1 : -1));
    });

    // ── worlds ────────────────────────────────────────────────────────────────
    const topWorlds = computed(() =>
        sortRows(topWorldsFrom(locationHistory.value), sortWorldCol.value, sortWorldDir.value)
    );

    // ── stat cards ────────────────────────────────────────────────────────────
    const totalRemovals = computed(() => kickEntries(auditLogs.value).length);
    const totalBans = computed(() => auditLogs.value.filter((r) => r.eventType === 'group.user.ban').length);

    // ── charts ────────────────────────────────────────────────────────────────
    function renderMembersChart() {
        if (!membersChartRef.value) return;
        if (membersChart && membersChart.getDom() !== membersChartRef.value) {
            membersChart.dispose();
            membersChart = null;
        }
        if (!membersChart) membersChart = echarts.init(membersChartRef.value, null, { renderer: 'svg' });
        const { dates, joins, leaves, net } = membersOverTime.value;
        membersChart.setOption({
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            legend: { data: ['Joined', 'Left / Removed / Banned', 'Net (cumulative)'], textStyle: { color: '#888' }, bottom: 0 },
            xAxis: { type: 'category', data: dates, axisLabel: { color: '#888', rotate: 30, formatter: (v) => v.slice(5) } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#888' } },
            series: [
                { name: 'Joined', type: 'bar', data: joins, itemStyle: { color: '#22c55e', borderRadius: [2, 2, 0, 0] }, stack: 'bars' },
                { name: 'Left / Removed / Banned', type: 'bar', data: leaves.map((v) => -v), itemStyle: { color: '#ef4444', borderRadius: [0, 0, 2, 2] }, stack: 'bars' },
                { name: 'Net (cumulative)', type: 'line', data: net, smooth: true, lineStyle: { color: '#3b82f6', width: 2.5 }, areaStyle: { color: 'rgba(59,130,246,0.08)' }, symbol: 'none' }
            ],
            grid: { left: '3%', right: '4%', bottom: '14%', containLabel: true }
        });
    }

    // ── export ────────────────────────────────────────────────────────────────
    function exportCsv(rows, filename) {
        if (!rows.length) return;
        const keys = Object.keys(rows[0]).filter((k) => k !== 'events' && k !== 'targets');
        const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
            download: filename
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── resize ────────────────────────────────────────────────────────────────
    function onResize() {
        crashChart?.resize();
        membersChart?.resize();
    }

    // ── crash detection ───────────────────────────────────────────────────────
    const crashChartRef = ref(null);
    let crashChart = null;
    const recentLeaveEvents = ref([]);
    const isLoadingCrash = ref(false);
    const monitorStore = useGroupMonitorStore();
    const { t } = useI18n();
    // Persisted per group in the groupMonitor store (used by the background check too).
    const crashThreshold = computed({
        get: () => monitorStore.getGroupSettings(selectedGroupId.value).crashThreshold,
        set: (v) => monitorStore.setGroupSettings(selectedGroupId.value, { crashThreshold: Number(v) })
    });
    const crashWindowSec = computed({
        get: () => monitorStore.getGroupSettings(selectedGroupId.value).crashWindowSec,
        set: (v) => monitorStore.setGroupSettings(selectedGroupId.value, { crashWindowSec: Number(v) })
    });

    async function loadCrashData() {
        const groupId = selectedGroupId.value;
        if (!groupId) return;
        isLoadingCrash.value = true;
        try {
            const rows = [];
            await sqliteService.execute(
                (row) => rows.push({ at: row[0], displayName: row[1], location: row[2] }),
                `SELECT created_at, display_name, location FROM gamelog_join_leave WHERE type = 'OnPlayerLeft' AND location LIKE '%${groupId}%' ORDER BY created_at DESC LIMIT 5000`
            );
            recentLeaveEvents.value = rows;
            await nextTick();
            renderCrashChart();
        } catch (err) {
            console.error('[GroupMonitor] Crash data error:', err);
            recentLeaveEvents.value = [];
        } finally {
            isLoadingCrash.value = false;
        }
    }

    // Same detector as the background service: uses the real window, and skips
    // the batch VRCX writes for everyone still there when you leave an instance.
    const detectedCrashes = computed(() => {
        const evs = recentLeaveEvents.value;
        if (!evs.length) return [];
        return detectCrashSessions(evs, {
            groupId: selectedGroupId.value,
            nowMs: Date.now(),
            threshold: crashThreshold.value,
            windowSec: crashWindowSec.value,
            ownLeaveTimes: ownLeaveTimesFromVisits(locationHistory.value),
            lookbackMs: Infinity,
            settleMs: 0
        }).reverse();
    });

    function renderCrashChart() {
        if (!crashChartRef.value) return;
        if (!crashChart) crashChart = echarts.init(crashChartRef.value, null, { renderer: 'svg' });
        const byBucket = new Map();
        for (const ev of recentLeaveEvents.value) {
            const t = dayjs(ev.at);
            const min5 = String(Math.floor(t.minute() / 5) * 5).padStart(2, '0');
            const key = t.format('MM-DD HH:') + min5;
            byBucket.set(key, (byBucket.get(key) ?? 0) + 1);
        }
        const keys = Array.from(byBucket.keys()).sort();
        const thr = crashThreshold.value;
        crashChart.setOption({
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: keys, axisLabel: { color: '#888', rotate: 30, fontSize: 9 } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#888' } },
            series: [{
                name: 'Player Leaves',
                type: 'bar',
                data: keys.map((k) => {
                    const v = byBucket.get(k);
                    return { value: v, itemStyle: { color: v >= thr ? '#ef4444' : '#3b82f6', borderRadius: [4, 4, 0, 0] } };
                })
            }],
            grid: { left: '3%', right: '4%', bottom: '18%', containLabel: true }
        });
    }

    watch([crashThreshold, crashWindowSec], () => renderCrashChart());

    // This page opens on the crash tab, so the activeTab watcher never fires:
    // load on open, on group change and when KeepAlive brings the page back.
    watch(selectedGroupId, (id) => { if (id) loadCrashData(); }, { immediate: true });

    function refreshCrashPage() {
        refreshAll();
        loadCrashData();
    }

    // ── crash alerts (owned by the groupMonitor store) ───────────────────────
    // Background crash checks and webhook delivery run in the store from login;
    // this page only edits the per-group settings and can send one manually.
    const webhookConfigs = computed(() => monitorStore.webhooks.filter((w) => w.groupId === selectedGroupId.value));
    const monitorCrashEnabled = computed(() => monitorStore.getGroupSettings(selectedGroupId.value).crashEnabled);
    const crashWebhookBusy = computed(() =>
        webhookConfigs.value.some((w) => w.type === 'crash-alert' && monitorStore.webhookState[w.id]?.sending)
    );

    function toggleCrashMonitor(enabled) {
        if (!selectedGroupId.value) return;
        monitorStore.setGroupSettings(selectedGroupId.value, { crashEnabled: enabled });
    }

    async function sendCrashToAllWebhooks(session) {
        const res = await monitorStore.sendCrashSession(session, selectedGroupId.value);
        if (!res.ok) toast.warning(t(`view.group_monitor.error.${res.error}`));
        else toast.success(t('view.group_monitor.webhook.queued'));
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    onMounted(async () => {
        loadVoteKickHistory();
        window.addEventListener('resize', onResize);
        const _savedGroupId = lastViewedGroupId();
        const _startGroupId = (_savedGroupId && allGroups.value.some((g) => g.id === _savedGroupId)) ? _savedGroupId : allGroups.value[0]?.id;
        // Only fetch if data isn't already loaded from another GroupMonitor page this session
        if (_startGroupId && _startGroupId !== selectedGroupId.value) handleGroupChange(_startGroupId);
        startPolling();
    });

    onActivated(() => {
        onPageActivated();
        loadCrashData();
    });

    onBeforeUnmount(() => {
        stopPolling();
        window.removeEventListener('resize', onResize);
        crashChart?.dispose();
        membersChart?.dispose();
    });

    watch(activeTab, async (tab) => {
        await nextTick();
        if (tab === 'crash') { await loadCrashData(); }
        if (tab === 'members' && membersView.value === 'overtime') renderMembersChart();
    });

    // Sync route name → active tab so sidebar nav entries open the right section
    watch(() => _route.name, (name) => {
        const tab = ROUTE_TAB_MAP[name];
        if (tab && tab !== activeTab.value) activeTab.value = tab;
    });

</script>



<template>
    <div class="x-container space-y-5">

        <!-- ── header ── -->
        <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
                <BarChart3 class="size-5 text-primary" />
                <h1 class="text-lg font-semibold">{{ pageTitle }}</h1>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
                <Select :model-value="selectedGroupId" @update:model-value="handleGroupChange">
                    <SelectTrigger class="w-64">
                        <SelectValue placeholder="Select a group…" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="g in groups" :key="g.id" :value="g.id">
                            {{ g.name }}<template v-if="isGroupPermLost(g.id)"> <span class="text-xs opacity-60">(cached – no access)</span></template>
                        </SelectItem>
                        <div v-if="groups.length === 0" class="px-3 py-2 text-sm text-muted-foreground">No groups found</div>
                    </SelectContent>
                </Select>
                <Select :model-value="String(auditDateDays)" @update:model-value="(v) => (auditDateDays = Number(v))">
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
                <Button variant="outline" size="icon" :disabled="!selectedGroupId || isLoadingAudit" @click="refreshCrashPage" :title="auditAutoLoading ? 'Loading history…' : 'Refresh'">
                    <RefreshCw :class="{ 'animate-spin': isLoadingAudit || auditAutoLoading || isFetchingNewLogs }" class="size-4" />
                </Button>
            </div>
        </div>

        <!-- ── no group ── -->
        <div v-if="!selectedGroupId" class="flex flex-col items-center justify-center mt-24 gap-3 text-muted-foreground">
            <CircleOff class="size-10 opacity-30" />
            <p class="text-sm">Select a group to load analytics.</p>
        </div>

        <template v-else>

            <div v-if="auditError" class="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
                <AlertTriangle class="size-4 shrink-0" />{{ auditError }}
            </div>

            <!-- passive audit load progress -->
            <div v-if="auditAutoLoading || isFetchingNewLogs" class="rounded-lg border bg-card px-4 py-2 flex items-center gap-3">
                <RefreshCw class="size-3.5 animate-spin text-muted-foreground shrink-0" />
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between text-xs text-muted-foreground mb-1">
                        <span v-if="auditAutoLoading && !auditLimitReached">Loading full history… {{ auditLogs.length }} / {{ auditTotal }} entries</span>
                        <span v-else-if="auditAutoLoading && auditLimitReached">Past API offset cap — fetching older entries by date ({{ auditLogs.length }} loaded)</span>
                        <span v-else>Checking for new entries…</span>
                    </div>
                    <div v-if="auditAutoLoading && auditTotal > 0" class="h-1 w-full rounded-full bg-muted overflow-hidden">
                        <div class="h-full rounded-full bg-primary transition-all duration-500"
                            :style="{ width: Math.min(100, Math.round((auditLogs.length / auditTotal) * 100)) + '%' }" />
                    </div>
                </div>
                <span v-if="auditAutoLoading && auditTotal > 0" class="text-xs text-muted-foreground tabular-nums shrink-0">
                    {{ Math.min(100, Math.round((auditLogs.length / auditTotal) * 100)) }}%
                </span>
            </div>

            <!-- ── Crash Detection ── -->
            <div class="space-y-4">
                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Instance Crash Detection</p>
                            <p class="text-xs text-muted-foreground">Detects mass-leave spikes in your group's instances. Red bars exceed the threshold.</p>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <Button variant="outline" size="sm" class="h-8" :disabled="isLoadingCrash" @click="loadCrashData">
                                <RefreshCw :class="{ 'animate-spin': isLoadingCrash }" class="size-3.5 mr-1" />Reload
                            </Button>
                        </div>
                    </div>

                    <!-- config row -->
                    <div class="rounded-lg border bg-card px-4 py-3 flex items-center gap-4 flex-wrap">
                        <div class="flex items-center gap-2">
                            <label class="text-xs text-muted-foreground whitespace-nowrap">Min players to flag:</label>
                            <input
                                type="number" min="2" max="50" :value="crashThreshold"
                                @change="crashThreshold = Number($event.target.value)"
                                class="w-16 h-7 rounded border bg-background px-2 text-sm text-center tabular-nums" />
                        </div>
                        <div class="flex items-center gap-2">
                            <label class="text-xs text-muted-foreground whitespace-nowrap">Within (seconds):</label>
                            <input
                                type="number" min="10" max="600" :value="crashWindowSec"
                                @change="crashWindowSec = Number($event.target.value)"
                                class="w-20 h-7 rounded border bg-background px-2 text-sm text-center tabular-nums" />
                        </div>
                        <div class="flex items-center gap-2 ml-auto">
                            <span class="text-xs text-muted-foreground">Background monitor:</span>
                            <button
                                class="flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors"
                                :class="monitorCrashEnabled ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
                                @click="toggleCrashMonitor(!monitorCrashEnabled)">
                                <Activity class="size-3.5" />{{ monitorCrashEnabled ? 'Active' : 'Off' }}
                            </button>
                        </div>
                    </div>

                    <!-- chart -->
                    <div class="rounded-lg border bg-card p-4">
                        <div class="text-xs font-medium text-muted-foreground mb-1">Player Leaves per 5-Minute Bucket (red = above threshold)</div>
                        <div v-if="isLoadingCrash" class="flex items-center justify-center h-44"><RefreshCw class="size-5 animate-spin text-muted-foreground" /></div>
                        <div v-else-if="recentLeaveEvents.length === 0" class="flex items-center justify-center h-36 text-muted-foreground text-sm">
                            No leave events found for this group's instances.<br/>Click Reload to query the game log.
                        </div>
                        <div v-else ref="crashChartRef" class="w-full h-52" />
                    </div>

                    <!-- detected crashes -->
                    <div class="flex items-center justify-between">
                        <p class="text-sm text-muted-foreground">
                            <span class="font-medium text-foreground">{{ detectedCrashes.length }}</span> potential crash event{{ detectedCrashes.length !== 1 ? 's' : '' }} detected.
                            <span class="text-xs">{{ recentLeaveEvents.length }} leave events loaded.</span>
                        </p>
                        <Badge v-if="webhookConfigs.filter(w => w.enabled && w.type === 'crash-alert').length" variant="secondary" class="text-xs">
                            {{ webhookConfigs.filter(w => w.enabled && w.type === 'crash-alert').length }} crash webhook{{ webhookConfigs.filter(w => w.enabled && w.type === 'crash-alert').length !== 1 ? 's' : '' }} active
                        </Badge>
                        <Badge v-else variant="outline" class="text-xs opacity-60">No crash webhooks set</Badge>
                    </div>

                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Players Left</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Severity</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Players</th>
                                    <th class="px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingCrash">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground"><RefreshCw class="size-4 animate-spin inline mr-2" />Loading…</td>
                                </tr>
                                <tr v-else-if="detectedCrashes.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">
                                        No crash patterns detected with current threshold settings.
                                    </td>
                                </tr>
                                <tr v-for="s in detectedCrashes" :key="s.id"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(s.startAt) }}</td>
                                    <td class="px-3 py-2.5">
                                        <Badge variant="destructive" class="text-xs tabular-nums">{{ s.count }} left</Badge>
                                    </td>
                                    <td class="px-3 py-2.5">
                                        <span class="text-xs font-semibold px-2 py-0.5 rounded"
                                            :class="s.severity === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : s.severity === 'medium' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'">
                                            {{ s.severity.toUpperCase() }}
                                        </span>
                                    </td>
                                    <td class="px-3 py-2.5 text-xs text-muted-foreground max-w-xs truncate" :title="s.players.join(', ')">
                                        {{ s.players.slice(0, 5).join(', ') }}{{ s.players.length > 5 ? ` +${s.players.length - 5} more` : '' }}
                                    </td>
                                    <td class="px-3 py-2.5">
                                        <Button variant="outline" size="sm" class="h-7 text-xs"
                                            :disabled="crashWebhookBusy"
                                            @click="sendCrashToAllWebhooks(s)">
                                            <Send class="size-3 mr-1" />Alert
                                        </Button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
            </div>

            <!-- ── Warn Leaderboard ── -->
            <div class="space-y-3">
                <div class="flex items-center justify-between flex-wrap gap-2">
                    <div class="flex items-center gap-2">
                        <AlertTriangle class="size-4 text-amber-500" />
                        <p class="text-sm font-medium">Warn Leaderboard</p>
                        <span class="text-xs text-muted-foreground">({{ auditLogs.filter(r => r.eventType === 'group.instance.warn').length }} total warning events)</span>
                    </div>
                    <div class="flex gap-1">
                        <Button size="sm" :variant="warnView === 'warners' ? 'default' : 'outline'" class="h-7 text-xs" @click="warnView = 'warners'">Top Warners</Button>
                        <Button size="sm" :variant="warnView === 'warned' ? 'default' : 'outline'" class="h-7 text-xs" @click="warnView = 'warned'">Most Warned</Button>
                    </div>
                </div>
                <div class="rounded-lg border bg-card overflow-hidden">
                    <table class="w-full text-sm">
                        <thead class="bg-muted/40 border-b">
                            <tr>
                                <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-8">#</th>
                                <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer select-none"
                                    @click="warnView === 'warners' ? toggleSort(sortWarnCol, sortWarnDir, 'actor') : toggleSort(sortWarnedCol, sortWarnedDir, 'target')">
                                    {{ warnView === 'warners' ? 'Moderator' : 'Player' }}
                                </th>
                                <th class="text-right px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer select-none"
                                    @click="warnView === 'warners' ? toggleSort(sortWarnCol, sortWarnDir, 'count') : toggleSort(sortWarnedCol, sortWarnedDir, 'count')">
                                    Warnings
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <template v-if="warnView === 'warners'">
                                <tr v-for="(r, i) in sortedWarnLeaderboard.slice(0, 25)" :key="r.id ?? r.actor"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-muted-foreground tabular-nums text-xs">{{ i + 1 }}</td>
                                    <td class="px-3 py-2">
                                        <span class="cursor-pointer hover:underline" @click="r.id ? openProfileById(r.id) : openProfileByName(r.actor)">{{ r.actor }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-right font-medium tabular-nums">{{ r.count }}</td>
                                </tr>
                                <tr v-if="sortedWarnLeaderboard.length === 0">
                                    <td colspan="3" class="px-3 py-8 text-center text-muted-foreground text-xs">No instance warnings recorded for this group.</td>
                                </tr>
                            </template>
                            <template v-else>
                                <tr v-for="(r, i) in sortedMostWarnedLeaderboard.slice(0, 25)" :key="r.id ?? r.target"
                                    class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-muted-foreground tabular-nums text-xs">{{ i + 1 }}</td>
                                    <td class="px-3 py-2">
                                        <span class="cursor-pointer hover:underline" @click="r.id ? openProfileById(r.id) : openProfileByName(r.target)">{{ r.target }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-right font-medium tabular-nums">{{ r.count }}</td>
                                </tr>
                                <tr v-if="sortedMostWarnedLeaderboard.length === 0">
                                    <td colspan="3" class="px-3 py-8 text-center text-muted-foreground text-xs">No instance warnings recorded for this group.</td>
                                </tr>
                            </template>
                        </tbody>
                    </table>
                </div>
            </div>
        </template>
    </div>
</template>
