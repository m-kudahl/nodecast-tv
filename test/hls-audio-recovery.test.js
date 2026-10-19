const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const HlsAudioRecovery = require('../public/js/components/HlsAudioRecovery');
const events = { FRAG_CHANGED: 'fragment', DESTROYING: 'destroying', MEDIA_ATTACHED: 'attached', MANIFEST_LOADING: 'manifest-loading' };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture(t, chromium = true) {
    let current = true, now = 10000;
    const video = new EventEmitter();
    Object.assign(video, { currentTime: 83.5, paused: false, volume: 0.6, muted: true, playbackRate: 1.25,
        addEventListener: video.on.bind(video), removeEventListener: video.off.bind(video),
        play: async () => { video.paused = false; video.plays++; },
        pause: () => { video.paused = true; }, plays: 0 });
    const hls = new EventEmitter();
    hls.config = { startPosition: -1 };
    hls.positions = [];
    hls.recoverMediaError = () => { hls.positions.push(hls.config.startPosition); video.pause(); hls.emit(events.MEDIA_ATTACHED); };
    const recovery = new HlsAudioRecovery(hls, video, events, () => current, { chromium, now: () => now });
    t.after(() => recovery.dispose());
    return { recovery, hls, video, fragment: (cc, sn = 1) => hls.emit(events.FRAG_CHANGED, 'fragment', { frag: { cc, sn } }),
        advance: time => { now += time; }, supersede: () => { current = false; } };
}

test('Chromium resets once at each played discontinuity, preserving time and playback settings', async t => {
    const f = fixture(t);
    f.fragment(0); f.fragment(0); f.fragment(0, 'initSegment');
    await tick();
    assert.deepEqual(f.hls.positions, []);
    f.fragment(1); f.fragment(1);
    assert.deepEqual(f.hls.positions, [], 'do not detach inside HLS event dispatch');
    await tick();
    assert.deepEqual(f.hls.positions, [83.5]);
    assert.equal(f.hls.config.startPosition, -1);
    assert.equal(f.video.paused, false);
    assert.deepEqual([f.video.volume, f.video.muted, f.video.playbackRate], [0.6, true, 1.25]);
    f.fragment(1);
    await tick();
    assert.equal(f.hls.positions.length, 1, 'reattachment does not create a recovery loop');
    f.advance(3000); f.video.currentTime = 89;
    f.fragment(2);
    await tick();
    assert.deepEqual(f.hls.positions, [83.5, 89]);
});

test('Firefox skips proactive discontinuity resets but supports requested media-error recovery', async t => {
    const f = fixture(t, false);
    f.fragment(0); f.fragment(1);
    await tick();
    assert.deepEqual(f.hls.positions, []);
    assert.equal(f.recovery.requestRecovery('media error'), true);
    await tick();
    assert.deepEqual(f.hls.positions, [83.5]);
});

test('paused boundaries wait for playback and error recovery does not start paused video', async t => {
    const f = fixture(t);
    f.video.pause();
    f.fragment(0); f.fragment(1);
    await tick();
    assert.deepEqual(f.hls.positions, []);
    f.video.paused = false; f.video.emit('playing');
    await tick();
    assert.equal(f.hls.positions.length, 1);
    f.advance(3000); f.video.pause();
    f.recovery.requestRecovery('media error');
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.video.plays, 1);
});

test('superseded or destroyed players cancel queued recovery and late attachment callbacks', async t => {
    const f = fixture(t);
    f.fragment(0); f.fragment(1);
    f.supersede();
    await tick();
    assert.deepEqual(f.hls.positions, []);
    const other = fixture(t);
    other.hls.recoverMediaError = () => { other.video.pause(); };
    other.recovery.requestRecovery('media error');
    await tick();
    const late = other.hls.listeners(events.MEDIA_ATTACHED)[0];
    other.hls.emit(events.DESTROYING);
    late();
    assert.equal(other.video.plays, 0);
    assert.equal(other.hls.config.startPosition, -1);
    assert.equal(other.video.listenerCount('playing'), 0);
    assert.equal(other.hls.listenerCount(events.MEDIA_ATTACHED), 0);
});

test('cooldown and retry budget bound frequent discontinuities and media errors', async t => {
    const f = fixture(t);
    assert.equal(f.recovery.requestRecovery('media error'), true);
    assert.equal(f.recovery.requestRecovery('media error'), true, 'coalesce simultaneous requests');
    await tick();
    assert.equal(f.recovery.requestRecovery('media error'), false);
    for (let i = 0; i < 2; i++) { f.advance(3000); f.recovery.requestRecovery('media error'); await tick(); }
    f.advance(3000);
    assert.equal(f.recovery.requestRecovery('media error'), false);
    assert.equal(f.hls.positions.length, 3);
    f.advance(30000);
    assert.equal(f.recovery.requestRecovery('media error'), true);
    await tick();
    assert.equal(f.hls.positions.length, 4);
});

test('loading a new manifest cancels old recovery and establishes a fresh discontinuity baseline', async t => {
    const f = fixture(t);
    f.fragment(0); f.fragment(1);
    f.hls.emit(events.MANIFEST_LOADING);
    await tick();
    assert.deepEqual(f.hls.positions, []);
    f.fragment(20);
    await tick();
    assert.deepEqual(f.hls.positions, []);
    f.fragment(21);
    await tick();
    assert.deepEqual(f.hls.positions, [83.5]);
});

for (const name of ['VideoPlayer', 'WatchPage']) {
    test(`${name} recovers append errors on the active instance and cancels superseded errors`, async () => {
        const window = {};
        class Hls extends EventEmitter {
            static Events = { ...events, ERROR: 'error', MANIFEST_PARSED: 'manifest',
                SUBTITLE_TRACKS_UPDATED: 'subtitles', SUBTITLE_TRACK_SWITCH: 'switch',
                NON_NATIVE_TEXT_TRACKS_FOUND: 'non-native', CUES_PARSED: 'cues' };
            static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
            constructor(config) { super(); this.config = config; this.positions = []; }
            loadSource() {} attachMedia() {}
            destroy() { this.emit(events.DESTROYING); }
            recoverMediaError() { this.positions.push(this.config.startPosition); this.emit(events.MEDIA_ATTACHED); }
        }
        const file = name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js';
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), {
            window, Hls, HlsAudioRecovery, CaptionTracks: require('../public/js/components/CaptionTracks'), console
        });
        const player = Object.create(window[name].prototype);
        Object.assign(player, { playbackGeneration: 1, video: { currentTime: 42, paused: false,
            play: async () => {}, pause() {}, querySelectorAll: () => [] } });
        player.playHls('/api/transcode/session/playlist.m3u8');
        const active = player.hls;
        const error = { type: 'media', fatal: false, details: 'bufferAppendError' };
        active.emit('error', 'error', error);
        await tick();
        assert.deepEqual(active.positions, [42]);
        const obsoleteHandler = active.listeners('error')[0];
        active.emit('error', 'error', error);
        player.playbackGeneration++;
        player.playHls('/api/transcode/replacement/playlist.m3u8');
        obsoleteHandler('error', { ...error, fatal: true });
        await tick();
        assert.deepEqual(player.hls.positions, []);
        assert.equal(player.hls.config.startPosition, undefined);
        player.hls.destroy();
    });
}
