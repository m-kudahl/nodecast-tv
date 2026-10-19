// Regressions found in review of the fork's own changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const load = (file, context = {}) => {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), { window, ...context });
    return window;
};

test('a watchdog reload of a session-backed movie resumes at content time, not session time', async () => {
    const { WatchPage } = load('pages/WatchPage.js', { VodDuration: require('../public/js/components/VodDuration') });
    const watch = Object.create(WatchPage.prototype);
    let resumedAt;
    Object.assign(watch, {
        content: { title: 'Film' }, currentUrl: 'http://provider.test/movie',
        currentSessionId: 'session', playbackTimeOffset: 3600, video: { currentTime: 300 },
        async loadVideo() { resumedAt = this.resumeTime; }, showNowPlaying() {}, startHistoryTracking() {}
    });
    await watch.reloadCurrentVideo();
    assert.equal(resumedAt, 3900);
});

test('the current programme falls back to now-playing data when the loaded full guide has nothing for now', () => {
    const { EpgGuide } = load('components/EpgGuide.js', { document: { addEventListener() {} } });
    const guide = Object.create(EpgGuide.prototype);
    const hour = 3600 * 1000, now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    Object.assign(guide, {
        fullEpgLoaded: true,
        channels: [{ id: 'dr1', name: 'DR1' }],
        // A guide loaded more than a day ago: every programme in it has ended.
        programmesByChannel: new Map([['dr1', [{ title: 'Old', start: iso(now - 30 * hour), stop: iso(now - 29 * hour) }]]]),
        nowByChannel: new Map([['dr1', { title: 'Now', start: iso(now - hour), stop: iso(now + hour) }]])
    });
    guide._indexChannels();
    assert.equal(guide.getCurrentProgram('dr1', 'DR1')?.title, 'Now');
});
