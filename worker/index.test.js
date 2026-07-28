import { describe, expect, it } from 'vitest';
import {
  default as worker,
  getCorsHeaders,
  validateImagesPayload,
  validateStatePayload,
} from './index.js';

function makeEnv(seed = {}, imageResult = { image: 'aGVsbG8=' }) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    env: {
      L1_STATE: {
        get: async key => values.get(key) ?? null,
        put: async (key, value) => { values.set(key, value); },
      },
      AI: {
        run: async model => model.includes('llama')
          ? { response: 'A valid photorealistic fire apparatus compartment rendering prompt.' }
          : imageResult,
      },
    },
  };
}

const request = (path, options = {}) => new Request(`https://worker.example${path}`, {
  ...options,
  headers: {
    Origin: 'https://l1.mbfdhub.com',
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  },
});

describe('Worker request validation', () => {
  it('accepts a bounded state document', () => {
    expect(validateStatePayload({
      allocations: { LS1: Array(15).fill('') },
      customQtys: {},
      customTools: [],
      bundles: {},
      removedItems: [],
      customDimensions: {},
    })).toEqual({ ok: true });
  });

  it('accepts populated optional state fields', () => {
    expect(validateStatePayload({
      allocations: { LS1: ['Axe'] },
      customQtys: { Axe: 1 },
      customTools: [{ name: 'Axe', qty: 1, dimensions: '36 in' }],
      bundles: { LS1: [] },
      removedItems: ['Old tool'],
      customDimensions: { Axe: '36 in' },
    })).toEqual({ ok: true });
  });

  it('rejects malformed or oversized state fields', () => {
    expect(validateStatePayload({ allocations: { LS1: 'not-an-array' } }).ok).toBe(false);
    expect(validateStatePayload({ allocations: { LS1: Array(501).fill('') } }).ok).toBe(false);
  });

  it.each([
    [null],
    [{ allocations: null }],
    [{ allocations: { ['x'.repeat(51)]: [] } }],
    [{ allocations: { LS1: ['x'.repeat(301)] } }],
    [{ allocations: {}, customTools: 'invalid' }],
    [{ allocations: {}, customTools: [{ name: 'Tool', qty: 1.5 }] }],
    [{ allocations: {}, customTools: [{ name: 'Tool', qty: -1 }] }],
    [{ allocations: {}, customTools: [{ name: 'Tool', qty: 10_001 }] }],
    [{ allocations: {}, customTools: [{ name: 'Tool', qty: 1, dimensions: 'x'.repeat(501) }] }],
    [{ allocations: {}, customQtys: [] }],
    [{ allocations: {}, customQtys: { Axe: -1 } }],
    [{ allocations: {}, customQtys: { Axe: 1.5 } }],
    [{ allocations: {}, customQtys: { Axe: 10_001 } }],
    [{ allocations: {}, bundles: [] }],
    [{ allocations: {}, bundles: { LS1: [{ id: '', name: 'Pack', colorIdx: 0, slotIndices: [0] }] } }],
    [{ allocations: {}, bundles: { LS1: [{ id: 'one', name: 'Pack', colorIdx: 0, slotIndices: [-1] }] } }],
    [{ allocations: {}, customDimensions: [] }],
    [{ allocations: {}, customDimensions: { Axe: 42 } }],
    [{ allocations: {}, removedItems: 'invalid' }],
    [{ allocations: {}, removedItems: ['x'.repeat(301)] }],
  ])('rejects invalid state boundary %#', payload => {
    expect(validateStatePayload(payload).ok).toBe(false);
  });

  it('rejects invalid or oversized image payloads', () => {
    expect(validateImagesPayload({ uploadedImages: [], featuredImages: {} }).ok).toBe(false);
    expect(validateImagesPayload({
      uploadedImages: { LS1: [{ uid: 'a', dataUrl: 'not-a-data-url' }] },
      featuredImages: {},
    }).ok).toBe(false);
  });

  it.each([
    [null],
    [{ uploadedImages: {}, featuredImages: [] }],
    [{ uploadedImages: { ['x'.repeat(51)]: [] }, featuredImages: {} }],
    [{ uploadedImages: { LS1: 'invalid' }, featuredImages: {} }],
    [{ uploadedImages: { LS1: Array(51).fill({}) }, featuredImages: {} }],
    [{ uploadedImages: { LS1: [null] }, featuredImages: {} }],
    [{ uploadedImages: { LS1: [{ uid: 'x'.repeat(101), dataUrl: 'data:image/png;base64,aA==' }] }, featuredImages: {} }],
    [{ uploadedImages: {}, featuredImages: { LS1: { kind: 'uploaded' } } }],
    [{ uploadedImages: {}, featuredImages: { LS1: { kind: 'preset', src: 'javascript:alert(1)' } } }],
  ])('rejects invalid image boundary %#', payload => {
    expect(validateImagesPayload(payload).ok).toBe(false);
  });

  it('only grants CORS to the production and Pages origins', () => {
    expect(getCorsHeaders('https://l1.mbfdhub.com')['Access-Control-Allow-Origin']).toBe('https://l1.mbfdhub.com');
    expect(getCorsHeaders('https://abc.l1-compartment-builder.pages.dev')['Access-Control-Allow-Origin'])
      .toBe('https://abc.l1-compartment-builder.pages.dev');
    expect(getCorsHeaders('https://evil.example')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(getCorsHeaders()['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('Worker routes', () => {
  it('handles preflight and reads shared state', async () => {
    const { env } = makeEnv({ allocations: '{"allocations":{}}' });
    const preflight = await worker.fetch(request('/state', { method: 'OPTIONS' }), env);
    const response = await worker.fetch(request('/state'), env);

    expect(preflight.status).toBe(204);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allocations: {} });
  });

  it('validates and persists state updates', async () => {
    const { env, values } = makeEnv();
    const payload = {
      allocations: { LS1: Array(15).fill('') },
      customQtys: {},
      customTools: [],
      bundles: {},
      removedItems: [],
      customDimensions: {},
    };
    const response = await worker.fetch(request('/state', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }), env);
    const invalid = await worker.fetch(request('/state', { method: 'PUT', body: '{' }), env);
    const malformed = await worker.fetch(request('/state', {
      method: 'PUT',
      body: JSON.stringify({ allocations: [] }),
    }), env);

    expect(response.status).toBe(200);
    expect(JSON.parse(values.get('allocations')).allocations.LS1).toHaveLength(15);
    expect(invalid.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it('validates and persists image updates', async () => {
    const { env, values } = makeEnv();
    const payload = {
      uploadedImages: {
        LS1: [{ uid: 'one', dataUrl: 'data:image/png;base64,aGVsbG8=', title: 'Test' }],
      },
      featuredImages: {},
    };
    const response = await worker.fetch(request('/images', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }), env);
    const read = await worker.fetch(request('/images'), env);
    const invalid = await worker.fetch(request('/images', { method: 'PUT', body: '{' }), env);

    expect(response.status).toBe(200);
    expect(JSON.parse(values.get('images')).uploadedImages.LS1).toHaveLength(1);
    expect(read.status).toBe(200);
    expect(invalid.status).toBe(400);
  });

  it('rejects untrusted origins and unknown routes', async () => {
    const { env } = makeEnv();
    const forbidden = await worker.fetch(new Request('https://worker.example/state', {
      headers: { Origin: 'https://evil.example' },
    }), env);
    const missing = await worker.fetch(request('/missing'), env);

    expect(forbidden.status).toBe(403);
    expect(missing.status).toBe(404);
  });

  it('requires an allowed browser origin for every mutation', async () => {
    const { env } = makeEnv();
    const noOrigin = new Request('https://worker.example/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations: {} }),
    });
    const response = await worker.fetch(noOrigin, env);

    expect(response.status).toBe(403);
  });

  it('generates a bounded AI image and enforces the hourly limit', async () => {
    const { env, values } = makeEnv();
    const body = JSON.stringify({
      compId: 'LS1',
      compartmentSpec: 'Forward compartment',
      tools: [{ name: 'Axe', qty: 1, dims: '36 in', visual: 'fire axe' }],
      userText: '',
    });
    const response = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body,
      headers: { 'CF-Connecting-IP': '192.0.2.1' },
    }), env);
    const rateKey = [...values.keys()].find(key => key.startsWith('ai-rate:'));
    values.set(rateKey, '5');
    const limited = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body,
      headers: { 'CF-Connecting-IP': '192.0.2.1' },
    }), env);

    expect(response.status).toBe(200);
    expect((await response.json()).dataUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(limited.status).toBe(429);
  });

  it('rejects malformed AI requests', async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body: JSON.stringify({ compId: 'x'.repeat(51), tools: [] }),
    }), env);
    const invalidJson = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body: '{',
    }), env);
    const invalidTool = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        compId: 'LS1',
        compartmentSpec: 'Forward compartment',
        tools: [{ name: 'Axe', qty: 'many' }],
      }),
    }), env);

    expect(response.status).toBe(400);
    expect(invalidJson.status).toBe(400);
    expect(invalidTool.status).toBe(400);
  });

  it('supports an ArrayBuffer response from the image model', async () => {
    const { env } = makeEnv({}, new TextEncoder().encode('hello').buffer);
    const response = await worker.fetch(request('/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        compId: 'LS1',
        compartmentSpec: 'Forward compartment',
        tools: [],
        userText: '',
      }),
    }), env);

    expect(response.status).toBe(200);
    expect((await response.json()).dataUrl).toBe('data:image/png;base64,aGVsbG8=');
  });
});
