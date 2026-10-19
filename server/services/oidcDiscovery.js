const MAX_DOCUMENT_BYTES = 128 * 1024;

function validateUrl(value, name, allowHttp) {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid OIDC ' + name);
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('Invalid OIDC ' + name); }
    if (!(parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:')) ||
        parsed.username || parsed.password || parsed.hash) throw new Error('Invalid OIDC ' + name);
    return parsed;
}

async function readDocument(response) {
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_DOCUMENT_BYTES) {
        await response.body?.cancel();
        throw new Error('OIDC discovery document is too large');
    }
    if (!response.body) throw new Error('OIDC discovery document is empty');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_DOCUMENT_BYTES) {
                await reader.cancel();
                throw new Error('OIDC discovery document is too large');
            }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new Error('OIDC discovery document is not valid JSON'); }
}

async function discoverOidcEndpoints(env, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    const issuer = env.OIDC_ISSUER_URL;
    const issuerUrl = validateUrl(issuer, 'issuer URL', true);
    if (issuerUrl.search) throw new Error('OIDC issuer URL must not contain a query');
    const allowHttp = issuerUrl.protocol === 'http:';
    const overrides = [env.OIDC_AUTH_URL, env.OIDC_TOKEN_URL, env.OIDC_USERINFO_URL];
    let document = {};
    if (!overrides.every(Boolean)) {
        let response;
        try {
            response = await fetchImpl(issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration', {
                headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)
            });
        } catch { throw new Error('OIDC discovery request failed or timed out'); }
        if (response.status !== 200) {
            await response.body?.cancel();
            throw new Error('OIDC discovery returned HTTP ' + response.status);
        }
        try { document = await readDocument(response); }
        catch (error) {
            if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('OIDC discovery request timed out');
            throw error;
        }
        if (!document || typeof document !== 'object' || Array.isArray(document) || document.issuer !== issuer) {
            throw new Error('OIDC discovery issuer does not match OIDC_ISSUER_URL');
        }
    }
    const authorizationURL = env.OIDC_AUTH_URL || document.authorization_endpoint;
    const tokenURL = env.OIDC_TOKEN_URL || document.token_endpoint;
    const userInfoURL = env.OIDC_USERINFO_URL || document.userinfo_endpoint;
    validateUrl(authorizationURL, 'authorization endpoint', allowHttp);
    validateUrl(tokenURL, 'token endpoint', allowHttp);
    if (userInfoURL !== undefined) validateUrl(userInfoURL, 'userinfo endpoint', allowHttp);
    return { issuer, authorizationURL, tokenURL, userInfoURL };
}

module.exports = { discoverOidcEndpoints };
