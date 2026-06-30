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
    } = useGroupMonitorData();

    const groupStore = useGroupStore();
    const _route = useRoute();

    // ── group selector ───────────────────────────────────────────────────────
    const groups = computed(() => Array.from(groupStore.currentUserGroups.values()));
    const selectedGroup = computed(() => groups.value.find((g) => g.id === selectedGroupId.value) ?? null);

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
    const sortWarnCol = ref('count');
    const sortWarnDir = ref('desc');
    const sortWarnedCol = ref('count');
    const sortWarnedDir = ref('desc');
    const warnView = ref('warners'); // 'warners' | 'warned'

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
    const membersView = ref('leaderboard'); // 'leaderboard' | 'overtime' | 'analysis'
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

    const warnLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.instance.warn' && (!cutoff || r.created_at >= cutoff)
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
        return sortRows(Array.from(map.values()), sortWarnCol.value, sortWarnDir.value);
    });

    const warnedLeaderboard = computed(() => {
        const cutoff = cutoffDate(auditDateDays.value);
        const rows = auditLogs.value.filter((r) =>
            r.eventType === 'group.instance.warn' && (!cutoff || r.created_at >= cutoff)
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
        return sortRows(Array.from(map.values()), sortWarnedCol.value, sortWarnedDir.value);
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

    // ── webhook service ───────────────────────────────────────────────────────
    const WEBHOOK_STORAGE_KEY = 'gm-webhooks-v1';
    const WEBHOOK_TYPE_LABELS = {
        'kick-board': 'Top Kickers',
        'most-kicked': 'Most Kicked',
        'ban-board': 'Top Banners',
        'most-banned': 'Most Banned',
        'snitch-report': 'Top Snitches',
        'vk-targets': 'Most Vote-Kicked',
        'crash-alert': 'Crash Alerts',
        'invite-board': 'Top Inviters'
    };

    function loadWebhookConfigs() {
        try { const raw = localStorage.getItem(WEBHOOK_STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
    }
    function saveWebhookConfigsFn(configs) {
        try { localStorage.setItem(WEBHOOK_STORAGE_KEY, JSON.stringify(configs)); } catch { /* quota */ }
    }

    const webhookConfigs = ref(loadWebhookConfigs());
    const webhookSendingIds = ref(new Set());
    const webhookStatus = ref({});
    const webhookLastSent = ref(JSON.parse(localStorage.getItem('gm-webhook-lastsent') ?? '{}'));
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

    function saveLastSent() {
        try { localStorage.setItem('gm-webhook-lastsent', JSON.stringify(webhookLastSent.value)); } catch { /* quota */ }
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
            saveLastSent();
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
        saveWebhookConfigsFn(webhookConfigs.value);
        webhookNewUrl.value = '';
        webhookNewName.value = '';
        webhookNewInterval.value = 0;
    }

    function updateWebhookInterval(id, minutes) {
        webhookConfigs.value = webhookConfigs.value.map((w) =>
            w.id === id ? { ...w, intervalMinutes: Number(minutes) || 0 } : w
        );
        saveWebhookConfigsFn(webhookConfigs.value);
    }

    function updateWebhookColor(id, color) {
        webhookConfigs.value = webhookConfigs.value.map((w) =>
            w.id === id ? { ...w, color } : w
        );
        saveWebhookConfigsFn(webhookConfigs.value);
    }

    function removeWebhook(id) {
        webhookConfigs.value = webhookConfigs.value.filter((w) => w.id !== id);
        saveWebhookConfigsFn(webhookConfigs.value);
        const s = { ...webhookStatus.value };
        delete s[id];
        webhookStatus.value = s;
    }

    function toggleWebhook(id) {
        webhookConfigs.value = webhookConfigs.value.map((w) => w.id === id ? { ...w, enabled: !w.enabled } : w);
        saveWebhookConfigsFn(webhookConfigs.value);
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
        const leaderboardTypes = ['kick-board', 'most-kicked', 'ban-board', 'most-banned', 'snitch-report', 'vk-targets', 'invite-board'];
        if (leaderboardTypes.includes(type)) return () => buildLeaderboardPayload(type, configId);
        return null;
    }

    async function sendCrashToAllWebhooks(session) {
        const targets = webhookConfigs.value.filter((w) => w.enabled && w.type === 'crash-alert');
        if (!targets.length) { toast.warning('No crash-alert webhooks configured. Add one in the Webhook tab.'); return; }
        await Promise.all(targets.map((w) => sendWebhook(w.id, buildCrashAlertPayload(session))));
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    onMounted(() => {
        loadVoteKickHistory();
        window.addEventListener('resize', onResize);
        const _savedGroupId = localStorage.getItem('gm-group-id');
        const _startGroupId = (_savedGroupId && groups.value.some((g) => g.id === _savedGroupId)) ? _savedGroupId : groups.value[0]?.id;
        // Only fetch if data isn't already loaded from another GroupMonitor page this session
        if (_startGroupId && _startGroupId !== selectedGroupId.value) handleGroupChange(_startGroupId);
        startPolling();
        if (monitorCrashEnabled.value) startCrashMonitor();
        startWebhookScheduler();
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
                        <SelectItem v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</SelectItem>
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

            <!-- ── tabs ── -->
            <Tabs v-model="activeTab" class="w-full">
                <TabsList class="mb-4">
                    <TabsTrigger value="kicks"><TrendingUp class="size-3.5 mr-1.5" />Instance Kicks</TabsTrigger>
                    <TabsTrigger value="bans"><UserX class="size-3.5 mr-1.5" />Ban Board</TabsTrigger>
                    <TabsTrigger value="warns"><AlertTriangle class="size-3.5 mr-1.5" />Instance Warns</TabsTrigger>
                    <TabsTrigger value="votekick"><Gavel class="size-3.5 mr-1.5" />Vote-to-Kick</TabsTrigger>
                    <TabsTrigger value="worlds"><Globe class="size-3.5 mr-1.5" />Top Worlds</TabsTrigger>
                </TabsList>

                <!-- ══ BAN BOARD ══ -->
                <TabsContent value="bans" class="space-y-3">
                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Ban Board</p>
                            <p class="text-xs text-muted-foreground">Based on group audit log ban events — tracks who issues the most bans and who gets banned the most.</p>
                        </div>
                        <div class="flex gap-2">
                            <Button variant="outline" size="sm" class="h-8" @click="exportCsv(banView === 'banners' ? banLeaderboard : bannedLeaderboard, banView === 'banners' ? 'top-banners.csv' : 'most-banned.csv')">
                                <Download class="size-3.5 mr-1" />Export
                            </Button>
                        </div>
                    </div>

                    <!-- view switcher -->
                    <div class="flex gap-1 border rounded-lg p-1 w-fit">
                        <button v-for="tab in [{ v: 'banners', icon: Shield, label: 'Top Banners' }, { v: 'banned', icon: UserX, label: 'Most Banned' }]"
                            :key="tab.v"
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            :class="banView === tab.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'"
                            @click="banView = tab.v">
                            <component :is="tab.icon" class="size-3.5" />{{ tab.label }}
                        </button>
                    </div>

                    <!-- TOP BANNERS -->
                    <div v-if="banView === 'banners'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Shield class="size-3.5 text-destructive" />Top Banners — Who Issues the Most Bans
                            </span>
                            <span class="text-xs text-muted-foreground">{{ banLeaderboard.length }} actors</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortBanCol, sortBanDir, 'actor')">
                                        <span class="flex items-center gap-1">Moderator <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortBanCol, sortBanDir, 'count')">
                                        <span class="flex items-center gap-1">Bans <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Target</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="banLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No ban events in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in banLeaderboard" :key="row.actor" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.actorId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.actorId)">{{ row.actor }}</button>
                                        <span v-else>{{ row.actor }}</span>
                                    </td>
                                    <td class="px-3 py-2"><Badge variant="destructive" class="text-xs tabular-nums">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.targets[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.targets[0].id)">{{ row.targets[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.targets[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.targets[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- MOST BANNED -->
                    <div v-if="banView === 'banned'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <UserX class="size-3.5 text-orange-500" />Most Banned — Who Gets Banned the Most
                            </span>
                            <span class="text-xs text-muted-foreground">{{ bannedLeaderboard.length }} players</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortBannedCol, sortBannedDir, 'target')">
                                        <span class="flex items-center gap-1">Player <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortBannedCol, sortBannedDir, 'count')">
                                        <span class="flex items-center gap-1">Times Banned <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Banned By</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Event</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="bannedLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No ban events in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in bannedLeaderboard" :key="row.target" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.targetId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.targetId)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                        <button v-else class="hover:underline cursor-pointer text-left" @click="openProfileByName(row.target)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                    </td>
                                    <td class="px-3 py-2"><Badge variant="outline" class="text-xs tabular-nums">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.actors[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.actors[0].id)">{{ row.actors[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.actors[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.actors[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ INSTANCE WARNS ══ -->
                <TabsContent value="warns" class="space-y-3">
                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Instance Warns</p>
                            <p class="text-xs text-muted-foreground">Based on group audit log warn events — tracks who issues the most warnings and who gets warned the most.</p>
                        </div>
                        <div class="flex gap-2">
                            <Button variant="outline" size="sm" class="h-8" @click="exportCsv(warnView === 'warners' ? warnLeaderboard : warnedLeaderboard, warnView === 'warners' ? 'top-warners.csv' : 'most-warned.csv')">
                                <Download class="size-3.5 mr-1" />Export
                            </Button>
                        </div>
                    </div>

                    <!-- view switcher -->
                    <div class="flex gap-1 border rounded-lg p-1 w-fit">
                        <button v-for="tab in [{ v: 'warners', icon: AlertTriangle, label: 'Most Warns Given' }, { v: 'warned', icon: UserX, label: 'Most Warned' }]"
                            :key="tab.v"
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            :class="warnView === tab.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'"
                            @click="warnView = tab.v">
                            <component :is="tab.icon" class="size-3.5" />{{ tab.label }}
                        </button>
                    </div>

                    <!-- TOP WARNERS -->
                    <div v-if="warnView === 'warners'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <AlertTriangle class="size-3.5 text-yellow-500" />Top Warners — Who Issues the Most Warns
                            </span>
                            <span class="text-xs text-muted-foreground">{{ warnLeaderboard.length }} actors</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWarnCol, sortWarnDir, 'actor')">
                                        <span class="flex items-center gap-1">Moderator <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWarnCol, sortWarnDir, 'count')">
                                        <span class="flex items-center gap-1">Warns <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Target</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="warnLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No warn events in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in warnLeaderboard" :key="row.actor" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.actorId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.actorId)">{{ row.actor }}</button>
                                        <span v-else>{{ row.actor }}</span>
                                    </td>
                                    <td class="px-3 py-2"><Badge class="text-xs tabular-nums bg-yellow-500/20 text-yellow-600 border-yellow-500/30">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.targets[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.targets[0].id)">{{ row.targets[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.targets[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.targets[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- MOST WARNED -->
                    <div v-if="warnView === 'warned'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <UserX class="size-3.5 text-orange-500" />Most Warned — Who Gets Warned the Most
                            </span>
                            <span class="text-xs text-muted-foreground">{{ warnedLeaderboard.length }} players</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWarnedCol, sortWarnedDir, 'target')">
                                        <span class="flex items-center gap-1">Player <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWarnedCol, sortWarnedDir, 'count')">
                                        <span class="flex items-center gap-1">Times Warned <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Warned By</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Event</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="warnedLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No warn events in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in warnedLeaderboard" :key="row.target" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.targetId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.targetId)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                        <button v-else class="hover:underline cursor-pointer text-left" @click="openProfileByName(row.target)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                    </td>
                                    <td class="px-3 py-2"><Badge variant="outline" class="text-xs tabular-nums">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.actors[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.actors[0].id)">{{ row.actors[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.actors[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.actors[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ INSTANCE KICK BOARD ══ -->
                <TabsContent value="kicks" class="space-y-3">
                    <div class="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p class="text-sm font-medium">Instance Kick Board</p>
                            <p class="text-xs text-muted-foreground">Based on group audit log member removals — tracks who kicks and who gets kicked.</p>
                        </div>
                        <div class="flex gap-2">
                            <Button variant="outline" size="sm" class="h-8" @click="exportCsv(kickView === 'kickers' ? kickLeaderboard : kickedLeaderboard, kickView === 'kickers' ? 'top-kickers.csv' : 'most-kicked.csv')">
                                <Download class="size-3.5 mr-1" />Export
                            </Button>
                        </div>
                    </div>

                    <!-- view switcher -->
                    <div class="flex gap-1 border rounded-lg p-1 w-fit">
                        <button v-for="tab in [{ v: 'kickers', icon: Shield, label: 'Top Kickers' }, { v: 'kicked', icon: UserX, label: 'Most Kicked' }]"
                            :key="tab.v"
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            :class="kickView === tab.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'"
                            @click="kickView = tab.v">
                            <component :is="tab.icon" class="size-3.5" />{{ tab.label }}
                        </button>
                    </div>

                    <!-- TOP KICKERS -->
                    <div v-if="kickView === 'kickers'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Shield class="size-3.5 text-destructive" />Top Kickers — Who Removes the Most
                            </span>
                            <span class="text-xs text-muted-foreground">{{ kickLeaderboard.length }} actors</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortKickCol, sortKickDir, 'actor')">
                                        <span class="flex items-center gap-1">Kicker <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortKickCol, sortKickDir, 'count')">
                                        <span class="flex items-center gap-1">Kicks <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Target</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="kickLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No member removals in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in kickLeaderboard" :key="row.actor" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.actorId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.actorId)">{{ row.actor }}</button>
                                        <span v-else>{{ row.actor }}</span>
                                    </td>
                                    <td class="px-3 py-2"><Badge variant="destructive" class="text-xs tabular-nums">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.targets[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.targets[0].id)">{{ row.targets[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.targets[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.targets[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- MOST KICKED -->
                    <div v-if="kickView === 'kicked'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <UserX class="size-3.5 text-orange-500" />Most Kicked — Who Gets Removed the Most
                            </span>
                            <span class="text-xs text-muted-foreground">{{ kickedLeaderboard.length }} players</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortKickedCol, sortKickedDir, 'target')">
                                        <span class="flex items-center gap-1">Player <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortKickedCol, sortKickedDir, 'count')">
                                        <span class="flex items-center gap-1">Times Kicked <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Kicked By</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Event</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="kickedLeaderboard.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No member removals in the loaded audit log.</td></tr>
                                <tr v-for="(row, i) in kickedLeaderboard" :key="row.target" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                                        <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                        <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                        <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                        <span v-else class="font-bold">{{ i + 1 }}</span>
                                    </td>
                                    <td class="px-3 py-2 font-medium">
                                        <button v-if="row.targetId" class="hover:underline cursor-pointer text-left" @click="openProfileById(row.targetId)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                        <button v-else class="hover:underline cursor-pointer text-left" @click="openProfileByName(row.target)">
                                            {{ row.target }}<ExternalLink class="size-3 inline ml-1 opacity-40" />
                                        </button>
                                    </td>
                                    <td class="px-3 py-2"><Badge variant="outline" class="text-xs tabular-nums">{{ row.count }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">
                                        <button v-if="row.actors[0]?.id" class="hover:underline cursor-pointer" @click="openProfileById(row.actors[0].id)">{{ row.actors[0]?.name ?? '—' }}</button>
                                        <span v-else>{{ row.actors[0]?.name ?? '—' }}</span>
                                    </td>
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(row.actors[0]?.at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>

                <!-- ══ VOTE-TO-KICK ══ -->
                <TabsContent value="votekick" class="space-y-4">

                    <!-- stat cards -->
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div class="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5">
                            <Gavel class="size-4 text-orange-500 shrink-0" />
                            <div><div class="text-lg font-bold tabular-nums">{{ vkStats.totalInitiations }}</div><div class="text-xs text-muted-foreground">Votes started</div></div>
                        </div>
                        <div class="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5">
                            <CheckCircle2 class="size-4 text-destructive shrink-0" />
                            <div><div class="text-lg font-bold tabular-nums">{{ vkStats.totalSuccesses }}</div><div class="text-xs text-muted-foreground">Succeeded</div></div>
                        </div>
                        <div class="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5">
                            <Target class="size-4 text-blue-500 shrink-0" />
                            <div><div class="text-lg font-bold tabular-nums">{{ vkStats.uniqueTargets }}</div><div class="text-xs text-muted-foreground">Unique targets</div></div>
                        </div>
                        <div class="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5">
                            <Flame class="size-4 text-yellow-500 shrink-0" />
                            <div>
                                <div class="text-lg font-bold tabular-nums">{{ vkStats.overallSuccessRate }}%</div>
                                <div class="text-xs text-muted-foreground">Success rate</div>
                            </div>
                        </div>
                    </div>

                    <!-- filters row -->
                    <div class="flex items-center gap-2 flex-wrap">
                        <div class="relative flex-1 min-w-44">
                            <Search class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input v-model="vkSearch" placeholder="Filter by name…" class="pl-8 h-8 text-sm" />
                        </div>
                        <Select :model-value="String(vkDateDays)" @update:model-value="(v) => (vkDateDays = Number(v))">
                            <SelectTrigger class="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="30">Last 30 days</SelectItem>
                                <SelectItem value="180">Last 6 months</SelectItem>
                                <SelectItem value="365">Last 12 months</SelectItem>
                                <SelectItem value="0">All time</SelectItem>
                            </SelectContent>
                        </Select>
                        <div class="flex rounded-md border overflow-hidden text-xs">
                            <button
                                v-for="opt in [{ v: 'all', label: 'All' }, { v: 'success', label: 'Succeeded' }, { v: 'failed', label: 'Failed' }]"
                                :key="opt.v"
                                class="px-3 py-1.5 transition-colors"
                                :class="vkSuccessFilter === opt.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
                                @click="vkSuccessFilter = opt.v">
                                {{ opt.label }}
                            </button>
                        </div>
                        <Button variant="outline" size="sm" class="h-8" :disabled="isLoadingVk" @click="loadVoteKickHistory">
                            <RefreshCw :class="{ 'animate-spin': isLoadingVk }" class="size-3.5 mr-1" />Reload
                        </Button>
                        <Button variant="outline" size="sm" class="h-8" @click="exportCsv(vkTargetLeaderboard, 'votekick-leaderboard.csv')">
                            <Download class="size-3.5 mr-1" />Export
                        </Button>
                    </div>

                    <!-- view switcher -->
                    <div class="flex gap-1 border rounded-lg p-1 w-fit">
                        <button v-for="tab in [{ v: 'targets', icon: Trophy, label: 'Most Targeted' }, { v: 'snitches', icon: UserX, label: 'Top Snitches' }, { v: 'logs', icon: ScrollText, label: 'VK Logs' }]"
                            :key="tab.v"
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            :class="vkView === tab.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'"
                            @click="vkView = tab.v">
                            <component :is="tab.icon" class="size-3.5" />{{ tab.label }}
                        </button>
                    </div>

                    <!-- TARGETS TABLE -->
                    <div v-if="vkView === 'targets'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <Trophy class="size-3.5 text-yellow-500" />
                                Most Vote-Kicked Players
                            </span>
                            <span class="text-xs text-muted-foreground">{{ vkTargetLeaderboard.length }} players</span>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortVkCol, sortVkDir, 'name')">
                                        <span class="flex items-center gap-1">Player <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortVkCol, sortVkDir, 'initiated')">
                                        <span class="flex items-center gap-1">Times Targeted <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Event</th>
                                    <th class="px-3 py-2 w-8"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingVk"><td colspan="5" class="text-center py-10 text-muted-foreground"><RefreshCw class="size-4 animate-spin inline mr-2" />Loading game log…</td></tr>
                                <tr v-else-if="vkTargetLeaderboard.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">
                                        No vote-to-kick events in your local game log yet.
                                    </td>
                                </tr>
                                <template v-else>
                                    <template v-for="(row, i) in vkTargetLeaderboard" :key="row.name">
                                        <tr class="border-b hover:bg-muted/30 transition-colors" :class="{ 'bg-muted/20': expandedTarget === row.name }">
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                                                <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                                <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                                <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                                <span v-else class="font-bold">{{ i + 1 }}</span>
                                            </td>
                                            <td class="px-3 py-2.5 font-medium">
                                                <button class="hover:underline cursor-pointer text-left" @click="openProfileByName(row.name)">
                                                    {{ row.name }}
                                                    <ExternalLink class="size-3 inline ml-1 opacity-40" />
                                                </button>
                                            </td>
                                            <td class="px-3 py-2.5">
                                                <Badge variant="outline" class="text-xs tabular-nums">{{ row.initiated }}</Badge>
                                            </td>
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDateShort(row.lastAt) }}</td>
                                            <td class="px-3 py-2.5">
                                                <button class="text-muted-foreground hover:text-foreground transition-colors" @click="expandedTarget = expandedTarget === row.name ? null : row.name">
                                                    <ChevronRight class="size-3.5 transition-transform" :class="{ 'rotate-90': expandedTarget === row.name }" />
                                                </button>
                                            </td>
                                        </tr>
                                        <!-- expanded event history -->
                                        <tr v-if="expandedTarget === row.name">
                                            <td colspan="5" class="bg-muted/10 border-b px-6 py-2">
                                                <div class="text-xs font-medium text-muted-foreground mb-2">All events for {{ row.name }}</div>
                                                <div class="space-y-1 max-h-48 overflow-y-auto">
                                                    <div v-for="(ev, ei) in row.events.slice().sort((a,b) => b.at.localeCompare(a.at))" :key="ei"
                                                        class="flex items-center gap-2 py-0.5">
                                                        <span class="text-xs text-muted-foreground tabular-nums">{{ fmtDate(ev.at) }}</span>
                                                        <span class="text-xs text-muted-foreground">by
                                                            <button class="hover:underline cursor-pointer" @click="openProfileByName(ev.initiator)">{{ ev.initiator }}</button>
                                                        </span>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </template>
                                </template>
                            </tbody>
                        </table>
                    </div>

                    <!-- SNITCHES TABLE -->
                    <div v-if="vkView === 'snitches'" class="rounded-lg border overflow-hidden">
                        <div class="bg-muted/40 border-b px-3 py-2 flex items-center justify-between">
                            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                                <UserX class="size-3.5 text-destructive" />
                                Top Snitches — Who Started the Most Vote-Kicks
                            </span>
                            <div class="flex items-center gap-2">
                                <span class="text-xs text-muted-foreground">{{ vkSnitchLeaderboard.length }} players</span>
                                <Button variant="outline" size="sm" class="h-6 text-xs px-2" @click="exportCsv(vkSnitchLeaderboard, 'top-snitches.csv')">
                                    <Download class="size-3 mr-1" />Export
                                </Button>
                            </div>
                        </div>
                        <table class="w-full text-sm">
                            <thead class="bg-muted/20 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortSnitchCol, sortSnitchDir, 'name')">
                                        <span class="flex items-center gap-1">Player <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortSnitchCol, sortSnitchDir, 'initiated')">
                                        <span class="flex items-center gap-1">Votes Started <ChevronsUpDown class="size-3 opacity-40" /></span>
                                    </th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Vote</th>
                                    <th class="px-3 py-2 w-8"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingVk"><td colspan="5" class="text-center py-10 text-muted-foreground"><RefreshCw class="size-4 animate-spin inline mr-2" />Loading game log…</td></tr>
                                <tr v-else-if="vkSnitchLeaderboard.length === 0">
                                    <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No vote-to-kick events in your local game log yet.</td>
                                </tr>
                                <template v-else>
                                    <template v-for="(row, i) in vkSnitchLeaderboard" :key="row.name">
                                        <tr class="border-b hover:bg-muted/30 transition-colors" :class="{ 'bg-muted/20': expandedTarget === 'snitch-' + row.name }">
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                                                <span v-if="i === 0" class="text-yellow-500">🥇</span>
                                                <span v-else-if="i === 1" class="text-zinc-400">🥈</span>
                                                <span v-else-if="i === 2" class="text-amber-600">🥉</span>
                                                <span v-else class="font-bold">{{ i + 1 }}</span>
                                            </td>
                                            <td class="px-3 py-2.5 font-medium">
                                                <button class="hover:underline cursor-pointer text-left" @click="openProfileByName(row.name)">
                                                    {{ row.name }}
                                                    <ExternalLink class="size-3 inline ml-1 opacity-40" />
                                                </button>
                                            </td>
                                            <td class="px-3 py-2.5">
                                                <Badge variant="outline" class="text-xs tabular-nums">{{ row.initiated }}</Badge>
                                            </td>
                                            <td class="px-3 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDateShort(row.lastAt) }}</td>
                                            <td class="px-3 py-2.5">
                                                <button class="text-muted-foreground hover:text-foreground transition-colors" @click="expandedTarget = expandedTarget === 'snitch-' + row.name ? null : 'snitch-' + row.name">
                                                    <ChevronRight class="size-3.5 transition-transform" :class="{ 'rotate-90': expandedTarget === 'snitch-' + row.name }" />
                                                </button>
                                            </td>
                                        </tr>
                                        <!-- expanded: who they targeted -->
                                        <tr v-if="expandedTarget === 'snitch-' + row.name">
                                            <td colspan="5" class="bg-muted/10 border-b px-6 py-2">
                                                <div class="text-xs font-medium text-muted-foreground mb-2">Votes started by {{ row.name }}</div>
                                                <div class="space-y-1 max-h-48 overflow-y-auto">
                                                    <div v-for="(ev, ei) in row.events.filter(e => e.type === 'initiation').slice().sort((a,b) => b.at.localeCompare(a.at))" :key="ei"
                                                        class="flex items-center gap-2 py-0.5">
                                                        <button class="text-xs hover:underline cursor-pointer" @click="openProfileByName(ev.target)">{{ ev.target }}</button>
                                                        <span class="text-xs text-muted-foreground tabular-nums ml-auto">{{ fmtDate(ev.at) }}</span>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </template>
                                </template>
                            </tbody>
                        </table>
                    </div>

                    <!-- VK LOGS -->
                    <div v-if="vkView === 'logs'" class="space-y-3">
                        <div class="flex items-center justify-between flex-wrap gap-2">
                            <p class="text-sm text-muted-foreground">
                                Vote-to-kick events that happened while you were inside this group's instances.
                                <span class="font-medium text-foreground">{{ groupVkLogs.length }}</span> events found.
                            </p>
                            <Button variant="outline" size="sm" @click="exportCsv(groupVkLogs, 'group-vk-log.csv')">
                                <Download class="size-3.5 mr-1" />Export
                            </Button>
                        </div>
                        <div class="relative">
                            <Search class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input v-model="vkLogSearch" placeholder="Filter by target or initiator name…" class="pl-8 h-8 text-sm" />
                        </div>
                        <div class="rounded-lg border overflow-hidden">
                            <table class="w-full text-sm">
                                <thead class="bg-muted/40 border-b">
                                    <tr>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Time</th>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Target (victim)</th>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Initiator (snitch)</th>
                                        <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">World</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-if="isLoadingVk || isLoadingWorlds">
                                        <td colspan="5" class="text-center py-10 text-muted-foreground">
                                            <RefreshCw class="size-4 animate-spin inline mr-2" />Loading…
                                        </td>
                                    </tr>
                                    <tr v-else-if="!selectedGroupId">
                                        <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">Select a group first.</td>
                                    </tr>
                                    <tr v-else-if="locationHistory.length === 0">
                                        <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No instance history found for this group in your game log.</td>
                                    </tr>
                                    <tr v-else-if="groupVkLogs.length === 0">
                                        <td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No vote-to-kick events found during your sessions in this group's instances.</td>
                                    </tr>
                                    <tr v-for="(ev, i) in groupVkLogs" :key="i" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                        <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{{ fmtDate(ev.at) }}</td>
                                        <td class="px-3 py-2">
                                            <Badge :variant="ev.type === 'success' ? 'destructive' : 'outline'" class="text-xs whitespace-nowrap">
                                                {{ ev.type === 'success' ? '✓ Succeeded' : 'Initiated' }}
                                            </Badge>
                                        </td>
                                        <td class="px-3 py-2 font-medium">
                                            <button class="hover:underline cursor-pointer text-left" @click="openProfileByName(ev.target)">
                                                {{ ev.target }}
                                                <ExternalLink class="size-3 inline ml-1 opacity-40" />
                                            </button>
                                        </td>
                                        <td class="px-3 py-2 text-muted-foreground">
                                            <button v-if="ev.initiator" class="hover:underline cursor-pointer text-left" @click="openProfileByName(ev.initiator)">
                                                {{ ev.initiator }}
                                                <ExternalLink class="size-3 inline ml-1 opacity-40" />
                                            </button>
                                            <span v-else class="text-xs opacity-40">—</span>
                                        </td>
                                        <td class="px-3 py-2 text-xs text-muted-foreground max-w-[180px] truncate" :title="ev.worldName">{{ ev.worldName }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </TabsContent>

                <!-- ══ TOP WORLDS ══ -->
                <TabsContent value="worlds" class="space-y-3">
                    <div class="flex items-center justify-between">
                        <p class="text-sm text-muted-foreground">Instance visits from your local game log where this group was the host.</p>
                        <Button variant="outline" size="sm" @click="exportCsv(topWorlds, 'top-worlds.csv')"><Download class="size-3.5 mr-1" />Export</Button>
                    </div>
                    <div class="rounded-lg border overflow-hidden">
                        <table class="w-full text-sm">
                            <thead class="bg-muted/40 border-b">
                                <tr>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground w-10">#</th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWorldCol, sortWorldDir, 'name')"><span class="flex items-center gap-1">World <ChevronsUpDown class="size-3 opacity-40" /></span></th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWorldCol, sortWorldDir, 'visits')"><span class="flex items-center gap-1">Visits <ChevronsUpDown class="size-3 opacity-40" /></span></th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground" @click="toggleSort(sortWorldCol, sortWorldDir, 'totalTime')"><span class="flex items-center gap-1">Total Time <ChevronsUpDown class="size-3 opacity-40" /></span></th>
                                    <th class="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Avg Session</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="isLoadingWorlds"><td colspan="5" class="text-center py-10 text-muted-foreground"><RefreshCw class="size-4 animate-spin inline mr-2" />Loading…</td></tr>
                                <tr v-else-if="topWorlds.length === 0"><td colspan="5" class="text-center py-10 text-muted-foreground text-sm">No world visit history for this group.</td></tr>
                                <tr v-for="(w, i) in topWorlds" :key="w.name" class="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                    <td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">{{ i + 1 }}</td>
                                    <td class="px-3 py-2 font-medium">{{ w.name }}</td>
                                    <td class="px-3 py-2"><Badge variant="secondary" class="text-xs tabular-nums">{{ w.visits }}</Badge></td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">{{ fmtDuration(w.totalTime) }}</td>
                                    <td class="px-3 py-2 text-sm text-muted-foreground">{{ fmtDuration(w.avgTime) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </TabsContent>
            </Tabs>
        </template>
    </div>
</template>
