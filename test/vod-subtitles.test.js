process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { spawnSync } = require('node:child_process'), { createRequire } = require('node:module');
const express = require('express');
const processDiagnostics = [];
function route(file) {
    const filename = path.join(__dirname, '../server/routes', file), realRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, URL, setTimeout, clearTimeout, console: { log() {}, error() {} },
        require: id => id === 'child_process' ? { spawn: (...args) => {
            const child = realRequire(id).spawn(...args); let stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            child.on('close', code => { if (code && stderr) processDiagnostics.push(stderr); });
            return child;
        } } : id === '../db' ? { settings: { get: async () => ({}) }, getUserAgent: () => 'Fixture' } : realRequire(id) }, { filename });
    return module.exports;
}

test('Watch VOD probes expose real embedded subtitles for HLS and remux, align seeks, and reset on content changes',
    { skip: process.env.NODECAST_BROWSER_TESTS === '1' ? false : 'Browser tests enabled in CI', timeout: 60000 }, async t => {
        const { chromium } = require('playwright');
        const binary = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffmpeg' : require('ffmpeg-static');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-vod-subs-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        for (const language of ['English', 'French']) fs.writeFileSync(path.join(dir, language + '.srt'),
            `1\n00:00:01,000 --> 00:00:04,000\n${language} early\n\n2\n00:00:08,000 --> 00:00:11,000\n${language} late\n`);
        const run = args => { const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 15000 }); assert.equal(result.status, 0, result.stderr); };
        const movie = path.join(dir, 'movie.mkv');
        run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
            '-i', path.join(dir, 'English.srt'), '-i', path.join(dir, 'French.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
            '-t', '12', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-c:s', 'srt',
            '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English', '-metadata:s:s:1', 'language=fra', '-metadata:s:s:1', 'title=French', movie]);
        const direct = path.join(dir, 'direct.mp4');
        run(['-i', movie, '-map', '0', '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text', direct]);
        for (const [name, offset] of [['video', '0'], ['seek', '6']]) run(['-ss', offset, '-i', movie, '-map', '0:v', '-map', '0:a', '-c', 'copy',
            '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, name + '%d.ts'), path.join(dir, name + '.m3u8')]);
        const scripts = ['/js/components/CaptionTracks.js', '/js/components/HlsAudioRecovery.js', '/js/components/PlaybackProbe.js',
            '/js/components/VodDuration.js', '/js/pages/WatchPage.js'], root = path.join(__dirname, '../public');
        const app = express(), requests = [];
        app.locals.ffmpegPath = binary;
        app.locals.ffprobePath = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffprobe' : require('@ffprobe-installer/ffprobe').path;
        app.use((req, res, next) => { requests.push(req.url); next(); });
        app.get('/', (req, res) => res.type('html').send(`<video muted></video><div id="list"></div><div id="menu"></div><div id="ui"></div><script src="/hls.js"></script>${scripts.map(src => `<script src="${src}"></script>`).join('')}`));
        app.get('/hls.js', (req, res) => res.type('js').send(fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'))));
        for (const file of scripts) app.get(file, (req, res) => res.type('js').send(fs.readFileSync(path.join(root, file))));
        for (const name of ['/movie.mkv', '/movie.ts']) app.get(name, (req, res) => res.type('video/x-matroska').send(fs.readFileSync(movie)));
        app.get('/direct.mp4', (req, res) => res.sendFile(direct));
        app.use('/api/probe', route('probe.js')); app.use('/api/subtitle', route('subtitle.js')); app.use('/api/remux', route('remux.js'));
        app.use(express.static(dir));
        const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const browser = await chromium.launch({ headless: true, executablePath: process.env.NODECAST_BROWSER_EXECUTABLE || undefined });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.address().port}`, page = await browser.newPage(), errors = [];
        const browserMessages = [];
        page.on('console', message => browserMessages.push(message.text()));
        page.on('pageerror', error => errors.push(error.message));
        if (process.env.NODECAST_BROWSER_DEBUG) page.on('console', message => console.log('VOD browser:', message.text()));
        await page.goto(base);
        await page.evaluate(() => {
            window.API = { settings: { get: async () => window.settings } };
            window.settings = { autoTranscode: true };
            const ui = document.querySelector('#ui'), watch = window.watch = Object.create(WatchPage.prototype);
            Object.assign(watch, { video: document.querySelector('video'), captionsList: document.querySelector('#list'), captionsMenu: document.querySelector('#menu'),
                overlay: ui, nowPlaying: ui, content: { type: 'movie' }, resumeTime: 0, stopHistoryTracking() {}, saveProgress() {}, hideNowPlaying() {},
                showLoading() {}, updateTranscodeStatus() {}, updateQualityBadge() {}, setVolumeFromStorage() {},
                getHlsConfig: () => ({ enableWorker: false }),
                stopTranscodeSession() { this.currentSessionId = null; this.playbackTimeOffset = 0; },
                async startTranscodeSession(url, options) {
                    this.currentSessionId = 'fixture'; this.currentTranscodeOptions = options; this.playbackTimeOffset = options.seekOffset || 0;
                    return this.playbackTimeOffset ? '/seek.m3u8' : '/video.m3u8';
                } });
        });
        await page.evaluate(base => window.watch.loadVideo(base + '/movie.mkv'), base);
        await page.waitForFunction(() => document.querySelectorAll('#list button').length === 3, null, { timeout: 10000 }).catch(async error => {
            console.error('VOD state:', await page.evaluate(() => ({ src: window.watch.video.src, probe: window.watch.getCaptionTracks().probe, hls: !!window.watch.hls, list: document.querySelector('#list').textContent })), errors, requests); throw error;
        });
        assert.deepEqual(await page.locator('#list button').allTextContents(), ['Off', 'English', 'French']);
        assert.equal(requests.some(url => url.startsWith('/api/subtitle')), false, 'Unselected subtitles must not open provider connections');
        await page.locator('#list button').nth(2).click();
        await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && track.cues?.length === 2));
        await page.evaluate(() => { window.watch.video.pause(); window.watch.video.currentTime = 2; });
        await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && Array.from(track.activeCues || []).some(cue => cue.text === 'French early')));
        await page.evaluate(() => window.watch.seekToContentTime(6));
        await page.waitForFunction(() => window.watch.hls?.url?.endsWith('/seek.m3u8') && document.querySelectorAll('#list button').length === 3);
        await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && Array.from(track.cues || []).some(cue => cue.text === 'French late' && cue.startTime > 1.9 && cue.startTime < 2.1)));
        await page.evaluate(() => { window.watch.video.pause(); window.watch.video.currentTime = 3; });
        await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && Array.from(track.activeCues || []).some(cue => cue.text === 'French late')));
        // Reversing an offset restores original timings, including cues clipped by a forward seek.
        await page.evaluate(() => { window.watch.getCaptionTracks().setTimeOffset(0); window.watch.video.currentTime = 2; });
        await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && Array.from(track.activeCues || []).some(cue => cue.text === 'French early')));
        for (const settings of [{ autoTranscode: false, forceTranscode: true }, { autoTranscode: false, forceRemux: true }, { autoTranscode: true }, { autoTranscode: true, direct: true }]) {
            await page.evaluate(async ({ base, settings }) => {
                window.settings = settings;
                const original = window.watch.playbackProbe.read.bind(window.watch.playbackProbe);
                if (settings.autoTranscode && !settings.direct) window.watch.playbackProbe.read = async (...args) => ({ ...await original(...args), needsTranscode: false, needsRemux: true });
                await window.watch.loadVideo(base + (settings.direct ? '/direct.mp4' : '/movie.ts')); window.watch.playbackProbe.read = original;
            }, { base, settings });
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 3 && window.watch.video.readyState >= 2, null, { timeout: 10000 }).catch(async error => {
                console.error('Playback mode failure:', settings, await page.evaluate(() => ({ ready: window.watch.video.readyState, src: window.watch.video.src,
                    mediaError: window.watch.video.error?.message, probe: window.watch.getCaptionTracks().probe,
                    list: document.querySelector('#list').textContent, hls: !!window.watch.hls })), browserMessages, processDiagnostics, requests);
                throw error;
            });
            assert.equal(await page.locator('video > track').count(), 2);
            await page.locator('#list button').nth(2).click();
            await page.waitForFunction(() => Array.from(window.watch.video.textTracks).some(track => track.mode === 'showing' && Array.from(track.cues || []).some(cue => cue.text === 'French early' && cue.startTime > 0.9 && cue.startTime < 1.1)), null, { timeout: 10000 }).catch(async error => { console.error('Caption mode:', settings, await page.evaluate(() => ({ offset: window.watch.getCaptionTracks().timeOffset, probe: window.watch.getCaptionTracks().probe, tracks: Array.from(window.watch.video.textTracks, track => ({ label: track.label, mode: track.mode, cues: Array.from(track.cues || [], cue => ({ text: cue.text, start: cue.startTime, end: cue.endTime })) })) }))); throw error; });
        }
        await page.evaluate(async base => { window.settings = {}; await window.watch.loadVideo(base + '/video.m3u8'); }, base);
        await page.waitForFunction(() => window.watch.getCaptionTracks().manifestReady && document.querySelectorAll('#list button').length === 1);
        assert.equal(await page.locator('video > track').count(), 0); assert.deepEqual(errors, []);
        await page.evaluate(() => window.watch.stop()); await page.close();
    });
