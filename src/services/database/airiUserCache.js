import sqliteService from '../sqlite.js';

/**
 * Persistent cache for the AIRI integration's extra lookups (represented
 * group, bio and VRC+ flag of players seen in your instances), so returning
 * players and a VRCX restart mid-stream cost no API calls.
 *
 * Not per account: represented groups and bios are public profile data.
 * `group_fetched_at` set with an empty `group_name` means "no group".
 * `is_vrc_plus` is NULL while unknown.
 */
const TABLE = 'paw_airi_user_cache';

/**
 * @typedef {object} AiriUserCacheEntry
 * @property {string} userId
 * @property {string} groupName
 * @property {string} shortCode
 * @property {string} bio
 * @property {boolean|null} isVRCPlus
 * @property {number} groupFetchedAt
 * @property {number} bioFetchedAt
 * @property {number} lastSeenAt
 */

function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * @param {any[]} row
 * @returns {AiriUserCacheEntry}
 */
function fromRow(row) {
    return {
        userId: String(row[0]),
        groupName: typeof row[1] === 'string' ? row[1] : '',
        shortCode: typeof row[2] === 'string' ? row[2] : '',
        bio: typeof row[3] === 'string' ? row[3] : '',
        isVRCPlus:
            row[4] === null || row[4] === undefined ? null : Boolean(row[4]),
        groupFetchedAt: toInt(row[5]),
        bioFetchedAt: toInt(row[6]),
        lastSeenAt: toInt(row[7])
    };
}

const airiUserCache = {
    async initAiriUserCache() {
        await sqliteService.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${TABLE} (user_id TEXT PRIMARY KEY, group_name TEXT, short_code TEXT, bio TEXT, is_vrc_plus INTEGER, group_fetched_at INTEGER, bio_fetched_at INTEGER, last_seen_at INTEGER)`
        );
        await sqliteService.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS ${TABLE}_last_seen_idx ON ${TABLE} (last_seen_at)`
        );
    },

    /**
     * Delete rows not seen for `maxAgeMs`, then keep the newest `maxRows`.
     * @param {number} maxRows
     * @param {number} maxAgeMs
     * @param {number} now
     */
    async pruneAiriUserCache(maxRows, maxAgeMs, now) {
        await sqliteService.executeNonQuery(
            `DELETE FROM ${TABLE} WHERE last_seen_at < @cutoff`,
            { '@cutoff': toInt(now - maxAgeMs) }
        );
        await sqliteService.executeNonQuery(
            `DELETE FROM ${TABLE} WHERE user_id NOT IN (SELECT user_id FROM ${TABLE} ORDER BY last_seen_at DESC LIMIT ${toInt(maxRows)})`
        );
    },

    /**
     * The most recently seen entries, newest first.
     * @param {number} limit
     * @returns {Promise<AiriUserCacheEntry[]>}
     */
    async loadAiriUserCache(limit) {
        /** @type {AiriUserCacheEntry[]} */
        const entries = [];
        await sqliteService.execute(
            (row) => {
                entries.push(fromRow(row));
            },
            `SELECT user_id, group_name, short_code, bio, is_vrc_plus, group_fetched_at, bio_fetched_at, last_seen_at FROM ${TABLE} ORDER BY last_seen_at DESC LIMIT ${toInt(limit)}`
        );
        return entries;
    },

    /**
     * @param {AiriUserCacheEntry} entry
     */
    async saveAiriUserCacheEntry(entry) {
        await sqliteService.executeNonQuery(
            `INSERT OR REPLACE INTO ${TABLE} (user_id, group_name, short_code, bio, is_vrc_plus, group_fetched_at, bio_fetched_at, last_seen_at) VALUES (@user_id, @group_name, @short_code, @bio, @is_vrc_plus, @group_fetched_at, @bio_fetched_at, @last_seen_at)`,
            {
                '@user_id': entry.userId,
                '@group_name': entry.groupName || '',
                '@short_code': entry.shortCode || '',
                '@bio': entry.bio || '',
                '@is_vrc_plus':
                    typeof entry.isVRCPlus === 'boolean'
                        ? Number(entry.isVRCPlus)
                        : null,
                '@group_fetched_at': toInt(entry.groupFetchedAt),
                '@bio_fetched_at': toInt(entry.bioFetchedAt),
                '@last_seen_at': toInt(entry.lastSeenAt)
            }
        );
    }
};

export { airiUserCache };
