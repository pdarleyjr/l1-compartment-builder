// Security review 2026-11 — identity: JWT forgery classes, JWKS failure, cookie/header precedence, test-mode lockout,
// service-vs-user separation, route enumeration, CSRF and the login redirect. Real router + handlers; only fetch/JWKS is mocked.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../../../shared/contracts.js';
import worker from '../../index.js';
import { resetAuthCache } from '../../src/auth.js';
import { makeEnv, ORIGIN } from '../helpers/index.js';
import { AUD, makeKeyPair, mockJwks, signJwt, TEAM } from '../helpers/jwt.js';

const accessEnv = (extra = {}) => makeEnv({ AUTH_MODE: 'access', ENVIRONMENT: 'staging', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra });
const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function call(env, method, path, { headers = {}, json, origin } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  let body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await worker.fetch(new Request(`https://l1.test${path}`, { method, headers: h, body }), env);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

let key; let other; let jwks;
beforeEach(async () => {
  resetAuthCache();
  key = await makeKeyPair('kid-good');
  other = await makeKeyPair('kid-other'); // an attacker's own RSA key
  jwks = mockJwks([key]);
});
afterEach(() => { vi.unstubAllGlobals(); });

const withToken = async (claims, opts) => ({ 'Cf-Access-Jwt-Assertion': await signJwt(key, { email: 'editor@example.com', ...claims }, opts) });

describe('JWT verification (alg confusion, kid injection, claims)', () => {
  it('accepts a correctly signed RS256 Access token (control)', async () => {
    const r = await call(accessEnv(), 'GET', '/api/usage', { headers: await withToken({}) });
    expect(r.status).not.toBe(401);
  });

  it('alg=none and an empty signature are rejected', async () => {
    const unsigned = await signJwt(key, { email: 'a@b.co' }, { header: { alg: 'none' }, unsigned: true });
    expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': unsigned } })).status).toBe(401);
    const noSig = await signJwt(key, { email: 'a@b.co' }, { unsigned: true });
    expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': noSig } })).status).toBe(401);
  });

  it('HS256 "signed" with the public key material as the HMAC secret is rejected (algorithm confusion)', async () => {
    const { createHmac } = await import('node:crypto');
    const head = b64u({ alg: 'HS256', typ: 'JWT', kid: key.kid });
    const s = Math.floor(Date.now() / 1000);
    const body = b64u({ iss: TEAM, aud: [AUD], exp: s + 3600, email: 'attacker@example.com' });
    const secret = Buffer.from(key.jwk.n, 'base64url'); // the publicly known modulus
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    const r = await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': `${head}.${body}.${sig}` } });
    expect(r.status).toBe(401);
  });

  it('a token signed by an attacker key but claiming a known kid, or an unknown kid, is rejected', async () => {
    const forgedKnownKid = await signJwt({ ...other, kid: 'kid-good' }, { email: 'a@b.co' });
    expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': forgedKnownKid } })).status).toBe(401);
    const unknownKid = await signJwt(other, { email: 'a@b.co' });
    expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': unknownKid } })).status).toBe(401);
  });

  it('kid values that look like URLs, paths or prototype keys never influence where keys are fetched', async () => {
    for (const kid of ['https://evil.test/jwks', '../../etc/passwd', '__proto__', 'constructor', 'kid-good\u0000', '']) {
      const t = await signJwt({ ...other, kid }, { email: 'a@b.co' }, { header: { kid } });
      expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': t } })).status, kid).toBe(401);
    }
    // the only URL ever fetched is the configured team certs endpoint (the mock throws on anything else)
    for (const [url] of globalThis.fetch.mock.calls) expect(String(url)).toBe(`${TEAM}/cdn-cgi/access/certs`);
  });

  it('expired, not-yet-valid, wrong issuer and wrong audience tokens are rejected; aud arrays are matched exactly', async () => {
    const now = Date.now();
    const bad = [
      await signJwt(key, { email: 'a@b.co', exp: Math.floor(now / 1000) - 3600 }),
      await signJwt(key, { email: 'a@b.co', nbf: Math.floor(now / 1000) + 3600 }),
      await signJwt(key, { email: 'a@b.co', iss: 'https://evil.cloudflareaccess.com' }),
      await signJwt(key, { email: 'a@b.co', aud: ['some-other-app'] }),
      await signJwt(key, { email: 'a@b.co', aud: [] }),
      await signJwt(key, { email: 'a@b.co', aud: undefined }),
      await signJwt(key, { email: 'a@b.co', aud: [`${AUD}x`] }),
      await signJwt(key, { email: 'a@b.co', exp: undefined }),
      await signJwt(key, { email: 'a@b.co', exp: 'never' }),
    ];
    for (const t of bad) expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': t } })).status).toBe(401);
    for (const aud of [AUD, ['x', AUD]]) {
      const ok = await signJwt(key, { email: 'a@b.co', aud });
      expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': ok } })).status).not.toBe(401);
    }
  });

  it('JWKS fetch failure fails closed with a generic 401 (no detail leak) and recovers when the endpoint returns', async () => {
    jwks.fail = true;
    const t = await signJwt(key, { email: 'a@b.co' });
    const r = await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': t } });
    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/jwks|500|certs|kid|signature/i);
    jwks.fail = false; resetAuthCache();
    expect((await call(accessEnv(), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': t } })).status).not.toBe(401);
  });

  it('unconfigured ACCESS_AUD / team domain / unknown AUTH_MODE fail closed for every caller', async () => {
    const t = await signJwt(key, { email: 'a@b.co' });
    for (const extra of [{ ACCESS_AUD: 'SET_AT_DEPLOY' }, { ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: '' }, { AUTH_MODE: 'off' }, { AUTH_MODE: undefined }]) {
      const r = await call(accessEnv(extra), 'GET', '/api/usage', { headers: { 'Cf-Access-Jwt-Assertion': t, 'X-Test-Actor': 'user:a@b.co,admin' } });
      expect(r.status, JSON.stringify(extra)).toBe(401);
    }
  });
});

describe('cookie vs header precedence', () => {
  it('the header wins: an invalid header is not rescued by a valid cookie, and a valid header is not overridden by a cookie', async () => {
    const good = await signJwt(key, { email: 'cookie-user@example.com' });
    const r1 = await call(accessEnv(), 'GET', '/api/session', { headers: { 'Cf-Access-Jwt-Assertion': 'garbage.garbage.garbage', Cookie: `CF_Authorization=${good}` } });
    expect(r1.body.email).toBeNull();
    const header = await signJwt(key, { email: 'header-user@example.com' });
    const r2 = await call(accessEnv(), 'GET', '/api/session', { headers: { 'Cf-Access-Jwt-Assertion': header, Cookie: `CF_Authorization=${good}` } });
    expect(r2.body.email).toBe('header-user@example.com');
  });

  it('a valid cookie alone works; a cookie with a look-alike name does not', async () => {
    const good = await signJwt(key, { email: 'cookie-user@example.com' });
    expect((await call(accessEnv(), 'GET', '/api/session', { headers: { Cookie: `CF_Authorization=${good}` } })).body.email).toBe('cookie-user@example.com');
    expect((await call(accessEnv(), 'GET', '/api/session', { headers: { Cookie: `XCF_Authorization=${good}; CF_Authorization_x=${good}` } })).body.email).toBeNull();
  });
});

describe('AUTH_MODE=test can never be honored outside test/development/local', () => {
  const actors = ['user:attacker@example.com,admin', 'service:l1-image-processor'];
  for (const environment of ['production', 'staging', 'Production', ' staging', 'prod', '', undefined]) {
    it(`ENVIRONMENT=${JSON.stringify(environment)} ignores X-Test-Actor on every route class`, async () => {
      const env = makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: environment });
      for (const actor of actors) {
        for (const path of ['/api/usage', '/api/admin/settings', '/api/processor/claim']) {
          const r = await call(env, path.includes('claim') ? 'POST' : 'GET', path, { headers: { 'X-Test-Actor': actor }, json: path.includes('claim') ? { node: 'n' } : undefined });
          expect(r.status, `${path} as ${actor}`).toBe(401);
        }
        expect((await call(env, 'GET', '/api/session', { headers: { 'X-Test-Actor': actor } })).body.email).toBeNull();
      }
    });
  }

  it('wrangler.toml never ships AUTH_MODE=test (top level or any env) and staging/production pin ENVIRONMENT', () => {
    const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    const modes = [...toml.matchAll(/^AUTH_MODE\s*=\s*"([^"]*)"/gm)].map(m => m[1]);
    expect(modes.length).toBeGreaterThanOrEqual(2);
    expect(modes.every(m => m === 'access')).toBe(true);
    expect(toml).toMatch(/^ENVIRONMENT = "production"/m);
    expect(toml).toMatch(/^ENVIRONMENT = "staging"/m);
    expect(toml).not.toMatch(/X-Test-Actor|AUTH_MODE\s*=\s*"test"/);
  });

  it('test mode itself still works where allowed (control)', async () => {
    const env = makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'development' });
    expect((await call(env, 'GET', '/api/session', { headers: { 'X-Test-Actor': 'user:a@b.co' } })).body.email).toBe('a@b.co');
  });
});

