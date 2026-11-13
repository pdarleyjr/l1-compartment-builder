// Audit reproduction tests (sync-data part), updated for the Studio Worker (docs/audit/sync-data.md).
// The whole-document KV PUT API (SD-01/10/11/12/14/15) is replaced by revisioned planner ops; the legacy hostname
// answers writes with 409 APP_UPDATED. Tests below assert the new contract. SD-09/SD-13 (quantity and bundle invariants)
// live in the planner op engine (shared/planner.js, tests/shared) and are covered there.
import { afterEach, describe, expect, test, vi } from 'vitest';
import worker from '../../worker/index.js';
import { ADMIN, EDITOR, imagesFixture, makeEnv, ORIGIN, request, v1Fixture } from '../../worker/test/helpers/index.js';

vi.mock('../../shared/planner.js', async () => (await import('../../worker/test/helpers/fake-shared.js')).fakePlanner());
vi.mock('../../shared/ids.js', async () => (await import('../../worker/test/helpers/fake-shared.js')).fakeIds());
vi.mock('../../shared/validation.js', async () => (await import('../../worker/test/helpers/fake-shared.js')).fakeValidation());

const LEGACY = 'https://l1-state-sync.pdarleyjr.workers.dev';
const LEGACY_ORIGIN = 'http://127.0.0.1:4173';
const FOG = '1 3/4 in Fog Nozzle (Elkhart Chief XD 175 GPM @ 75psi)';
const TORCH = '1 1/2 Fog Nozzles';

async function migratedEnv(images) {
  const env = makeEnv({ kv: { allocations: v1Fixture(), ...(images ? { images } : {}) } });
  const res = await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: ADMIN, origin: ORIGIN }), env);
  expect((await res.json()).done).toBe(true);
  return env;
}
const ops = (env, clientOpId, op) => worker.fetch(request('POST', '/api/planner/ops', {
  actor: EDITOR, origin: ORIGIN, json: { baseRevision: 1, clientOpId, ops: [op] },
}), env);
const legacyCall = (env, method, path, body) => worker.fetch(new Request(`${LEGACY}${path}`, {
  method, headers: { Origin: LEGACY_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);

afterEach(() => { vi.useRealTimers(); });

describe('planner document: revisioned ops replace whole-document last-write-wins', () => {
  test('SD-01 two devices holding the same base revision edit different compartments: neither edit is lost', async () => {
    const env = await migratedEnv();
    const a = await ops(env, 'op_deviceA01', { op: 'setSlot', comp: 'LS3', index: 0, value: FOG, expect: '' });
    const b = await ops(env, 'op_deviceB01', { op: 'setSlot', comp: 'RS3', index: 0, value: FOG, expect: '' }); // B never saw A's revision
    expect(a.status).toBe(200);
    const merged = await b.json();
    expect(merged.applied).toEqual([0]);
    expect(merged.doc.allocations.LS3[0]).toBe(FOG);
    expect(merged.doc.allocations.RS3[0]).toBe(FOG);
  });

  test('SD-01 a stale edit of the SAME slot is reported as a conflict instead of silently overwriting', async () => {
    const env = await migratedEnv();
    await ops(env, 'op_deviceA02', { op: 'setSlot', comp: 'LS3', index: 1, value: FOG, expect: '' });
    const stale = await (await ops(env, 'op_deviceB02', { op: 'setSlot', comp: 'LS3', index: 1, value: TORCH, expect: '' })).json();
    expect(stale.conflicts).toEqual([{ index: 0, reason: 'PRECONDITION', current: FOG }]);
    expect(stale.doc.allocations.LS3[1]).toBe(FOG);
  });

  test('SD-14 writes in the same millisecond receive distinct, increasing revisions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const env = await migratedEnv();
    const r1 = await (await ops(env, 'op_samems001', { op: 'setSlot', comp: 'LS3', index: 2, value: FOG, expect: '' })).json();
    const r2 = await (await ops(env, 'op_samems002', { op: 'setSlot', comp: 'LS3', index: 3, value: FOG, expect: '' })).json();
    expect(r2.revision).toBeGreaterThan(r1.revision);
  });
});

describe('legacy whole-document API is closed (SD-01/10/11/12/15)', () => {
  test.each([
    ['SD-01 a stale full-document PUT cannot erase another device\'s edit', '/state', { allocations: { LS1: [] } }],
    ['SD-15 unknown top-level fields are not persisted', '/state', { allocations: { LS1: ['Axe'] }, junk: 'x'.repeat(100_000) }],
    ['SD-12 over-limit fields no longer fail silently half-way: the answer is a clear APP_UPDATED', '/state', { allocations: { LS1: Array(501).fill('') } }],
    ['SD-10 duplicate image uids are not persisted', '/images', { uploadedImages: { LS1: [{ uid: 'd', dataUrl: 'data:image/png;base64,AAAA' }, { uid: 'd', dataUrl: 'data:image/png;base64,AAAA' }] }, featuredImages: {} }],
    ['SD-10 a dangling featured upload is not persisted', '/images', { uploadedImages: {}, featuredImages: { LS1: { kind: 'uploaded', uid: 'gone' } } }],
  ])('%s', async (_name, path, body) => {
    const env = makeEnv({ kv: { allocations: v1Fixture() } });
    const before = env.L1_STATE.values.get('allocations');
    const res = await legacyCall(env, 'PUT', path, body);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('APP_UPDATED');
    expect(env.L1_STATE.values.get('allocations')).toBe(before);
    expect(env.L1_STATE.values.has('images')).toBe(false);
  });

  test('SD-11 no KV write exists to fail: legacy PUT answers with JSON even when KV.put would throw', async () => {
    const env = makeEnv({ kv: { allocations: v1Fixture() } });
    env.L1_STATE.put = async () => { throw new Error('KV PUT failed with 429 Too Many Requests'); };
    const res = await legacyCall(env, 'PUT', '/state', { allocations: {} });
    expect(res.status).toBe(409);
  });
});

describe('images: legacy base64 document -> committed assets', () => {
  test('SD-05 one new photo no longer re-sends the whole document: the legacy images read is a lightweight projection of URLs', async () => {
    const env = await migratedEnv(imagesFixture());
    const res = await worker.fetch(new Request(`${LEGACY}/images`, { headers: { Origin: LEGACY_ORIGIN } }), env);
    const text = await res.text();
    const doc = JSON.parse(text);
    expect(doc.uploadedImages.LS1).toHaveLength(2);
    expect(text).not.toMatch(/data:image/);
    expect(doc.uploadedImages.LS1[0].dataUrl).toMatch(/^https:\/\/.*\/api\/public\/assets\/ast_[0-9a-z]+\/display$/);
  });

  test('SD-10 a featured upload that points at a non-existent uid is skipped by the migration (reported, not stored)', async () => {
    const images = { uploadedImages: {}, featuredImages: { LS1: { kind: 'uploaded', uid: 'gone' } } };
    const env = makeEnv({ kv: { allocations: v1Fixture(), images } });
    const out = await (await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: ADMIN, origin: ORIGIN }), env)).json();
    expect(out.report.skipped).toEqual([{ compId: 'LS1', reason: 'featured image not resolvable' }]);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM main_images').first()).n).toBe(0);
  });
});
