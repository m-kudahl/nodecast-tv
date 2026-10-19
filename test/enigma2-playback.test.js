process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const express = require('express');
const { parseProgram } = require('../server/services/mpegTsProgram');

function playerFixture(name, settings, fetcher) {
    const requests = [], sessions = [];
    const window = { dispatchEvent() {} };
    const document = { getElementById() { return null; }, removeEventListener() {} };
    const probe = { video: 'h264', audio: 'aac', audioChannels: 2, audioCodecs: ['aac'], needsRemux: true };
    const context = { window, document, AbortController, setTimeout, clearTimeout, CustomEvent: class {},
        PlaybackProbe: require('../public/js/components/PlaybackProbe'), CaptionTracks: require('../public/js/components/CaptionTracks'),
        VodDuration: require('../public/js/components/VodDuration'), console: { log() {}, warn() {}, error() {} },
        API: { settings: { get: async () => settings } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (fetcher) return fetcher(url, options);
            return { ok: true, json: async () => url.includes('/zap') ? { success: true } : probe };
        } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js'), 'utf8'), context);
    const player = Object.create(window[name].prototype);
    const element = { classList: { add() {}, remove() {} } };
    Object.assign(player, { settings, content: { data: { program: '102' } }, video: { src: '', play: async () => {}, pause() {}, load() {}, querySelectorAll: () => [] },
        overlay: element, nowPlaying: element, updateTranscodeStatus() {}, updateQualityBadge() {},
        updateNowPlaying() {}, showNowPlayingOverlay() {}, fetchEpgData() {}, setVolumeFromStorage() {}, showLoading() {},
        stopHistoryTracking() {}, saveProgress() {},
        playHls(url) { this.video.src = url; }, showError(message) { throw Error(message); },
        startTranscodeSession: async (url, options) => { sessions.push({ url, options }); return '/api/session/stream.m3u8'; }
    });
    return { player, requests, sessions, context, start: () => name === 'VideoPlayer'
        ? player.play({ id: 'service', program: '102' }, 'http://receiver/multi.ts') : player.loadVideo('http://receiver/multi.ts') };
}

for (const name of ['VideoPlayer', 'WatchPage']) {
    for (const mode of ['autoTranscode', 'forceRemux', 'default', 'forceTranscode', 'forceVideoTranscode']) {
        test(`${name} selects the requested program in ${mode} mode`, async () => {
            const f = playerFixture(name, mode === 'default' ? {} : { [mode]: true });
            await f.start();
            for (const { url } of f.requests.filter(request => request.url.startsWith('/api/probe'))) {
                assert.equal(new URL(url, 'http://app').searchParams.get('program'), '102');
            }
            if (name === 'WatchPage' || mode === 'forceTranscode' || mode === 'forceVideoTranscode') {
                assert.equal(f.sessions.length, 1);
                assert.equal(f.sessions[0].options.program, '102');
            } else {
                const remux = new URL(f.player.video.src, 'http://app');
                assert.equal(remux.pathname, '/api/remux');
                assert.equal(remux.searchParams.get('program'), '102');
                assert.equal(remux.searchParams.get('audioCodecs'), 'aac');
            }
        });
    }
}

test('Stop cancels the actual zap delay without starting playback', async () => {
    let requested;
    const request = new Promise(resolve => { requested = resolve; });
    const f = playerFixture('VideoPlayer', { forceVideoTranscode: true }, async (url, options) => {
        requested(options.signal);
        return { ok: true, json: async () => ({ success: true }) };
    });
    const playing = f.player.play({ streamId: 'service', sourceId: 1, zapBeforeStreaming: true, zapDelay: 10000 }, 'http://receiver/multi.ts');
    const signal = await request;
    f.player.stop();
    await playing;
    assert.equal(signal.aborted, true);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.player.video.src, '');
});

function navigationFixture(f) {
    Object.assign(f.context.document, { addEventListener() {}, querySelectorAll: () => [] });
    f.context.history = { pushState() {}, replaceState() {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8') + ';window.TestApp = App;', f.context);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/LivePage.js'), 'utf8'), f.context);
    const app = Object.create(f.context.window.TestApp.prototype);
    app.player = f.player;
    app.channelList = { channels: [{}] };
    app.pages = { live: new f.context.window.LivePage(app) };
    app.currentPage = 'live';
    return app;
}

test('browsing the guide and catalogs preserves Live TV playback and its session', async () => {
    const f = playerFixture('VideoPlayer', { forceVideoTranscode: true });
    await f.start();
    let released = 0;
    f.player.playbackSessions = { stop() { released++; } };
    f.player.currentSessionId = 'live-session';
    const source = f.player.video.src, generation = f.player.playbackGeneration;
    const app = navigationFixture(f);
    for (const page of ['guide', 'movies', 'series']) {
        app.navigateTo('live');
        app.navigateTo(page);
        assert.equal(f.player.video.src, source);
        assert.equal(f.player.currentSessionId, 'live-session');
        assert.equal(f.player.playbackGeneration, generation);
    }
    assert.equal(released, 0);
});

