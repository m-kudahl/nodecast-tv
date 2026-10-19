const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

function fullscreenFixture(name) {
    const window = {}, document = { querySelector: () => player.container };
    const helper = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/components/PlayerFullscreen.js'), 'utf8'), {
        module: helper, console: { error() {} }, document
    });
    const file = name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js';
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), {
        window, document, PlayerFullscreen: helper.exports
    });
    const player = Object.create(window[name].prototype);
    player.container = {}; player.video = {};
    return { player, document };
}

for (const name of ['VideoPlayer', 'WatchPage']) {
    test(`${name} supports standard, prefixed and native-video fullscreen without invoking disabled APIs`, async () => {
        const scenarios = [
            { doc: { fullscreenEnabled: true }, container: 'requestFullscreen', expected: 'standard' },
            { doc: { fullscreenEnabled: false, webkitFullscreenEnabled: true }, container: 'webkitRequestFullscreen', expected: 'prefixed' },
            { doc: { fullscreenEnabled: false, webkitFullscreenEnabled: false }, native: true, expected: 'native' },
            { doc: {}, native: true, expected: 'native' },
            { doc: { fullscreenElement: {} }, exit: 'exitFullscreen', expected: 'exit' },
            { doc: { webkitFullscreenElement: {} }, exit: 'webkitExitFullscreen', expected: 'exit' },
            { doc: {}, nativeExit: true, expected: 'exit-native' }
        ];
        for (const scenario of scenarios) {
            const { player, document } = fullscreenFixture(name), calls = [];
            Object.assign(document, scenario.doc);
            if (scenario.container) player.container[scenario.container] = () => { calls.push(scenario.expected); return Promise.resolve(); };
            if (scenario.exit) document[scenario.exit] = () => { calls.push('exit'); };
            if (scenario.native) {
                player.container.requestFullscreen = () => { throw Error('Disabled element API used'); };
                player.container.webkitRequestFullscreen = () => { throw Error('Disabled prefixed API used'); };
                player.video.webkitEnterFullscreen = () => { calls.push('native'); };
            }
            if (scenario.nativeExit) Object.assign(player.video, { webkitDisplayingFullscreen: true, webkitExitFullscreen() { calls.push('exit-native'); } });
            const result = player.toggleFullscreen();
            assert.deepEqual(calls, [scenario.expected], 'invoke during the originating user gesture');
            assert.equal(await result, true);
        }
        const rejected = fullscreenFixture(name);
        rejected.document.fullscreenEnabled = true;
        rejected.player.container.requestFullscreen = () => Promise.reject(Error('Fullscreen denied'));
        assert.equal(await rejected.player.toggleFullscreen(), false, 'handle rejected promises');
        const missing = fullscreenFixture(name);
        assert.equal(await missing.player.toggleFullscreen(), false, 'missing API is harmless');
    });
}

const browserEnabled = process.env.NODECAST_BROWSER_TESTS === '1';

