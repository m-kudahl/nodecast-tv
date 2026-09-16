/**
 * Stream URL validation for anything that gets handed to ffmpeg/ffprobe.
 *
 * ffmpeg speaks far more than http: file:, concat:, subfile:, data: and friends
 * all work, so a `url` parameter that reaches it unchecked is a local file read.
 * Upstream PR #144 fixed this for /api/subtitle; probe, remux and transcode take
 * the same parameter and had the same hole, and none of them require a login.
 */

// Everything an http(s) stream needs, and nothing that touches the filesystem.
const PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto';

/**
 * @returns {string} the normalised URL, safe to pass to ffmpeg
 * @throws {Error} if it is not an http(s) URL
 */
function parseStreamUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http(s) URLs are allowed');
    }
    return parsed.href;
}

/**
 * Express helper: validates req.query.url / req.body.url, answering 400 itself
 * if it is bad. Returns null when it has already responded.
 */
function requireStreamUrl(url, res) {
    try {
        return parseStreamUrl(url);
    } catch (err) {
        res.status(400).json({ error: err.message });
        return null;
    }
}

module.exports = { parseStreamUrl, requireStreamUrl, PROTOCOL_WHITELIST };
