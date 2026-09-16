// ffmpeg argument checks for the transcode session. Run: node test_transcode_args.js
const assert = require('assert');
const { TranscodeSession } = require('./server/services/transcodeSession');

const argsFor = opts => new TranscodeSession('http://example.test/live.m3u8', {
    videoMode: 'copy', videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6, ...opts
}).buildFFmpegArgs();

const flag = (args, name) => args[args.indexOf(name) + 1];

// Live rolls a window and never writes an endlist, so one channel can't fill the disk.
const live = argsFor({ isLive: true });
assert.strictEqual(flag(live, '-hls_list_size'), '20');
assert.match(flag(live, '-hls_flags'), /delete_segments/);
assert.match(flag(live, '-hls_flags'), /omit_endlist/);

// VOD keeps every segment - the player seeks within the list.
const vod = argsFor({ isLive: false });
assert.strictEqual(flag(vod, '-hls_list_size'), '0');
assert.doesNotMatch(flag(vod, '-hls_flags'), /delete_segments/);

// Copying video must not force keyframes - there is no encoder to ask.
assert.ok(!live.includes('-force_key_frames'));

// Encoding must, or the encoder's own 10s GOP decides segment length and
// -hls_time 4 is silently ignored.
const enc = argsFor({ isLive: true, videoMode: 'encode', hwEncoder: 'software' });
assert.strictEqual(flag(enc, '-force_key_frames'), 'expr:gte(t,n_forced*4)');
assert.strictEqual(flag(enc, '-c:v'), 'libx264');

// Bitrate is capped, and capped to the source rather than the max-resolution setting.
assert.strictEqual(flag(enc, '-maxrate'), '8000k');          // 1080p default cap
const sd = argsFor({ isLive: true, videoMode: 'encode', hwEncoder: 'software', videoHeight: 576 });
assert.strictEqual(flag(sd, '-maxrate'), '2500k');

// 5.1 AC3 gets downmixed to stereo AAC; stereo AAC is passed through untouched.
assert.strictEqual(flag(live, '-c:a'), 'aac');
const aac = argsFor({ isLive: true, audioCodec: 'aac', audioChannels: 2 });
assert.strictEqual(flag(aac, '-c:a'), 'copy');

console.log('ok');
