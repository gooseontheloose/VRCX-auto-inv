<template>
    <div class="x-container space-y-3">
        <input ref="fileInputRef" type="file" accept=".txt,.log" multiple class="hidden" @change="onFilesSelected" />

        <!-- Header -->
        <div class="flex items-center gap-2 flex-wrap">
            <div class="flex items-center gap-2 flex-1 min-w-0">
                <Bug class="size-5 shrink-0 text-primary" />
                <h2 class="text-base font-semibold">Debug Logs</h2>
            </div>
            <select v-if="files.length > 1" v-model="activeIdx"
                class="h-8 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                <option v-for="(f, i) in files" :key="i" :value="i">{{ f.name }}</option>
            </select>
            <Button variant="outline" size="sm" @click="fileInputRef.click()">
                <FolderOpen class="size-3.5 mr-1.5" />
                {{ files.length ? 'Load More' : 'Open Log File(s)' }}
            </Button>
            <Button v-if="files.length" variant="ghost" size="sm" @click="removeActive">
                <X class="size-3.5" />
            </Button>
        </div>

        <!-- Empty state -->
        <div v-if="!activeFile" class="flex flex-col items-center justify-center py-16 gap-4 text-muted-foreground">
            <Bug class="size-12 opacity-25" />
            <div class="text-center">
                <p class="font-medium">No log file loaded</p>
                <p class="text-sm mt-1">VRChat logs are at:</p>
                <code class="text-xs bg-muted px-2 py-1 rounded mt-1 inline-block select-all">
                    %AppData%\..\LocalLow\VRChat\VRChat
                </code>
            </div>
            <Button @click="fileInputRef.click()">
                <FolderOpen class="size-4 mr-2" />Open Log File(s)
            </Button>
        </div>

        <!-- Loaded -->
        <Tabs v-else v-model="activeTab">
            <TabsList class="h-9">
                <TabsTrigger value="viewer">
                    <ScrollText class="size-3.5 mr-1.5" />
                    Log Viewer
                    <span class="ml-1.5 text-xs text-muted-foreground">
                        ({{ filteredLines.length.toLocaleString() }}/{{ parsedLines.length.toLocaleString() }})
                    </span>
                </TabsTrigger>
                <TabsTrigger value="summary">
                    <BarChart2 class="size-3.5 mr-1.5" />
                    Session Summary
                </TabsTrigger>
            </TabsList>

            <!-- LOG VIEWER -->
            <TabsContent value="viewer" class="space-y-2 mt-2">
                <div class="flex items-center gap-2 flex-wrap">
                    <div class="relative flex-1 min-w-48">
                        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                        <Input v-model="search" class="pl-8 h-8 text-sm" placeholder="Search text, player name, error…" />
                        <button v-if="search" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="search = ''">
                            <X class="size-3.5" />
                        </button>
                    </div>
                    <div class="flex gap-1 border rounded-lg p-0.5">
                        <button v-for="lvl in LEVELS" :key="lvl"
                            class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                            :class="levelFilter === lvl ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
                            @click="levelFilter = lvl">
                            <span v-if="lvl === 'Warning'" class="text-amber-500 mr-0.5">⚠</span>
                            <span v-else-if="lvl === 'Error'" class="text-red-500 mr-0.5">✗</span>
                            {{ lvl }}
                            <span v-if="lvl !== 'All'" class="ml-1 opacity-60">{{ counts[lvl] }}</span>
                        </button>
                    </div>
                    <select v-model="catFilter"
                        class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                        <option value="">All Categories</option>
                        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
                    </select>
                    <Button variant="outline" size="sm" @click="exportFiltered">
                        <Download class="size-3.5 mr-1" />Export
                    </Button>
                    <Button variant="outline" size="sm" title="Save a copy before VRChat deletes it" @click="saveArchive">
                        <Archive class="size-3.5 mr-1" />Archive
                    </Button>
                </div>

                <div ref="logPane" class="font-mono text-xs border rounded-lg bg-muted/20 overflow-auto"
                    style="height: calc(100vh - 270px); min-height: 280px;">
                    <div v-if="!filteredLines.length" class="flex items-center justify-center h-full text-muted-foreground">
                        No lines match
                    </div>
                    <div v-else>
                        <div v-for="l in visibleLines" :key="l.lineNum"
                            class="flex items-start px-3 py-0.5 hover:bg-muted/40 group leading-5"
                            :class="rowBg(l.level)">
                            <span class="select-none text-muted-foreground/40 w-10 shrink-0 text-right mr-3 tabular-nums group-hover:text-muted-foreground">{{ l.lineNum }}</span>
                            <span class="shrink-0 w-16 mr-2 text-right" :class="levelCls(l.level)">{{ l.level }}</span>
                            <span class="text-muted-foreground/70 mr-2 shrink-0 tabular-nums">{{ l.time }}</span>
                            <span class="break-all whitespace-pre-wrap" v-html="hl(l.text)" />
                        </div>
                        <div v-if="limit < filteredLines.length" class="flex flex-col items-center gap-2 py-4 border-t text-sm text-muted-foreground">
                            Showing {{ limit.toLocaleString() }} of {{ filteredLines.length.toLocaleString() }}
                            <Button variant="outline" size="sm" @click="limit += PAGE">
                                Load {{ Math.min(PAGE, filteredLines.length - limit).toLocaleString() }} more
                            </Button>
                        </div>
                    </div>
                </div>
            </TabsContent>

            <!-- SESSION SUMMARY -->
            <TabsContent value="summary" class="mt-2">
                <div v-if="!summary" class="text-sm text-muted-foreground text-center py-8">Nothing to summarize</div>
                <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div class="border rounded-lg p-4 space-y-3">
                        <h3 class="font-semibold flex items-center gap-2"><Info class="size-4 text-primary" /> Session Info</h3>
                        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                            <dt class="text-muted-foreground">File</dt><dd class="font-mono text-xs break-all">{{ activeFile.name }}</dd>
                            <dt class="text-muted-foreground">VRChat Build</dt><dd>{{ summary.build || '—' }}</dd>
                            <dt class="text-muted-foreground">Logged in as</dt><dd class="font-medium">{{ summary.username || '—' }}</dd>
                            <dt class="text-muted-foreground">Start</dt><dd>{{ summary.start || '—' }}</dd>
                            <dt class="text-muted-foreground">End</dt><dd>{{ summary.end || '—' }}</dd>
                            <dt class="text-muted-foreground">Lines</dt><dd>{{ parsedLines.length.toLocaleString() }}</dd>
                            <dt class="text-muted-foreground">Warnings</dt>
                            <dd :class="counts.Warning > 0 ? 'text-amber-500 font-medium' : ''">{{ counts.Warning.toLocaleString() }}</dd>
                            <dt class="text-muted-foreground">Errors</dt>
                            <dd :class="counts.Error > 0 ? 'text-red-500 font-medium' : ''">{{ counts.Error.toLocaleString() }}</dd>
                        </dl>
                    </div>

                    <div class="border rounded-lg p-4 space-y-3">
                        <h3 class="font-semibold flex items-center gap-2">
                            <Globe class="size-4 text-primary" /> World Visits
                            <span class="ml-auto text-xs font-normal text-muted-foreground">{{ summary.worlds.length }}</span>
                        </h3>
                        <div v-if="!summary.worlds.length" class="text-sm text-muted-foreground">None detected</div>
                        <div v-else class="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                            <div v-for="(w, i) in summary.worlds" :key="i" class="flex items-start gap-2 text-sm">
                                <span class="text-muted-foreground tabular-nums text-xs mt-0.5 shrink-0">{{ w.time }}</span>
                                <div class="min-w-0">
                                    <div class="font-medium truncate">{{ w.name }}</div>
                                    <div v-if="w.dur" class="text-xs text-muted-foreground">{{ w.dur }}</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="border rounded-lg p-4 space-y-3">
                        <h3 class="font-semibold flex items-center gap-2">
                            <Users class="size-4 text-primary" /> Player Activity
                            <span class="ml-auto text-xs font-normal text-muted-foreground">{{ summary.uniquePlayers }} unique</span>
                        </h3>
                        <div class="grid grid-cols-2 gap-3 text-sm">
                            <div class="bg-muted/30 rounded-md p-3 text-center">
                                <div class="text-2xl font-bold text-green-500">{{ summary.joins }}</div>
                                <div class="text-xs text-muted-foreground mt-0.5">Joins</div>
                            </div>
                            <div class="bg-muted/30 rounded-md p-3 text-center">
                                <div class="text-2xl font-bold text-red-400">{{ summary.leaves }}</div>
                                <div class="text-xs text-muted-foreground mt-0.5">Leaves</div>
                            </div>
                        </div>
                        <div v-if="summary.players.length" class="space-y-0.5 max-h-40 overflow-y-auto">
                            <div v-for="p in summary.players.slice(0, 60)" :key="p.name"
                                class="flex items-center justify-between text-xs py-0.5">
                                <span class="truncate">{{ p.name }}</span>
                                <span class="text-muted-foreground shrink-0 ml-2">{{ p.n }}×</span>
                            </div>
                        </div>
                    </div>

                    <div class="border rounded-lg p-4 space-y-3">
                        <h3 class="font-semibold flex items-center gap-2">
                            <AlertTriangle class="size-4 text-red-500" /> Notable Events
                        </h3>
                        <div v-if="!summary.notable.length" class="text-sm text-muted-foreground">None</div>
                        <div v-else class="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                            <div v-for="(e, i) in summary.notable" :key="i"
                                class="text-xs border-l-2 pl-2 py-0.5"
                                :class="e.level === 'Error' ? 'border-red-500 text-red-400' : 'border-amber-400 text-amber-400'">
                                <span class="text-muted-foreground mr-1">{{ e.time }}</span>
                                <span class="break-all">{{ e.text.slice(0, 200) }}</span>
                            </div>
                        </div>
                    </div>

                    <div v-if="summary.avatars.length" class="border rounded-lg p-4 space-y-3 lg:col-span-2">
                        <h3 class="font-semibold flex items-center gap-2">
                            <Sparkles class="size-4 text-primary" /> Avatar Activity
                            <span class="ml-auto text-xs font-normal text-muted-foreground">{{ summary.avatars.length }} events</span>
                        </h3>
                        <div class="space-y-0.5 max-h-52 overflow-y-auto">
                            <div v-for="(e, i) in summary.avatars" :key="i" class="flex items-start gap-3 text-xs py-0.5">
                                <span class="text-muted-foreground shrink-0 tabular-nums">{{ e.time }}</span>
                                <span class="text-muted-foreground/70 shrink-0 truncate max-w-36">{{ e.player }}</span>
                                <span>{{ e.detail }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </TabsContent>
        </Tabs>
    </div>
</template>

<script setup>
    import { ref, computed, watch, nextTick } from 'vue';
    import {
        Bug, FolderOpen, X, Search, Download, Archive,
        ScrollText, BarChart2, Info, Globe, Users, AlertTriangle, Sparkles
    } from 'lucide-vue-next';
    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

    const PAGE   = 2000;
    const LEVELS = ['All', 'Debug', 'Warning', 'Error'];
    const LINE_RE = /^(\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) (Debug|Warning|Error|Exception)\s+-\s+(.*)/;
    const NOISE  = /ObservableCast|AmplitudeAPI|SteamVR|Discord:|LOCALIZATION|StyleEngine|GarbageCollect/;

    const fileInputRef = ref(null);
    const logPane      = ref(null);
    const activeTab    = ref('viewer');
    const activeIdx    = ref(0);
    const files        = ref([]); // [{ name, content }]

    const search      = ref('');
    const levelFilter = ref('All');
    const catFilter   = ref('');
    const limit       = ref(PAGE);

    const activeFile = computed(() => files.value[activeIdx.value] ?? null);

    // reset filters when file changes
    watch(activeIdx, () => {
        search.value = '';
        levelFilter.value = 'All';
        catFilter.value = '';
        limit.value = PAGE;
    });

    async function onFilesSelected(e) {
        for (const file of Array.from(e.target.files || [])) {
            const content = await file.text();
            const idx = files.value.findIndex((f) => f.name === file.name);
            if (idx >= 0) {
                files.value[idx] = { name: file.name, content };
                activeIdx.value = idx;
            } else {
                files.value.push({ name: file.name, content });
                activeIdx.value = files.value.length - 1;
            }
        }
        e.target.value = '';
        search.value = '';
        levelFilter.value = 'All';
        catFilter.value = '';
        limit.value = PAGE;
    }

    function removeActive() {
        files.value.splice(activeIdx.value, 1);
        activeIdx.value = Math.max(0, activeIdx.value - 1);
    }

    // ── Parsing ───────────────────────────────────────────────────────────────────
    const parsedLines = computed(() => {
        const content = activeFile.value?.content;
        if (!content) return [];
        const result = [];
        let cur = null, n = 0;
        for (const raw of content.split('\n')) {
            n++;
            const m = raw.match(LINE_RE);
            if (m) {
                if (cur) result.push(cur);
                const lvl  = m[2] === 'Exception' ? 'Error' : m[2];
                const catM = m[3].match(/^\[([^\]]+)\]/);
                cur = { lineNum: n, time: m[1].slice(11), level: lvl, cat: catM?.[1] ?? '', text: m[3] };
            } else if (cur && /^\s+\S/.test(raw)) {
                cur.text += '\n' + raw.trimEnd();
            }
        }
        if (cur) result.push(cur);
        return result;
    });

    const counts = computed(() => {
        const c = { Debug: 0, Warning: 0, Error: 0 };
        for (const l of parsedLines.value) if (l.level in c) c[l.level]++;
        return c;
    });

    const categories = computed(() => {
        const s = new Set();
        for (const l of parsedLines.value) if (l.cat) s.add(l.cat);
        return [...s].sort();
    });

    const filteredLines = computed(() => {
        const s  = search.value.toLowerCase().trim();
        const lv = levelFilter.value;
        const ct = catFilter.value;
        return parsedLines.value.filter((l) => {
            if (lv !== 'All' && l.level !== lv) return false;
            if (ct && l.cat !== ct) return false;
            if (s && !l.text.toLowerCase().includes(s) && !l.time.includes(s)) return false;
            return true;
        });
    });

    const visibleLines = computed(() => filteredLines.value.slice(0, limit.value));

    watch([search, levelFilter, catFilter], () => {
        limit.value = PAGE;
        nextTick(() => { if (logPane.value) logPane.value.scrollTop = 0; });
    });

    // ── Summary ───────────────────────────────────────────────────────────────────
    const summary = computed(() => {
        const lines = parsedLines.value;
        if (!lines.length) return null;

        const build    = first(lines, /VRChat Build: ([^\n]+)/)?.[1] ?? '';
        const username = first(lines, /User Authenticated: (.+?) \(usr_/)?.[1] ?? '';

        const worlds = [];
        for (const l of lines) {
            const m = l.text.match(/\[Behaviour\] Entering Room: (.+)/);
            if (m) worlds.push({ time: l.time, name: m[1].trim() });
        }
        for (let i = 0; i < worlds.length; i++) {
            if (worlds[i + 1]) worlds[i].dur = tdiff(worlds[i].time, worlds[i + 1].time);
        }

        const pc = {};
        let joins = 0, leaves = 0;
        for (const l of lines) {
            const j = l.text.match(/\[Behaviour\] OnPlayerJoined (.+?) \(usr_/);
            if (j) { joins++; const n = j[1].trim(); pc[n] = (pc[n] || 0) + 1; }
            if (l.text.includes('[Behaviour] OnPlayerLeft ')) leaves++;
        }
        const players = Object.entries(pc).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);

        const seen = new Set(), notable = [];
        for (const l of lines) {
            if (l.level !== 'Error' && l.level !== 'Warning') continue;
            if (NOISE.test(l.text)) continue;
            const k = l.text.slice(0, 80);
            if (!seen.has(k)) { seen.add(k); notable.push(l); if (notable.length >= 60) break; }
        }

        const avatars = [];
        for (const l of lines) {
            const la = l.text.match(/\[Behaviour\] Loading avatar for (.+)/);
            if (la) { avatars.push({ time: l.time, player: la[1].trim(), detail: 'loading avatar…' }); continue; }
            const ua = l.text.match(/\[AssetBundleDownloadManager\].*Unpacking Avatar \((.+) by (.+)\)/);
            if (ua) avatars.push({ time: l.time, player: ua[2].trim(), detail: `"${ua[1].trim()}"` });
        }

        return {
            build, username,
            start: lines[0]?.time ?? '', end: lines[lines.length - 1]?.time ?? '',
            worlds, joins, leaves, uniquePlayers: Object.keys(pc).length,
            players, notable, avatars
        };
    });

    function first(lines, re) {
        for (const l of lines) { const m = l.text.match(re); if (m) return m; }
        return null;
    }
    function tdiff(t1, t2) {
        try {
            const s = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
            const d = s(t2) - s(t1);
            if (d <= 0) return null;
            const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), sc = d % 60;
            return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sc}s` : `${sc}s`;
        } catch { return null; }
    }

    // ── Highlight ─────────────────────────────────────────────────────────────────
    function hl(text) {
        const e = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const s = search.value.trim();
        if (!s) return e;
        const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return e.replace(re, (m) => `<mark class="bg-yellow-400/40 text-foreground rounded-sm">${m}</mark>`);
    }

    function rowBg(lvl) {
        if (lvl === 'Error')   return 'bg-red-500/5 hover:bg-red-500/10';
        if (lvl === 'Warning') return 'bg-amber-500/5 hover:bg-amber-500/10';
        return '';
    }
    function levelCls(lvl) {
        if (lvl === 'Error')   return 'text-red-500 font-medium';
        if (lvl === 'Warning') return 'text-amber-500 font-medium';
        return 'text-muted-foreground';
    }

    // ── Export ────────────────────────────────────────────────────────────────────
    function exportFiltered() {
        dl(filteredLines.value.map((l) => `${l.time} ${l.level.padEnd(9)} -  ${l.text}`).join('\n'),
            `filtered_${activeFile.value?.name ?? 'log'}.txt`);
    }
    function saveArchive() {
        if (activeFile.value) dl(activeFile.value.content, `archive_${activeFile.value.name}`);
    }
    function dl(text, name) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        Object.assign(document.createElement('a'), { href: url, download: name }).click();
        URL.revokeObjectURL(url);
    }
</script>
