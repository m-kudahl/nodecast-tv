const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parse, parseStreaming } = require('../server/services/m3uParser');

const ORDINARY = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="news.one" group-title="News",News One',
    'http://provider.test/news1.ts',
    '#EXTINF:-1 group-title="Sports",Sports One',
    'http://provider.test/sports1.ts',
    ''
].join('\n');

// Enigma2/OpenWebif bouquet export: program tags, no group-title
const PROGRAM_TAGGED = [
    '#EXTM3U',
    '#EXTVLCOPT:http-reconnect=true',
    '#EXTINF:-1 tvg-id="1:0:1:65:65:53:CE40000:0:0:0:",RTP1',
    '#EXTVLCOPT:program=101',
    'http://receiver.test:8001/1:0:1:65:65:53:CE40000:0:0:0:',
    '#EXTINF:-1 tvg-id="1:0:1:66:65:53:CE40000:0:0:0:",RTP2',
    '#EXTVLCOPT:program=102',
    'http://receiver.test:8001/1:0:1:66:65:53:CE40000:0:0:0:',
    '#EXTINF:-1 tvg-id="untagged",Untagged',
    'http://receiver.test:8001/untagged',
    ''
].join('\n');

async function collect(input, batchSize) {
    const batches = [];
    for await (const batch of parseStreaming(input, batchSize)) batches.push(batch);
    return batches;
}

for (const [label, toInput] of [['string', text => text], ['stream', text => Readable.from([text])]]) {
    test(`streaming parser imports ordinary playlists without program tags (${label} input)`, async () => {
        const batches = await collect(toInput(ORDINARY));
        const channels = batches.flatMap(batch => batch.channels);
        assert.equal(batches.at(-1).isLast, true);
        assert.deepEqual(channels.map(c => [c.name, c.groupTitle, c.url, c.program]), [
            ['News One', 'News', 'http://provider.test/news1.ts', null],
            ['Sports One', 'Sports', 'http://provider.test/sports1.ts', null]
        ]);
        assert.deepEqual([...batches.at(-1).groups], ['News', 'Sports']);
    });

    test(`streaming parser keeps program tags per channel (${label} input)`, async () => {
        const channels = (await collect(toInput(PROGRAM_TAGGED))).flatMap(batch => batch.channels);
        assert.deepEqual(channels.map(c => [c.name, c.groupTitle, c.program]), [
            ['RTP1', 'Uncategorized', '101'],
            ['RTP2', 'Uncategorized', '102'],
            ['Untagged', 'Uncategorized', null]
        ]);
    });
}

test('streaming parser does not leak program state between batches or into globals', async () => {
    const batches = await collect(PROGRAM_TAGGED, 1);
    assert.deepEqual(batches.filter(b => b.channels.length).map(b => b.channels[0].program), ['101', '102', null]);
    assert.equal('currentVlcProgram' in globalThis, false);
});

test('full parser matches the streaming parser for ordinary and program-tagged playlists', async () => {
    for (const playlist of [ORDINARY, PROGRAM_TAGGED]) {
        const { channels } = await parse(playlist);
        const streamed = (await collect(playlist)).flatMap(batch => batch.channels);
        assert.deepEqual(channels, streamed);
    }
});
