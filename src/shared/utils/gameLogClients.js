/**
 * Tracks which VRChat client wrote each output_log file, so that when
 * several clients run at once (e.g. a second account started with
 * --profile=1) VRCX follows the logged-in user's own client instead of
 * mixing both clients' events into one location and player list.
 *
 * LogWatcher emits two bookkeeping events per log file:
 * - 'user-authenticated' (userId, displayName): the account of that client
 * - 'log-closed': the client no longer has the file open (it exited)
 *
 * Events from another account's log are only dropped while a log of the
 * current user is still open. If only the other client is running, its
 * events are used as before.
 */
export function createGameLogClientTracker() {
    /** @type {Map<string, {userId: string, closed: boolean}>} */
    const files = new Map();

    function getFile(fileName) {
        let file = files.get(fileName);
        if (!file) {
            file = { userId: '', closed: false };
            files.set(fileName, file);
        }
        return file;
    }

    /**
     * Records a bookkeeping event. Returns true when the event was one.
     *
     * @param {{type: string, fileName?: string, userId?: string}} gameLog
     * @returns {boolean}
     */
    function observe(gameLog) {
        if (!gameLog || !gameLog.fileName) {
            return gameLog?.type === 'user-authenticated' || gameLog?.type === 'log-closed';
        }
        if (gameLog.type === 'user-authenticated') {
            if (gameLog.userId) {
                getFile(gameLog.fileName).userId = gameLog.userId;
            }
            return true;
        }
        if (gameLog.type === 'log-closed') {
            getFile(gameLog.fileName).closed = true;
            return true;
        }
        return false;
    }

    /**
     * @param {string} userId
     * @returns {boolean} whether a log of this user is still being written
     */
    function isClientOpen(userId) {
        if (!userId) {
            return false;
        }
        for (const file of files.values()) {
            if (file.userId === userId && !file.closed) {
                return true;
            }
        }
        return false;
    }

    /**
     * True when the event comes from another account's client while the
     * current user's own client is running, i.e. it should be ignored.
     *
     * @param {{fileName?: string}} gameLog
     * @param {string} currentUserId
     * @returns {boolean}
     */
    function isFromOtherClient(gameLog, currentUserId) {
        if (!currentUserId || !gameLog?.fileName) {
            return false;
        }
        const file = files.get(gameLog.fileName);
        if (!file || !file.userId || file.userId === currentUserId) {
            return false;
        }
        return isClientOpen(currentUserId);
    }

    function reset() {
        files.clear();
    }

    return { observe, isClientOpen, isFromOtherClient, reset, files };
}

export const gameLogClients = createGameLogClientTracker();
