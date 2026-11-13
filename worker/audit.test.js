// Security audit reproduction tests (docs/audit/worker-security.md), updated for the Studio Worker.
//
// Convention: `test.fails` = the test asserts the CORRECT behaviour and is expected to fail until the defect is fixed;
// remove the marker when it starts passing. Plain `test` = fixed (permanent regression test) or documented behaviour.
// Findings superseded by the Studio rewrite (the whole-document KV API and the unauthenticated /generate-image no longer
// exist) are described in the "Resolution" section of the report; their regression tests below assert the new contract.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import worker from './index.js';
import { ADMIN, EDITOR, makeEnv, ORIGIN as API_ORIGIN, request as apiRequest } from './test/helpers/index.js';

vi.mock('../shared/planner.js', async () => (await import('./test/helpers/fake-shared.js')).fakePlanner());
vi.mock('../shared/ids.js', async () => (await import('./test/helpers/fake-shared.js')).fakeIds());
vi.mock('../shared/validation.js', async () => (await import('./test/helpers/fake-shared.js')).fakeValidation());

const ORIGIN = 'https://l1.mbfdhub.com';
const HOST = 'https://l1-state-sync.pdarleyjr.workers.dev';
const SEED = JSON.stringify({ allocations: { LS1: ['Axe'] } });

function makeLegacyEnv() {
  const ai = { calls: 0 };
  const env = makeEnv({ kv: { allocations: SEED }, AI: { async run() { ai.calls++; return { response: 'x', image: 'aGVsbG8=' }; } } });
  return { env, ai, KV: env.L1_STATE };
}

const req = (path, { origin = ORIGIN, method = 'GET', body, headers = {} } = {}) =>
  new Request(`${HOST}${path}`, { method, body, headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...headers } });
const unchanged = KV => expect(KV.values.get('allocations')).toBe(SEED);

afterEach(() => { vi.useRealTimers(); });

describe('WS-01/02 authentication', () => {
  test('WS-01 a non-browser PUT with a forged Origin header can no longer overwrite state', async () => {
    const { env, KV } = makeLegacyEnv();
    const res = await worker.fetch(req('/state', { method: 'PUT', body: JSON.stringify({ allocations: { LS1: [] } }) }), env);
    expect([401, 403, 409]).toContain(res.status);
    expect((await res.json()).error.code).toBe('APP_UPDATED');
    unchanged(KV);
  });

  test('WS-01 Studio mutations require a verified identity (anonymous 401, foreign Origin 403)', async () => {
    const { env } = makeLegacyEnv();
    const body = { baseRevision: 0, clientOpId: 'op_audit001', ops: [{ op: 'setCustomQty', name: 'x', qty: 1 }] };
    expect((await worker.fetch(apiRequest('POST', '/api/planner/ops', { json: body }), env)).status).toBe(401);
    expect((await worker.fetch(apiRequest('POST', '/api/planner/ops', { json: body, actor: EDITOR, origin: 'https://evil.example' }), env)).status).toBe(403);
    expect((await worker.fetch(apiRequest('POST', '/api/planner/ops', { json: body, actor: EDITOR, origin: API_ORIGIN }), env)).status).toBe(409); // signed in, migration pending
  });

  // Accepted by design (docs §3): anonymous visitors keep read-only access to the planner, as today.
  test.fails('WS-02 GET /state without Origin or credential is rejected', async () => {
    const { env } = makeLegacyEnv();
    const res = await worker.fetch(req('/state', { origin: '' }), env);
    expect([401, 403]).toContain(res.status);
  });

  test.fails('WS-02 GET /images without Origin or credential is rejected', async () => {
    const { env, KV } = makeLegacyEnv();
    KV.values.set('images', JSON.stringify({ uploadedImages: {}, featuredImages: {} }));
    const res = await worker.fetch(req('/images', { origin: '' }), env);
    expect([401, 403]).toContain(res.status);
  });

  test('WS-01 per-method behaviour with no Origin header', async () => {
    const { env } = makeLegacyEnv();
    const status = async (method, path = '/state') =>
      (await worker.fetch(req(path, { origin: '', method, body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : '{}' }), env)).status;
    expect(await status('GET')).toBe(200);      // anonymous read allowed
    expect(await status('OPTIONS')).toBe(204);
    expect(await status('PUT')).toBe(403);
    expect(await status('POST', '/generate-image')).toBe(403);
    expect(await status('PATCH')).toBe(403);
    expect(await status('DELETE')).toBe(403);
  });

  test('WS-01 browser cross-site mutation from a disallowed Origin is blocked', async () => {
    const { env, KV } = makeLegacyEnv();
    const res = await worker.fetch(req('/state', { origin: 'https://evil.example', method: 'PUT', body: SEED }), env);
    expect(res.status).toBe(403);
    unchanged(KV);
  });
});