test('browsing during a zap delay lets the selected live channel start normally', async () => {
    let requested;
    const ready = new Promise(resolve => { requested = resolve; });
    const f = playerFixture('VideoPlayer', { forceVideoTranscode: true }, async (url, options) => {
        requested(options.signal);
        return { ok: true, json: async () => ({ success: true }) };
    });
    const playing = f.player.play({ streamId: 'service', sourceId: 1, zapBeforeStreaming: true, zapDelay: 0 }, 'http://receiver/multi.ts');
    const signal = await ready;
    navigationFixture(f).navigateTo('guide');
    assert.equal(signal.aborted, false);
    await playing;
    assert.equal(f.sessions.length, 1);
    assert.equal(f.player.video.src, '/api/session/stream.m3u8');
});

test('Stop cancels an in-flight zap request and releases the old session before retuning', async () => {
    let requested, released = false;
    const ready = new Promise(resolve => { requested = resolve; });
    const f = playerFixture('VideoPlayer', { forceVideoTranscode: true }, (url, { signal }) => {
        assert.equal(released, true);
        requested();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('Cancelled'), { name: 'AbortError' })), { once: true }));
    });
    f.player.playbackSessions = { stop() { released = true; } };
    const playing = f.player.play({ streamId: 'service', sourceId: 1, zapBeforeStreaming: true }, 'http://receiver/multi.ts');
    await ready;
    f.player.stop();
    await playing;
    assert.equal(f.sessions.length, 0);
});

test('an older zap completing after the latest selection cannot replace its playback', async () => {
    const f = playerFixture('VideoPlayer', { forceVideoTranscode: true });
    const releases = {};
    f.player.zapBeforeStreaming = channel => new Promise(resolve => { releases[channel.id] = resolve; });
    const old = f.player.play({ id: 'old', zapBeforeStreaming: true }, 'http://receiver/old.ts');
    const latest = f.player.play({ id: 'latest', zapBeforeStreaming: true }, 'http://receiver/latest.ts');
    releases.latest(); await latest;
    releases.old(); await old;
    assert.deepEqual(f.sessions.map(session => session.url), ['http://receiver/latest.ts']);
    assert.equal(f.player.currentChannel.id, 'latest');
});

function routeFixture(file) {
    const filename = path.join(__dirname, '../server/routes', file);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const context = { module, URL, console: { log() {}, error() {} }, setTimeout, clearTimeout,
        require(id) { return id === '../db' ? { settings: { get: async () => ({}) }, getUserAgent: () => 'fixture' } : realRequire(id); } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { router: module.exports, context };
}

test('program validation rejects malformed/structured inputs and probing selects only the requested service', () => {
    for (const value of ['', [], ['102'], {}, true, -1, 0, 65536, '102:a', '1e2', ' 102', 1.5]) assert.throws(() => parseProgram(value));
    assert.equal(parseProgram(undefined), null);
    assert.equal(parseProgram(102), '102');
    const { context } = routeFixture('probe.js');
    const first = [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 64 }, { index: 1, codec_type: 'audio', codec_name: 'mp3', channels: 1 }];
    const second = [{ index: 2, codec_type: 'video', codec_name: 'hevc', width: 96 }, { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2 }];
    const input = { streams: [...first, ...second], programs: [{ program_id: 101, streams: first }, { program_id: 102, streams: second }], format: { format_name: 'mpegts' } };
    const info = context.analyzeProbeResult(input, 'http://receiver/multi.ts', '102');
    assert.equal(info.video, 'hevc'); assert.equal(info.width, 96); assert.equal(info.audioChannels, 2);
    assert.deepEqual(Array.from(info.audioCodecs), ['aac']);
    assert.equal(info.needsTranscode, true);
    assert.throws(() => context.analyzeProbeResult(input, 'http://receiver/multi.ts', '103'), /not found/);
});

