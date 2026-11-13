// Shared test harness: makeEnv, request, fixtures.
import { COMPARTMENT_IDS } from '../../../shared/contracts.js';
import { createD1 } from './d1.js';
import { createKv, createR2 } from './r2.js';

export const ORIGIN = 'https://l1.test';
export { createD1, createKv, createR2 };

/** @param {object} [overrides] env keys; pass `kv` to seed L1_STATE */
export function makeEnv({ kv = {}, ...overrides } = {}) {
  return {
    DB: createD1(),
    ASSETS: createR2(),
    L1_STATE: createKv(kv),
    AUTH_MODE: 'test',
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: ORIGIN,
    ACCESS_TEAM_DOMAIN: 'https://team.example.cloudflareaccess.com',
    ACCESS_AUD: 'aud-tag-123',
    OWNER_EMAILS: 'owner@example.com',
    ...overrides,
  };
}

/** request('POST', '/api/x', {actor:'user:a@b.c', json:{...}, headers, origin, body}) */
export function request(method, path, { actor, json, headers = {}, origin, body, host = 'l1.test' } = {}) {
  const h = { ...headers };
  if (actor) h['X-Test-Actor'] = actor;
  if (origin) h.Origin = origin;
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  return new Request(`https://${host}${path}`, { method, headers: h, body: payload });
}

export const EDITOR = 'user:editor@example.com';
export const ADMIN = 'user:owner@example.com,admin';

export const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
export const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Synthetic legacy KV `allocations` (v1) fixture. */
export function v1Fixture() {
  const allocations = Object.fromEntries(COMPARTMENT_IDS.map(c => [c, Array(15).fill('')]));
  allocations.LS1[0] = '1 Ton Griphoist';
  allocations.LS1[1] = 'Custom Wrench';
  allocations.LS2[3] = '1 Ton Griphoist';
  allocations.RS1[0] = 'Custom Wrench';
  return {
    allocations,
    customQtys: { 'Custom Wrench': 2 },
    customTools: [{ name: 'Custom Wrench', qty: 2, dimensions: '12 in' }],
    bundles: { LS1: [{ id: 'b1', name: 'Kit', colorIdx: 0, slotIndices: [0, 1] }] },
    removedItems: [],
    customDimensions: {},
    _serverTs: 1700000000000,
  };
}

/** Synthetic legacy KV `images` fixture (tiny real JPEG/PNG bytes). */
export function imagesFixture() {
  return {
    uploadedImages: {
      LS1: [
        { uid: 'u-1', title: 'Front', fileName: 'front.jpg', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` },
        { uid: 'u-2', title: 'Side', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
      ],
      RS2: [{ uid: 'u-3', title: 'Right', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` }],
    },
    featuredImages: {
      LS1: { kind: 'uploaded', uid: 'u-2' },
      LS2: { kind: 'preset', src: '/images/LS2_rendering.webp' },
      LS3: { kind: 'preset', src: '/images/NOT_THERE.webp' },
    },
  };
}
