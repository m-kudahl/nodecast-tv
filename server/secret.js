/**
 * Signing secret for JWTs and session cookies.
 *
 * The defaults this replaces were literals in the repository
 * ('nodecast-tv-secret-key-change-in-production' and 'keyboard cat'), so any
 * install that never set JWT_SECRET was signing tokens with a key printed in
 * public - enough to mint an admin token for it. Upstream issue #151.
 *
 * JWT_SECRET still wins if set. Otherwise one is generated on first run and kept
 * in data/, which is gitignored and already holds the credentials anyway.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(process.cwd(), 'data', 'secret.key');

function loadOrCreate() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

    try {
        const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
        if (existing.length >= 32) return existing;
    } catch {
        // no secret yet - fall through and make one
    }

    const secret = crypto.randomBytes(48).toString('hex');
    try {
        fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
        fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
        console.log('[Secret] Generated a new signing key at data/secret.key');
    } catch (err) {
        // Read-only data dir: still better than a published constant, but every
        // restart invalidates existing logins, so say so rather than fail quietly.
        console.warn('[Secret] Could not persist a signing key, using a temporary one ' +
            `(logins will not survive a restart): ${err.message}`);
    }
    return secret;
}

module.exports = loadOrCreate();
