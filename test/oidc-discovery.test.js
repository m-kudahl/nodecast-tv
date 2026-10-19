const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { discoverOidcEndpoints } = require('../server/services/oidcDiscovery');

const issuer = 'https://idp.fixture.test/application/o/nodecast/';
const metadata = { issuer, authorization_endpoint: 'https://idp.fixture.test/application/o/authorize/',
    token_endpoint: 'https://idp.fixture.test/application/o/token/', userinfo_endpoint: 'https://idp.fixture.test/application/o/userinfo/' };
const jsonResponse = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('OIDC discovery keeps the configured issuer exact, removes the path slash once, and honors explicit overrides', async () => {
    const requests = [];
    const endpoints = await discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async (url, options) => {
        requests.push({ url, options }); return jsonResponse(metadata);
    } });
    assert.equal(requests[0].url, issuer + '.well-known/openid-configuration');
    assert.equal(requests[0].options.redirect, 'manual');
    assert.ok(requests[0].options.signal);
    assert.deepEqual(endpoints, { issuer, authorizationURL: metadata.authorization_endpoint, tokenURL: metadata.token_endpoint, userInfoURL: metadata.userinfo_endpoint });
    const partial = await discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer, OIDC_AUTH_URL: 'https://custom.fixture.test/auth' }, { fetchImpl: async () => jsonResponse(metadata) });
    assert.equal(partial.authorizationURL, 'https://custom.fixture.test/auth'); assert.equal(partial.tokenURL, metadata.token_endpoint);
    const manual = await discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer, OIDC_AUTH_URL: metadata.authorization_endpoint,
        OIDC_TOKEN_URL: metadata.token_endpoint, OIDC_USERINFO_URL: metadata.userinfo_endpoint }, { fetchImpl: () => { throw Error('Discovery must be skipped'); } });
    assert.deepEqual(manual, endpoints);
    const withoutUserinfo = await discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => jsonResponse({ ...metadata, userinfo_endpoint: undefined }) });
    assert.equal(withoutUserinfo.userInfoURL, undefined, 'userinfo endpoint is optional in OIDC discovery');
});

test('OIDC rejects mismatched issuers, malformed metadata, unsafe endpoints, redirects, and oversized bodies', async () => {
    for (const data of [{ ...metadata, issuer: issuer.slice(0, -1) }, { ...metadata, issuer: 'https://other.fixture.test' }, [], null,
        { ...metadata, token_endpoint: undefined }, { ...metadata, token_endpoint: 'file:///tmp/token' },
        { ...metadata, token_endpoint: 'http://idp.fixture.test/token' }, { ...metadata, authorization_endpoint: 'javascript:alert(1)' },
        { ...metadata, userinfo_endpoint: 'https://user:secret@idp.fixture.test/userinfo' }]) {
        await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => jsonResponse(data) }));
    }
    for (const value of ['file:///tmp/issuer', 'https://user:secret@idp.fixture.test', issuer + '?query=1', issuer + '#fragment']) {
        await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: value }));
    }
    for (const status of [302, 404, 500]) {
        await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => new Response('', { status }) }), /returned HTTP/);
    }
    await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => new Response('not json') }), /not valid JSON/);
    await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1)) }), /too large/);
    await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: issuer }, { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '999999' } }) }), /too large/);
});