describe('service identities vs user identities', () => {
  const service = async (id = 'processor-client-id.access') => ({ 'Cf-Access-Jwt-Assertion': await signJwt(key, { common_name: id, email: undefined }) });

  it('an Access service-token JWT (no email) is a service actor: processor routes yes, user routes no', async () => {
    const env = accessEnv();
    expect((await call(env, 'POST', '/api/processor/claim', { headers: await service(), json: { node: 'n' } })).status).toBe(204);
    expect((await call(env, 'GET', '/api/usage', { headers: await service() })).status).toBe(403);
    expect((await call(env, 'GET', '/api/admin/settings', { headers: await service() })).status).toBe(403);
    expect((await call(env, 'POST', '/api/planner/ops', { headers: await service(), origin: ORIGIN, json: {} })).status).toBe(403);
  });

  it('PROCESSOR_SERVICE_IDS pins which service tokens count as the processor', async () => {
    const env = accessEnv({ PROCESSOR_SERVICE_IDS: 'processor-client-id.access' });
    expect((await call(env, 'POST', '/api/processor/claim', { headers: await service('processor-client-id.access'), json: { node: 'n' } })).status).toBe(204);
    expect((await call(env, 'POST', '/api/processor/claim', { headers: await service('someone-else.access'), json: { node: 'n' } })).status).toBe(401);
  });

  it('a human editor cannot call processor routes; a non-admin editor cannot call admin routes', async () => {
    const env = accessEnv();
    const editor = await withToken({ email: 'editor@example.com' });
    expect((await call(env, 'POST', '/api/processor/claim', { headers: editor, json: { node: 'n' } })).status).toBe(403);
    for (const [m, p] of [['GET', '/api/admin/settings'], ['GET', '/api/admin/audit'], ['POST', '/api/admin/migrate-legacy'], ['GET', '/api/admin/migration-report'],
      ['PUT', '/api/admin/settings/ai.enabled'], ['GET', '/api/admin/settings/ai.enabled/history']]) {
      expect((await call(env, m, p, { headers: editor, origin: m === 'GET' ? undefined : ORIGIN, json: m === 'GET' ? undefined : {} })).status, `${m} ${p}`).toBe(403);
    }
  });

  it('an email claim that is not an address, or a token with neither email nor common_name, is anonymous', async () => {
    const env = accessEnv();
    for (const claims of [{ email: 'not-an-email' }, { email: undefined }, { email: 42 }]) {
      expect((await call(env, 'GET', '/api/usage', { headers: await withToken(claims) })).status).toBe(401);
    }
  });
});

