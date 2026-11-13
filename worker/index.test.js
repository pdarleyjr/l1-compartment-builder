// Worker entry + legacy-host behaviour. The pre-Studio whole-document PUT API is gone: legacy writes answer 409 APP_UPDATED.
import { describe, expect, it, vi } from 'vitest';
import worker, { getCorsHeaders } from './index.js';
import { makeEnv } from './test/helpers/index.js';

vi.mock('../shared/planner.js', async () => (await import('./test/helpers/fake-shared.js')).fakePlanner());
vi.mock('../shared/ids.js', async () => (await import('./test/helpers/fake-shared.js')).fakeIds());
vi.mock('../shared/validation.js', async () => (await import('./test/helpers/fake-shared.js')).fakeValidation());

const LEGACY = 'https://l1-state-sync.pdarleyjr.workers.dev';
const ORIGIN = 'https://l1.mbfdhub.com';
const request = (path, options = {}) => new Request(`${LEGACY}${path}`, {
  ...options,
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
});
const envWith = (seed = {}) => makeEnv({ kv: seed });

describe('legacy CORS policy', () => {
  it('only grants CORS to the production and Pages origins', () => {
    expect(getCorsHeaders('https://l1.mbfdhub.com')['Access-Control-Allow-Origin']).toBe('https://l1.mbfdhub.com');
    expect(getCorsHeaders('https://abc.l1-compartment-builder.pages.dev')['Access-Control-Allow-Origin'])
      .toBe('https://abc.l1-compartment-builder.pages.dev');
    expect(getCorsHeaders('https://evil.example')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(getCorsHeaders()['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('Worker routes (legacy host)', () => {
  it('handles preflight and reads shared state', async () => {
    const env = envWith({ allocations: '{"allocations":{}}' });
    const preflight = await worker.fetch(request('/state', { method: 'OPTIONS' }), env);
    const response = await worker.fetch(request('/state'), env);

    expect(preflight.status).toBe(204);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allocations: {} });
  });

  it('reads the images document', async () => {
    const env = envWith({ images: JSON.stringify({ uploadedImages: {}, featuredImages: {} }) });
    const read = await worker.fetch(request('/images'), env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ uploadedImages: {}, featuredImages: {} });
  });

  it('answers every legacy write with 409 APP_UPDATED and leaves KV untouched', async () => {
    const env = envWith({ allocations: '{"allocations":{"LS1":["Axe"]}}' });
    const payload = JSON.stringify({ allocations: { LS1: Array(15).fill('') } });
    for (const [method, path] of [['PUT', '/state'], ['PUT', '/images'], ['POST', '/generate-image']]) {
      const response = await worker.fetch(request(path, { method, body: payload }), env);
      expect(response.status, path).toBe(409);
      expect((await response.json()).error.code).toBe('APP_UPDATED');
    }
    expect(env.L1_STATE.writes).toEqual([]);
    expect(env.L1_STATE.values.get('allocations')).toBe('{"allocations":{"LS1":["Axe"]}}');
  });

  it('rejects untrusted origins and unknown routes', async () => {
    const env = envWith();
    const forbidden = await worker.fetch(new Request(`${LEGACY}/state`, { headers: { Origin: 'https://evil.example' } }), env);
    const missing = await worker.fetch(request('/missing'), env);

    expect(forbidden.status).toBe(403);
    expect(missing.status).toBe(404);
  });

  it('requires an allowed browser origin for every mutation', async () => {
    const noOrigin = new Request(`${LEGACY}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations: {} }),
    });
    expect((await worker.fetch(noOrigin, envWith())).status).toBe(403);
  });
});

describe('Worker entry', () => {
  it('returns a JSON 404 for non-API paths on the main host and never touches the legacy handlers', async () => {
    const response = await worker.fetch(new Request('https://l1.mbfdhub.com/state'), envWith());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  it('routes /api/* to the Studio router', async () => {
    const response = await worker.fetch(new Request('https://l1.mbfdhub.com/api/session'), envWith());
    expect(response.status).toBe(200);
    expect((await response.json()).email).toBeNull();
  });
});
