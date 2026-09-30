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
    import { isValidDiscordWebhookUrl } from '../../services/groupMonitor/discord';
    import { AUDIT_EVENT_CATEGORIES } from '../../services/groupMonitor/payloads';

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
    const crashThreshold = ref(5);
    const crashWindowSec = ref(60);

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

    const detectedCrashes = computed(() => {
        const evs = recentLeaveEvents.value;
        if (!evs.length) return [];
        const threshold = crashThreshold.value;
        const windowMs = crashWindowSec.value * 1000;
        const sessions = [];
        let i = 0;
        while (i < evs.length) {
            const startMs = new Date(evs[i].at).getTime();
            const windowEvs = [];
            let j = i;
            while (j < evs.length) {
                if (startMs - new Date(evs[j].at).getTime() > windowMs) break;
                windowEvs.push(evs[j]);
                j++;
            }
            if (windowEvs.length >= threshold) {
                const count = windowEvs.length;
                const sev = count >= threshold * 3 ? 'high' : count >= threshold * 1.5 ? 'medium' : 'low';
                sessions.push({
                    startAt: evs[i].at,
                    endAt: evs[j - 1]?.at ?? evs[i].at,
                    count, windowSeconds: crashWindowSec.value, severity: sev,
                    location: evs[i].location ?? '',
                    players: windowEvs.map((e) => e.displayName).filter(Boolean)
                });
                i = j;
            } else {
                i++;
            }
        }
        return sessions;
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

    // ── webhooks + background monitoring ─────────────────────────────────────
    // Sending, schedules, audit polling and crash checks all run in the
    // groupMonitor store from login onwards. This page is only a UI over it:
    // opening or closing it never starts, stops or duplicates anything.
    const monitorStore = useGroupMonitorStore();
    const { t } = useI18n();

    const WEBHOOK_TYPE_LABELS = {
        'audit-events': 'Audit Events (live)',
        'kick-board': 'Top Kickers',
        'most-kicked': 'Most Kicked',
        'ban-board': 'Top Banners',
        'most-banned': 'Most Banned',
        'snitch-report': 'Top Snitches',
        'vk-targets': 'Most Vote-Kicked',
        'crash-alert': 'Crash Alerts',
        'invite-board': 'Top Inviters',
        'warn-board': 'Top Warners',
        'most-warned': 'Most Warned'
    };
    const EVENT_FILTER_OPTIONS = Object.keys(AUDIT_EVENT_CATEGORIES);
    const isLeaderboard = (type) => type !== 'crash-alert' && type !== 'audit-events';

    const webhookNewUrl = ref('');
    const webhookNewName = ref('');
    const webhookNewType = ref('audit-events');
    const webhookNewColor = ref('#5865f2');
    const webhookNewInterval = ref(0);
    const webhookNewGroupId = ref('');
    const webhookNewFilter = ref(['kick', 'ban', 'warn']);
    const webhookNewUrlValid = computed(() => isValidDiscordWebhookUrl(webhookNewUrl.value));
    const webhookBusy = ref(new Set());

    const webhookConfigs = computed(() => monitorStore.webhooks);
    const viewedGroupSettings = computed(() => monitorStore.getGroupSettings(selectedGroupId.value));
    const viewedPollStatus = computed(() => monitorStore.pollStatus[selectedGroupId.value] ?? null);
    const showDeliveryLog = ref(false);

    function fmtTime(ms) {
        return ms ? dayjs(ms).format('YYYY-MM-DD HH:mm:ss') : t('view.group_monitor.background.never');
    }

    function groupLabel(wh) {
        return allGroups.value.find((g) => g.id === wh.groupId)?.name ?? wh.groupName ?? wh.groupId;
    }

    function webhookName(id) {
        return monitorStore.webhooks.find((w) => w.id === id)?.name ?? id;
    }

    function errorText(code, fallback) {
        const key = `view.group_monitor.error.${code}`;
        const msg = t(key);
        return msg === key ? fallback ?? code : msg;
    }

    async function addWebhook() {
        const res = await monitorStore.addWebhook({
            name: webhookNewName.value.trim() || WEBHOOK_TYPE_LABELS[webhookNewType.value] || 'Webhook',
            url: webhookNewUrl.value.trim(),
            type: webhookNewType.value,
            color: webhookNewColor.value || '#5865f2',
            intervalMinutes: isLeaderboard(webhookNewType.value) ? Number(webhookNewInterval.value) || 0 : 0,
            groupId: webhookNewGroupId.value || selectedGroupId.value,
            eventFilter: [...webhookNewFilter.value]
        });
        if (!res.ok) {
            toast.error(errorText(res.error));
            return;
        }
        webhookNewUrl.value = '';
        webhookNewName.value = '';
        webhookNewInterval.value = 0;
    }

    function toggleNewFilter(cat) {
        const s = new Set(webhookNewFilter.value);
        if (s.has(cat)) s.delete(cat);
        else s.add(cat);
        webhookNewFilter.value = [...s];
    }

    function updateWebhook(id, patch) {
        monitorStore.updateWebhook(id, patch).then((res) => {
            if (!res.ok) toast.error(errorText(res.error));
        });
    }

    function toggleWebhookFilter(wh, cat) {
        const s = new Set(wh.eventFilter ?? []);
        if (s.has(cat)) s.delete(cat);
        else s.add(cat);
        if (!s.size) return;
        updateWebhook(wh.id, { eventFilter: [...s] });
    }

    function removeWebhook(id) {
        monitorStore.removeWebhook(id);
    }

    async function runBusy(id, fn) {
        webhookBusy.value = new Set([...webhookBusy.value, id]);
        try {
            return await fn();
        } finally {
            webhookBusy.value = new Set([...webhookBusy.value].filter((x) => x !== id));
        }
    }

    async function testWebhook(id) {
        const res = await runBusy(id, () => monitorStore.testWebhook(id));
        if (res?.ok) toast.success(t('view.group_monitor.webhook.test_queued'));
        else toast.error(errorText(res?.error, 'Failed'));
    }

    async function sendNow(id) {
        const res = await runBusy(id, () => monitorStore.sendNow(id));
        if (res?.ok) toast.success(t('view.group_monitor.webhook.queued'));
        else toast.error(errorText(res?.error, 'Failed'));
    }

    function setViewedGroupSetting(patch) {
        if (!selectedGroupId.value) return;
        monitorStore.setGroupSettings(selectedGroupId.value, patch);
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

    onActivated(() => onPageActivated());

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
                <Button variant="outline" size="icon" :disabled="!selectedGroupId || isLoadingAudit" @click="refreshAll" :title="auditAutoLoading ? 'Loading history…' : 'Refresh'">
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

            <!-- ── Webhooks ── -->
            <div class="space-y-4">
                    <!-- background service status + settings -->
                    <div class="rounded-lg border bg-card px-4 py-3 space-y-3">
                        <div class="flex items-center gap-2 flex-wrap">
                            <Activity class="size-4 text-primary" />
                            <p class="text-sm font-medium">{{ t('view.group_monitor.background.title') }}</p>
                            <Badge
                                :variant="monitorStore.serviceState === 'running' ? 'default' : 'outline'"
                                class="text-xs"
                                data-testid="gm-service-state">
                                {{ t(`view.group_monitor.background.state.${monitorStore.serviceState}`) }}
                            </Badge>
                            <span class="text-xs text-muted-foreground">
                                {{ t('view.group_monitor.background.last_cycle', { time: fmtTime(monitorStore.lastCycleAt) }) }}
                            </span>
                            <button
                                class="ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors"
                                :class="monitorStore.enabled ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
                                @click="monitorStore.setEnabled(!monitorStore.enabled)">
                                <Zap class="size-3" />
                                {{ monitorStore.enabled ? t('view.group_monitor.background.on') : t('view.group_monitor.background.off') }}
                            </button>
                        </div>
                        <p class="text-xs text-muted-foreground">{{ t('view.group_monitor.background.description') }}</p>

                        <!-- viewed group settings -->
                        <div class="flex items-center gap-3 flex-wrap text-xs border-t pt-3">
                            <span class="font-medium">{{ t('view.group_monitor.background.viewed_group') }}: {{ selectedGroup?.name ?? selectedGroupId }}</span>
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    :checked="viewedGroupSettings.monitored"
                                    @change="setViewedGroupSetting({ monitored: $event.target.checked })" />
                                {{ t('view.group_monitor.background.monitor_group') }}
                            </label>
                            <label class="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    :checked="viewedGroupSettings.crashEnabled"
                                    @change="setViewedGroupSetting({ crashEnabled: $event.target.checked })" />
                                {{ t('view.group_monitor.background.crash_alerts') }}
                            </label>
                            <span class="flex items-center gap-1">
                                {{ t('view.group_monitor.background.crash_threshold') }}
                                <input
                                    type="number" min="2" max="50"
                                    :value="viewedGroupSettings.crashThreshold"
                                    @change="setViewedGroupSetting({ crashThreshold: Number($event.target.value) })"
                                    class="w-14 h-6 rounded border bg-background px-1 text-xs text-center tabular-nums" />
                            </span>
                            <span class="flex items-center gap-1">
                                {{ t('view.group_monitor.background.crash_window') }}
                                <input
                                    type="number" min="10" max="600"
                                    :value="viewedGroupSettings.crashWindowSec"
                                    @change="setViewedGroupSetting({ crashWindowSec: Number($event.target.value) })"
                                    class="w-16 h-6 rounded border bg-background px-1 text-xs text-center tabular-nums" />
                            </span>
                            <span v-if="viewedPollStatus" class="w-full"
                                :class="viewedPollStatus.ok ? 'text-muted-foreground' : 'text-destructive'">
                                <template v-if="viewedPollStatus.ok">
                                    {{ t('view.group_monitor.background.poll_ok', { time: fmtTime(viewedPollStatus.at), count: viewedPollStatus.newCount }) }}
                                </template>
                                <template v-else>
                                    {{ t('view.group_monitor.background.poll_error', { error: viewedPollStatus.error }) }}
                                </template>
                                <template v-if="viewedPollStatus.gapsRemaining">
                                    · {{ t('view.group_monitor.background.gaps_pending', { count: viewedPollStatus.gapsRemaining }) }}
                                </template>
                            </span>
                        </div>

                        <!-- queue -->
                        <div class="flex items-center gap-2 flex-wrap text-xs border-t pt-3">
                            <span class="text-muted-foreground" data-testid="gm-queue">
                                {{ t('view.group_monitor.background.queue', { pending: monitorStore.queueStats.pending, dead: monitorStore.queueStats.dead }) }}
                            </span>
                            <template v-if="monitorStore.queueStats.dead > 0">
                                <Button variant="outline" size="sm" class="h-6 text-xs" @click="monitorStore.retryDead()">
                                    {{ t('view.group_monitor.background.retry_failed') }}
                                </Button>
                                <Button variant="ghost" size="sm" class="h-6 text-xs" @click="monitorStore.clearDead()">
                                    {{ t('view.group_monitor.background.clear_failed') }}
                                </Button>
                            </template>
                            <button class="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground" @click="showDeliveryLog = !showDeliveryLog">
                                <ChevronDown v-if="showDeliveryLog" class="size-3" />
                                <ChevronRight v-else class="size-3" />
                                {{ t('view.group_monitor.background.delivery_log') }}
                            </button>
                        </div>
                        <div v-if="showDeliveryLog" class="text-xs space-y-0.5 max-h-48 overflow-y-auto">
                            <p v-if="!monitorStore.deliveryLog.length" class="text-muted-foreground">{{ t('view.group_monitor.background.no_deliveries') }}</p>
                            <div v-for="(e, i) in monitorStore.deliveryLog" :key="i" class="flex items-center gap-2">
                                <CheckCircle2 v-if="e.status === 'sent'" class="size-3 text-green-500 shrink-0" />
                                <XCircle v-else class="size-3 text-destructive shrink-0" />
                                <span class="tabular-nums text-muted-foreground">{{ fmtTime(e.at) }}</span>
                                <span class="font-medium">{{ webhookName(e.webhookId) }}</span>
                                <span class="text-muted-foreground truncate">{{ e.eventId }}</span>
                                <span v-if="e.status !== 'sent'" class="text-destructive truncate">
                                    {{ e.status }}{{ e.httpStatus ? ` (${e.httpStatus})` : '' }} {{ e.message }}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm font-medium">Discord Webhook Notifications</p>
                            <p class="text-xs text-muted-foreground">Live audit events, scheduled leaderboards and crash alerts. Analytics-only — no moderation actions.</p>
                        </div>
                        <Badge variant="secondary" class="text-xs">{{ webhookConfigs.filter(w => w.enabled).length }} active</Badge>
                    </div>

                    <!-- add webhook form -->
                    <div class="rounded-lg border bg-card p-4 space-y-3">
                        <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add Webhook</p>
                        <div class="flex gap-2 flex-wrap">
                            <Input v-model="webhookNewName" placeholder="Label…" class="w-36 h-8 text-sm" />
                            <Input v-model="webhookNewUrl" placeholder="https://discord.com/api/webhooks/…" class="flex-1 min-w-48 h-8 text-sm"
                                :class="webhookNewUrl.trim() && !webhookNewUrlValid ? 'border-destructive' : ''" />
                        </div>
                        <p v-if="webhookNewUrl.trim() && !webhookNewUrlValid" class="text-xs text-destructive">{{ t('view.group_monitor.error.invalid_url') }}</p>
                        <div class="flex gap-2 flex-wrap items-center">
                            <Select :model-value="webhookNewGroupId || selectedGroupId" @update:model-value="(v) => (webhookNewGroupId = v)">
                                <SelectTrigger class="w-52 h-8 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select v-model="webhookNewType">
                                <SelectTrigger class="w-48 h-8 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="audit-events">Audit Events (live)</SelectItem>
                                    <SelectItem value="crash-alert">Crash Alerts</SelectItem>
                                    <SelectItem value="kick-board">Top Kickers</SelectItem>
                                    <SelectItem value="most-kicked">Most Kicked</SelectItem>
                                    <SelectItem value="ban-board">Top Banners</SelectItem>
                                    <SelectItem value="most-banned">Most Banned</SelectItem>
                                    <SelectItem value="warn-board">Top Warners</SelectItem>
                                    <SelectItem value="most-warned">Most Warned</SelectItem>
                                    <SelectItem value="snitch-report">Top Snitches</SelectItem>
                                    <SelectItem value="vk-targets">Most Vote-Kicked</SelectItem>
                                    <SelectItem value="invite-board">Top Inviters</SelectItem>
                                </SelectContent>
                            </Select>
                            <div class="flex items-center gap-1.5">
                                <span class="text-xs text-muted-foreground whitespace-nowrap">Color</span>
                                <input
                                    type="color" :value="webhookNewColor"
                                    @input="webhookNewColor = $event.target.value"
                                    class="w-8 h-8 rounded border bg-background cursor-pointer p-0.5" />
                            </div>
                            <div v-if="isLeaderboard(webhookNewType)" class="flex items-center gap-1.5">
                                <span class="text-xs text-muted-foreground whitespace-nowrap">Auto-send every</span>
                                <input
                                    type="number" min="0" max="10080" :value="webhookNewInterval"
                                    @input="webhookNewInterval = Number($event.target.value)"
                                    class="w-16 h-8 rounded border bg-background px-2 text-sm text-center tabular-nums" />
                                <span class="text-xs text-muted-foreground">min (0 = manual)</span>
                            </div>
                            <Button variant="default" size="sm" class="h-8 ml-auto" @click="addWebhook" :disabled="!webhookNewUrlValid">
                                <Plus class="size-3.5 mr-1" />Add
                            </Button>
                        </div>
                        <div v-if="webhookNewType === 'audit-events'" class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-xs text-muted-foreground">{{ t('view.group_monitor.webhook.events') }}:</span>
                            <button v-for="cat in EVENT_FILTER_OPTIONS" :key="cat"
                                class="text-xs px-2 py-0.5 rounded border transition-colors"
                                :class="webhookNewFilter.includes(cat) ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'"
                                @click="toggleNewFilter(cat)">
                                {{ t(`view.group_monitor.webhook.filter.${cat}`) }}
                            </button>
                        </div>
                    </div>

                    <!-- webhook list -->
                    <div v-if="webhookConfigs.length === 0" class="rounded-lg border border-dashed bg-muted/20 p-8 flex flex-col items-center gap-2 text-center">
                        <Webhook class="size-8 text-muted-foreground opacity-40" />
                        <p class="text-sm text-muted-foreground">No webhooks configured yet. Add one above.</p>
                    </div>

                    <div v-for="wh in webhookConfigs" :key="wh.id" class="rounded-lg border bg-card px-4 py-3 space-y-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <!-- enable toggle -->
                            <button
                                class="shrink-0 transition-colors"
                                :class="wh.enabled ? 'text-primary' : 'text-muted-foreground'"
                                :title="wh.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'"
                                @click="updateWebhook(wh.id, { enabled: !wh.enabled })">
                                <Bell v-if="wh.enabled" class="size-4" />
                                <BellOff v-else class="size-4" />
                            </button>
                            <span class="font-medium text-sm">{{ wh.name }}</span>
                            <Badge variant="outline" class="text-xs">{{ WEBHOOK_TYPE_LABELS[wh.type] ?? wh.type }}</Badge>
                            <span class="text-xs text-muted-foreground">· {{ groupLabel(wh) }}</span>
                            <span v-if="isLeaderboard(wh.type) && wh.intervalMinutes > 0" class="text-xs text-muted-foreground">
                                · every {{ wh.intervalMinutes }}m
                            </span>
                            <div class="ml-auto flex items-center gap-2">
                                <div class="flex items-center gap-1" title="Embed color">
                                    <input
                                        type="color" :value="wh.color ?? '#5865f2'"
                                        @change="updateWebhook(wh.id, { color: $event.target.value })"
                                        class="w-6 h-6 rounded border bg-background cursor-pointer p-0.5" />
                                </div>
                                <Button
                                    variant="outline" size="sm" class="h-7 text-xs"
                                    :disabled="webhookBusy.has(wh.id)"
                                    @click="testWebhook(wh.id)">
                                    <Zap class="size-3 mr-1" />{{ t('view.group_monitor.webhook.test') }}
                                </Button>
                                <Button
                                    v-if="isLeaderboard(wh.type)"
                                    variant="outline" size="sm" class="h-7 text-xs"
                                    :disabled="!wh.enabled || webhookBusy.has(wh.id) || monitorStore.webhookState[wh.id]?.sending"
                                    @click="sendNow(wh.id)">
                                    <RefreshCw v-if="webhookBusy.has(wh.id) || monitorStore.webhookState[wh.id]?.sending" class="size-3 mr-1 animate-spin" />
                                    <Send v-else class="size-3 mr-1" />
                                    {{ t('view.group_monitor.webhook.send_now') }}
                                </Button>
                                <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" @click="removeWebhook(wh.id)">
                                    <Trash2 class="size-3.5" />
                                </Button>
                            </div>
                        </div>

                        <!-- group / URL / interval / filter -->
                        <div class="flex items-center gap-3 flex-wrap">
                            <span class="text-xs text-muted-foreground font-mono truncate max-w-sm opacity-60">{{ wh.url }}</span>
                            <div class="flex items-center gap-1.5">
                                <span v-if="!wh.groupId" class="text-xs text-destructive">{{ t('view.group_monitor.webhook.needs_group') }}</span>
                                <Select :model-value="wh.groupId || ''" @update:model-value="(v) => v && v !== wh.groupId && updateWebhook(wh.id, { groupId: v })">
                                    <SelectTrigger class="w-44 h-6 text-xs"><SelectValue :placeholder="groupLabel(wh) || t('view.group_monitor.webhook.group')" /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem v-for="g in allGroups" :key="g.id" :value="g.id">{{ g.name }}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div v-if="isLeaderboard(wh.type)" class="flex items-center gap-1.5 ml-auto">
                                <span class="text-xs text-muted-foreground">Auto every</span>
                                <input
                                    type="number" min="0" max="10080"
                                    :value="wh.intervalMinutes ?? 0"
                                    @change="updateWebhook(wh.id, { intervalMinutes: Number($event.target.value) || 0 })"
                                    class="w-16 h-6 rounded border bg-background px-2 text-xs text-center tabular-nums" />
                                <span class="text-xs text-muted-foreground">min</span>
                            </div>
                            <div v-if="wh.type === 'audit-events'" class="flex items-center gap-1 flex-wrap ml-auto">
                                <button v-for="cat in EVENT_FILTER_OPTIONS" :key="cat"
                                    class="text-xs px-2 py-0.5 rounded border transition-colors"
                                    :class="(wh.eventFilter ?? []).includes(cat) ? 'bg-primary/80 text-primary-foreground border-primary' : 'hover:bg-muted text-muted-foreground'"
                                    @click="toggleWebhookFilter(wh, cat)">
                                    {{ t(`view.group_monitor.webhook.filter.${cat}`) }}
                                </button>
                            </div>
                        </div>

                        <!-- delivery status -->
                        <div class="flex items-center gap-3 flex-wrap text-xs">
                            <span v-if="monitorStore.webhookState[wh.id]?.lastSuccessAt" class="text-green-600 dark:text-green-400">
                                {{ t('view.group_monitor.webhook.last_success', { time: fmtTime(monitorStore.webhookState[wh.id].lastSuccessAt) }) }}
                            </span>
                            <span v-if="monitorStore.webhookState[wh.id]?.lastError" class="text-destructive">
                                {{ t('view.group_monitor.webhook.last_error', { error: monitorStore.webhookState[wh.id].lastError }) }}
                            </span>
                            <span v-if="monitorStore.queueStats.byWebhook[wh.id]?.pending" class="text-muted-foreground">
                                {{ t('view.group_monitor.webhook.pending', { n: monitorStore.queueStats.byWebhook[wh.id].pending }) }}
                            </span>
                            <span v-if="monitorStore.queueStats.byWebhook[wh.id]?.dead" class="text-destructive">
                                {{ t('view.group_monitor.webhook.dead', { n: monitorStore.queueStats.byWebhook[wh.id].dead }) }}
                            </span>
                            <span v-if="isLeaderboard(wh.type) && monitorStore.lastSent[wh.id]" class="text-muted-foreground">
                                · scheduled last: {{ fmtTime(monitorStore.lastSent[wh.id]) }}
                            </span>
                        </div>
                    </div>
            </div>
        </template>
    </div>
</template>
