import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { EDITOR, makeEnv, ORIGIN, request } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', async () => {
  const { json, HttpError } = await import('../../src/http.js');
  return {
    assets: {
      createAsset: async ctx => json({ ok: true, actor: ctx.actor.email, hasDb: Boolean(ctx.db), now: typeof ctx.now }, 201),
      getVariant: async ctx => json({ params: ctx.params }),
      deleteAsset: async () => { throw new HttpError('NOT_FOUND', 'No such asset.'); },
      commitAsset: async () => { throw new Error('secret db password leaked'); },
      listAssets: async () => new Response('raw', { headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'text/plain' } }),
    },
    gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {},
    studioCron: async () => {},
  };
});

const get = (path, o) => worker.fetch(request('GET', path, o), makeEnv());

describe('router', () => {
  it('dispatches studio handlers with the full ctx and security headers', async () => {
    const res = await worker.fetch(request('POST', '/api/assets', { actor: EDITOR, json: {}, origin: ORIGIN }), makeEnv());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, actor: 'editor@example.com', hasDb: true, now: 'number' });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('extracts :params and keeps handler-set headers', async () => {
    const res = await get('/api/assets/ast_1/display', { actor: EDITOR });
    expect(await res.json()).toEqual({ params: { assetId: 'ast_1', variant: 'display' } });
    const listed = await get('/api/compartments/LS1/assets', { actor: EDITOR });
    expect(listed.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(listed.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('404s unknown paths and 405s with Allow on a known path', async () => {
    const missing = await get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toMatch(/json/);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
    const wrong = await worker.fetch(request('DELETE', '/api/session'), makeEnv());
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('GET');
    const planner = await worker.fetch(request('PUT', '/api/assets/ast_1/original', { actor: EDITOR }), makeEnv());
    expect(planner.status).not.toBe(405); // PUT variant is a real route
    const opt = await worker.fetch(request('OPTIONS', '/api/session'), makeEnv());
    expect(opt.status).toBe(405);
    expect(opt.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('non-/api paths on the main host are JSON 404', async () => {
    const res = await get('/index.html');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('a missing handler is a JSON 500 INTERNAL, never a crash', async () => {
    const res = await get('/api/usage', { actor: EDITOR });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL');
  });

  it('HttpError becomes its contract status; unexpected errors are generic 500 and log without secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nf = await worker.fetch(request('DELETE', '/api/assets/ast_1', { actor: EDITOR, origin: ORIGIN }), makeEnv());
    expect(nf.status).toBe(404);
    const boom = await worker.fetch(request('POST', '/api/assets/ast_1/commit', { actor: EDITOR, json: { s: 'topsecret' }, origin: ORIGIN }), makeEnv());
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).not.toMatch(/password|topsecret/);
    expect(JSON.parse(text).error.code).toBe('INTERNAL');
    const logged = err.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('router.unhandled');
    expect(logged).not.toContain('topsecret');
    err.mockRestore();
  });

  it('enforces auth levels: anonymous 401, editor on admin route 403', async () => {
    expect((await get('/api/compartments/LS1/assets')).status).toBe(401);
    expect((await get('/api/admin/settings', { actor: EDITOR })).status).toBe(403);
    expect((await get('/api/admin/settings', { actor: 'user:owner@example.com,admin' })).status).toBe(200);
    expect((await get('/api/session')).status).toBe(200);
  });

  it('CSRF: mutations with a foreign Origin are rejected; same origin and no Origin are accepted; GET is unaffected', async () => {
    const mk = origin => worker.fetch(request('POST', '/api/assets', { actor: EDITOR, json: {}, origin }), makeEnv());
    expect((await mk('https://evil.example')).status).toBe(403);
    expect((await mk('null')).status).toBe(403);
    expect((await mk(ORIGIN)).status).toBe(201);
    expect((await mk(undefined)).status).toBe(201);
    expect((await get('/api/session', { origin: 'https://evil.example' })).status).toBe(200);
    const noConfig = await worker.fetch(request('POST', '/api/assets', { actor: EDITOR, json: {}, origin: ORIGIN }), makeEnv({ PUBLIC_ORIGIN: undefined }));
    expect(noConfig.status).toBe(403);
  });
});