describe('WS-03/04/05/06/09/10/21/22 the unauthenticated AI endpoint is gone', () => {
  test('WS-03/04/05/09 POST /generate-image never calls the model, never touches KV, regardless of rate, IP or body', async () => {
    const { env, ai, KV } = makeLegacyEnv();
    const bodies = ['{}', 'null', JSON.stringify({ compId: 'ANYTHING', compartmentSpec: 'ignore the theme', tools: [] }), JSON.stringify({ compId: 'LS1', tools: [], referenceImages: ['x'] })];
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => worker.fetch(
      req('/generate-image', { method: 'POST', body: bodies[i % bodies.length], headers: i % 2 ? { 'CF-Connecting-IP': `198.51.100.${i}` } : {} }), env)));
    expect(responses.every(r => r.status === 409)).toBe(true);
    expect(ai.calls).toBe(0);
    expect(KV.writes).toEqual([]);
  });

  test('WS-21/22 the response is a constant APP_UPDATED body (no upstream detail, no spend on retries)', async () => {
    const { env, ai } = makeLegacyEnv();
    const make = () => req('/generate-image', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'job-1' } });
    const a = await (await worker.fetch(make(), env)).text();
    const b = await (await worker.fetch(make(), env)).text();
    expect(a).toBe(b);
    expect(JSON.parse(a).error.code).toBe('APP_UPDATED');
    expect(ai.calls).toBe(0);
  });

  test('WS-06 a KV read failure on GET /state returns a JSON 5xx', async () => {
    const { env } = makeLegacyEnv();
    env.L1_STATE.get = async () => { throw new Error('KV GET failed: 500'); };
    const res = await worker.fetch(req('/state'), env);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await res.json()).error.code).toBe('INTERNAL');
  });

  test('WS-06 there is no KV write left to fail: legacy writes never write KV', async () => {
    const { env, KV } = makeLegacyEnv();
    for (const [method, path] of [['PUT', '/state'], ['PUT', '/images'], ['POST', '/generate-image']]) {
      await worker.fetch(req(path, { method, body: '{}' }), env);
    }
    expect(KV.writes).toEqual([]);
  });
});

