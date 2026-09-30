// In-memory monitor storage with the same interface as storage.js (tests).

/**
 * Pass the same `backing` object to two instances to simulate a restart.
 */
export function createMemoryMonitorStorage(backing = {}) {
    backing.kv ??= new Map();
    backing.queue ??= new Map();
    backing.dedupe ??= new Map();
    backing.log ??= [];
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    return {
        backing,
        async init() {},
        async getKv(key) {
            return backing.kv.has(key) ? clone(backing.kv.get(key)) : null;
        },
        async setKv(key, value) {
            backing.kv.set(key, clone(value));
        },
        async loadQueue(userId) {
            return [...backing.queue.values()]
                .filter((i) => i.userId === userId)
                .sort((a, b) => a.createdAt - b.createdAt)
                .map(clone);
        },
        async saveQueueItem(item) {
            backing.queue.set(item.id, clone(item));
        },
        async deleteQueueItem(id) {
            backing.queue.delete(id);
        },
        async hasDedupe(key) {
            return backing.dedupe.has(key);
        },
        async addDedupe(key, at) {
            if (!backing.dedupe.has(key)) backing.dedupe.set(key, at);
        },
        async pruneDedupe(olderThan) {
            for (const [k, at] of backing.dedupe)
                if (at < olderThan) backing.dedupe.delete(k);
        },
        async appendLog(entry) {
            backing.log.push(clone(entry));
        },
        async loadLog(userId, limit = 50) {
            return backing.log
                .filter((e) => e.userId === userId)
                .slice(-limit)
                .reverse()
                .map(clone);
        },
        async pruneLog(userId, keep = 200) {
            const mine = backing.log.filter((e) => e.userId === userId);
            if (mine.length <= keep) return;
            const drop = new Set(mine.slice(0, mine.length - keep));
            backing.log = backing.log.filter((e) => !drop.has(e));
        }
    };
}
