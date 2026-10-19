process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const cp = require('node:child_process');
const express = require('express');
const PlaybackProbe = require('../public/js/components/PlaybackProbe');
const { ProbeLeases, parseProbeLease } = require('../server/services/probeLeases');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 300; n++) { if (fn()) return; await delay(10); } throw Error('Fixture condition timed out'); }
function router(spawn) {
    const filename = path.join(__dirname, '../server/routes/probe.js'), realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, URL, console: { log() {}, error() {} }, setTimeout, clearTimeout,
        require: name => name === 'child_process' ? { spawn } : realRequire(name) }, { filename });
    return module.exports;
}
async function serve(t, app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('probe leases reject invalid and late sequences, serialize cleanup and isolate accounts', async () => {
    for (const query of [{ probeLeaseId: 'short', requestSequence: '1' }, { probeLeaseId: 'a'.repeat(16) },
        { probeLeaseId: ['a'.repeat(16)], requestSequence: '1' }, { probeLeaseId: 'a'.repeat(16), requestSequence: '1e2' },
        { probeLeaseId: 'a'.repeat(16), requestSequence: '0' }]) assert.throws(() => parseProbeLease(query));
    assert.equal(parseProbeLease({}), null);
    const leases = new ProbeLeases(), signal = new AbortController().signal, id = 'a'.repeat(16);
    let release, aborted = false, secondStarted = false;
    const first = leases.run(1, { id, sequence: 1 }, signal, async s => {
        s.addEventListener('abort', () => { aborted = true; });
        await new Promise(resolve => { release = resolve; });
    });
    await until(() => release);
    const second = leases.run(1, { id, sequence: 2 }, signal, async () => { secondStarted = true; });
    await leases.run(2, { id, sequence: 1 }, signal, async () => 'independent');
    assert.equal(aborted, true); assert.equal(secondStarted, false);
    await assert.rejects(leases.run(1, { id, sequence: 1 }, signal, async () => assert.fail('Late request ran')), { name: 'AbortError' });
    release(); await Promise.all([first, second]); assert.equal(secondStarted, true);
    await assert.rejects(leases.run(1, { id, sequence: 2 }, signal, async () => {}), { name: 'AbortError' });
});

test('browser probe cancels response bodies and retains program, user agent and increasing sequence', async () => {
    const requests = []; let body;
    const probe = new PlaybackProbe(async (url, options) => {
        requests.push({ url: new URL(url, 'http://app'), options });
        return { ok: true, json: () => requests.length === 1 ? new Promise(resolve => { body = resolve; }) : Promise.resolve({ audio: 'aac' }) };
    });
    const first = probe.read('http://provider/old'); const rejected = assert.rejects(first, { name: 'AbortError' });
    await until(() => body);
    assert.deepEqual(await probe.read('http://provider/new', { program: '102', userAgent: 'Custom Agent' }), { audio: 'aac' });
    assert.equal(requests[0].options.signal.aborted, true); body({ audio: 'mp3' }); await rejected;
    const query = requests[1].url.searchParams;
    assert.equal(query.get('program'), '102'); assert.equal(query.get('ua'), 'Custom Agent');
    assert.equal(query.get('requestSequence'), '2'); assert.equal(query.get('probeLeaseId'), requests[0].url.searchParams.get('probeLeaseId'));
});

test('probe route waits for child close before cached replacements or timeout fallback and does not cache cancellations', async t => {
    const children = [], info = { streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mpegts' } };
    const app = express(); app.locals.ffprobePath = 'fixture'; app.locals.probeTimeoutMs = 150;
    app.use((req, res, next) => { req.user = { id: req.headers['x-owner'] || 1 }; next(); });
    app.use('/api/probe', router((binary, args) => {
        const child = new EventEmitter(); Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), url: args.at(-1), closed: false });
        child.kill = () => { child.killed = true; setTimeout(() => { child.closed = true; child.emit('close', null); }, 50); return true; };
        children.push(child);
        if (!child.url.includes('stall')) setImmediate(() => { child.stdout.emit('data', JSON.stringify(info)); child.closed = true; child.emit('close', 0); });
        return child;
    }));
    const base = await serve(t, app), lease = 'abcdef0123456789';
    const request = (url, seq, options) => fetch(base + '/api/probe?' + new URLSearchParams({ url, probeLeaseId: lease, requestSequence: String(seq) }), options);
    assert.equal((await request('http://provider/cached', 1)).status, 200);
    const old = request('http://provider/stall', 2); await until(() => children.length === 2);
    const cached = request('http://provider/cached', 3); await until(() => children[1].killed);
    assert.equal(children[1].closed, false);
    assert.equal((await old).status, 409); assert.equal(children[1].closed, true);
    assert.equal((await cached).status, 200); assert.equal(children.length, 2);
    assert.equal((await request('http://provider/stall', 2)).status, 409); assert.equal(children.length, 2);
    // Cancellation did not create a cached unknown-codec fallback.
    const disconnected = new AbortController(), pending = request('http://provider/stall', 4, { signal: disconnected.signal });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    await until(() => children.length === 3); disconnected.abort(); await rejection;
    await until(() => children[2].closed);
    const started = Date.now(), timeout = await request('http://provider/stall', 5);
    assert.equal(children.length, 4); assert.equal(children[3].closed, true);
    assert.ok(Date.now() - started >= 190); assert.match((await timeout.json()).error, /timeout/);
    // A different account can use its own sequence even with the same lease identifier.
    assert.equal((await request('http://provider/cached', 1, { headers: { 'x-owner': '2' } })).status, 200);
    for (const query of ['probeLeaseId[]=abc&requestSequence=1', 'probeLeaseId=abcdefghijklmnop&requestSequence=0', 'ua[]=a']) {
        assert.equal((await fetch(base + '/api/probe?url=http://provider/a&' + query)).status, 400);
    }
});

test('real FFprobe releases stalled provider connections on replacement, Stop and timeout', { timeout: 15000 }, async t => {
    const ffprobe = cp.spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffprobe' : require('@ffprobe-installer/ffprobe').path;
    const app = express(), children = []; let active = 0, maxActive = 0;
    app.locals.ffprobePath = ffprobe; app.locals.probeTimeoutMs = 700;
    app.get('/stall/:id', (req, res) => {
        active++; maxActive = Math.max(active, maxActive); res.once('close', () => active--);
        res.set('Content-Type', 'video/mp2t'); res.flushHeaders();
    });
    app.use('/api/probe', router((...args) => {
        assert.equal(children.filter(child => !child.closed).length, 0, 'New probe started before old process closed');
        const child = cp.spawn(...args); children.push(child); child.on('close', () => { child.closed = true; }); return child;
    }));
    t.after(() => { for (const child of children) if (!child.closed) child.kill('SIGKILL'); });
    const base = await serve(t, app), probe = new PlaybackProbe((url, options) => fetch(base + url, options));
    const first = probe.read(base + '/stall/first'); const firstRejected = assert.rejects(first, { name: 'AbortError' });
    await until(() => active === 1);
    const second = probe.read(base + '/stall/second'); const secondRejected = assert.rejects(second, { name: 'AbortError' });
    await firstRejected; await until(() => children.length === 2 && active === 1);
    probe.cancel(); await secondRejected; await until(() => active === 0 && children.every(child => child.closed));
    const fallback = await probe.read(base + '/stall/timeout');
    assert.match(fallback.error, /timeout/); await until(() => active === 0);
    assert.ok(children.every(child => child.closed)); assert.equal(maxActive, 1);
});
