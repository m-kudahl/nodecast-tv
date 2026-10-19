const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const cast = require('../server/routes/cast');

// A transcode session service whose cache lives in a throwaway directory.
function isolatedSessions(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-cast-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(__dirname, '../server/services/transcodeSession.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: createRequire(filename),
        process: { cwd: () => dir, env: {} }, console: { log() {}, error() {} }, setTimeout, clearTimeout,
        setInterval, clearInterval }, { filename });
    return module.exports;
}

async function serve(t, router) {
    const app = express();
    app.use('/cast-media', router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/cast-media`;
}

test('only sessions started for casting get a cast token, and lookups reject malformed tokens', async t => {
    const service = isolatedSessions(t);
    const plain = await service.createSession('http://provider.test/live', { ownerId: 1, videoMode: 'copy' });
    const casting = await service.createSession('http://provider.test/live', { ownerId: 1, videoMode: 'copy', cast: true });

    assert.equal(plain.castToken, null);
    assert.match(casting.castToken, /^[0-9a-f]{32}$/);
    assert.equal(service.getSessionByCastToken(casting.castToken), casting);
    for (const bad of [null, undefined, '', 'null', casting.castToken.toUpperCase(), casting.castToken + '0', { length: 32 }]) {
        assert.equal(service.getSessionByCastToken(bad), null, String(bad));
    }

    await service.removeSession(casting.id);
    assert.equal(service.getSessionByCastToken(casting.castToken), null);
    await service.removeSession(plain.id);
});

test('cast media serves only its own session\'s playlist and segments, cross-origin', async t => {
    const service = isolatedSessions(t);
    const session = await service.createSession('http://provider.test/live', { ownerId: 1, videoMode: 'copy', cast: true });
    const other = await service.createSession('http://provider.test/live', { ownerId: 2, videoMode: 'copy', cast: true });
    t.after(() => Promise.all([service.removeSession(session.id), service.removeSession(other.id)]));
    fs.mkdirSync(session.dir, { recursive: true });
    fs.writeFileSync(session.playlistPath, '#EXTM3U\nseg0.ts\n');
    fs.writeFileSync(path.join(session.dir, 'seg0.ts'), 'segment-bytes');
    fs.writeFileSync(path.join(path.dirname(session.dir), 'secret.txt'), 'not for the receiver');

    const base = await serve(t, cast.media(service.getSessionByCastToken));

    const playlist = await fetch(`${base}/${session.castToken}/stream.m3u8`);
    assert.equal(playlist.status, 200);
    assert.equal(playlist.headers.get('access-control-allow-origin'), '*');
    assert.match(playlist.headers.get('content-type'), /mpegurl/);
    assert.equal(await playlist.text(), '#EXTM3U\nseg0.ts\n');

    const segment = await fetch(`${base}/${session.castToken}/seg0.ts`);
    assert.equal(segment.status, 200);
    assert.equal(await segment.text(), 'segment-bytes');

    for (const url of [
        `${base}/${'0'.repeat(32)}/stream.m3u8`,         // unknown token
        `${base}/${other.castToken}/seg0.ts`,             // another session's token
        `${base}/${session.castToken}/..%2Fsecret.txt`,   // escaping the session directory
        `${base}/${session.castToken}/seg1.ts`,           // not written yet
    ]) {
        assert.equal((await fetch(url)).status, 404, url);
    }
});

test('LAN addresses skip loopback, IPv6 and interfaces a Chromecast cannot reach', () => {
    const addresses = cast.lanAddresses({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
        eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
        docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
        wg0: [{ family: 'IPv4', internal: false, address: '10.8.0.2' }],
    });
    assert.deepEqual(addresses, [{ name: 'eth0', address: '192.168.1.20' }]);
});
