// Stall-escalation check for the live player watchdog. Run: node test_watchdog.js
const assert = require('assert');
const StallWatchdog = require('./public/js/stallWatchdog.js');
const act = StallWatchdog.action;

// Nothing happens while the stall is short.
assert.strictEqual(act(2000, false, null), null);

// Visible tab escalates kick -> recover -> reload, each step only once.
assert.strictEqual(act(4000, false, null), 'kick');
assert.strictEqual(act(6000, false, 'kick'), null);
assert.strictEqual(act(10000, false, 'kick'), 'recover');
assert.strictEqual(act(12000, false, 'recover'), null);
assert.strictEqual(act(16000, false, 'recover'), 'reload');

// A stall that jumps straight past a threshold (throttled timers) still escalates.
assert.strictEqual(act(60000, false, null), 'reload');

// Hidden tab: nudge only, never tear the stream down and re-probe.
assert.strictEqual(act(4000, true, null), 'kick');
assert.strictEqual(act(60000, true, null), null);
assert.strictEqual(act(60000, true, 'kick'), null);

// --- tick() drives the right recovery on a fake video ---
const calls = [];
const video = { currentTime: 5, paused: false, ended: false, seeking: false };
global.document = { hidden: false };
const wd = new StallWatchdog(() => video, {
    kick: () => { calls.push('kick'); },
    recover: () => { calls.push('recover'); },
    reload: () => { calls.push('reload'); }
});

wd.tick();                                   // first sample
for (let i = 0; i < 9; i++) wd.tick();       // 18s frozen
assert.deepStrictEqual(calls, ['kick', 'recover', 'reload']);

// Once it advances again the escalation starts over from clean.
video.currentTime = 6;
wd.tick();
assert.strictEqual(wd.stalledMs, 0);
assert.strictEqual(wd.lastAction, null);

// A paused video is not a stalled video.
video.paused = true;
for (let i = 0; i < 20; i++) wd.tick();
assert.deepStrictEqual(calls, ['kick', 'recover', 'reload']);

console.log('ok');
