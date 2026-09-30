/* global __dirname, require, process */
// Clones (or updates) the private paw-telemetry repo into ./telemetry-private so a local
// `npm run prod` / `npm run dev` includes the telemetry module. Uses your own git credentials;
// without access to that repo, builds simply use the no-op stub.
//
//   npm run telemetry:link              clone or pull
//   PAW_TELEMETRY_REPO=<url> npm run telemetry:link   another remote (e.g. an SSH URL)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'telemetry-private');
const repo = process.env.PAW_TELEMETRY_REPO || 'https://github.com/gooseontheloose/paw-telemetry.git';

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
    execFileSync('git', args, { cwd, stdio: 'inherit' });
}

try {
    if (fs.existsSync(path.join(target, '.git'))) {
        console.log(`[telemetry:link] updating ${target}`);
        git(['pull', '--ff-only'], target);
    } else if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
        console.error(`[telemetry:link] ${target} exists but is not a git checkout; move it away first.`);
        process.exit(1);
    } else {
        console.log(`[telemetry:link] cloning ${repo} into ${target}`);
        git(['clone', '--depth', '1', repo, target], root);
    }
} catch {
    console.error('[telemetry:link] git failed (no access to the private repo?). Builds will use the no-op stub.');
    process.exit(1);
}

const entry = path.join(target, 'client', 'index.js');
if (!fs.existsSync(entry)) {
    console.error(`[telemetry:link] ${entry} is missing; is this the right repo?`);
    process.exit(1);
}
console.log('[telemetry:link] done: vite builds now include the telemetry module.');
