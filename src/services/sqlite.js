import { i18n } from '../plugins/i18n';
import { openExternalLink } from '../shared/utils';
import { useModalStore } from '../stores';

/**
 * i18n lookup that falls back to a plain message when i18n is not ready yet
 * (SQLite errors can fire during startup, before the plugin is installed).
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function safeT(key, fallback) {
    try {
        return i18n.global.t(key);
    } catch {
        return fallback;
    }
}

// requires binding of SQLite
class SQLiteService {
    handleSQLiteError(e) {
        if (typeof e.message === 'string' && !window.isVrOverlay) {
            try {
                const modalStore = useModalStore();
                if (e.message.includes('database disk image is malformed')) {
                    modalStore
                        .confirm({
                            description: 'Please repair or delete your database file by following these instructions.',
                            title: 'Your database is corrupted'
                        })
                        .then(({ ok }) => {
                            if (!ok) return;
                            openExternalLink(
                                'https://github.com/gooseontheloose/VRCX-auto-inv/wiki#how-to-repair-vrcx-database'
                            );
                        })
                        .catch(() => {});
                }
                if (e.message.includes('database or disk is full')) {
                    modalStore.alert({
                        description: safeT(
                            'message.database.disk_space',
                            'The disk containing your database is full. Please free up disk space.'
                        ),
                        title: 'Disk containing database is full'
                    });
                }
                if (
                    e.message.includes('database is locked') ||
                    e.message.includes('attempt to write a readonly database')
                ) {
                    modalStore.alert({
                        description: 'Please close other applications that might be using the database file.',
                        title: 'Database is locked'
                    });
                }
                if (e.message.includes('disk I/O error')) {
                    modalStore.alert({
                        description: safeT(
                            'message.database.disk_error',
                            'A disk I/O error occurred while accessing the database.'
                        ),
                        title: 'Disk I/O error'
                    });
                }
            } catch (innerErr) {
                console.error('[SQLite] handleSQLiteError inner failure:', innerErr);
            }
        }
        throw e;
    }

    async execute(callback, sql, args = null) {
        try {
            if (LINUX) {
                if (args) {
                    args = new Map(Object.entries(args));
                }
                var json = await SQLite.ExecuteJson(sql, args);
                var items = JSON.parse(json);
                items.forEach((item) => {
                    callback(item);
                });
                return;
            }
            var data = await SQLite.Execute(sql, args);
            data.forEach((row) => {
                callback(row);
            });
        } catch (e) {
            this.handleSQLiteError(e);
        }
    }

    async executeNonQuery(sql, args = null) {
        try {
            if (LINUX && args) {
                args = new Map(Object.entries(args));
            }
            return await SQLite.ExecuteNonQuery(sql, args);
        } catch (e) {
            this.handleSQLiteError(e);
        }
    }
}

var self = new SQLiteService();
window.sqliteService = self;

export { self as default, SQLiteService };