test('login prevents native GET credential leaks after missing or failed scripts and still supports setup/login',
    { skip: browserEnabled ? false : 'Browser tests enabled in CI', timeout: 45000 }, async t => {
        const { chromium } = require('playwright');
        const source = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
        const requests = [];
        let mode = 'normal', setup = true;
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://fixture');
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    requests.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] });
                    res.setHeader('Content-Type', 'application/json');
                    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(400); res.end('{"error":"JavaScript required"}'); return; }
                    if (url.pathname === '/api/auth/setup') setup = false;
                    res.writeHead(url.pathname.endsWith('/setup') ? 201 : 200); res.end('{}');
                });
                return;
            }
            requests.push({ method: req.method, url: req.url });
            if (url.pathname === '/api/auth/setup-required') {
                res.setHeader('Content-Type', 'application/json');
                if (mode === 'unavailable') { res.writeHead(503); res.end('{"error":"Unavailable"}'); }
                else res.end(JSON.stringify({ setupRequired: setup }));
                return;
            }
            res.setHeader('Content-Type', 'text/html');
            if (url.pathname === '/') { res.end('<p>Main app</p>'); return; }
            const html = mode === 'broken' ? source.replace('// Start SSO Login', "throw Error('Fixture script failed');\n        // Start SSO Login") : source;
            res.end(html);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const base = `http://127.0.0.1:${server.address().port}`;
        const browser = await chromium.launch({ headless: true, executablePath: process.env.NODECAST_BROWSER_EXECUTABLE || undefined });
        t.after(() => browser.close());
        for (const scenario of ['no-js', 'broken']) {
            mode = scenario === 'broken' ? 'broken' : 'normal';
            const context = await browser.newContext({ javaScriptEnabled: scenario !== 'no-js' });
            const page = await context.newPage();
            page.on('pageerror', () => {});
            await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
            await page.goto(base + '/login.html');
            assert.equal(await page.locator('#username').getAttribute('autocapitalize'), 'none');
            assert.equal(await page.locator('#username').getAttribute('autocorrect'), 'off');
            assert.equal(await page.locator('#username').getAttribute('spellcheck'), 'false');
            await page.fill('#username', 'fixture-user'); await page.fill('#password', 'fixture-password');
            assert.equal(await page.locator('#submit-btn').isDisabled(), true);
            await page.locator('#password').press('Enter');
            assert.equal(new URL(page.url()).pathname, '/login.html');
            // Even direct native form.submit() must put credentials in a POST body, never a URL.
            const sent = page.waitForRequest(request => request.method() === 'POST');
            await page.evaluate(() => document.getElementById('login-form').submit());
            const request = await sent;
            assert.equal(new URL(request.url()).pathname, '/api/auth/login');
            assert.equal(new URL(request.url()).search, '');
            assert.equal(new URLSearchParams(request.postData()).get('username'), 'fixture-user');
            await context.close();
        }
        mode = 'unavailable';
        const failed = await browser.newPage();
        await failed.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await failed.goto(base + '/login.html');
        await failed.waitForFunction(() => document.querySelector('#error-message').textContent.includes('Reload'));
        assert.equal(await failed.locator('#submit-btn').isDisabled(), true);
        await failed.close();
        mode = 'normal';
        for (const endpoint of ['/api/auth/setup', '/api/auth/login']) {
            const page = await browser.newPage();
            await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
            await page.goto(base + '/login.html');
            await page.waitForFunction(() => !document.querySelector('#submit-btn').disabled);
            assert.equal(await page.locator('#submit-btn').textContent(), endpoint.endsWith('setup') ? 'Create Account' : 'Sign In');
            assert.equal(await page.locator('#username').getAttribute('autocapitalize'), 'none');
            assert.equal(await page.locator('#username').getAttribute('autocorrect'), 'off');
            assert.equal(await page.locator('#username').getAttribute('spellcheck'), 'false');
            await page.fill('#username', 'fixture-user'); await page.fill('#password', 'fixture-password');
            const sent = page.waitForRequest(request => request.url() === base + endpoint && request.method() === 'POST');
            await page.click('#submit-btn');
            const request = await sent;
            assert.deepEqual(JSON.parse(request.postData()), { username: 'fixture-user', password: 'fixture-password' });
            await page.waitForURL(base + '/'); await page.close();
        }
        assert.equal(requests.some(request => /[?&](username|password)=/.test(request.url)), false);
    });

test('both real Chromium player buttons enter and exit element fullscreen',
    { skip: browserEnabled ? false : 'Browser tests enabled in CI', timeout: 30000 }, async t => {
        const { chromium } = require('playwright');
        const scripts = ['/js/components/PlayerFullscreen.js', '/js/components/VideoPlayer.js', '/js/pages/WatchPage.js'];
        const root = path.join(__dirname, '../public');
        const server = http.createServer((req, res) => {
            if (scripts.includes(req.url)) { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, req.url))); return; }
            res.setHeader('Content-Type', 'text/html');
            res.end(`<div class="watch-video-section"><video></video><button>Fullscreen</button></div>${scripts.map(src => `<script src="${src}"></script>`).join('')}`);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const browser = await chromium.launch({ headless: true, executablePath: process.env.NODECAST_BROWSER_EXECUTABLE || undefined });
        t.after(() => browser.close());
        for (const name of ['VideoPlayer', 'WatchPage']) {
            const page = await browser.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(name => {
                const player = Object.create(window[name].prototype);
                player.video = document.querySelector('video'); player.container = document.querySelector('.watch-video-section');
                document.querySelector('button').addEventListener('click', () => player.toggleFullscreen());
            }, name);
            await page.click('button');
            await page.waitForFunction(() => document.fullscreenElement?.classList.contains('watch-video-section'));
            await page.click('button');
            await page.waitForFunction(() => document.fullscreenElement === null);
            assert.deepEqual(errors, []); await page.close();
        }
    });
