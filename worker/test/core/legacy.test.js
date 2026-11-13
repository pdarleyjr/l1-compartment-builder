import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { ADMIN, imagesFixture, makeEnv, request, v1Fixture } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron: async () => {} }));

const ORIGIN = 'https://l1.mbfdhub.com'; // an origin the legacy CORS policy allows
const HOST = 'l1-state-sync.pdarleyjr.workers.dev';
const legacy = (method, path, o = {}) => request(method, path, { host: HOST, origin: ORIGIN, ...o });
const seeded = () => makeEnv({ PUBLIC_ORIGIN: 'https://l1.mbfdhub.com', kv: { allocations: v1Fixture(), images: imagesFixture() } });

describe('legacy workers.dev host', () => {
  it('serves raw KV before migration', async () => {
    const env = seeded();
    const state = await (await worker.fetch(legacy('GET', '/state'), env)).json();
    expect(state.allocations.LS1[0]).toBe('1 Ton Griphoist');
    expect(state._serverTs).toBe(1700000000000);
    const images = await (await worker.fetch(legacy('GET', '/images'), env)).json();
    expect(images.uploadedImages.LS1[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const empty = await worker.fetch(legacy('GET', '/state'), makeEnv());
    expect(await empty.text()).toBe('null');
  });

  it('serves v1 projections from D1 after migration (absolute public image URLs)', async () => {
    const env = seeded();
    await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: ADMIN, origin: 'https://l1.mbfdhub.com' }), env);
    const state = await (await worker.fetch(legacy('GET', '/state'), env)).json();
    expect(Object.keys(state).sort()).toEqual(['_serverTs', 'allocations', 'bundles', 'customDimensions', 'customQtys', 'customTools', 'removedItems']);
    expect(state.allocations.RS1[0]).toBe('Custom Wrench');
    const images = await (await worker.fetch(legacy('GET', '/images'), env)).json();
    const ids = (await env.DB.prepare('SELECT id, legacy_uid FROM assets').all()).results;
    const idOf = uid => ids.find(r => r.legacy_uid === uid).id;
    expect(images.uploadedImages.LS1.map(i => i.uid)).toEqual(['u-1', 'u-2']);
    expect(images.uploadedImages.LS1[0]).toMatchObject({ title: 'Front', dataUrl: `https://l1.mbfdhub.com/api/public/assets/${idOf('u-1')}/display` });
    expect(images.uploadedImages.RS2).toHaveLength(1);
    expect(images.featuredImages).toEqual({
      LS1: { kind: 'uploaded', uid: 'u-2' },
      LS2: { kind: 'preset', src: '/images/LS2_rendering.webp' },
    });
  });

  it('answers PUT /state, PUT /images and POST /generate-image with 409 APP_UPDATED and never writes KV', async () => {
    const env = seeded();
    for (const [method, path] of [['PUT', '/state'], ['PUT', '/images'], ['POST', '/generate-image']]) {
      const res = await worker.fetch(legacy(method, path, { json: { allocations: {} } }), env);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'APP_UPDATED', message: 'This page is out of date. Reload to continue.' } });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    }
    expect(env.L1_STATE.writes).toEqual([]);
  });

  it('keeps the legacy CORS policy: foreign origins 403, preflight only for real paths, JSON 404/405', async () => {
    const env = seeded();
    expect((await worker.fetch(legacy('GET', '/state', { origin: 'https://evil.example' }), env)).status).toBe(403);
    expect((await worker.fetch(legacy('PUT', '/state', { origin: undefined, json: {} }), env)).status).toBe(403);
    expect((await worker.fetch(legacy('PUT', '/state', { origin: 'https://abc.l1-compartment-builder.pages.dev', json: {} }), env)).status).toBe(409);
    const pre = await worker.fetch(legacy('OPTIONS', '/state'), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Max-Age')).toBeTruthy();
    expect((await worker.fetch(legacy('OPTIONS', '/nope'), env)).status).toBe(404);
    const missing = await worker.fetch(legacy('GET', '/nope'), env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toMatch(/json/);
    const wrong = await worker.fetch(legacy('POST', '/state', { json: {} }), env);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toContain('GET');
    expect((await worker.fetch(legacy('GET', '/state', { origin: undefined }), env)).headers.get('Content-Security-Policy')).toMatch(/default-src 'none'/);
  });

  it('does not serve /api on the legacy host as the Studio API', async () => {
    const res = await worker.fetch(legacy('GET', '/api/session'), seeded());
    expect(res.status).toBe(404);
  });
});
