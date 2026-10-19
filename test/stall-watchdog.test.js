const test = require('node:test');
const assert = require('node:assert');
const StallWatchdog = require('../public/js/stallWatchdog.js');

const act = StallWatchdog.action;

test('stall escalation: kick -> recover -> reload, once each; hidden tabs only kick', () => {
    assert.strictEqual(act(2000, false, null), null);
    assert.strictEqual(act(4000, false, null), 'kick');
    assert.strictEqual(act(6000, false, 'kick'), null);
    assert.strictEqual(act(10000, false, 'kick'), 'recover');
    assert.strictEqual(act(12000, false, 'recover'), null);
    assert.strictEqual(act(16000, false, 'recover'), 'reload');
    // A stall that jumps past a threshold (throttled timers) still escalates.
    assert.strictEqual(act(60000, false, null), 'reload');
    assert.strictEqual(act(4000, true, null), 'kick');
    assert.strictEqual(act(60000, true, null), null);
    assert.strictEqual(act(60000, true, 'kick'), null);
});

function fixture(t) {
    const calls = [];
    const video = { currentTime: 5, paused: false, ended: false, seeking: false };
    const hidden = t.mock.method(StallWatchdog, 'hidden', () => false);
    const wd = new StallWatchdog(() => video, {
        kick: () => calls.push('kick'),
        recover: () => calls.push('recover'),
        reload: () => calls.push('reload')
    });
    return { calls, video, hidden, wd };
}

test('tick() drives recovery on a frozen video and ignores a paused one', t => {
    const { calls, video, wd } = fixture(t);
    wd.tick();
    for (let i = 0; i < 9; i++) wd.tick(); // 18s frozen
    assert.deepStrictEqual(calls, ['kick', 'recover', 'reload']);

    video.currentTime = 6;
    wd.tick();
    assert.strictEqual(wd.stalledMs, 0);
    assert.strictEqual(wd.lastAction, null);

    video.paused = true;
    for (let i = 0; i < 20; i++) wd.tick();
    assert.deepStrictEqual(calls, ['kick', 'recover', 'reload']);
});

test('fatal() reloads, defers while hidden, and gives up after 3 straight failures', t => {
    const { calls, video, hidden, wd } = fixture(t);
    assert.strictEqual(wd.fatal(), true);
    assert.deepStrictEqual(calls, ['reload']);

    // Hidden (another workspace/monitor): no reload until visible again.
    hidden.mock.mockImplementation(() => true);
    assert.strictEqual(wd.fatal(), true);
    assert.deepStrictEqual(calls, ['reload']);
    assert.strictEqual(wd.reloadOnVisible, true);

    assert.strictEqual(wd.fatal(), true);
    assert.strictEqual(wd.fatal(), false); // 4th straight failure: let the caller show an error

    // Playback advancing clears the failure count.
    wd.tick();
    video.currentTime = 7;
    hidden.mock.mockImplementation(() => false);
    wd.tick();
    assert.strictEqual(wd.fatalCount, 0);
});

test('a stream the user starts gets a fresh fatal-retry budget', t => {
    const { calls, wd } = fixture(t);
    for (let i = 0; i < 3; i++) wd.fatal();
    assert.strictEqual(wd.fatal(), false); // previous channel gave up
    wd.newStream();
    assert.strictEqual(wd.fatal(), true);
    assert.strictEqual(calls.filter(c => c === 'reload').length, 4);
});