// ── Every route, programmatically ─────────────────────────────────────────────────────────────────────────────────────
const sampleParams = { compId: 'LS1', assetId: 'ast_0000000000000000000000aaaa', variant: 'original', linkId: 'al_0000000000000000000000aaaa', mountId: 'mt_0000000000000000000000aaaa',
  jobId: 'gj_0000000000000000000000aaaa', versionId: 'iv_0000000000000000000000aaaa', key: 'ai.enabled' };
const pathOf = route => `/api${route.path.replace(/:(\w+)/g, (_, k) => sampleParams[k] ?? 'x')}`;
const send = (env, route, headers = {}, origin = ORIGIN) => call(env, route.method, pathOf(route), {
  headers, origin: route.method === 'GET' ? undefined : origin, json: route.method === 'GET' ? undefined : {},
});

describe('every ROUTES entry enforces its declared auth class', () => {
  const protectedRoutes = ROUTES.filter(r => r.auth !== 'public');

  it('there is at least one route per auth class (the enumeration is meaningful)', () => {
    expect(new Set(ROUTES.map(r => r.auth))).toEqual(new Set(['public', 'editor', 'admin', 'service']));
    expect(protectedRoutes.length).toBeGreaterThan(30);
  });

  it('anonymous callers get 401 on every non-public route (test mode without actor, and access mode without a token)', async () => {
    for (const env of [makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'test' }), accessEnv()]) {
      for (const route of protectedRoutes) {
        const r = await send(env, route);
        expect(r.status, `${route.method} ${route.path} (${env.AUTH_MODE})`).toBe(401);
      }
    }
  });

  it('public routes never answer 401/403 to anonymous callers (they are public on purpose)', async () => {
    const env = makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'test' });
    for (const route of ROUTES.filter(r => r.auth === 'public')) {
      const r = await send(env, route);
      expect([401, 403], `${route.method} ${route.path}`).not.toContain(r.status);
    }
  });

  it('a service identity is refused (403) on every editor/admin route; editors refused on service routes; non-admins on admin routes', async () => {
    const env = makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'test' });
    for (const route of protectedRoutes) {
      const svc = await send(env, route, { 'X-Test-Actor': 'service:l1-image-processor' });
      const ed = await send(env, route, { 'X-Test-Actor': 'user:editor@example.com' });
      if (route.auth === 'service') expect(ed.status, `editor on ${route.path}`).toBe(403);
      else expect(svc.status, `service on ${route.method} ${route.path}`).toBe(403);
      if (route.auth === 'admin') expect(ed.status, `editor on ${route.path}`).toBe(403);
    }
  });

  it('unknown routes and wrong methods are rejected without reaching a handler', async () => {
    const env = makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'test' });
    expect((await call(env, 'GET', '/api/nope', { headers: { 'X-Test-Actor': 'user:a@b.co,admin' } })).status).toBe(404);
    const r = await call(env, 'DELETE', '/api/usage', { headers: { 'X-Test-Actor': 'user:a@b.co,admin' }, origin: ORIGIN });
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET');
  });
});

