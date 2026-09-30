// Persistence for the background Group Monitor service: per-account settings
// (key/value in paw_settings), the webhook delivery queue, the dedupe ledger
// and a short delivery log. Everything goes through parameterised SQL.
//
// memoryStorage.js implements the same interface for tests.

import sqliteService from '../sqlite';

const SQL_TABLES = [
    `CREATE TABLE IF NOT EXISTS paw_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS paw_webhook_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, webhook_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS paw_webhook_dedupe (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS paw_webhook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, webhook_id TEXT, event_id TEXT, status TEXT, http_status INTEGER, message TEXT, at INTEGER NOT NULL)`
];

function parseJson(raw, fallback = null) {
    if (raw === null || raw === undefined) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function rowToQueueItem(row) {
    return {
        id: row[0],
        userId: row[1],
        webhookId: row[2],
        eventId: row[3],
        payload: parseJson(row[4], {}),
        attempts: Number(row[5]) || 0,
        nextAt: Number(row[6]) || 0,
        status: row[7],
        lastError: row[8] ?? null,
        createdAt: Number(row[9]) || 0
    };
}

/**
 * @param {() => typeof sqliteService} getSql resolved lazily: storage.js sits in an
 *   import cycle with sqlite.js (via stores/index), so never touch it at load time.
 */
export function createSqliteMonitorStorage(getSql = () => sqliteService) {
    let ready = null;
    function init() {
        if (!ready) {
            ready = (async () => {
                for (const stmt of SQL_TABLES)
                    await getSql().executeNonQuery(stmt);
            })().catch((err) => {
                ready = null;
                throw err;
            });
        }
        return ready;
    }
    return {
        init,
        async getKv(key) {
            await init();
            let raw = null;
            await getSql().execute(
                (row) => {
                    raw = row[0];
                },
                `SELECT value FROM paw_settings WHERE key = @key`,
                { '@key': key }
            );
            return parseJson(raw, null);
        },
        async setKv(key, value) {
            await init();
            await getSql().executeNonQuery(
                `INSERT OR REPLACE INTO paw_settings (key, value) VALUES (@key, @value)`,
                { '@key': key, '@value': JSON.stringify(value) }
            );
        },
        async loadQueue(userId) {
            await init();
            const items = [];
            await getSql().execute(
                (row) => items.push(rowToQueueItem(row)),
                `SELECT id, user_id, webhook_id, event_id, payload, attempts, next_at, status, last_error, created_at FROM paw_webhook_queue WHERE user_id = @userId ORDER BY created_at ASC`,
                { '@userId': userId }
            );
            return items;
        },
        async saveQueueItem(item) {
            await init();
            await getSql().executeNonQuery(
                `INSERT OR REPLACE INTO paw_webhook_queue (id, user_id, webhook_id, event_id, payload, attempts, next_at, status, last_error, created_at) VALUES (@id, @userId, @webhookId, @eventId, @payload, @attempts, @nextAt, @status, @lastError, @createdAt)`,
                {
                    '@id': item.id,
                    '@userId': item.userId,
                    '@webhookId': item.webhookId,
                    '@eventId': item.eventId,
                    '@payload': JSON.stringify(item.payload),
                    '@attempts': item.attempts,
                    '@nextAt': item.nextAt,
                    '@status': item.status,
                    '@lastError': item.lastError ?? '',
                    '@createdAt': item.createdAt
                }
            );
        },
        async deleteQueueItem(id) {
            await init();
            await getSql().executeNonQuery(
                `DELETE FROM paw_webhook_queue WHERE id = @id`,
                { '@id': id }
            );
        },
        async hasDedupe(key) {
            await init();
            let found = false;
            await getSql().execute(
                () => {
                    found = true;
                },
                `SELECT 1 FROM paw_webhook_dedupe WHERE key = @key LIMIT 1`,
                { '@key': key }
            );
            return found;
        },
        async addDedupe(key, at) {
            await init();
            await getSql().executeNonQuery(
                `INSERT OR IGNORE INTO paw_webhook_dedupe (key, created_at) VALUES (@key, @at)`,
                { '@key': key, '@at': at }
            );
        },
        async pruneDedupe(olderThan) {
            await init();
            await getSql().executeNonQuery(
                `DELETE FROM paw_webhook_dedupe WHERE created_at < @t`,
                { '@t': olderThan }
            );
        },
        async appendLog(entry) {
            await init();
            await getSql().executeNonQuery(
                `INSERT INTO paw_webhook_log (user_id, webhook_id, event_id, status, http_status, message, at) VALUES (@userId, @webhookId, @eventId, @status, @httpStatus, @message, @at)`,
                {
                    '@userId': entry.userId,
                    '@webhookId': entry.webhookId ?? '',
                    '@eventId': entry.eventId ?? '',
                    '@status': entry.status,
                    '@httpStatus': entry.httpStatus ?? 0,
                    '@message': entry.message ?? '',
                    '@at': entry.at
                }
            );
        },
        async loadLog(userId, limit = 50) {
            await init();
            const out = [];
            await getSql().execute(
                (row) =>
                    out.push({
                        webhookId: row[0],
                        eventId: row[1],
                        status: row[2],
                        httpStatus: Number(row[3]) || 0,
                        message: row[4],
                        at: Number(row[5]) || 0
                    }),
                `SELECT webhook_id, event_id, status, http_status, message, at FROM paw_webhook_log WHERE user_id = @userId ORDER BY id DESC LIMIT @limit`,
                { '@userId': userId, '@limit': limit }
            );
            return out;
        },
        async pruneLog(userId, keep = 200) {
            await init();
            await getSql().executeNonQuery(
                `DELETE FROM paw_webhook_log WHERE user_id = @userId AND id NOT IN (SELECT id FROM paw_webhook_log WHERE user_id = @userId ORDER BY id DESC LIMIT @keep)`,
                { '@userId': userId, '@keep': keep }
            );
        }
    };
}

const monitorStorage = createSqliteMonitorStorage();
export default monitorStorage;
