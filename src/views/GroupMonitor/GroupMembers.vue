<script setup>
    import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
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
        openProfileById,
        openProfileByName,
        startPolling,
        stopPolling,
        webhookConfigs,
        webhookSendingIds,
        webhookStatus,
        webhookLastSent,
        initWebhooks,
        saveWebhookConfigs,
        saveWebhookLastSent,
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
        return dayjs().subtract(days, 'day').toISOString();
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
    const membersView = ref('overtime'); // 'leaderboard' | 'overtime' | 'analysis'
    const sortInviteCol = ref('invites');
    const sortInviteDir = ref('desc');
    const expandedInviter = ref(null);

    // ── members over time ─────────────────────────────────────────────────────
    const membersOverTime = computed(() => {
        const joinTypes  = new Set(['group.member.join', 'group.invite.accept']);
        const leaveTypes = new Set(['group.member.leave', 'group.member.remove', 'group.user.ban']);
        const relevant   = auditLogs.value.filter((r) => joinTypes.has(r.eventType) || leaveTypes.has(r.eventType));
        if (!relevant.length) return { dates: [], joins: [], leaves: [], net: [] };

        const dayMap = new Map();
        for (const r of [...relevant].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
            const day = r.created_at.slice(0, 10);
            if (!dayMap.has(day)) dayMap.set(day, { joins: 0, leaves: 0 });
            if (joinTypes.has(r.eventType)) dayMap.get(day).joins++;
            else dayMap.get(day).leaves++;
        }

        const keys = [...dayMap.keys()].sort();
        if (!keys.length) return { dates: [], joins: [], leaves: [], net: [] };

        const allDays = [];
        const cur = new Date(keys[0]);
        const last = new Date(keys[keys.length - 1]);
        while (cur <= last) { allDays.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1); }

        let running = 0;
        const joins = [], leaves = [], net = [];
        for (const day of allDays) {
            const { joins: j = 0, leaves: l = 0 } = dayMap.get(day) ?? {};
            running += j - l;
            joins.push(j); leaves.push(l); net.push(Math.max(0, running));
        }
        return { dates: allDays, joins, leaves, net };
    });

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
            const m = r.created_at.slice(0, 7);
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
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.instance.kick' && (!cutoff || r.created_at >= cutoff)
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
            e.targets.push({ name: resolveKickTarget(r) || '—', id: r.targetId, at: r.created_at });
        }
        return sortRows(Array.from(map.values()), sortKickCol.value, sortKickDir.value);
    });

    const kickedLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.instance.kick' && (!cutoff || r.created_at >= cutoff)
        );
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
    const groupVkEvents = computed(() => {
        if (!locationHistory.value.length || !vkEvents.value.length) return [];
        const ranges = locationHistory.value.map((loc) => {
            const startMs = new Date(loc.created_at).getTime();
            const dur = (Number(loc.time) || 0) * 1000;
            return { startMs, endMs: dur > 0 ? startMs + dur : Date.now(), worldName: loc.worldName || 'Unknown World' };
        });
        return vkEvents.value
            .map((ev) => {
                const evMs = new Date(ev.at).getTime();
                const range = ranges.find((r) => evMs >= r.startMs && evMs <= r.endMs);
                return range ? { ...ev, worldName: range.worldName } : null;
            })
            .filter(Boolean);
    });

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
    const topWorlds = computed(() => {
        const map = new Map();
        for (const row of locationHistory.value) {
            const name = row.worldName || 'Unknown World';
            if (!map.has(name)) map.set(name, { name, visits: 0, totalTime: 0 });
            const e = map.get(name);
            e.visits++;
            e.totalTime += Number(row.time) || 0;
        }
        return sortRows(
            Array.from(map.values()).map((e) => ({ ...e, avgTime: e.visits > 0 ? Math.round(e.totalTime / e.visits) : 0 })),
            sortWorldCol.value,
            sortWorldDir.value
        );
    });

    // ── stat cards ────────────────────────────────────────────────────────────
    const totalRemovals = computed(() => auditLogs.value.filter((r) => r.eventType === 'group.instance.kick').length);
    const totalBans = computed(() => auditLogs.value.filter((r) => r.eventType === 'group.user.ban').length);

    // ── charts ────────────────────────────────────────────────────────────────
    function renderMembersChart() {
        if (!membersChartRef.value) return;
        if (membersChart && membersChart.getDom() !== membersChartRef.value) {
            membersChart.dispose();
            membersChart = null;
        }
        if (!membersChart) membersChart = echarts.init(membersChartRef.value, null, { renderer: 'svg' });
        const { dates, joins, leaves, net } = filteredMembersOverTime.value;
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

    // ── webhook service ───────────────────────────────────────────────────────
    // webhookConfigs / webhookSendingIds / webhookStatus / webhookLastSent
    // are module-level singletons from useGroupMonitorData (SQLite-backed).
    const WEBHOOK_TYPE_LABELS = {
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
    const webhookNewUrl = ref('');
    const webhookNewName = ref('');
    const webhookNewType = ref('kick-board');
    const webhookNewColor = ref('#5865f2');
    const webhookNewInterval = ref(0);
    let webhookSchedulerInterval = null;

    const monitoredGroupId = ref(localStorage.getItem('gm-monitored-group') ?? '');
    const monitorCrashEnabled = ref(localStorage.getItem('gm-monitor-crash') === '1');
    let crashMonitorInterval = null;

    function setMonitoredGroup(groupId) {
        monitoredGroupId.value = groupId;
        localStorage.setItem('gm-monitored-group', groupId);
    }

    function toggleCrashMonitor(enabled) {
        monitorCrashEnabled.value = enabled;
        localStorage.setItem('gm-monitor-crash', enabled ? '1' : '0');
        if (enabled) startCrashMonitor();
        else stopCrashMonitor();
    }

    async function backgroundCrashCheck() {
        const groupId = monitoredGroupId.value || selectedGroupId.value;
        if (!groupId || !monitorCrashEnabled.value) return;
        try {
            const rows = [];
            await sqliteService.execute(
                (row) => rows.push({ at: row[0], displayName: row[1], location: row[2] }),
                `SELECT created_at, display_name, location FROM gamelog_join_leave WHERE type = 'OnPlayerLeft' AND location LIKE '%${groupId}%' AND created_at >= datetime('now', '-10 minutes') ORDER BY created_at DESC`
            );
            if (!rows.length) return;
            const windowMs = crashThreshold.value * 1000;
            const thr = crashThreshold.value;
            const startMs = new Date(rows[0].at).getTime();
            const windowEvs = rows.filter((r) => startMs - new Date(r.at).getTime() <= windowMs);
            if (windowEvs.length >= thr) {
                const session = {
                    startAt: rows[0].at, endAt: rows[windowEvs.length - 1].at,
                    count: windowEvs.length, windowSeconds: crashWindowSec.value,
                    severity: windowEvs.length >= thr * 3 ? 'high' : windowEvs.length >= thr * 1.5 ? 'medium' : 'low',
                    location: rows[0].location ?? '',
                    players: windowEvs.map((e) => e.displayName).filter(Boolean)
                };
                await sendCrashToAllWebhooks(session);
            }
        } catch { /* silent — background check is non-fatal */ }
    }

    function startCrashMonitor() {
        stopCrashMonitor();
        crashMonitorInterval = setInterval(backgroundCrashCheck, 60_000);
    }

    function stopCrashMonitor() {
        if (crashMonitorInterval) { clearInterval(crashMonitorInterval); crashMonitorInterval = null; }
    }

    async function webhookScheduler() {
        const now = Date.now();
        for (const wh of webhookConfigs.value) {
            if (!wh.enabled || !wh.intervalMinutes || wh.type === 'crash-alert') continue;
            const last = webhookLastSent.value[wh.id] ?? 0;
            if (now - last < wh.intervalMinutes * 60_000) continue;
            const fn = getPayloadFn(wh.type, wh.id);
            if (!fn) continue;
            webhookLastSent.value = { ...webhookLastSent.value, [wh.id]: now };
            saveWebhookLastSent();
            await sendWebhook(wh.id, fn).catch(() => { });
        }
    }

    function startWebhookScheduler() {
        stopWebhookScheduler();
        webhookSchedulerInterval = setInterval(webhookScheduler, 60_000);
    }

    function stopWebhookScheduler() {
        if (webhookSchedulerInterval) { clearInterval(webhookSchedulerInterval); webhookSchedulerInterval = null; }
    }

    function addWebhook() {
        const url = webhookNewUrl.value.trim();
        if (!url) return;
        const id = `wh-${Date.now()}`;
        const name = webhookNewName.value.trim() || WEBHOOK_TYPE_LABELS[webhookNewType.value] || 'Webhook';
        webhookConfigs.value = [...webhookConfigs.value, {
            id, name, url, type: webhookNewType.value,
            color: webhookNewColor.value || '#5865f2',
            enabled: true, intervalMinutes: Number(webhookNewInterval.value) || 0
        }];
        saveWebhookConfigs();
        webhookNewUrl.value = '';
        webhookNewName.value = '';
        webhookNewInterval.value = 0;
    }

    function updateWebhookInterval(id, minutes) {
        webhookConfigs.value = webhookConfigs.value.map((w) =>
            w.id === id ? { ...w, intervalMinutes: Number(minutes) || 0 } : w
        );
        saveWebhookConfigs();
    }

    function updateWebhookColor(id, color) {
        webhookConfigs.value = webhookConfigs.value.map((w) =>
            w.id === id ? { ...w, color } : w
        );
        saveWebhookConfigs();
    }

    function removeWebhook(id) {
        webhookConfigs.value = webhookConfigs.value.filter((w) => w.id !== id);
        saveWebhookConfigs();
        const s = { ...webhookStatus.value };
        delete s[id];
        webhookStatus.value = s;
    }

    function toggleWebhook(id) {
        webhookConfigs.value = webhookConfigs.value.map((w) => w.id === id ? { ...w, enabled: !w.enabled } : w);
        saveWebhookConfigs();
    }

    async function doFetchWebhook(url, payload) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    function hexToDiscordColor(hex) {
        return parseInt((hex ?? '#5865f2').replace('#', ''), 16);
    }

    function buildLeaderboardPayload(type, configId) {
        const config = webhookConfigs.value.find((w) => w.id === configId);
        const color = hexToDiscordColor(config?.color);
        const groupName = selectedGroup.value?.name ?? 'Unknown Group';
        let title, subtitle, rows, nameFn, countFn;
        if (type === 'kick-board') {
            title = 'Top Kickers'; subtitle = 'Who has issued the most instance kicks. Players are temporarily removed from the instance for 1 hour but remain in the group.';
            rows = kickLeaderboard.value; nameFn = (r) => r.actor; countFn = (r) => r.count;
        } else if (type === 'most-kicked') {
            title = 'Most Kicked'; subtitle = 'Who has been instance kicked the most. These players were removed from instances the most times.';
            rows = kickedLeaderboard.value; nameFn = (r) => r.target; countFn = (r) => r.count;
        } else if (type === 'snitch-report') {
            title = 'Top Snitches'; subtitle = 'Who has started the most vote-kicks against other players in group instances.';
            rows = vkSnitchLeaderboard.value; nameFn = (r) => r.name; countFn = (r) => r.initiated;
        } else if (type === 'vk-targets') {
            title = 'Most Vote-Kicked'; subtitle = 'Who has had the most vote-kicks initiated against them. These are the most targeted players.';
            rows = vkTargetLeaderboard.value; nameFn = (r) => r.name; countFn = (r) => r.initiated;
        } else if (type === 'ban-board') {
            title = 'Top Banners'; subtitle = 'Who has issued the most group bans. These moderators have removed the most members from the group permanently.';
            rows = banLeaderboard.value; nameFn = (r) => r.actor; countFn = (r) => r.count;
        } else if (type === 'most-banned') {
            title = 'Most Banned'; subtitle = 'Who has been banned from the group the most times. These players have the most ban events on record.';
            rows = bannedLeaderboard.value; nameFn = (r) => r.target; countFn = (r) => r.count;
        } else if (type === 'invite-board') {
            title = 'Top Inviters'; subtitle = 'Who has sent the most group invites and their join conversion rate.';
            rows = inviteLeaderboard.value;
            nameFn = (r) => r.actor;
            countFn = (r) => `${r.invites} invites · ${r.converts} joined · ${r.rate}%`;
        } else if (type === 'warn-board') {
            title = 'Top Warners'; subtitle = 'Who has issued the most instance warnings to players.';
            rows = warnLeaderboard.value; nameFn = (r) => r.actor; countFn = (r) => r.count;
        } else if (type === 'most-warned') {
            title = 'Most Warned'; subtitle = 'Who has received the most instance warnings.';
            rows = mostWarnedLeaderboard.value; nameFn = (r) => r.target; countFn = (r) => r.count;
        } else { return null; }
        const lines = rows.slice(0, 25).map((r, i) => `${i + 1}. ${nameFn(r)} — ${countFn(r)}`);
        const description = `*${subtitle}*\n\n${lines.join('\n') || 'No data yet.'}`;
        return { embeds: [{ title: `${title} — ${groupName}`, description,
            color, footer: { text: 'PAW Inviter - VRCX' }, timestamp: new Date().toISOString() }] };
    }

    function buildCrashAlertPayload(session) {
        const groupName = selectedGroup.value?.name ?? (monitoredGroupId.value ? `Group ${monitoredGroupId.value.slice(-6)}` : 'Unknown Group');
        const color = session.severity === 'high' ? 0xe74c3c : session.severity === 'medium' ? 0xf39c12 : 0x3498db;
        return { embeds: [{ title: `⚠️ Instance Crash Detected — ${groupName}`, description: `${session.count} players left in ${session.windowSeconds}s`, color, fields: [
            { name: 'Time', value: fmtDate(session.startAt), inline: true },
            { name: 'Count', value: String(session.count), inline: true },
            { name: 'Severity', value: session.severity.toUpperCase(), inline: true },
            { name: 'Players', value: session.players.slice(0, 20).join(', ') || 'Unknown', inline: false }
        ], footer: { text: 'PAW Inviter - VRCX' }, timestamp: new Date().toISOString() }] };
    }

    async function sendWebhook(configId, payloadOrFn) {
        const config = webhookConfigs.value.find((w) => w.id === configId);
        if (!config?.url) return;
        webhookSendingIds.value = new Set([...webhookSendingIds.value, configId]);
        try {
            const payload = typeof payloadOrFn === 'function' ? payloadOrFn() : payloadOrFn;
            await doFetchWebhook(config.url, payload);
            webhookStatus.value = { ...webhookStatus.value, [configId]: { ok: true, msg: 'Sent ✓' } };
            toast.success(`Sent to "${config.name}"`);
        } catch (err) {
            const msg = err?.message ?? 'Failed';
            webhookStatus.value = { ...webhookStatus.value, [configId]: { ok: false, msg } };
            toast.error(`Webhook failed: ${msg}`);
        } finally {
            webhookSendingIds.value = new Set([...webhookSendingIds.value].filter((id) => id !== configId));
        }
    }

    function getPayloadFn(type, configId) {
        const leaderboardTypes = ['kick-board', 'most-kicked', 'ban-board', 'most-banned', 'snitch-report', 'vk-targets', 'invite-board', 'warn-board', 'most-warned'];
        if (leaderboardTypes.includes(type)) return () => buildLeaderboardPayload(type, configId);
        return null;
    }

    async function sendCrashToAllWebhooks(session) {
        const targets = webhookConfigs.value.filter((w) => w.enabled && w.type === 'crash-alert');
        if (!targets.length) { toast.warning('No crash-alert webhooks configured. Add one in the Webhook tab.'); return; }
        await Promise.all(targets.map((w) => sendWebhook(w.id, buildCrashAlertPayload(session))));
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    onMounted(async () => {
        await initWebhooks();
        loadVoteKickHistory();
        window.addEventListener('resize', onResize);
        const _savedGroupId = localStorage.getItem('gm-group-id');
        const _startGroupId = (_savedGroupId && allGroups.value.some((g) => g.id === _savedGroupId)) ? _savedGroupId : allGroups.value[0]?.id;
        // Only fetch if data isn't already loaded from another GroupMonitor page this session
        if (_startGroupId && _startGroupId !== selectedGroupId.value) handleGroupChange(_startGroupId);
        startPolling();
        if (monitorCrashEnabled.value) startCrashMonitor();
        startWebhookScheduler();
        // Singleton case: data already loaded, ref is set — render immediately after DOM settles
        nextTick(() => { if (membersView.value === 'overtime') renderMembersChart(); });
    });

    onBeforeUnmount(() => {
        stopPolling();
        stopCrashMonitor();
        stopWebhookScheduler();
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

    // ── members page: filterable chart data & analytics ───────────────────────
    const membersDateFilter = ref(0); // 0=all, 30/90/180/365 days

    const filteredMembersOverTime = computed(() => {
        const src = membersOverTime.value;
        if (!membersDateFilter.value || !src.dates.length) return src;
        const cutoff = dayjs().subtract(membersDateFilter.value, 'day').format('YYYY-MM-DD');
        const startIdx = src.dates.findIndex((d) => d >= cutoff);
        if (startIdx < 0) return { dates: [], joins: [], leaves: [], net: [] };
        const sJoins = src.joins.slice(startIdx);
        const sLeaves = src.leaves.slice(startIdx);
        let running = 0;
        const sNet = sJoins.map((j, i) => { running += j - sLeaves[i]; return Math.max(0, running); });
        return { dates: src.dates.slice(startIdx), joins: sJoins, leaves: sLeaves, net: sNet };
    });

    const membersActivityStats = computed(() => {
        const { dates, joins, leaves, net } = filteredMembersOverTime.value;
        if (!dates.length) return null;
        const totalJ = joins.reduce((s, v) => s + v, 0);
        const totalL = leaves.reduce((s, v) => s + v, 0);
        const days = dates.length || 1;
        const peakJoinIdx = joins.indexOf(Math.max(...joins));
        const peakLeaveIdx = leaves.indexOf(Math.max(...leaves));
        const dowJ = [0,0,0,0,0,0,0], dowL = [0,0,0,0,0,0,0], dowN = [0,0,0,0,0,0,0];
        for (let i = 0; i < dates.length; i++) {
            const d = new Date(dates[i]).getDay();
            dowJ[d] += joins[i]; dowL[d] += leaves[i]; dowN[d]++;
        }
        const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const byDow = DOW.map((label, i) => ({
            label, joins: dowJ[i], leaves: dowL[i], net: dowJ[i] - dowL[i],
            avgJoins: dowN[i] > 0 ? (dowJ[i] / dowN[i]).toFixed(1) : '0.0'
        }));
        const moMap = new Map();
        for (let i = 0; i < dates.length; i++) {
            const mo = dates[i].slice(0, 7);
            if (!moMap.has(mo)) moMap.set(mo, { joins: 0, leaves: 0 });
            moMap.get(mo).joins += joins[i];
            moMap.get(mo).leaves += leaves[i];
        }
        const byMonth = [...moMap.entries()].sort(([a], [b]) => b.localeCompare(a))
            .map(([month, v]) => ({ month, joins: v.joins, leaves: v.leaves, net: v.joins - v.leaves }));
        return {
            totalJoins: totalJ, totalLeaves: totalL,
            netChange: net.at(-1) ?? 0, days,
            avgJoinsPerDay: (totalJ / days).toFixed(1),
            avgLeavesPerDay: (totalL / days).toFixed(1),
            avgJoinsPerWeek: ((totalJ / days) * 7).toFixed(1),
            avgLeavesPerWeek: ((totalL / days) * 7).toFixed(1),
            peakJoinDay: dates[peakJoinIdx] ?? null, peakJoinCount: joins[peakJoinIdx] ?? 0,
            peakLeaveDay: dates[peakLeaveIdx] ?? null, peakLeaveCount: leaves[peakLeaveIdx] ?? 0,
            retentionRate: totalJ > 0 ? Math.max(0, Math.round(((totalJ - totalL) / totalJ) * 100)) : 0,
            churnRate: totalJ > 0 ? Math.round((totalL / totalJ) * 100) : 0,
            byDow, byMonth
        };
    });

    watch(membersDateFilter, async () => {
        if (membersView.value === 'overtime') { await nextTick(); renderMembersChart(); }
    });

    // Fresh-load case: chart div is inside v-else, so membersChartRef is null until data arrives.
    // Fire renderMembersChart the moment the ref element mounts.
    watch(membersChartRef, (el) => {
        if (el && membersView.value === 'overtime') nextTick(renderMembersChart);
    });

    const bestTimeToInvite = computed(() => {
        const inviteTypes = new Set(['group.invite.create', 'group.invite.send']);
        const joinTypes  = new Set(['group.member.join', 'group.invite.accept']);
        const invites = auditLogs.value.filter((r) => inviteTypes.has(r.eventType));
        const joins   = auditLogs.value.filter((r) => joinTypes.has(r.eventType));

        if (invites.length < 10) return null; // not enough data

        const joinTimeById = new Map();
        for (const j of joins) {
            if (!j.targetId) continue;
            if (!joinTimeById.has(j.targetId)) joinTimeById.set(j.targetId, []);
            joinTimeById.get(j.targetId).push(j.created_at);
        }

        const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const DOW_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const dowData   = Array.from({ length: 7 },  (_, i) => ({ label: DOW_LABELS[i], short: DOW_SHORT[i], invites: 0, converts: 0 }));
        const hourData  = Array.from({ length: 24 }, (_,  i) => ({ hour: i, invites: 0, converts: 0 }));
        const monthData = Array.from({ length: 12 }, (_, i) => ({ label: MONTH_LABELS[i], invites: 0, converts: 0 }));

        for (const inv of invites) {
            const d = new Date(inv.created_at);
            const converted = inv.targetId && joinTimeById.has(inv.targetId)
                && joinTimeById.get(inv.targetId).some((t) => t >= inv.created_at);
            const dow = d.getDay(), hour = d.getHours(), mo = d.getMonth();
            dowData[dow].invites++;   if (converted) dowData[dow].converts++;
            hourData[hour].invites++; if (converted) hourData[hour].converts++;
            monthData[mo].invites++;  if (converted) monthData[mo].converts++;
        }

        const addRate = (arr) => arr.map((r) => ({ ...r, rate: r.invites > 0 ? Math.round(r.converts / r.invites * 100) : 0 }));
        const byDow   = addRate(dowData);
        const byHour  = addRate(hourData);
        const byMonth = addRate(monthData);

        const SLOTS = [
            { label: 'Morning',   short: '6 am – 12 pm', range: [6, 12]  },
            { label: 'Afternoon', short: '12 pm – 6 pm',  range: [12, 18] },
            { label: 'Evening',   short: '6 pm – 12 am',  range: [18, 24] },
            { label: 'Night',     short: '12 am – 6 am',  range: [0, 6]   },
        ];
        const bySlot = SLOTS.map((s) => {
            const hrs = byHour.filter((h) => h.hour >= s.range[0] && h.hour < s.range[1]);
            const inv = hrs.reduce((t, h) => t + h.invites, 0);
            const con = hrs.reduce((t, h) => t + h.converts, 0);
            return { ...s, invites: inv, converts: con, rate: inv > 0 ? Math.round(con / inv * 100) : 0 };
        });

        const MIN = 5;
        const best = (arr) => [...arr].filter((r) => r.invites >= MIN).sort((a, b) => b.rate - a.rate)[0] ?? null;

        return {
            totalInvites: invites.length,
            byDow, byHour, byMonth, bySlot,
            bestDow:   best(byDow),
            bestSlot:  best(bySlot),
            bestMonth: best(byMonth),
        };
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

            <!-- ── Group Members ── -->
            <div class="space-y-4">
                    <!-- live member stat cards -->
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div class="rounded-lg border bg-card px-4 py-3 flex flex-col gap-0.5">
                            <div class="text-xs text-muted-foreground">Current Members</div>
                            <div class="text-2xl font-bold tabular-nums">{{ selectedGroup?.memberCount?.toLocaleString() ?? '—' }}</div>
                            <div class="text-xs text-muted-foreground/60">live from VRChat</div>
                        </div>
                        <div class="rounded-lg border bg-card px-4 py-3 flex flex-col gap-0.5">
                            <div class="text-xs text-muted-foreground">Online Now</div>
                            <div class="text-2xl font-bold tabular-nums text-emerald-500">{{ selectedGroup?.onlineMemberCount?.toLocaleString() ?? '—' }}</div>
                            <div class="text-xs text-muted-foreground/60">currently in VRChat</div>
                        </div>
                        <div class="rounded-lg border bg-card px-4 py-3 flex flex-col gap-0.5">
                            <div class="text-xs text-muted-foreground">Recorded Joins</div>
                            <div class="text-2xl font-bold tabular-nums text-emerald-500">{{ membersOverTime.joins.reduce((s,v)=>s+v,0).toLocaleString() }}</div>
                            <div class="text-xs text-muted-foreground/60">from audit log history</div>
                        </div>
                        <div class="rounded-lg border bg-card px-4 py-3 flex flex-col gap-0.5">
                            <div class="text-xs text-muted-foreground">Recorded Leaves</div>
                            <div class="text-2xl font-bold tabular-nums text-red-500">{{ membersOverTime.leaves.reduce((s,v)=>s+v,0).toLocaleString() }}</div>
                            <div class="text-xs text-muted-foreground/60">left, removed or banned</div>
                        </div>
                    </div>

                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Members &amp; Invites</p>
                            <p class="text-xs text-muted-foreground">Invite performance and member growth from audit log history.</p>
                        </div>
                        <Button variant="outline" size="sm" class="h-8" @click="exportCsv(inviteLeaderboard, 'invite-leaderboard.csv')">
                            <Download class="size-3.5 mr-1" />Export
                        </Button>
                    </div>

                    <!-- view switcher -->
                    <div class="flex gap-1 border rounded-lg p-1 w-fit">
                        <button v-for="tab in [{ v: 'overtime', icon: TrendingUp, label: 'Group Members' }, { v: 'leaderboard', icon: Trophy, label: 'Invite Leaderboard' }, { v: 'analysis', icon: Activity, label: 'Deep Analysis' }]"
                            :key="tab.v"
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            :class="membersView === tab.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'"
                            @click="membersView = tab.v; tab.v === 'overtime' && $nextTick(renderMembersChart)">
                            <component :is="tab.icon" class="size-3.5" />{{ tab.label }}
                        </button>
                    </div>

                    <!-- INVITE LEADERBOARD -->
                    <div v-if="membersView === 'leaderboard'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Send class="size-3.5 text-blue-500" />
                                Top Inviters — Join Conversion Rate
                            </span>
                            <span class="text-xs text-muted-foreground">{{ inviteLeaderboard.length }} inviters</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortInviteCol, sortInviteDir, 'actor')">
                                        <span class="flex items-center gap-1">Inviter <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortInviteCol, sortInviteDir, 'invites')">
                                        <span class="flex items-center gap-1">Invites Sent <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortInviteCol, sortInviteDir, 'converts')">
                                        <span class="flex items-center gap-1">Joined <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortInviteCol, sortInviteDir, 'rate')">
                                        <span class="flex items-center gap-1">Join Rate <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Invite</th>
                                    <th class="px-3 py-2 w-8"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="auditLogs.length === 0">
                                    <td colspan="7" class="text-center py-10 text-muted-foreground text-sm">No audit log data loaded yet.</td>
                                </tr>
                                <tr v-else-if="inviteLeaderboard.length === 0">
                                    <td colspan="7" class="text-center py-10 text-muted-foreground text-sm">No invite events found in the audit log.</td>
                                </tr>
                                <template v-else>
                                    <template v-for="(row, i) in inviteLeaderboard" :key="row.actor">
                                        <tr class="border-b hover:bg-muted/30 transition-colors" :class="{ 'bg-muted/20': expandedInviter === row.actor }">
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                                                <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                                <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                                <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                                <span v-else class="font-bold">{{ i + 1 }}</span>
                                            </td>
                                            <td class="px-3 py-2.5 font-medium">
                                                <button v-if="row.actorId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.actorId)">
                                                    {{ row.actor }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                                </button>
                                                <span v-else>{{ row.actor }}</span>
                                            </td>
                                            <td class="px-3 py-2.5">
                                                <Badge variant="outline" class="text-xs tabular-nums">{{ row.invites }}</Badge>
                                            </td>
                                            <td class="px-3 py-2.5">
                                                <Badge variant="outline" class="text-xs tabular-nums bg-emerald-500/10 text-emerald-600 border-emerald-500/30">{{ row.converts }}</Badge>
                                            </td>
                                            <td class="px-3 py-2.5">
                                                <div class="flex items-center gap-2">
                                                    <div class="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                                                        <div class="h-full rounded-full transition-all"
                                                            :class="row.rate >= 50 ? 'bg-emerald-500' : row.rate >= 25 ? 'bg-amber-500' : 'bg-red-500'"
                                                            :style="{ width: row.rate + '%' }" />
                                                    </div>
                                                    <span class="text-xs tabular-nums font-medium"
                                                        :class="row.rate >= 50 ? 'text-emerald-500' : row.rate >= 25 ? 'text-amber-500' : 'text-red-500'">
                                                        {{ row.rate }}%
                                                    </span>
                                                </div>
                                            </td>
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDateShort(row.lastAt) }}</td>
                                            <td class="px-3 py-2.5">
                                                <button class="text-muted-foreground hover:text-foreground transition-colors" @click="expandedInviter = expandedInviter === row.actor ? null : row.actor">
                                                    <ChevronRight class="size-3.5 transition-transform" :class="{ 'rotate-90': expandedInviter === row.actor }" />
                                                </button>
                                            </td>
                                        </tr>
                                        <!-- expanded invitee history -->
                                        <tr v-if="expandedInviter === row.actor">
                                            <td colspan="7" class="bg-muted/10 border-b px-6 py-3">
                                                <div class="text-xs font-medium text-muted-foreground mb-2">Invitees sent by {{ row.actor }}</div>
                                                <div class="space-y-1 max-h-52 overflow-y-auto">
                                                    <div v-for="(inv, ii) in row.invitees.slice().sort((a,b) => b.at.localeCompare(a.at))" :key="ii"
                                                        class="flex items-center gap-3 py-0.5">
                                                        <span class="size-2 rounded-full shrink-0" :class="inv.converted ? 'bg-emerald-500' : 'bg-muted-foreground/30'" />
                                                        <button v-if="inv.id" class="text-xs hover:underline" @click="openProfileById(inv.id)">{{ inv.name }}</button>
                                                        <span v-else class="text-xs">{{ inv.name }}</span>
                                                        <span class="text-xs text-muted-foreground ml-auto tabular-nums">{{ fmtDate(inv.at) }}</span>
                                                        <Badge variant="outline" :class="inv.converted ? 'text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'text-xs text-muted-foreground'">
                                                            {{ inv.converted ? 'Joined ✓' : 'No join' }}
                                                        </Badge>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </template>
                                </template>
                            </tbody>
                        </table>
                    </div>

                    <!-- GROUP MEMBERS (over time chart + analytics) -->
                    <div v-if="membersView === 'overtime'" class="space-y-4">

                        <!-- chart card with date filter -->
                        <div class="rounded-lg border bg-card p-4 space-y-3">
                            <div class="flex items-center justify-between flex-wrap gap-2">
                                <div>
                                    <div class="text-xs font-medium text-muted-foreground">Member Activity Over Time</div>
                                    <p class="text-xs text-muted-foreground/60 mt-0.5">Joins, leaves/bans, and cumulative net from audit log events.</p>
                                </div>
                                <div class="flex gap-1">
                                    <button v-for="opt in [{ v: 30, l: '30d' }, { v: 90, l: '90d' }, { v: 180, l: '6mo' }, { v: 365, l: '1yr' }, { v: 0, l: 'All' }]"
                                        :key="opt.v"
                                        @click="membersDateFilter = opt.v; $nextTick(renderMembersChart)"
                                        class="px-2.5 py-1 text-xs rounded-md font-medium transition-colors"
                                        :class="membersDateFilter === opt.v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'">
                                        {{ opt.l }}
                                    </button>
                                </div>
                            </div>
                            <div v-if="filteredMembersOverTime.dates.length === 0" class="flex items-center justify-center h-48 text-muted-foreground text-sm">
                                No join/leave events in this period.
                            </div>
                            <div v-else ref="membersChartRef" style="height: 300px;" />
                        </div>

                        <!-- key stats row -->
                        <div v-if="membersActivityStats" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Joins in period</div>
                                <div class="text-2xl font-bold tabular-nums text-emerald-500">{{ membersActivityStats.totalJoins.toLocaleString() }}</div>
                                <div class="text-xs text-muted-foreground/60 mt-0.5">{{ membersActivityStats.avgJoinsPerDay }}/day · {{ membersActivityStats.avgJoinsPerWeek }}/wk</div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Leaves in period</div>
                                <div class="text-2xl font-bold tabular-nums text-red-500">{{ membersActivityStats.totalLeaves.toLocaleString() }}</div>
                                <div class="text-xs text-muted-foreground/60 mt-0.5">{{ membersActivityStats.avgLeavesPerDay }}/day · {{ membersActivityStats.avgLeavesPerWeek }}/wk</div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Net change</div>
                                <div class="text-2xl font-bold tabular-nums" :class="membersActivityStats.netChange >= 0 ? 'text-emerald-500' : 'text-red-500'">
                                    {{ membersActivityStats.netChange >= 0 ? '+' : '' }}{{ membersActivityStats.netChange }}
                                </div>
                                <div class="text-xs text-muted-foreground/60 mt-0.5">over {{ membersActivityStats.days }} days</div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Retention rate</div>
                                <div class="text-2xl font-bold tabular-nums"
                                    :class="membersActivityStats.retentionRate >= 60 ? 'text-emerald-500' : membersActivityStats.retentionRate >= 40 ? 'text-amber-500' : 'text-red-500'">
                                    {{ membersActivityStats.retentionRate }}%
                                </div>
                                <div class="text-xs text-muted-foreground/60 mt-0.5">churn {{ membersActivityStats.churnRate }}%</div>
                            </div>
                        </div>

                        <!-- peaks row -->
                        <div v-if="membersActivityStats" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div class="rounded-lg border bg-card px-4 py-3 flex items-center justify-between">
                                <div>
                                    <div class="text-xs text-muted-foreground">Peak join day</div>
                                    <div class="text-sm font-semibold mt-0.5">{{ membersActivityStats.peakJoinDay ? fmtDateShort(membersActivityStats.peakJoinDay) : '—' }}</div>
                                </div>
                                <Badge class="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 tabular-nums">+{{ membersActivityStats.peakJoinCount }} joins</Badge>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3 flex items-center justify-between">
                                <div>
                                    <div class="text-xs text-muted-foreground">Peak leave day</div>
                                    <div class="text-sm font-semibold mt-0.5">{{ membersActivityStats.peakLeaveDay ? fmtDateShort(membersActivityStats.peakLeaveDay) : '—' }}</div>
                                </div>
                                <Badge class="bg-red-500/15 text-red-600 border-red-500/30 tabular-nums">−{{ membersActivityStats.peakLeaveCount }} leaves</Badge>
                            </div>
                        </div>

                        <!-- day of week breakdown -->
                        <div v-if="membersActivityStats" class="rounded-lg border bg-card p-4 space-y-3">
                            <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Activity by Day of Week</div>
                            <div class="space-y-2">
                                <div v-for="row in membersActivityStats.byDow" :key="row.label" class="flex items-center gap-3">
                                    <span class="text-xs text-muted-foreground w-8 shrink-0">{{ row.label }}</span>
                                    <div class="flex-1 flex gap-1 h-4 items-center">
                                        <div class="h-3 rounded-sm bg-emerald-500/70 transition-all"
                                            :style="{ width: membersActivityStats.totalJoins > 0 ? Math.max(2, Math.round(row.joins / membersActivityStats.totalJoins * 400)) + 'px' : '2px' }" />
                                        <div class="h-3 rounded-sm bg-red-500/60 transition-all"
                                            :style="{ width: membersActivityStats.totalLeaves > 0 ? Math.max(2, Math.round(row.leaves / membersActivityStats.totalLeaves * 400)) + 'px' : '2px' }" />
                                    </div>
                                    <div class="flex gap-3 text-xs tabular-nums shrink-0">
                                        <span class="text-emerald-500">+{{ row.joins }}</span>
                                        <span class="text-red-500">−{{ row.leaves }}</span>
                                        <span :class="row.net >= 0 ? 'text-emerald-500' : 'text-red-500'" class="w-12 text-right font-medium">
                                            {{ row.net >= 0 ? '+' : '' }}{{ row.net }}
                                        </span>
                                        <span class="text-muted-foreground/60 w-16 text-right">{{ row.avgJoins }}/wk avg</span>
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-4 pt-1 border-t text-xs text-muted-foreground">
                                <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-emerald-500/70 inline-block" />Joins</span>
                                <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-red-500/60 inline-block" />Leaves</span>
                            </div>
                        </div>

                        <!-- month-by-month table -->
                        <div v-if="membersActivityStats && membersActivityStats.byMonth.length > 0" class="rounded-lg border overflow-hidden">
                            <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                                <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Month by Month</span>
                                <span class="text-xs text-muted-foreground">{{ membersActivityStats.byMonth.length }} months</span>
                            </div>
                            <table class="w-full text-sm">
                                <thead class="bg-muted/20 border-b">
                                    <tr>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Month</th>
                                        <th class="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Joins</th>
                                        <th class="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Leaves</th>
                                        <th class="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Net</th>
                                        <th class="px-3 py-2 text-xs font-medium text-muted-foreground w-40">Trend</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="row in membersActivityStats.byMonth" :key="row.month"
                                        class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                        <td class="px-3 py-2 font-medium tabular-nums">{{ row.month }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums text-emerald-500">{{ row.joins }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums text-red-500">{{ row.leaves }}</td>
                                        <td class="px-3 py-2 text-right tabular-nums font-medium"
                                            :class="row.net >= 0 ? 'text-emerald-500' : 'text-red-500'">
                                            {{ row.net >= 0 ? '+' : '' }}{{ row.net }}
                                        </td>
                                        <td class="px-3 py-2">
                                            <div class="flex gap-1 h-3">
                                                <div class="h-full rounded-sm bg-emerald-500/60"
                                                    :style="{ width: membersActivityStats.totalJoins > 0 ? Math.max(2, Math.round(row.joins / Math.max(...membersActivityStats.byMonth.map(r=>r.joins)) * 80)) + 'px' : '2px' }" />
                                                <div class="h-full rounded-sm bg-red-500/50"
                                                    :style="{ width: membersActivityStats.totalLeaves > 0 ? Math.max(2, Math.round(row.leaves / Math.max(...membersActivityStats.byMonth.map(r=>r.leaves)) * 80)) + 'px' : '2px' }" />
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- DEEP ANALYSIS -->
                    <div v-if="membersView === 'analysis'" class="space-y-4">
                        <!-- headline stats -->
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Total Invites Sent</div>
                                <div class="text-2xl font-bold">{{ inviteStats.totalInvites }}</div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Confirmed Joins</div>
                                <div class="text-2xl font-bold text-emerald-500">{{ inviteStats.totalJoined }}</div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Overall Join Rate</div>
                                <div class="text-2xl font-bold" :class="inviteStats.overallRate >= 50 ? 'text-emerald-500' : inviteStats.overallRate >= 25 ? 'text-amber-500' : 'text-red-500'">
                                    {{ inviteStats.overallRate }}%
                                </div>
                            </div>
                            <div class="rounded-lg border bg-card px-4 py-3">
                                <div class="text-xs text-muted-foreground">Unique Inviters</div>
                                <div class="text-2xl font-bold">{{ inviteStats.totalInviters }}</div>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <!-- top performers -->
                            <div class="rounded-lg border bg-card p-4 space-y-3">
                                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Top Performers</div>
                                <div class="space-y-2">
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-muted-foreground">Most invites sent</span>
                                        <div class="flex items-center gap-2">
                                            <span class="text-sm font-medium">{{ inviteStats.topByVolume?.actor ?? '—' }}</span>
                                            <Badge variant="outline" class="text-xs">{{ inviteStats.topByVolume?.invites ?? 0 }} invites</Badge>
                                        </div>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-muted-foreground">Best conversion (≥3 invites)</span>
                                        <div class="flex items-center gap-2">
                                            <span class="text-sm font-medium">{{ inviteStats.topByRate?.actor ?? '—' }}</span>
                                            <Badge variant="outline" class="text-xs text-emerald-600 bg-emerald-500/10 border-emerald-500/30">{{ inviteStats.topByRate?.rate ?? 0 }}%</Badge>
                                        </div>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-muted-foreground">Avg invites per person</span>
                                        <span class="text-sm font-medium">{{ inviteStats.avgInvites }}</span>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-muted-foreground">Invites that never converted</span>
                                        <Badge variant="outline" class="text-xs text-red-500 bg-red-500/10 border-red-500/30">{{ inviteStats.neverConverted }}</Badge>
                                    </div>
                                </div>
                            </div>

                            <!-- conversion breakdown -->
                            <div class="rounded-lg border bg-card p-4 space-y-3">
                                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Conversion Rate Distribution</div>
                                <div class="space-y-2">
                                    <div v-for="(bucket, label) in inviteStats.convBuckets" :key="label" class="flex items-center gap-2">
                                        <span class="text-xs text-muted-foreground w-20 shrink-0">{{ label }}</span>
                                        <div class="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                                            <div class="h-full rounded-full bg-primary/60 transition-all"
                                                :style="{ width: inviteStats.totalInviters > 0 ? (bucket / inviteStats.totalInviters * 100) + '%' : '0%' }" />
                                        </div>
                                        <span class="text-xs tabular-nums w-8 text-right">{{ bucket }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- best time to invite -->
                        <div v-if="bestTimeToInvite" class="space-y-3">
                            <div class="text-sm font-medium flex items-center gap-2">
                                <Clock class="size-4 text-primary" />
                                Best Time to Invite
                            </div>
                            <p class="text-xs text-muted-foreground -mt-1">Based on {{ bestTimeToInvite.totalInvites.toLocaleString() }} recorded invite events and their confirmed join conversions.</p>

                            <!-- summary pills -->
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div class="rounded-lg border bg-card p-3 space-y-1">
                                    <div class="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Best Day</div>
                                    <div class="text-lg font-bold">{{ bestTimeToInvite.bestDow?.label ?? '—' }}</div>
                                    <div class="text-xs text-muted-foreground">
                                        {{ bestTimeToInvite.bestDow?.converts ?? 0 }} joins from {{ bestTimeToInvite.bestDow?.invites ?? 0 }} invites
                                        <span class="ml-1 text-emerald-500 font-medium">({{ bestTimeToInvite.bestDow?.rate ?? 0 }}%)</span>
                                    </div>
                                </div>
                                <div class="rounded-lg border bg-card p-3 space-y-1">
                                    <div class="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Best Time Slot</div>
                                    <div class="text-lg font-bold">{{ bestTimeToInvite.bestSlot?.label ?? '—' }}</div>
                                    <div class="text-xs text-muted-foreground">
                                        {{ bestTimeToInvite.bestSlot?.short }}
                                        <span class="ml-1 text-emerald-500 font-medium">({{ bestTimeToInvite.bestSlot?.rate ?? 0 }}%)</span>
                                    </div>
                                </div>
                                <div class="rounded-lg border bg-card p-3 space-y-1">
                                    <div class="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Best Month</div>
                                    <div class="text-lg font-bold">{{ bestTimeToInvite.bestMonth?.label ?? '—' }}</div>
                                    <div class="text-xs text-muted-foreground">
                                        {{ bestTimeToInvite.bestMonth?.converts ?? 0 }} joins from {{ bestTimeToInvite.bestMonth?.invites ?? 0 }} invites
                                        <span class="ml-1 text-emerald-500 font-medium">({{ bestTimeToInvite.bestMonth?.rate ?? 0 }}%)</span>
                                    </div>
                                </div>
                            </div>

                            <!-- day of week heatmap -->
                            <div class="rounded-lg border bg-card p-4 space-y-3">
                                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Conversion Rate by Day of Week</div>
                                <div class="space-y-2">
                                    <div v-for="row in bestTimeToInvite.byDow" :key="row.label" class="flex items-center gap-3">
                                        <span class="text-xs text-muted-foreground w-8 shrink-0">{{ row.short }}</span>
                                        <div class="flex-1 h-5 rounded bg-muted overflow-hidden relative">
                                            <div class="h-full rounded transition-all"
                                                :class="row.rate >= 50 ? 'bg-emerald-500' : row.rate >= 30 ? 'bg-amber-500' : row.rate > 0 ? 'bg-red-400' : 'bg-muted'"
                                                :style="{ width: row.rate + '%' }" />
                                        </div>
                                        <div class="flex gap-2 text-xs tabular-nums shrink-0 w-48 justify-end">
                                            <span class="text-muted-foreground">{{ row.invites }} invites</span>
                                            <span class="text-emerald-500">{{ row.converts }} joined</span>
                                            <span class="font-semibold w-10 text-right"
                                                :class="row.rate >= 50 ? 'text-emerald-500' : row.rate >= 30 ? 'text-amber-500' : 'text-muted-foreground'">
                                                {{ row.invites > 0 ? row.rate + '%' : '—' }}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- time-of-day slots -->
                            <div class="rounded-lg border bg-card p-4 space-y-3">
                                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Conversion Rate by Time of Day</div>
                                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                    <div v-for="slot in bestTimeToInvite.bySlot" :key="slot.label"
                                        class="rounded-lg border p-3 space-y-1"
                                        :class="bestTimeToInvite.bestSlot?.label === slot.label ? 'border-emerald-500/40 bg-emerald-500/5' : 'bg-muted/20'">
                                        <div class="text-xs font-semibold">{{ slot.label }}</div>
                                        <div class="text-xs text-muted-foreground">{{ slot.short }}</div>
                                        <div class="text-xl font-bold"
                                            :class="slot.rate >= 50 ? 'text-emerald-500' : slot.rate >= 30 ? 'text-amber-500' : slot.rate > 0 ? 'text-red-400' : 'text-muted-foreground'">
                                            {{ slot.invites > 0 ? slot.rate + '%' : '—' }}
                                        </div>
                                        <div class="text-xs text-muted-foreground">{{ slot.converts }}/{{ slot.invites }}</div>
                                    </div>
                                </div>
                            </div>

                            <!-- month of year heatmap -->
                            <div class="rounded-lg border bg-card p-4 space-y-3">
                                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Conversion Rate by Month</div>
                                <div class="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
                                    <div v-for="mo in bestTimeToInvite.byMonth" :key="mo.label"
                                        class="flex flex-col items-center gap-1 p-1.5 rounded border text-center"
                                        :class="bestTimeToInvite.bestMonth?.label === mo.label ? 'border-emerald-500/40 bg-emerald-500/5' : 'bg-muted/20 border-transparent'">
                                        <span class="text-xs text-muted-foreground">{{ mo.label }}</span>
                                        <span class="text-sm font-bold"
                                            :class="mo.rate >= 50 ? 'text-emerald-500' : mo.rate >= 30 ? 'text-amber-500' : mo.invites > 0 ? 'text-red-400' : 'text-muted-foreground/30'">
                                            {{ mo.invites > 0 ? mo.rate + '%' : '—' }}
                                        </span>
                                        <span class="text-xs text-muted-foreground/60">{{ mo.invites }}inv</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- not enough data notice -->
                        <div v-else class="rounded-lg border border-dashed bg-muted/10 p-6 text-center text-sm text-muted-foreground">
                            Not enough invite data yet to calculate best invite times. Need at least 10 recorded invite events.
                        </div>

                    </div>

            </div>
        </template>
    </div>
</template>
