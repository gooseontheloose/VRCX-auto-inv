<script setup>
    import { ref, computed, watch, onMounted } from 'vue';
    import { useI18n } from 'vue-i18n';
    import {
        Copy,
        Check,
        CircleX,
        Loader,
        RefreshCw,
        Trash2,
        Download,
        ClipboardList,
        Filter,
        ArrowUpDown,
        Sparkles,
        ListChecks,
        Ban,
        CheckCircle2,
        XCircle,
        Clock,
        Hash,
        ChevronDown,
        BookOpen,
        FolderOpen,
        Shuffle
    } from 'lucide-vue-next';

    import { request } from '../../services/request';
    import { Button } from '@/components/ui/button';
    import { Badge } from '@/components/ui/badge';
    import { Input } from '@/components/ui/input';
    import { Textarea } from '@/components/ui/textarea';
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

    const { t } = useI18n();

    // ── constants ────────────────────────────────────────────────────────────
    const STORAGE_KEY = 'paw_username_checker_log';
    const VRC_MIN_LEN = 4;
    const VRC_MAX_LEN = 32;
    const VOWELS = 'aeiou';
    const CONSONANTS = 'bcdfghjklmnpqrstvwxyz';
    const DIGITS = '0123456789';
    const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

    // ── input state ──────────────────────────────────────────────────────────
    const inputMode = ref('generate');
    const nameListInput = ref('');

    const genPrefix = ref('');
    const genSuffix = ref('');
    const genMinLen = ref(4);
    const genMaxLen = ref(6);
    const genBatch = ref(25);
    const genStyle = ref('random');   // 'random' | 'pronounceable' | 'wordlike'
    const genChars = ref('both');     // 'alpha' | 'digits' | 'both'

    // ── check state ──────────────────────────────────────────────────────────
    const isChecking = ref(false);
    const stopRequested = ref(false);
    const checkedCount = ref(0);
    const totalCount = ref(0);
    const currentName = ref('');
    const startTime = ref(null);

    // ── results ──────────────────────────────────────────────────────────────
    // entry: { name, status: 'available'|'taken'|'error', checkedAt: Date }
    const log = ref([]);

    // ── speed + check settings ────────────────────────────────────────────────
    const SPEED_PRESETS = [
        { label: 'Careful', ms: 1100, rate: '~55/min' },
        { label: 'Normal',  ms: 600,  rate: '~100/min' }
    ];
    const speedPreset = ref(0);         // 0 = Careful, 1 = Normal
    const doubleCheckMode = ref(false); // verify "taken" via profile lookup
    const rateLimitHit = ref(false);    // auto-set when API returns 429

    // ── UI state ─────────────────────────────────────────────────────────────
    const filterView = ref('all');   // 'all' | 'available' | 'taken'
    const sortMode = ref('newest');  // 'newest' | 'oldest' | 'az' | 'length'
    const copiedName = ref('');
    const copiedAll = ref(false);

    // ── dictionary state ──────────────────────────────────────────────────────
    const dictWords = ref([]);          // all words loaded from file
    const dictFileName = ref('');
    const dictMinLen = ref(4);
    const dictMaxLen = ref(8);
    const dictSampleSize = ref(50);     // 0 = all matching words
    const dictFileInput = ref(null);    // ref to hidden <input type="file">

    // ── computed ─────────────────────────────────────────────────────────────
    const availableCount = computed(() => log.value.filter((e) => e.status === 'available').length);
    const takenCount = computed(() => log.value.filter((e) => e.status === 'taken').length);
    const errorCount = computed(() => log.value.filter((e) => e.status === 'error').length);
    const hitRate = computed(() => {
        const checked = availableCount.value + takenCount.value;
        if (!checked) return 0;
        return Math.round((availableCount.value / checked) * 100);
    });

    const etaSeconds = computed(() => {
        if (!isChecking.value || !startTime.value || checkedCount.value === 0) return null;
        const elapsed = (Date.now() - startTime.value) / 1000;
        const rate = checkedCount.value / elapsed;
        const remaining = totalCount.value - checkedCount.value;
        return Math.round(remaining / rate);
    });

    const pendingList = computed(() => {
        return nameListInput.value
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length >= VRC_MIN_LEN && s.length <= VRC_MAX_LEN);
    });

    const invalidLines = computed(() => {
        return nameListInput.value
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && (s.length < VRC_MIN_LEN || s.length > VRC_MAX_LEN));
    });

    const filteredLog = computed(() => {
        let entries = log.value;
        if (filterView.value === 'available') entries = entries.filter((e) => e.status === 'available');
        else if (filterView.value === 'taken') entries = entries.filter((e) => e.status === 'taken');

        switch (sortMode.value) {
            case 'oldest':  return [...entries].reverse();
            case 'az':      return [...entries].sort((a, b) => a.name.localeCompare(b.name));
            case 'length':  return [...entries].sort((a, b) => a.name.length - b.name.length);
            default:        return entries; // newest first (already newest-first)
        }
    });

    const availableNames = computed(() => log.value.filter((e) => e.status === 'available').map((e) => e.name));

    const currentSpeed = computed(() => SPEED_PRESETS[speedPreset.value] ?? SPEED_PRESETS[0]);

    const dictFiltered = computed(() => {
        const min = Math.max(VRC_MIN_LEN, dictMinLen.value);
        const max = Math.min(VRC_MAX_LEN, dictMaxLen.value);
        return dictWords.value.filter((w) => w.length >= min && w.length <= max);
    });

    const dictCheckCount = computed(() => {
        if (dictSampleSize.value > 0) return Math.min(dictSampleSize.value, dictFiltered.value.length);
        return dictFiltered.value.length;
    });

    // ── persistence ───────────────────────────────────────────────────────────
    onMounted(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    log.value = parsed.map((e) => ({ ...e, checkedAt: new Date(e.checkedAt) }));
                }
            }
        } catch { /* ignore */ }
    });

    watch(log, (val) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
        } catch { /* ignore */ }
    }, { deep: true });

    // ── generators ────────────────────────────────────────────────────────────
    function charPool() {
        if (genChars.value === 'alpha') return ALPHA;
        if (genChars.value === 'digits') return DIGITS;
        return ALPHA + DIGITS;
    }

    function randomName() {
        const pfx = genPrefix.value.trim().toLowerCase();
        const sfx = genSuffix.value.trim().toLowerCase();
        const fixed = pfx.length + sfx.length;
        const min = Math.max(VRC_MIN_LEN, genMinLen.value);
        const max = Math.min(VRC_MAX_LEN, Math.max(min, genMaxLen.value));
        const midLen = Math.floor(Math.random() * (max - min + 1)) + min - fixed;
        if (midLen <= 0) return pfx + sfx;
        const pool = charPool();
        let mid = '';
        for (let i = 0; i < midLen; i++) mid += pool[Math.floor(Math.random() * pool.length)];
        return pfx + mid + sfx;
    }

    function pronounceableName() {
        const pfx = genPrefix.value.trim().toLowerCase();
        const sfx = genSuffix.value.trim().toLowerCase();
        const fixed = pfx.length + sfx.length;
        const min = Math.max(VRC_MIN_LEN, genMinLen.value);
        const max = Math.min(VRC_MAX_LEN, Math.max(min, genMaxLen.value));
        const midLen = Math.floor(Math.random() * (max - min + 1)) + min - fixed;
        if (midLen <= 0) return pfx + sfx;
        let mid = '';
        for (let i = 0; i < midLen; i++) {
            if (i % 2 === 0) mid += CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)];
            else mid += VOWELS[Math.floor(Math.random() * VOWELS.length)];
        }
        if (genChars.value !== 'alpha' && Math.random() < 0.3) {
            const pos = Math.floor(Math.random() * mid.length);
            mid = mid.slice(0, pos) + DIGITS[Math.floor(Math.random() * DIGITS.length)] + mid.slice(pos + 1);
        }
        return pfx + mid + sfx;
    }

    // CVC-CVC pattern — reads like a word
    function wordlikeName() {
        const pfx = genPrefix.value.trim().toLowerCase();
        const sfx = genSuffix.value.trim().toLowerCase();
        const fixed = pfx.length + sfx.length;
        const min = Math.max(VRC_MIN_LEN, genMinLen.value);
        const max = Math.min(VRC_MAX_LEN, Math.max(min, genMaxLen.value));
        const midLen = Math.floor(Math.random() * (max - min + 1)) + min - fixed;
        if (midLen <= 0) return pfx + sfx;
        // CVC syllable pattern
        const pattern = ['c', 'v', 'c', 'v', 'c', 'v', 'c', 'c', 'v', 'c'];
        let mid = '';
        for (let i = 0; i < midLen; i++) {
            const p = pattern[i % pattern.length];
            if (p === 'v') mid += VOWELS[Math.floor(Math.random() * VOWELS.length)];
            else mid += CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)];
        }
        return pfx + mid + sfx;
    }

    function buildName() {
        switch (genStyle.value) {
            case 'pronounceable': return pronounceableName();
            case 'wordlike':      return wordlikeName();
            default:              return randomName();
        }
    }

    function buildBatch() {
        const count = Math.min(100, Math.max(1, genBatch.value));
        const names = [];
        const seen = new Set(log.value.map((e) => e.name.toLowerCase()));
        let attempts = 0;
        while (names.length < count && attempts < count * 8) {
            const n = buildName();
            if (n.length >= VRC_MIN_LEN && !seen.has(n.toLowerCase())) {
                seen.add(n.toLowerCase());
                names.push(n);
            }
            attempts++;
        }
        return names;
    }

    // ── API check ─────────────────────────────────────────────────────────────
    function is429(err) {
        return err?.status === 429 || String(err?.message ?? '').includes('429');
    }

    async function isNameAvailable(name) {
        try {
            const result = await request('users', {
                method: 'GET',
                params: { search: name, n: 1, fuzzy: false }
            });
            if (!Array.isArray(result) || result.length === 0) return { status: 'available' };
            const exact = result.find((u) => u.displayName?.toLowerCase() === name.toLowerCase());
            if (!exact) return { status: 'available' };

            // Double-check: fetch the matched user's profile to confirm the account is real.
            // The search endpoint sometimes returns ghost/deleted accounts causing false "taken".
            if (doubleCheckMode.value && exact.id) {
                try {
                    const profile = await request(`users/${exact.id}`, { method: 'GET' });
                    const stillMatch = profile?.displayName?.toLowerCase() === name.toLowerCase();
                    return { status: stillMatch ? 'taken' : 'available', verified: true };
                } catch (err) {
                    if (is429(err)) return { status: 'error', rateLimited: true };
                    // Profile 404 or other error → account doesn't really exist, name is free
                    return { status: 'available', verified: true };
                }
            }

            return { status: 'taken' };
        } catch (err) {
            if (is429(err)) return { status: 'error', rateLimited: true };
            return { status: 'error' };
        }
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    async function runChecks(names) {
        isChecking.value = true;
        stopRequested.value = false;
        rateLimitHit.value = false;
        checkedCount.value = 0;
        totalCount.value = names.length;
        startTime.value = Date.now();

        for (const name of names) {
            if (stopRequested.value) break;
            currentName.value = name;
            const { status, verified, rateLimited } = await isNameAvailable(name);

            if (rateLimited) {
                rateLimitHit.value = true;
                stopRequested.value = true;
                break;
            }

            log.value.unshift({ name, status, checkedAt: new Date(), verified: verified ?? false });
            checkedCount.value++;
            if (checkedCount.value < names.length && !stopRequested.value) {
                await sleep(currentSpeed.value.ms);
            }
        }

        isChecking.value = false;
        currentName.value = '';
        startTime.value = null;
    }

    function checkList() {
        const deduped = [...new Set(pendingList.value)];
        if (!deduped.length) return;
        runChecks(deduped);
    }

    function checkGenerated() {
        const names = buildBatch();
        if (!names.length) return;
        runChecks(names);
    }

    function stopChecking() {
        stopRequested.value = true;
    }

    // ── clipboard ─────────────────────────────────────────────────────────────
    async function copyName(name) {
        try {
            await navigator.clipboard.writeText(name);
            copiedName.value = name;
            setTimeout(() => { if (copiedName.value === name) copiedName.value = ''; }, 1500);
        } catch { /* ignore */ }
    }

    async function copyAllAvailable() {
        try {
            await navigator.clipboard.writeText(availableNames.value.join('\n'));
            copiedAll.value = true;
            setTimeout(() => { copiedAll.value = false; }, 1800);
        } catch { /* ignore */ }
    }

    function exportCsv() {
        const rows = ['name,status,length,checked_at'];
        log.value.forEach((e) => {
            rows.push(`${e.name},${e.status},${e.name.length},"${e.checkedAt.toISOString()}"`);
        });
        const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'username_check_log.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── dictionary ────────────────────────────────────────────────────────────
    function openDictFilePicker() {
        dictFileInput.value?.click();
    }

    function onDictFileChange(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        dictFileName.value = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            const words = text
                .split(/\r?\n/)
                .map((l) => l.trim().toLowerCase())
                // strip lines with spaces, apostrophes, hyphens — not valid VRC names
                .filter((l) => l.length > 0 && /^[a-z0-9_]+$/.test(l));
            dictWords.value = [...new Set(words)];
        };
        reader.readAsText(file);
        // reset so same file can be re-loaded
        event.target.value = '';
    }

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function checkDictWords() {
        let words = dictFiltered.value;
        if (dictSampleSize.value > 0 && words.length > dictSampleSize.value) {
            words = shuffle(words).slice(0, dictSampleSize.value);
        }
        // skip already-checked names to avoid duplicate API calls
        const checked = new Set(log.value.map((e) => e.name.toLowerCase()));
        const fresh = words.filter((w) => !checked.has(w));
        if (!fresh.length) return;
        runChecks(fresh);
    }

    // ── clear ─────────────────────────────────────────────────────────────────
    function clearAll() { log.value = []; }
    function clearTaken() { log.value = log.value.filter((e) => e.status !== 'taken'); }
    function clearAvailable() { log.value = log.value.filter((e) => e.status !== 'available'); }

    // ── formatters ────────────────────────────────────────────────────────────
    function fmtTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function fmtEta(s) {
        if (s === null) return '';
        if (s < 60) return `~${s}s`;
        return `~${Math.ceil(s / 60)}m`;
    }
</script>

<template>
    <div class="x-container x-container--auto-height" style="display:flex;flex-direction:column;gap:0;height:100%;overflow:hidden;">

        <!-- ── Stats bar ─────────────────────────────────────── -->
        <div style="display:flex;align-items:center;gap:20px;padding:10px 16px 8px;border-bottom:1px solid hsl(var(--border));flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:6px;">
                <i class="ri-user-search-line" style="font-size:17px;" />
                <span style="font-size:14px;font-weight:600;">Username Checker</span>
            </div>

            <div style="display:flex;gap:16px;margin-left:8px;">
                <div style="display:flex;align-items:center;gap:5px;" class="text-muted-foreground text-xs">
                    <ListChecks class="size-3.5" />
                    <span>Checked: <strong class="text-foreground">{{ log.length }}</strong></span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;color:#22c55e;" class="text-xs">
                    <CheckCircle2 class="size-3.5" />
                    <span>Available: <strong>{{ availableCount }}</strong></span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;color:#ef4444;" class="text-xs">
                    <XCircle class="size-3.5" />
                    <span>Taken: <strong>{{ takenCount }}</strong></span>
                </div>
                <div v-if="log.length > 0" style="display:flex;align-items:center;gap:5px;" class="text-muted-foreground text-xs">
                    <Sparkles class="size-3.5" />
                    <span>Hit rate: <strong class="text-foreground">{{ hitRate }}%</strong></span>
                </div>
            </div>

            <div style="margin-left:auto;display:flex;gap:6px;">
                <Button v-if="availableCount > 0" variant="outline" size="sm" @click="copyAllAvailable">
                    <Check v-if="copiedAll" class="size-3.5 text-green-500" />
                    <ClipboardList v-else class="size-3.5" />
                    Copy all available
                </Button>
                <Button v-if="log.length > 0" variant="outline" size="sm" @click="exportCsv">
                    <Download class="size-3.5" />
                    Export CSV
                </Button>
            </div>
        </div>

        <!-- ── Main body ─────────────────────────────────────── -->
        <div style="display:flex;flex:1;min-height:0;overflow:hidden;">

            <!-- Left panel: input controls -->
            <div style="width:300px;min-width:260px;flex-shrink:0;border-right:1px solid hsl(var(--border));display:flex;flex-direction:column;overflow-y:auto;">
                <!-- hidden file input for dictionary loading -->
                <input ref="dictFileInput" type="file" accept=".txt" style="display:none;" @change="onDictFileChange" />

                <Tabs v-model="inputMode" style="display:flex;flex-direction:column;flex:1;">
                    <TabsList style="margin:12px 12px 0;flex-shrink:0;">
                        <TabsTrigger value="generate" style="flex:1;">
                            <Sparkles class="size-3.5 mr-1" />Generate
                        </TabsTrigger>
                        <TabsTrigger value="dictionary" style="flex:1;">
                            <BookOpen class="size-3.5 mr-1" />Dict
                        </TabsTrigger>
                        <TabsTrigger value="list" style="flex:1;">
                            <ListChecks class="size-3.5 mr-1" />List
                        </TabsTrigger>
                    </TabsList>

                    <!-- LIST mode -->
                    <TabsContent value="list" style="padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;">
                        <p class="text-muted-foreground text-xs">One name per line. Minimum 4 characters.</p>

                        <Textarea
                            v-model="nameListInput"
                            placeholder="coolname&#10;paw_user&#10;myhandle"
                            style="flex:1;min-height:180px;font-family:monospace;font-size:12px;resize:none;" />

                        <!-- Validation feedback -->
                        <div v-if="invalidLines.length" style="display:flex;gap:5px;align-items:flex-start;" class="text-xs text-amber-500">
                            <Ban class="size-3.5 shrink-0 mt-0.5" />
                            <span>{{ invalidLines.length }} line(s) skipped (must be 4–32 chars): {{ invalidLines.slice(0,3).join(', ') }}{{ invalidLines.length > 3 ? '…' : '' }}</span>
                        </div>

                        <Button
                            :disabled="isChecking || pendingList.length === 0"
                            @click="checkList"
                            style="width:100%;">
                            <Loader v-if="isChecking" class="size-4 animate-spin" />
                            <RefreshCw v-else class="size-4" />
                            Check {{ pendingList.length }} name{{ pendingList.length !== 1 ? 's' : '' }}
                        </Button>
                    </TabsContent>

                    <!-- GENERATE mode -->
                    <TabsContent value="generate" style="padding:12px;display:flex;flex-direction:column;gap:12px;">
                        <p class="text-muted-foreground text-xs">Generate random names and check availability.</p>

                        <!-- Style picker -->
                        <div style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Style</label>
                            <Select v-model="genStyle">
                                <SelectTrigger style="font-size:13px;">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="random">Random (letters + digits)</SelectItem>
                                    <SelectItem value="pronounceable">Pronounceable (consonant-vowel)</SelectItem>
                                    <SelectItem value="wordlike">Wordlike (CVC syllables)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <!-- Char set (only for random style) -->
                        <div v-if="genStyle === 'random'" style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Characters</label>
                            <Select v-model="genChars">
                                <SelectTrigger style="font-size:13px;">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="both">Letters + Numbers</SelectItem>
                                    <SelectItem value="alpha">Letters only</SelectItem>
                                    <SelectItem value="digits">Numbers only</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <!-- Prefix / Suffix -->
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Prefix</label>
                                <Input v-model="genPrefix" placeholder="paw" style="font-family:monospace;font-size:12px;" />
                            </div>
                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Suffix</label>
                                <Input v-model="genSuffix" placeholder="vr" style="font-family:monospace;font-size:12px;" />
                            </div>
                        </div>

                        <!-- Length range -->
                        <div style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Length (chars)</label>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <Input v-model.number="genMinLen" type="number" :min="4" :max="VRC_MAX_LEN" style="width:64px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">to</span>
                                <Input v-model.number="genMaxLen" type="number" :min="4" :max="VRC_MAX_LEN" style="width:64px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">chars</span>
                            </div>
                        </div>

                        <!-- Batch size -->
                        <div style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Batch size</label>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <Input v-model.number="genBatch" type="number" :min="1" :max="100" style="width:64px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">names per run</span>
                            </div>
                        </div>

                        <Button
                            :disabled="isChecking"
                            @click="checkGenerated"
                            style="width:100%;margin-top:auto;">
                            <Loader v-if="isChecking" class="size-4 animate-spin" />
                            <Sparkles v-else class="size-4" />
                            Generate &amp; Check
                        </Button>
                    </TabsContent>

                    <!-- DICTIONARY mode -->
                    <TabsContent value="dictionary" style="padding:12px;display:flex;flex-direction:column;gap:12px;">
                        <p class="text-muted-foreground text-xs">Load a word list (.txt, one word per line) and check VRChat availability for a filtered sample.</p>

                        <!-- File loader -->
                        <div style="display:flex;flex-direction:column;gap:6px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Word list file</label>
                            <Button variant="outline" style="width:100%;justify-content:flex-start;gap:8px;font-size:12px;" @click="openDictFilePicker">
                                <FolderOpen class="size-4 shrink-0" />
                                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                    {{ dictFileName || 'Browse for .txt file…' }}
                                </span>
                            </Button>
                            <div v-if="dictWords.length > 0" class="text-xs text-muted-foreground">
                                {{ dictWords.length.toLocaleString() }} words loaded
                            </div>
                        </div>

                        <!-- Quick presets for common length ranges -->
                        <div v-if="dictWords.length > 0" style="display:flex;flex-direction:column;gap:6px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Quick filter</label>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=4;dictMaxLen=4">4 chars</Button>
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=5;dictMaxLen=5">5 chars</Button>
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=6;dictMaxLen=6">6 chars</Button>
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=4;dictMaxLen=6">4–6</Button>
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=4;dictMaxLen=8">4–8</Button>
                                <Button variant="outline" size="sm" style="height:24px;font-size:11px;" @click="dictMinLen=6;dictMaxLen=10">6–10</Button>
                            </div>
                        </div>

                        <!-- Length filter -->
                        <div style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Length filter (chars)</label>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <Input v-model.number="dictMinLen" type="number" :min="4" :max="32" style="width:56px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">to</span>
                                <Input v-model.number="dictMaxLen" type="number" :min="4" :max="32" style="width:56px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">chars</span>
                            </div>
                            <div v-if="dictWords.length > 0" class="text-xs text-muted-foreground">
                                {{ dictFiltered.length.toLocaleString() }} words match
                            </div>
                        </div>

                        <!-- Sample size -->
                        <div style="display:flex;flex-direction:column;gap:4px;">
                            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sample size</label>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <Input v-model.number="dictSampleSize" type="number" :min="0" :max="10000" style="width:72px;font-size:13px;" />
                                <span class="text-muted-foreground text-xs">words (0 = all)</span>
                            </div>
                            <div v-if="dictWords.length > 0" class="text-xs text-muted-foreground">
                                Will check {{ dictCheckCount.toLocaleString() }} names
                                <span v-if="dictCheckCount > 500" style="color:#f59e0b;"> · ~{{ Math.ceil(dictCheckCount * 1.1 / 60) }} min</span>
                            </div>
                        </div>

                        <Button
                            :disabled="isChecking || dictCheckCount === 0"
                            @click="checkDictWords"
                            style="width:100%;margin-top:auto;">
                            <Loader v-if="isChecking" class="size-4 animate-spin" />
                            <Shuffle v-else class="size-4" />
                            Check {{ dictCheckCount.toLocaleString() }} word{{ dictCheckCount !== 1 ? 's' : '' }}
                        </Button>

                        <!-- More languages hint -->
                        <div style="border-top:1px solid hsl(var(--border));padding-top:10px;display:flex;flex-direction:column;gap:4px;">
                            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">More languages</span>
                            <p class="text-xs text-muted-foreground">Download .txt dictionaries from <strong>gwicks.net/dictionaries.htm</strong> and load them here. Works with any plain text word list.</p>
                        </div>
                    </TabsContent>
                </Tabs>

                <!-- Speed + double-check controls -->
                <div style="border-top:1px solid hsl(var(--border));padding:10px 12px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;">

                    <!-- Speed toggle -->
                    <div style="display:flex;flex-direction:column;gap:5px;">
                        <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Speed</label>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
                            <Button
                                v-for="(preset, i) in SPEED_PRESETS"
                                :key="preset.label"
                                :variant="speedPreset === i ? 'default' : 'outline'"
                                size="sm"
                                :disabled="isChecking"
                                style="flex-direction:column;height:auto;padding:5px 4px;gap:1px;"
                                @click="speedPreset = i">
                                <span style="font-size:12px;font-weight:600;">{{ preset.label }}</span>
                                <span style="font-size:10px;opacity:0.75;">{{ preset.rate }}</span>
                            </Button>
                        </div>
                    </div>

                    <!-- Double-check toggle -->
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <div>
                            <div style="font-size:12px;font-weight:500;">Double-check taken</div>
                            <div style="font-size:10px;" class="text-muted-foreground">Verify "taken" via profile lookup to fix false positives</div>
                        </div>
                        <button
                            @click="doubleCheckMode = !doubleCheckMode"
                            :disabled="isChecking"
                            style="flex-shrink:0;width:36px;height:20px;border-radius:10px;border:none;cursor:pointer;transition:background 0.2s;position:relative;"
                            :style="{ background: doubleCheckMode ? 'hsl(var(--primary))' : 'hsl(var(--border))' }">
                            <span
                                style="position:absolute;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;"
                                :style="{ left: doubleCheckMode ? '18px' : '2px' }" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right panel: results -->
            <div style="flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden;">

                <!-- Results toolbar -->
                <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid hsl(var(--border));flex-shrink:0;">
                    <!-- Filter chips -->
                    <div style="display:flex;gap:4px;">
                        <Button
                            :variant="filterView === 'all' ? 'default' : 'outline'"
                            size="sm"
                            style="height:26px;font-size:12px;gap:4px;"
                            @click="filterView = 'all'">
                            All
                            <Badge variant="secondary" style="height:16px;min-width:16px;font-size:10px;padding:0 4px;">{{ log.length }}</Badge>
                        </Button>
                        <Button
                            :variant="filterView === 'available' ? 'default' : 'outline'"
                            size="sm"
                            style="height:26px;font-size:12px;gap:4px;"
                            @click="filterView = 'available'">
                            <span style="color:#22c55e;">●</span> Available
                            <Badge variant="secondary" style="height:16px;min-width:16px;font-size:10px;padding:0 4px;">{{ availableCount }}</Badge>
                        </Button>
                        <Button
                            :variant="filterView === 'taken' ? 'default' : 'outline'"
                            size="sm"
                            style="height:26px;font-size:12px;gap:4px;"
                            @click="filterView = 'taken'">
                            <span style="color:#ef4444;">●</span> Taken
                            <Badge variant="secondary" style="height:16px;min-width:16px;font-size:10px;padding:0 4px;">{{ takenCount }}</Badge>
                        </Button>
                    </div>

                    <!-- Sort -->
                    <Select v-model="sortMode" style="margin-left:auto;">
                        <SelectTrigger style="height:26px;font-size:12px;width:140px;gap:4px;">
                            <ArrowUpDown class="size-3" />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="newest">Newest first</SelectItem>
                            <SelectItem value="oldest">Oldest first</SelectItem>
                            <SelectItem value="az">A → Z</SelectItem>
                            <SelectItem value="length">Shortest first</SelectItem>
                        </SelectContent>
                    </Select>

                    <!-- Clear menu -->
                    <div style="display:flex;gap:4px;">
                        <Button v-if="takenCount > 0" variant="ghost" size="sm" style="height:26px;font-size:12px;" @click="clearTaken">
                            Clear taken
                        </Button>
                        <Button v-if="log.length > 0" variant="ghost" size="sm" style="height:26px;font-size:12px;" @click="clearAll">
                            <Trash2 class="size-3" />
                            Clear all
                        </Button>
                    </div>
                </div>

                <!-- Rate-limit banner -->
                <div
                    v-if="rateLimitHit && !isChecking"
                    style="display:flex;align-items:center;gap:8px;padding:6px 12px;flex-shrink:0;border-bottom:1px solid #f59e0b44;background:#f59e0b11;">
                    <i class="ri-timer-flash-line" style="color:#f59e0b;font-size:14px;flex-shrink:0;" />
                    <span style="font-size:12px;color:#f59e0b;flex:1;">Rate limited — auto-stopped after {{ checkedCount }} name{{ checkedCount !== 1 ? 's' : '' }}. Try switching to Careful mode.</span>
                    <Button variant="ghost" size="sm" style="height:22px;font-size:11px;color:#f59e0b;" @click="rateLimitHit = false">
                        <CircleX class="size-3" />
                        Dismiss
                    </Button>
                </div>

                <!-- Progress bar (when checking) -->
                <div
                    v-if="isChecking"
                    style="display:flex;align-items:center;gap:10px;padding:7px 12px;flex-shrink:0;border-bottom:1px solid hsl(var(--border));"
                    class="bg-accent/50">
                    <Loader class="size-3.5 animate-spin shrink-0" />
                    <span class="text-xs text-muted-foreground" style="flex-shrink:0;">Checking</span>
                    <span style="font-family:monospace;font-size:12px;font-weight:600;">{{ currentName }}</span>
                    <div style="flex:1;background:hsl(var(--border));border-radius:9999px;height:3px;overflow:hidden;">
                        <div
                            :style="{ width: totalCount > 0 ? (checkedCount / totalCount * 100) + '%' : '0%' }"
                            style="height:100%;background:hsl(var(--primary));transition:width 0.3s;" />
                    </div>
                    <span class="text-xs text-muted-foreground" style="flex-shrink:0;">
                        {{ checkedCount }}/{{ totalCount }}
                        <span v-if="etaSeconds !== null"> · {{ fmtEta(etaSeconds) }}</span>
                    </span>
                    <Button variant="ghost" size="sm" style="height:24px;font-size:12px;" @click="stopChecking">
                        <CircleX class="size-3.5" />
                        Stop
                    </Button>
                </div>

                <!-- Column headers -->
                <div
                    v-if="filteredLog.length > 0"
                    style="display:grid;grid-template-columns:16px 1fr auto auto auto;gap:0 12px;padding:5px 12px;border-bottom:1px solid hsl(var(--border));flex-shrink:0;"
                    class="text-muted-foreground text-xs font-medium bg-muted/30">
                    <span></span>
                    <span>Name</span>
                    <span style="text-align:center;">Length</span>
                    <span style="text-align:right;">Checked at</span>
                    <span></span>
                </div>

                <!-- Log entries -->
                <div style="flex:1;overflow-y:auto;">

                    <!-- Empty state -->
                    <div
                        v-if="filteredLog.length === 0"
                        style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;opacity:0.5;">
                        <i class="ri-user-search-line" style="font-size:36px;" />
                        <span class="text-sm text-muted-foreground">
                            {{ log.length === 0 ? 'Run a check to see results here.' : 'No results match the current filter.' }}
                        </span>
                    </div>

                    <!-- Rows -->
                    <div
                        v-for="entry in filteredLog"
                        :key="entry.name + entry.checkedAt"
                        style="display:grid;grid-template-columns:16px 1fr auto auto auto;gap:0 12px;align-items:center;padding:5px 12px;border-bottom:1px solid hsl(var(--border)/0.5);transition:background 0.1s;"
                        :class="entry.status === 'available' ? 'hover:bg-green-500/5' : entry.status === 'taken' ? 'hover:bg-red-500/5' : 'hover:bg-accent/30'">

                        <!-- Status dot -->
                        <span
                            style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"
                            :style="{
                                background: entry.status === 'available' ? '#22c55e'
                                          : entry.status === 'taken'     ? '#ef4444'
                                          : '#6b7280'
                            }" />

                        <!-- Name + copy button (together, left side) -->
                        <div style="display:flex;align-items:center;gap:4px;min-width:0;">
                            <span
                                style="font-family:monospace;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                                :style="{ color: entry.status === 'available' ? '#22c55e' : entry.status === 'taken' ? 'hsl(var(--muted-foreground))' : 'hsl(var(--muted-foreground))' }">
                                {{ entry.name }}
                            </span>
                            <!-- Copy button RIGHT next to the name -->
                            <Button
                                v-if="entry.status === 'available'"
                                variant="ghost"
                                size="sm"
                                style="height:22px;width:22px;padding:0;flex-shrink:0;"
                                @click.stop="copyName(entry.name)">
                                <Check v-if="copiedName === entry.name" class="size-3 text-green-500" />
                                <Copy v-else class="size-3" />
                            </Button>
                            <!-- Verified shield when double-check was used -->
                            <i
                                v-if="entry.verified"
                                class="ri-shield-check-line"
                                style="font-size:11px;flex-shrink:0;"
                                :style="{ color: entry.status === 'available' ? '#22c55e' : '#9ca3af' }"
                                title="Double-checked via profile lookup" />
                        </div>

                        <!-- Length: N chars (explicitly labeled) -->
                        <span class="text-muted-foreground text-xs" style="text-align:center;white-space:nowrap;font-family:monospace;">
                            {{ entry.name.length }} chars
                        </span>

                        <!-- Checked at -->
                        <span class="text-muted-foreground text-xs" style="text-align:right;white-space:nowrap;font-family:monospace;">
                            {{ fmtTime(entry.checkedAt) }}
                        </span>

                        <!-- Status badge -->
                        <Badge
                            style="height:18px;font-size:10px;padding:0 6px;justify-self:end;"
                            :style="{
                                background: entry.status === 'available' ? '#16a34a22' : entry.status === 'taken' ? '#dc262622' : '#6b728022',
                                color: entry.status === 'available' ? '#22c55e' : entry.status === 'taken' ? '#ef4444' : '#9ca3af',
                                border: 'none'
                            }">
                            {{ entry.status === 'available' ? (entry.verified ? '✓ Free (verified)' : '✓ Available') : entry.status === 'taken' ? (entry.verified ? '✗ Taken (verified)' : '✗ Taken') : '? Error' }}
                        </Badge>
                    </div>
                </div>

            </div><!-- /right panel -->
        </div><!-- /main body -->
    </div>
</template>