test('real FFmpeg probes, remuxes and transcodes only the requested MPEG-TS program', { timeout: 60000 }, async t => {
    const binary = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffmpeg' : require('ffmpeg-static');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-program-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'multi.ts');
    const run = args => { const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 15000, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result; };
    run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000',
        '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=10', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '12',
        '-map', '0:v', '-map', '1:a', '-map', '2:v', '-map', '3:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '10',
        '-c:a:0', 'libmp3lame', '-c:a:1', 'aac', '-program', 'program_num=101:st=0:st=1', '-program', 'program_num=102:st=2:st=3', '-f', 'mpegts', source]);
    const media = fs.readFileSync(source);
    const probe = routeFixture('probe.js');
    const app = express();
    app.locals.ffprobePath = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
        ? 'ffprobe' : require('@ffprobe-installer/ffprobe').path;
    app.locals.ffmpegPath = binary;
    app.get('/multi.ts', (req, res) => res.end(media));
    app.use('/api/probe', probe.router); app.use('/api/remux', routeFixture('remux.js').router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = encodeURIComponent(base + '/multi.ts');
    for (const [program, width, audio] of [['102', 96, 'aac'], ['101', 64, 'mp3'], ['102', 96, 'aac']]) {
        const response = await fetch(`${base}/api/probe?url=${url}&program=${program}`);
        assert.equal(response.status, 200);
        const info = await response.json(); assert.equal(info.width, width, JSON.stringify(info)); assert.deepEqual(info.audioCodecs, [audio]);
        const remux = await fetch(`${base}/api/remux?url=${url}&program=${program}&audioCodecs=${audio}`);
        assert.equal(remux.status, 200);
        const output = path.join(dir, `program${program}.mp4`); fs.writeFileSync(output, Buffer.from(await remux.arrayBuffer()));
        const details = spawnSync(app.locals.ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' });
        assert.equal(details.status, 0, details.stderr);
        const streams = JSON.parse(details.stdout).streams;
        assert.equal(streams.filter(stream => stream.codec_type === 'video').length, 1);
        assert.equal(streams.find(stream => stream.codec_type === 'video').width, width);
        assert.deepEqual(streams.filter(stream => stream.codec_type === 'audio').map(stream => stream.codec_name), [audio]);
        run(['-i', output, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
    }
    for (const endpoint of ['probe', 'remux']) {
        for (const query of ['program=102&program=101', 'program[x]=102', 'program=65536', 'program=102:a']) {
            assert.equal((await fetch(`${base}/api/${endpoint}?url=${url}&${query}`)).status, 400);
        }
    }
    // Encode the requested service using the actual session argument builder.
    const filename = path.join(__dirname, '../server/services/transcodeSession.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: createRequire(filename), process: { env: {}, cwd: () => dir }, console,
        setTimeout, clearTimeout, setInterval, clearInterval });
    const session = new module.exports.TranscodeSession(base + '/multi.ts', { program: '102', videoMode: 'encode', videoHeight: 64, audioCodec: 'aac', audioChannels: 2, quality: 'low', audioMixPreset: 'auto' });
    fs.mkdirSync(session.dir, { recursive: true });
    // Spawn asynchronously so the fixture HTTP server can deliver input while FFmpeg is running.
    const { spawn } = require('node:child_process');
    await new Promise((resolve, reject) => {
        const child = spawn(binary, session.buildFFmpegArgs()); let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(Error('Session encode timed out')); }, 15000);
        child.stderr.on('data', data => { stderr += data; }); child.on('error', reject);
        child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(stderr)); });
    });
    assert.ok(fs.existsSync(session.playlistPath));
    const output = spawnSync(app.locals.ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', session.playlistPath], { encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).streams.find(stream => stream.codec_type === 'video').width, 96);
});

for (const name of ['VideoPlayer', 'WatchPage']) {
    for (const mode of ['autoTranscode', 'forceTranscode', 'forceRemux']) {
        test(`${name} ${mode} cancels probes on Stop and replacement playback`, async () => {
            for (const replace of [false, true]) {
                const probes = [];
                const f = playerFixture(name, { [mode]: true }, (url, options) => {
                    probes.push({ url, options });
                    if (probes.length > 1) return Promise.resolve({ ok: true, json: async () => ({ audio: 'aac', audioCodecs: ['aac'], needsRemux: true }) });
                    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('Stopped'), { name: 'AbortError' })), { once: true }));
                });
                const first = f.start();
                while (probes.length === 0) await new Promise(resolve => setImmediate(resolve));
                if (replace) await f.start(); else f.player.stop();
                await first;
                assert.equal(probes[0].options.signal.aborted, true);
                if (replace) {
                    assert.equal(probes.length, 2);
                    assert.equal(new URL(probes[1].url, 'http://app').searchParams.get('requestSequence'), '2');
                    assert.equal(name === 'WatchPage' || mode === 'forceTranscode' ? f.sessions.length : Number(f.player.video.src !== ''), 1);
                } else { assert.equal(f.sessions.length, 0); assert.equal(f.player.video.src, ''); }
            }
        });
    }
}

test('browsing away from Live TV preserves its in-flight metadata probe and starts playback', async () => {
    let signal, finish;
    const f = playerFixture('VideoPlayer', { forceRemux: true }, (url, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ audioCodecs: ['aac'] }) }); });
    });
    const playing = f.start(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    const app = navigationFixture(f); app.navigateTo('guide');
    assert.equal(signal.aborted, false); finish(); await playing;
    assert.equal(new URL(f.player.video.src, 'http://app').pathname, '/api/remux');
});
