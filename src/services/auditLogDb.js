// IndexedDB persistence for Group Monitor audit logs.
// Replaces localStorage which has a ~5-10 MB quota that breaks at ~13k entries.
// IndexedDB can hold hundreds of MB with no practical limit for this use case.

const DB_NAME = 'paw-group-monitor';
// Stays at 1: older builds open the database at version 1 and would fail on a
// higher one. The newest entry per group is tracked in the meta record instead
// of an index.
const DB_VERSION = 1;
const AUDIT_STORE = 'audit_logs';
const META_STORE = 'audit_meta';

let _db = null;

function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(AUDIT_STORE)) {
                const store = db.createObjectStore(AUDIT_STORE, { keyPath: 'id' });
                store.createIndex('by_group', 'groupId', { unique: false });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'groupId' });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Folds entries into a {newestAt, newestIds} marker (every id sharing the
 * newest created_at).
 *
 * @param {{ newestAt?: string; newestIds?: string[] } | null} marker
 * @param {{ id: string; created_at: string }[]} entries
 */
function foldNewest(marker, entries) {
    let at = marker?.newestAt ?? '';
    let atMs = at ? Date.parse(at) : -Infinity;
    let ids = new Set(marker?.newestIds ?? []);
    for (const e of entries) {
        const t = Date.parse(e?.created_at);
        if (!Number.isFinite(t) || e.id == null) continue;
        if (t > atMs) {
            atMs = t;
            at = e.created_at;
            ids = new Set([e.id]);
        } else if (t === atMs) {
            ids.add(e.id);
        }
    }
    return { newestAt: at, newestIds: [...ids] };
}

// Load all cached entries for a group, sorted newest-first
export async function auditDbLoadEntries(groupId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIT_STORE, 'readonly');
        const idx = tx.objectStore(AUDIT_STORE).index('by_group');
        const req = idx.getAll(IDBKeyRange.only(groupId));
        req.onsuccess = () => {
            const rows = req.result ?? [];
            rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            resolve(rows);
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * The newest cached entries of a group ({id, created_at} of every entry
 * sharing the newest created_at), or [] when nothing is cached. Caches written
 * before the marker existed are scanned once.
 *
 * @param {string} groupId
 * @returns {Promise<{ id: string; created_at: string }[]>}
 */
export async function auditDbLoadNewest(groupId) {
    const meta = await auditDbLoadMeta(groupId);
    let marker = meta?.newestAt ? meta : null;
    if (!marker) {
        const rows = await auditDbLoadEntries(groupId);
        if (!rows.length) return [];
        marker = foldNewest(null, rows);
        const found = marker.newestIds.map((id) => ({ id, created_at: marker.newestAt }));
        // merged with a marker another writer may have stored meanwhile
        await auditDbUpdateMeta(groupId, (cur) => ({
            ...(cur ?? {}),
            ...foldNewest(cur?.newestAt ? cur : null, found)
        }));
    }
    return (marker.newestIds ?? []).map((id) => ({ id, created_at: marker.newestAt }));
}

// Upsert a batch of entries. Each entry gets a groupId tag for the index.
// PUT is idempotent — safe to call with entries already in the store.
export async function auditDbSaveEntries(groupId, entries) {
    if (!entries.length) return;
    // Entries without a valid id cannot be stored (id is the keyPath) — skip them.
    const valid = entries.filter((e) => e.id != null);
    if (!valid.length) {
        console.warn('[auditLogDb] auditDbSaveEntries: no entries with valid id — skipping batch');
        return;
    }
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([AUDIT_STORE, META_STORE], 'readwrite');
        const store = tx.objectStore(AUDIT_STORE);
        for (const entry of valid) {
            const req = store.put({ ...entry, groupId });
            req.onerror = (e) => {
                // Prevent one bad entry from aborting the whole transaction.
                e.preventDefault();
                console.warn('[auditLogDb] Failed to put entry', entry.id, ':', req.error);
            };
        }
        // Keep the newest-entry marker current (only once a marker exists, so
        // a cache from before the marker is still scanned in full once).
        const metaStore = tx.objectStore(META_STORE);
        const metaReq = metaStore.get(groupId);
        metaReq.onsuccess = () => {
            const cur = metaReq.result;
            if (!cur?.newestAt) return;
            const next = foldNewest(cur, valid);
            if (next.newestAt !== cur.newestAt || next.newestIds.length !== (cur.newestIds ?? []).length) {
                metaStore.put({ ...cur, ...next });
            }
        };
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
    });
}

export async function auditDbLoadMeta(groupId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).get(groupId);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Read-modify-write of a group's meta record in one transaction, so the page
 * and the background service never overwrite each other's fields (gap list,
 * history flags, totals).
 *
 * @param {string} groupId
 * @param {(current: any) => any} fn Return null to leave the record unchanged
 * @returns {Promise<any>} The stored record
 */
export async function auditDbUpdateMeta(groupId, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        const store = tx.objectStore(META_STORE);
        const req = store.get(groupId);
        let result = null;
        let failed = null;
        req.onsuccess = () => {
            const current = req.result ?? null;
            let next;
            try {
                next = fn(current);
            } catch (err) {
                failed = err;
                tx.abort();
                return;
            }
            if (!next) {
                result = current;
                return;
            }
            result = { ...next, groupId };
            store.put(result);
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failed ?? tx.error);
        tx.onerror = () => reject(tx.error);
    });
}

// Merges into the existing record: fields not passed (e.g. the gap list) are kept.
export async function auditDbSaveMeta(groupId, meta) {
    await auditDbUpdateMeta(groupId, (current) => ({ ...(current ?? {}), ...meta }));
}

// One-time migration from the old localStorage cache (gm-audit-v1-{groupId}).
// Runs silently on first load; does nothing if IndexedDB already has data for this group.
export async function auditDbMigrateFromLocalStorage(groupId) {
    try {
        const meta = await auditDbLoadMeta(groupId);
        // already migrated (records made only by the background service have no savedAt)
        if (meta?.savedAt) return;

        const raw = localStorage.getItem(`gm-audit-v1-${groupId}`);
        if (!raw) return;

        const cached = JSON.parse(raw);
        if (!cached?.entries?.length) return;

        await auditDbSaveEntries(groupId, cached.entries);
        await auditDbSaveMeta(groupId, {
            total: cached.total ?? cached.entries.length,
            fullyLoaded: cached.fullyLoaded ?? false,
            savedAt: cached.savedAt ?? Date.now()
        });
        console.debug('[auditLogDb] Migrated', cached.entries.length, 'entries from localStorage →', groupId);
        // Keep localStorage copy for safety; user can clear manually
    } catch (err) {
        console.warn('[auditLogDb] localStorage migration failed:', err);
    }
}
