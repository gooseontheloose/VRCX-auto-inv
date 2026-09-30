import { beforeEach, describe, expect, test, vi } from 'vitest';

// storage.js imports the app's sqlite service; the tests hand it a real
// in-memory SQLite (node:sqlite) through the same execute/executeNonQuery API.
vi.mock('../../sqlite', () => ({ default: {} }));

const { DatabaseSync } = await import('node:sqlite');
const { createSqliteMonitorStorage } = await import('../storage');

function fakeSqliteService(db) {
    const bind = (args) =>
        args
            ? Object.fromEntries(
                  Object.entries(args).map(([k, v]) => [k.replace(/^@/, ''), v])
              )
            : {};
    return {
        async execute(cb, sql, args = null) {
            const stmt = db.prepare(sql);
            stmt.setReturnArrays(true);
            for (const row of stmt.all(bind(args))) cb(row);
        },
        async executeNonQuery(sql, args = null) {
            return db.prepare(sql).run(bind(args)).changes;
        }
    };
}

let db;
let storage;

beforeEach(() => {
    db = new DatabaseSync(':memory:');
    const svc = fakeSqliteService(db);
    storage = createSqliteMonitorStorage(() => svc);
});

describe('sqlite monitor storage', () => {
    test('kv round-trips JSON and keeps quotes safe', async () => {
        expect(await storage.getKv('gm:usr_1:config')).toBeNull();
        await storage.setKv('gm:usr_1:config', {
            name: 'O\'Brien\'s "group"',
            n: 1
        });
        expect(await storage.getKv('gm:usr_1:config')).toEqual({
            name: 'O\'Brien\'s "group"',
            n: 1
        });
    });

    test('queue items persist per account and can be deleted', async () => {
        const item = {
            id: 'q1',
            userId: 'usr_1',
            webhookId: 'wh',
            eventId: 'audit:1',
            payload: { embeds: [{ title: "it's" }] },
            attempts: 2,
            nextAt: 123,
            status: 'pending',
            lastError: 'HTTP 500',
            createdAt: 100
        };
        await storage.saveQueueItem(item);
        await storage.saveQueueItem({
            ...item,
            id: 'q2',
            userId: 'usr_2',
            createdAt: 50
        });
        expect(await storage.loadQueue('usr_1')).toEqual([item]);
        await storage.saveQueueItem({ ...item, status: 'dead' });
        expect((await storage.loadQueue('usr_1'))[0].status).toBe('dead');
        await storage.deleteQueueItem('q1');
        expect(await storage.loadQueue('usr_1')).toEqual([]);
        expect(await storage.loadQueue('usr_2')).toHaveLength(1);
    });

    test('dedupe ledger with pruning', async () => {
        await storage.addDedupe('usr_1|wh|audit:1', 100);
        await storage.addDedupe('usr_1|wh|audit:1', 999); // ignored
        await storage.addDedupe('usr_1|wh|audit:2', 500);
        expect(await storage.hasDedupe('usr_1|wh|audit:1')).toBe(true);
        await storage.pruneDedupe(200);
        expect(await storage.hasDedupe('usr_1|wh|audit:1')).toBe(false);
        expect(await storage.hasDedupe('usr_1|wh|audit:2')).toBe(true);
    });

    test('delivery log keeps the newest N per account', async () => {
        for (let i = 0; i < 5; i++) {
            await storage.appendLog({
                userId: 'usr_1',
                webhookId: 'wh',
                eventId: `e${i}`,
                status: 'sent',
                httpStatus: 200,
                at: i
            });
        }
        await storage.appendLog({
            userId: 'usr_2',
            webhookId: 'wh',
            eventId: 'x',
            status: 'dead',
            at: 9
        });
        await storage.pruneLog('usr_1', 3);
        const log = await storage.loadLog('usr_1', 10);
        expect(log.map((e) => e.eventId)).toEqual(['e4', 'e3', 'e2']);
        expect(await storage.loadLog('usr_2')).toHaveLength(1);
    });
});
