/**
 * Chromecast support, server side.
 *
 * The browser drives casting (public/js/cast.js); the Chromecast then fetches the
 * media itself. That gives the server two jobs:
 *
 * - api: tell a browser opened on localhost which LAN address the Chromecast can
 *   reach us on, since 'localhost' on the Chromecast means the Chromecast.
 * - media: serve a cast transcode session's HLS to the receiver. The receiver runs
 *   on Google's origin and can't carry our login cookie, so it presents the
 *   session's cast token instead - minted only for sessions started for casting,
 *   and good for that one session's playlist and segments, nothing else.
 */
const express = require('express');
const os = require('os');

// Interfaces a Chromecast on the local network can't reach us over.
const UNREACHABLE_INTERFACE = /^(docker|br-|veth|tun|tap|virbr|zt|wg)/;

function lanAddresses(nets = os.networkInterfaces()) {
    const addresses = [];
    for (const [name, ifaces] of Object.entries(nets)) {
        if (UNREACHABLE_INTERFACE.test(name)) continue;
        for (const iface of ifaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) addresses.push({ name, address: iface.address });
        }
    }
    return addresses;
}

/** Authenticated: mount under /api/cast. */
function api(port) {
    const router = express.Router();
    router.get('/host', (req, res) => res.json({ addresses: lanAddresses(), port }));
    return router;
}

/** Unauthenticated, token-gated: mount at /cast-media. */
function media(getSessionByCastToken) {
    const router = express.Router();
    router.get('/:token/:file', async (req, res) => {
        // Cross-origin fetch from the receiver - without this it sits on "loading" forever.
        res.setHeader('Access-Control-Allow-Origin', '*');
        const session = getSessionByCastToken(req.params.token);
        if (!session) return res.sendStatus(404);

        if (req.params.file === 'stream.m3u8') {
            const playlist = await session.getPlaylist();
            if (!playlist) return res.sendStatus(404);
            return res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(playlist);
        }
        // getSegment() only accepts segNNN.ts names, so no path can escape the session dir.
        const segment = await session.getSegment(req.params.file);
        if (!segment) return res.sendStatus(404);
        res.type('video/MP2T').set('Cache-Control', 'no-store').sendFile(segment);
    });
    return router;
}

module.exports = { api, media, lanAddresses };
