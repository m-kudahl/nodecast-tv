const test = require('node:test');
const assert = require('node:assert/strict');
const { TranscodeSession } = require('../server/services/transcodeSession');
const { verifyEncoder } = require('../server/services/hwDetect');

const argsFor = opts => new TranscodeSession('http://example.test/live.m3u8', {
    videoMode: 'copy', videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6, ...opts
}).buildFFmpegArgs();
const flag = (args, name) => args[args.indexOf(name) + 1];

test('live rolls a segment window; VOD keeps every segment for seeking', () => {
    const live = argsFor({ isLive: true });
    assert.equal(flag(live, '-hls_list_size'), '6');
    assert.match(flag(live, '-hls_flags'), /delete_segments/);
    assert.match(flag(live, '-hls_flags'), /omit_endlist/);

    const vod = argsFor({ isLive: false });
    assert.equal(flag(vod, '-hls_list_size'), '0');
    assert.doesNotMatch(flag(vod, '-hls_flags'), /delete_segments/);
});

test('encoding forces keyframes on segment boundaries and caps bitrate to the source', () => {
    // Copying video has no encoder to ask for keyframes.
    assert.ok(!argsFor({ isLive: true }).includes('-force_key_frames'));

    // Otherwise the encoder's own 10s GOP decides segment length and -hls_time 4 is ignored.
    const enc = argsFor({ isLive: true, videoMode: 'encode', hwEncoder: 'software' });
    assert.equal(flag(enc, '-force_key_frames'), 'expr:gte(t,n_forced*4)');
    assert.equal(flag(enc, '-c:v'), 'libx264');
    assert.equal(flag(enc, '-maxrate'), '8000k'); // 1080p default cap

    const sd = argsFor({ isLive: true, videoMode: 'encode', hwEncoder: 'software', videoHeight: 576 });
    assert.equal(flag(sd, '-maxrate'), '2500k');
});

test('5.1 AC3 is downmixed to stereo AAC; stereo AAC passes through', () => {
    assert.equal(flag(argsFor({ isLive: true }), '-c:a'), 'aac');
    assert.equal(flag(argsFor({ isLive: true, audioCodec: 'aac', audioChannels: 2 }), '-c:a'), 'copy');
});

test('hardware encoders are verified by a test encode, not inferred from a device node', async () => {
    // Issue #87: render node present, Mesa VPE broken, black screen and no fallback.
    assert.equal(await verifyEncoder('vaapi', '/dev/dri/renderD999'), false);
    assert.equal(await verifyEncoder('software'), true);
});
