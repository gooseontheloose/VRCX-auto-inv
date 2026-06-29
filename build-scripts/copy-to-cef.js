/* global __dirname, require, process */
// Copies build/html → build/Cef/html so the local CEF app picks up the latest frontend.
// Run automatically as part of `npm run prod`.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'html');
const dst = path.join(root, 'build', 'Cef', 'html');

if (!fs.existsSync(src)) {
    console.error(`[copy-to-cef] Source not found: ${src}`);
    process.exit(1);
}

if (!fs.existsSync(path.join(root, 'build', 'Cef'))) {
    console.log('[copy-to-cef] build/Cef does not exist — skipping copy (CI environment).');
    process.exit(0);
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

// Wipe destination first so stale files don't linger.
if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
}

copyDir(src, dst);
console.log(`[copy-to-cef] Copied build/html → build/Cef/html`);
