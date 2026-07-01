import { ref, computed } from 'vue';

const DB_NAME    = 'paw-debug-logs';
const DB_VERSION = 1;
const FILES_STORE = 'log_files'; // { name, content, size, lastModified, cachedAt }
const META_STORE  = 'debug_meta'; // { key, folderName, lastScannedAt }

let _db = null;
async function openDb() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(FILES_STORE))
                db.createObjectStore(FILES_STORE, { keyPath: 'name' });
            if (!db.objectStoreNames.contains(META_STORE))
                db.createObjectStore(META_STORE, { keyPath: 'key' });
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function dbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function dbPut(store, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
    });
}

async function dbGetAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function dbClearStore(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
    });
}

export function useDebugLogs() {
    const fileIndex     = ref([]);  // [{ name, size, lastModified, cachedAt }]
    const folderName    = ref('');
    const isScanning    = ref(false);
    const scanError     = ref('');
    const scanProgress  = ref('');
    const lastScannedAt = ref(null);

    const folderConfigured = computed(() => !!folderName.value);
    const sortedFiles = computed(() =>
        [...fileIndex.value].sort((a, b) => b.name.localeCompare(a.name))
    );

    // Load cached state from IDB on startup
    async function init() {
        const meta = await dbGet(META_STORE, 'folder');
        if (meta) {
            folderName.value    = meta.folderName    || '';
            lastScannedAt.value = meta.lastScannedAt || null;
        }
        const all = await dbGetAll(FILES_STORE);
        if (all.length) {
            fileIndex.value = all.map(({ name, size, lastModified, cachedAt }) =>
                ({ name, size, lastModified, cachedAt })
            );
        }
    }

    // Called when the webkitdirectory input fires
    async function processFileList(fileList) {
        scanError.value = '';
        const logFiles = Array.from(fileList).filter(
            (f) => f.name.startsWith('output_log_') && f.name.endsWith('.txt')
        );

        if (!logFiles.length) {
            scanError.value =
                'No VRChat log files (output_log_*.txt) found. Make sure you selected the VRChat folder, not a subfolder.';
            return;
        }

        isScanning.value = true;
        try {
            // Derive folder name from webkitRelativePath ("FolderName/file.txt")
            const firstPath     = logFiles[0].webkitRelativePath || '';
            const detectedFolder = firstPath.split('/')[0] || 'VRChat';

            await dbClearStore(FILES_STORE);

            const index = [];
            for (let i = 0; i < logFiles.length; i++) {
                const file = logFiles[i];
                scanProgress.value = `Reading ${i + 1} / ${logFiles.length}: ${file.name}`;
                const content = await file.text();
                const record = {
                    name: file.name,
                    content,
                    size: file.size,
                    lastModified: file.lastModified,
                    cachedAt: Date.now()
                };
                await dbPut(FILES_STORE, record);
                index.push({ name: record.name, size: record.size, lastModified: record.lastModified, cachedAt: record.cachedAt });
            }

            const now = Date.now();
            await dbPut(META_STORE, { key: 'folder', folderName: detectedFolder, lastScannedAt: now });

            folderName.value    = detectedFolder;
            lastScannedAt.value = now;
            fileIndex.value     = index;
        } catch (err) {
            scanError.value = err.message || String(err);
        } finally {
            isScanning.value   = false;
            scanProgress.value = '';
        }
    }

    // Forget the folder and clear all cached logs
    async function clearFolder() {
        await dbClearStore(FILES_STORE);
        await dbClearStore(META_STORE);
        folderName.value    = '';
        lastScannedAt.value = null;
        fileIndex.value     = [];
        scanError.value     = '';
    }

    // Lazy-load file content from IDB (only when a file is selected)
    async function getFileContent(name) {
        const record = await dbGet(FILES_STORE, name);
        return record?.content ?? '';
    }

    return {
        sortedFiles,
        folderName,
        folderConfigured,
        isScanning,
        scanError,
        scanProgress,
        lastScannedAt,
        init,
        processFileList,
        clearFolder,
        getFileContent
    };
}