describe('CSRF: cross-origin state changes with ambient credentials', () => {
  const MUTATIONS = [['POST', '/api/planner/ops'], ['PUT', '/api/compartments/LS1/design'], ['DELETE', '/api/assets/ast_0000000000000000000000aaaa'],
    ['PATCH', '/api/mounts/mt_0000000000000000000000aaaa'], ['POST', '/api/compartments/LS1/jobs']];

  it('a mutation with a foreign, "null" or look-alike Origin is refused before authentication, even with a valid cookie', async () => {
    const cookie = `CF_Authorization=${await signJwt(key, { email: 'editor@example.com' })}`;
    for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`, 'http://l1.test', `${ORIGIN}:8443`, 'https://L1.TEST']) {
      for (const [method, path] of MUTATIONS) {
        const r = await call(accessEnv({ PUBLIC_ORIGIN: ORIGIN }), method, path, { headers: { Cookie: cookie }, origin, json: {} });
        expect(r.status, `${method} ${path} from ${origin}`).toBe(403);
        expect(r.body.error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('a mutation flagged cross-site / same-site by Fetch Metadata is refused even when Origin was stripped', async () => {
    const cookie = `CF_Authorization=${await signJwt(key, { email: 'editor@example.com' })}`;
    for (const site of ['cross-site', 'same-site']) {
      for (const [method, path] of MUTATIONS) {
        const r = await call(accessEnv(), method, path, { headers: { Cookie: cookie, 'Sec-Fetch-Site': site }, json: {} });
        expect(r.status, `${method} ${path} ${site}`).toBe(403);
      }
    }
  });

  it('same-origin browser requests (and header-less non-browser clients) are not blocked by the CSRF check (control)', async () => {
    const cookie = `CF_Authorization=${await signJwt(key, { email: 'editor@example.com' })}`;
    const same = await call(accessEnv(), 'POST', '/api/planner/ops', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }, origin: ORIGIN, json: {} });
    expect(same.status).not.toBe(403);
    const curl = await call(accessEnv(), 'POST', '/api/planner/ops', { headers: { Cookie: cookie }, json: {} });
    expect(curl.status).not.toBe(403);
  });
});

describe('GET /api/auth/login open redirect', () => {
  const env = () => makeEnv({ AUTH_MODE: 'test', ENVIRONMENT: 'test' });
  const login = async value => call(env(), 'GET', `/api/auth/login?return=${encodeURIComponent(value)}`, { headers: { 'X-Test-Actor': 'user:editor@example.com' } });
  const evil = ['//evil.example', '/\\evil.example', '/\\/evil.example', '///evil.example', '\\\\evil.example', 'https://evil.example', 'http://evil.example/x',
    'javascript:alert(1)', 'data:text/html,x', '%2F%2Fevil.example', '%252F%252Fevil.example', '/%0d%0aSet-Cookie:%20pwn=1', '/\r\nLocation: https://evil.example',
    '/\t/evil.example', '/\n/evil.example', ' //evil.example', '/\u0000//evil.example', '/%5Cevil.example', '/a\\b'];
  for (const value of evil) {
    it(`refuses ${JSON.stringify(value)}`, async () => {
      const r = await login(value);
      expect(r.status).toBe(302);
      const loc = r.headers.get('Location');
      expect(loc === '/' || (loc.startsWith('/') && !loc.startsWith('//') && !/[\\\r\n]/.test(loc))).toBe(true);
      expect(new URL(loc, 'https://l1.test').origin).toBe('https://l1.test'); // a browser resolves it on our own origin
      expect(r.headers.get('Set-Cookie')).toBeNull();
    });
  }
  it('keeps a legitimate same-origin path and query', async () => {
    expect((await login('/studio?compartment=LS1')).headers.get('Location')).toBe('/studio?compartment=LS1');
  });
});
