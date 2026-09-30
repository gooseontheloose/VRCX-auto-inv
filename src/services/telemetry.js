/**
 * Plug-in point for anonymous usage stats.
 *
 * `@paw/telemetry` is a build-time alias (src/vite.config.js): official release builds point it
 * at the private telemetry module (telemetry-private/client, or PAW_TELEMETRY_DIR); every other
 * build gets ./telemetryStub.js, which sends nothing. `__PAW_TELEMETRY__` tells which one it is.
 *
 * Call sites only ever pass a counter name and a number.
 */
export { available, countUsage, getInstallId, isEnabled, messages, setEnabled, start } from '@paw/telemetry';
