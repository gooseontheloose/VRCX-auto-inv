// IndexedDB persistence for Group Monitor audit logs.
// Replaces localStorage which has a ~5-10 MB quota that breaks at ~13k entries.
// IndexedDB can hold hundreds of MB with no practical limit for this use case.

const DB_NAME = 'paw-group-monitor';
const DB_VERSION = 1;
const AUDIT_STORE = 'audit_logs';
const META_STORE = 'audit_meta';

let _db = null;

function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(AUDIT_STORE)) {
                const store = db.createObjectStore(AUDIT_STORE, { keyPath: 'id' });
                store.createIndex('by_group', 'groupId', { unique: false });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'groupId' });
            }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => reject(e.target.error);
    });
}

// Load all cached entries for a group, sorted newest-first
export async function auditDbLoadEntries(groupId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIT_STORE, 'readonly');
        const idx = tx.objectStore(AUDIT_STORE).index('by_group');
        const req = idx.getAll(IDBKeyRange.only(groupId));
        req.onsuccess = (e) => {
            const rows = e.target.result ?? [];
            rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            resolve(rows);
        };
        req.onerror = (e) => reject(e.target.error);
    });
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
        const tx = db.transaction(AUDIT_STORE, 'readwrite');
        const store = tx.objectStore(AUDIT_STORE);
        for (const entry of valid) {
            const req = store.put({ ...entry, groupId });
            req.onerror = (e) => {
                // Prevent one bad entry from aborting the whole transaction.
                e.preventDefault();
                console.warn('[auditLogDb] Failed to put entry', entry.id, ':', e.target.error);
            };
        }
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
    });
}

export async function auditDbLoadMeta(groupId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).get(groupId);
        req.onsuccess = (e) => resolve(e.target.result ?? null);
        req.onerror = (e) => reject(e.target.error);
    });
}

export async function auditDbSaveMeta(groupId, meta) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put({ groupId, ...meta });
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
    });
}

// One-time migration from the old localStorage cache (gm-audit-v1-{groupId}).
// Runs silently on first load; does nothing if IndexedDB already has data for this group.
export async function auditDbMigrateFromLocalStorage(groupId) {
    try {
        const meta = await auditDbLoadMeta(groupId);
        if (meta !== null) return; // already migrated

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
