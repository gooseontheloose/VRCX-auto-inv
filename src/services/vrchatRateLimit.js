/**
 * Tells interested stores that VRChat answered HTTP 429 to any request made
 * through services/request.js, so every sender can back off together (the
 * AIRI integration pauses its lookups and friend actions). Kept free of store
 * imports so request.js can use it without an import cycle.
 */

/** @type {Set<(endpoint: string) => void>} */
const listeners = new Set();

/**
 * @param {(endpoint: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onVrchatRateLimit(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * @param {string} [endpoint]
 */
export function notifyVrchatRateLimit(endpoint = '') {
    for (const listener of listeners) {
        try {
            listener(endpoint);
        } catch (err) {
            console.warn('[vrchatRateLimit] listener failed', err);
        }
    }
}