async function listen(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('OIDC discovery timeout covers both response headers and a stalled response body', async t => {
    const base = await listen(t, (req, res) => {
        if (req.url.startsWith('/body/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
    });
    for (const part of ['headers', 'body']) {
        const began = Date.now();
        await assert.rejects(discoverOidcEndpoints({ OIDC_ISSUER_URL: base + '/' + part }, { timeoutMs: 50 }), /timed out/);
        assert.ok(Date.now() - began < 2000);
    }
});

async function startApp(t, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-oidc-'));
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [], sources: [], hiddenItems: [], favorites: [], settings: {}, nextId: 1 }));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir, NODECAST_DISABLE_BACKGROUND_JOBS: 'true',
            JWT_SECRET: '', SESSION_SECRET: '', AUTH_COOKIE_SECURE: 'false',
            OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', OIDC_AUTH_URL: '', OIDC_TOKEN_URL: '', OIDC_USERINFO_URL: '', OIDC_CALLBACK_URL: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        if (child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    let output = '';
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('App startup timed out')), 15000);
        child.stdout.on('data', data => {
            output += data;
            const match = output.match(/server running on http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
        });
        child.stderr.on('data', data => { output += data; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(Error('App exited ' + code + ': ' + output)); });
    });
    return { base };
}

for (const provider of ['authentik', 'keycloak']) {
    test(`real app waits for ${provider} discovery before SSO and uses the published authorization endpoint`, async t => {
        let release, requested, docRequests = 0;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { requested = resolve; });
        let providerBase;
        const prefix = provider === 'authentik' ? '/application/o/nodecast/' : '/realms/nodecast';
        const authPath = provider === 'authentik' ? '/application/o/authorize/' : '/realms/nodecast/protocol/openid-connect/auth';
        providerBase = await listen(t, async (req, res) => {
            docRequests++;
            assert.equal(req.url, prefix.replace(/\/$/, '') + '/.well-known/openid-configuration');
            requested(); await gate;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ issuer: providerBase + prefix, authorization_endpoint: providerBase + authPath,
                token_endpoint: providerBase + '/token', userinfo_endpoint: providerBase + '/userinfo' }));
        });
        const { base } = await startApp(t, { OIDC_ISSUER_URL: providerBase + prefix, OIDC_CLIENT_ID: 'fixture-client', OIDC_CLIENT_SECRET: 'fixture-secret' });
        await ready;
        assert.equal((await fetch(base + '/api/health')).status, 503, 'readiness waits for discovery');
        const login = fetch(base + '/api/auth/oidc/login', { redirect: 'manual' });
        release();
        const response = await login;
        assert.equal(response.status, 302);
        const redirect = new URL(response.headers.get('location'));
        assert.equal(redirect.origin, providerBase); assert.equal(redirect.pathname, authPath);
        assert.equal(redirect.searchParams.get('client_id'), 'fixture-client');
        assert.ok(redirect.searchParams.get('state'));
        let healthStatus;
        for (let attempt = 0; attempt < 50; attempt++) {
            healthStatus = (await fetch(base + '/api/health')).status;
            if (healthStatus === 200) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(healthStatus, 200, 'ready after discovery and plugin initialization');
        const callback = await fetch(base + '/api/auth/oidc/callback?error=access_denied', { redirect: 'manual' });
        assert.equal(callback.status, 302);
        assert.ok(callback.headers.get('location').startsWith('/login.html?error='));
        assert.equal(docRequests, 1);
    });
}

test('failed or unconfigured SSO returns a clear 503 while local setup and login remain usable', async t => {
    const provider = await listen(t, (req, res) => {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...metadata, issuer: 'https://wrong.fixture.test' }));
    });
    for (const env of [{}, { OIDC_ISSUER_URL: provider + '/issuer', OIDC_CLIENT_ID: 'fixture-client', OIDC_CLIENT_SECRET: 'fixture-secret' }]) {
        const { base } = await startApp(t, env);
        for (const route of ['/api/auth/oidc/login', '/api/auth/oidc/callback']) {
            const response = await fetch(base + route, { redirect: 'manual' });
            assert.equal(response.status, 503); assert.match((await response.json()).error, /unavailable/);
        }
        const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'Fixture', password: 'fixture-password' }) });
        assert.equal(setup.status, 201);
        const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'Fixture', password: 'fixture-password' }) });
        assert.equal(login.status, 200);
        assert.equal((await fetch(base + '/api/health')).status, 200);
    }
});