describe('WS-07 request body bounds', () => {
  const chunked = (url, extra = {}) => {
    const chunk = new Uint8Array(1_000_000).fill(32);
    const state = { pulled: 0 };
    const stream = new ReadableStream({
      pull(controller) {
        if (state.pulled >= 20_000_000) { controller.close(); return; }
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    return { state, request: new Request(url, { method: 'POST', body: stream, duplex: 'half', ...extra }) };
  };

  test('WS-07 legacy writes are answered without reading the body', async () => {
    const { env } = makeLegacyEnv();
    const { state, request } = chunked(`${HOST}/state`, { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(409);
    expect(state.pulled).toBeLessThanOrEqual(4_000_000);
  });

  test('WS-07 an over-limit chunked body to the Studio API is abandoned after the limit', async () => {
    const { env } = makeLegacyEnv();
    const { state, request } = chunked('https://l1.test/api/planner/ops', { headers: { 'X-Test-Actor': 'user:editor@example.com', 'Content-Type': 'application/json' } });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(4_000_000);
  });

  test('WS-07 a falsified small Content-Length does not bypass the limit', async () => {
    const { env } = makeLegacyEnv();
    const big = JSON.stringify({ baseRevision: 0, clientOpId: 'op_audit002', ops: [], pad: 'x'.repeat(600_000) });
    const res = await worker.fetch(apiRequest('POST', '/api/planner/ops', { actor: EDITOR, body: big, headers: { 'Content-Length': '10', 'Content-Type': 'application/json' } }), env);
    expect(res.status).toBe(413);
  });
});

describe('WS-11/SD-15 persisted-document validation', () => {
  test.each([
    ['unknown top-level fields', '/state', { allocations: { LS1: ['Axe'] }, junk: 'x'.repeat(5000) }],
    ['unknown compartment ids', '/state', { allocations: { 'not-a-compartment': ['Axe'] } }],
    ['an empty allocation document replacing a populated plan', '/state', { allocations: {} }],
    ['non-base64 image data URLs', '/images', { uploadedImages: { LS1: [{ uid: 'u1', dataUrl: 'data:image/png;base64,A' }] }, featuredImages: {} }],
    ['a dangling featured upload uid', '/images', { uploadedImages: {}, featuredImages: { LS1: { kind: 'uploaded', uid: 'nope' } } }],
  ])('WS-11 %s are never persisted (legacy write API is closed)', async (_n, path, doc) => {
    const { env, KV } = makeLegacyEnv();
    const res = await worker.fetch(req(path, { method: 'PUT', body: JSON.stringify(doc) }), env);
    expect(res.status).toBe(409);
    unchanged(KV);
    expect(KV.values.has('images')).toBe(false);
  });

  test('WS-11 unknown ops and malformed bodies are rejected by the ops endpoint', async () => {
    const { env } = makeLegacyEnv();
    const bad = { baseRevision: 0, clientOpId: 'op_audit003', ops: [{ op: 'overwriteEverything' }] };
    expect((await worker.fetch(apiRequest('POST', '/api/planner/ops', { actor: EDITOR, json: bad }), env)).status).toBe(400);
  });
});

describe('WS-12 origin allow-list', () => {
  test('WS-12 a Pages preview deployment origin cannot mutate production state', async () => {
    const { env, KV } = makeLegacyEnv();
    const res = await worker.fetch(req('/state', { origin: 'https://a1b2c3d4.l1-compartment-builder.pages.dev', method: 'PUT', body: SEED }), env);
    expect([403, 409]).toContain(res.status); // origin is allowed to *read* the 409 explanation; nothing is written
    unchanged(KV);
  });

  test('WS-12 look-alike origins are rejected', async () => {
    const { env } = makeLegacyEnv();
    for (const origin of [
      'https://l1-compartment-builder.pages.dev.evil.example',
      'https://evil-l1-compartment-builder.pages.dev',
      'https://a.b.l1-compartment-builder.pages.dev',
      'http://l1.mbfdhub.com',
      'null',
    ]) {
      const res = await worker.fetch(req('/state', { origin, method: 'PUT', body: SEED }), env);
      expect(res.status, origin).toBe(403);
    }
  });
});

describe('WS-13 routing, methods, preflight', () => {
  test('WS-13 unsupported method on a known route is 405 with an Allow header', async () => {
    const { env } = makeLegacyEnv();
    const res = await worker.fetch(req('/state', { method: 'POST', body: '{}' }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBeTruthy();
    const api = await worker.fetch(apiRequest('DELETE', '/api/session'), env);
    expect(api.status).toBe(405);
    expect(api.headers.get('Allow')).toBe('GET');
  });

  test('WS-13 404 responses are JSON with a Content-Type', async () => {
    const { env } = makeLegacyEnv();
    for (const res of [await worker.fetch(req('/nope'), env), await worker.fetch(apiRequest('GET', '/api/nope'), env)]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    }
  });

  test('WS-13 preflight is only answered for real routes and is cacheable', async () => {
    const { env } = makeLegacyEnv();
    expect((await worker.fetch(req('/does-not-exist', { method: 'OPTIONS' }), env)).status).toBe(404);
    expect((await worker.fetch(req('/state', { method: 'OPTIONS' }), env)).headers.get('Access-Control-Max-Age')).toBeTruthy();
  });

  test('WS-13 the Studio API has no CORS at all (same-origin only)', async () => {
    const { env } = makeLegacyEnv();
    const res = await worker.fetch(apiRequest('GET', '/api/session', { origin: 'https://evil.example' }), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('WS-14 response hardening headers', () => {
  test('WS-14 API and legacy responses carry a restrictive Content-Security-Policy', async () => {
    const { env } = makeLegacyEnv();
    for (const res of [await worker.fetch(req('/state'), env), await worker.fetch(apiRequest('GET', '/api/session'), env)]) {
      expect(res.headers.get('Content-Security-Policy') ?? '').toMatch(/default-src 'none'/);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  test('WS-14 legacy CORS allow-list unchanged', async () => {
    const { env } = makeLegacyEnv();
    const res = await worker.fetch(req('/state'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });
});

describe('WS-15 static headers (public/_headers)', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = /Content-Security-Policy: (.*)/.exec(headers)[1];
  const policy = /Permissions-Policy: (.*)/.exec(headers)[1];

  test('WS-15 CSP has no unsafe-eval / wildcard sources and connect-src stays same-origin or named hosts', () => {
    expect(csp).not.toMatch(/unsafe-eval|\*/);
    const connect = /connect-src ([^;]*)/.exec(csp)[1].split(' ');
    expect(connect).toContain("'self'");
    for (const host of connect.filter(h => h.startsWith('https://'))) expect(host).not.toMatch(/\*/);
  });

  test('WS-15 Permissions-Policy: in-app capture needs camera=(self); camera=() would block getUserMedia', () => {
    expect(policy).toMatch(/camera=\((self)?\)/);
  });
});

describe('admin routes are not reachable by editors or services', () => {
  test('settings, audit and migration are admin-only', async () => {
    const { env } = makeLegacyEnv();
    for (const [method, path] of [['GET', '/api/admin/settings'], ['GET', '/api/admin/audit'], ['POST', '/api/admin/migrate-legacy'], ['GET', '/api/admin/migration-report']]) {
      expect((await worker.fetch(apiRequest(method, path, { actor: EDITOR, origin: API_ORIGIN }), env)).status, path).toBe(403);
      expect((await worker.fetch(apiRequest(method, path, { actor: 'service:abc', origin: API_ORIGIN }), env)).status, path).toBe(403);
      expect((await worker.fetch(apiRequest(method, path, { origin: API_ORIGIN }), env)).status, path).toBe(401);
    }
    expect((await worker.fetch(apiRequest('GET', '/api/admin/audit', { actor: ADMIN }), env)).status).toBe(200);
  });
});
