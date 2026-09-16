// Stream URL validation. Run: node test_safeurl.js
const assert = require('assert');
const { parseStreamUrl } = require('./server/safeUrl');

// http(s) passes through normalised.
assert.strictEqual(parseStreamUrl('http://p.test/a.m3u8'), 'http://p.test/a.m3u8');
assert.strictEqual(parseStreamUrl('https://p.test/a'), 'https://p.test/a');

// Everything ffmpeg can use to read the server's own filesystem is refused.
for (const bad of ['file:///etc/passwd', 'concat:/etc/passwd', 'subfile,,start,0,end,100,:///etc/passwd',
                   'data:text/plain,x', 'ftp://p.test/a', 'not a url', '']) {
    assert.throws(() => parseStreamUrl(bad), /Only http\(s\)|Invalid URL/, `should refuse: ${bad}`);
}

console.log('ok');
