const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

test('Chromium plays program/ad/program audio with decoder resets at played boundaries',
    { skip: process.env.NODECAST_BROWSER_TESTS !== '1' ? 'Browser tests enabled in CI' : false, timeout: 90000 }, async t => {
        const { chromium } = require('playwright');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-ad-audio-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        let binary = 'ffmpeg';
        if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0) binary = require('ffmpeg-static');
        const files = new Map();
        const manifest = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
        for (let phase = 0; phase < 3; phase++) {
            const rate = phase === 1 ? 44100 : 48000;
            const channels = phase === 1 ? 2 : 6;
            const generated = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10',
                '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${rate}`, '-t', '3',
                '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '10',
                '-c:a', 'aac', '-ar', String(rate), '-ac', String(channels), '-b:a', '160k',
                '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
                '-hls_segment_filename', path.join(dir, `phase${phase}-%d.ts`), path.join(dir, `phase${phase}.m3u8`)],
            { encoding: 'utf8', timeout: 15000 });
            assert.equal(generated.status, 0, generated.stderr);
            if (phase) manifest.push('#EXT-X-DISCONTINUITY');
            const lines = fs.readFileSync(path.join(dir, `phase${phase}.m3u8`), 'utf8').trim().split(/\r?\n/);
            for (const line of lines) {
                if (line.startsWith('#EXTINF:')) manifest.push(line);
                else if (line.endsWith('.ts')) { manifest.push('/' + line); files.set('/' + line, fs.readFileSync(path.join(dir, line))); }
            }
        }
        manifest.push('#EXT-X-ENDLIST');
        const root = path.join(__dirname, '../public');
        const scripts = ['/js/components/CaptionTracks.js', '/js/components/HlsAudioRecovery.js',
            '/js/components/PlaybackProbe.js', '/js/components/PlayerFullscreen.js', '/js/components/VideoPlayer.js', '/js/pages/WatchPage.js'];
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://fixture.test');
            const send = (type, data) => { res.writeHead(200, { 'Content-Type': type }); res.end(data); };
            if (url.pathname === '/') return send('text/html', `<video></video><div id="ui"></div><div id="list"></div><script src="/hls.js"></script>${scripts.map(src => `<script src="${src}"></script>`).join('')}`);
            if (url.pathname === '/hls.js') return send('application/javascript', fs.readFileSync(require.resolve('hls.js/dist/hls.min.js')));
            if (scripts.includes(url.pathname)) return send('application/javascript', fs.readFileSync(path.join(root, url.pathname)));
            if (url.pathname === '/ads.m3u8') return send('application/vnd.apple.mpegurl', manifest.join('\n') + '\n');
            if (url.pathname === '/api/subtitle') return send('text/vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:09.000\nTest caption\n\n');
            if (files.has(url.pathname)) return send('video/mp2t', files.get(url.pathname));
            res.writeHead(404); res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
            executablePath: process.env.NODECAST_BROWSER_EXECUTABLE || undefined });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const name of ['VideoPlayer', 'WatchPage']) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(base);
            await page.evaluate(async ({ name, base }) => {
                const ui = document.getElementById('ui');
                const video = document.querySelector('video');
                const player = window.player = Object.create(window[name].prototype);
                Object.assign(player, { video, settings: {}, currentUrl: `${base}/ads.m3u8`, playbackGeneration: 1,
                    captionsList: document.getElementById('list'), captionsMenu: ui, overlay: ui, nowPlaying: ui,
                    stopTranscodeSession() {}, stopHistoryTracking() {}, saveProgress() {}, hideNowPlaying() {},
                    updateTranscodeStatus() {}, updateNowPlaying() {}, showNowPlayingOverlay() {}, fetchEpgData() {},
                    showError(message) { throw Error(message); } });
                const context = window.audioContext = new AudioContext();
                const analyser = context.createAnalyser();
                analyser.fftSize = 4096;
                context.createMediaElementSource(video).connect(analyser);
                analyser.connect(context.destination);
                await context.resume();
                window.measurements = { recoveries: [], tones: [], formats: [], played: [], errors: [] };
                let cc = 0;
                if (name === 'VideoPlayer') await player.play({ id: 'fixture', name: 'Ad fixture' }, `${base}/ads.m3u8`);
                else player.playHls(`${base}/ads.m3u8`);
                player.getCaptionTracks().setProbe({ subtitles: [{ index: 1, title: 'Extracted', language: 'en' }] }, 'http://provider.test/source');
                const hls = player.hls;
                const recover = hls.recoverMediaError.bind(hls);
                hls.recoverMediaError = () => { window.measurements.recoveries.push({ time: video.currentTime, cc }); recover(); };
                hls.on(Hls.Events.FRAG_CHANGED, (event, data) => { cc = data.frag.cc; window.measurements.played.push({ cc, time: video.currentTime }); });
                hls.on(Hls.Events.FRAG_PARSING_INIT_SEGMENT, (event, data) => {
                    if (data.tracks.audio) window.measurements.formats.push({ cc: data.frag.cc, channels: data.tracks.audio.metadata.channelCount });
                });
                hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal) window.measurements.errors.push(data.details); });
                const bins = new Float32Array(analyser.frequencyBinCount);
                window.sampleTimer = setInterval(() => {
                    if (video.paused || video.readyState < 3) return;
                    analyser.getFloatFrequencyData(bins);
                    let peak = 0;
                    for (let i = 10; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
                    if (bins[peak] > -65) window.measurements.tones.push({ cc, time: video.currentTime,
                        frequency: peak * context.sampleRate / analyser.fftSize,
                        captions: Array.from(video.textTracks).some(track => track.mode === 'showing' && track.activeCues?.length > 0) });
                }, 100);
            }, { name, base });
            await page.waitForFunction(() => document.querySelectorAll('#list button').length === 2);
            await page.locator('#list button').nth(1).click();
            await page.waitForFunction(() => window.player.video.ended, null, { timeout: 30000 });
            const measured = await page.evaluate(() => { clearInterval(window.sampleTimer); return window.measurements; });
            assert.deepEqual(errors, [], name);
            assert.deepEqual(measured.errors, [], `${name}: ${JSON.stringify(measured)}`);
            assert.equal(measured.recoveries.length, 2, `${name}: ${JSON.stringify(measured)}`);
            assert.deepEqual(measured.recoveries.map(item => item.cc), [1, 2]);
            assert.ok(measured.recoveries[0].time >= 2.9 && measured.recoveries[1].time >= 5.9, 'recover at playback, not when ads prebuffer');
            for (const period of [0, 1, 2]) {
                assert.ok(measured.formats.some(format => format.cc === period && format.channels === (period === 1 ? 2 : 6)));
                const tones = measured.tones.filter(sample => sample.cc === period && sample.time % 3 > 0.5 && sample.time % 3 < 2.5);
                assert.ok(tones.length > 0, `${name}: missing audio in period ${period}: ${JSON.stringify(measured)}`);
                assert.ok(tones.every(sample => Math.abs(sample.frequency - 1000) < 100), `${name}: wrong pitch in period ${period}: ${JSON.stringify(tones)}`);
                assert.ok(tones.some(sample => sample.captions), `${name}: captions lost in period ${period}`);
            }
            await page.evaluate(() => { window.player.stop(); window.audioContext.close(); });
            await page.close();
        }
    });
