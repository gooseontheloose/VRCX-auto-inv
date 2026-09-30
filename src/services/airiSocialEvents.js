/**
 * Forwards VRChat websocket messages (boops, invites, friend presence) to the
 * AIRI integration's social event buffer (GET /paw/events). Kept free of
 * store imports so websocket.js can use it without an import cycle.
 */

/** @type {Set<(type: string, content: any) => void>} */
const listeners = new Set();

/**
 * @param {(type: string, content: any) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onAiriSocialEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const FORWARDED_TYPES = new Set([
    'notification',
    'notification-v2',
    'friend-online',
    'friend-offline',
    'friend-location',
    'friend-add',
    'friend-delete'
]);

/**
 * @param {string} type websocket message type
 * @param {any} content parsed content
 */
export function forwardAiriSocialEvent(type, content) {
    if (!FORWARDED_TYPES.has(type) || !listeners.size) {
        return;
    }
    for (const listener of listeners) {
        try {
            listener(type, content);
        } catch (err) {
            console.warn('[airiSocialEvents] listener failed', err);
        }
    }
}
