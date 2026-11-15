// A real signed ID-token/code exchange: exercises the application's OIDC
// validation instead of injecting user/group data into a customer request.
import http from 'node:http';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function startMockOidc() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const wrong = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let issuer;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return send({ issuer, authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/jwks') return send({ keys: [jwk] });
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = codes.get(params.get('code')); codes.delete(params.get('code'));
      if (!code || crypto.createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== code.challenge) return send({ error: 'invalid_grant' }, 400);
      const token = await new SignJWT({ email_verified: true, nonce: code.nonce, ...code.claims })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(code.claims.iss ?? issuer).setAudience(code.claims.aud ?? 'panel-test')
        .setSubject(code.claims.sub ?? code.claims.email).setIssuedAt().setExpirationTime(code.claims.exp ?? '10m').sign(code.claims.badSignature ? wrong.privateKey : privateKey);
      return send({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 600, id_token: token });
    }
    return send({ error: 'not_found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { issuer, async login(session, claims) {
    const start = await session.get('/api/auth/oidc/start');
    if (start.status !== 302) throw new Error(`OIDC start failed: ${start.status} ${start.text}`);
    const url = new URL(start.headers.get('location'));
    const code = crypto.randomBytes(12).toString('hex');
    codes.set(code, { claims, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
    return session.get(`/api/auth/oidc/callback?${new URLSearchParams({ code, state: url.searchParams.get('state'), iss: issuer })}`);
  }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
