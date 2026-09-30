/**
 * No-op telemetry module: what `@paw/telemetry` resolves to in every build that does not
 * include the private telemetry module (forks, local builds, PR/CI builds). Same exports as
 * the real module; it sends nothing and stores nothing.
 */

export const available = false;

/** @type {null | { toggleLabel: string; toggleDescription: string; notice: string; learnMore: string }} */
export const messages = null;

/**
 * @param {object} _context
 * @returns {Promise<void>}
 */
export function start(_context) {
    return Promise.resolve();
}

/**
 * @param {boolean} _value
 * @returns {Promise<void>}
 */
export function setEnabled(_value) {
    return Promise.resolve();
}

/** @returns {boolean} */
export function isEnabled() {
    return false;
}

/**
 * @param {string} _name
 * @param {number} [_amount]
 */
export function countUsage(_name, _amount = 1) {}
