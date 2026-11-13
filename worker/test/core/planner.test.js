import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { applyPlannerOpsInBatch } from '../../src/planner.js';
import { EDITOR, makeEnv, ORIGIN, request, v1Fixture } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron: async () => {} }));

async function migratedEnv() {
  const env = makeEnv({ kv: { allocations: v1Fixture() } });
  const res = await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: 'user:owner@example.com,admin', origin: ORIGIN }), env);
  expect((await res.json()).done).toBe(true);
  return env;
}
const ops = (env, body, actor = EDITOR) => worker.fetch(request('POST', '/api/planner/ops', { actor, json: body, origin: ORIGIN }), env);
const FOG = '1 3/4 in Fog Nozzle (Elkhart Chief XD 175 GPM @ 75psi)'; // master qty 5, unassigned in the fixture
const setSlot = (comp, index, value, expect) => ({ op: 'setSlot', comp, index, value, ...(expect !== undefined ? { expect } : {}) });

describe('GET /api/public/planner', () => {
  it('serves the KV v1 document with revision 0 and migrated:false before migration', async () => {
    const env = makeEnv({ kv: { allocations: v1Fixture() } });
    const res = await worker.fetch(request('GET', '/api/public/planner'), env);
    const body = await res.json();
    expect(body).toMatchObject({ revision: 0, migrated: false });
    expect(body.doc.allocations.LS1[0]).toBe('1 Ton Griphoist');
    expect(res.headers.get('ETag')).toBe('"0"');
    expect((await worker.fetch(request('GET', '/api/public/planner?since=0'), env)).status).toBe(304);
  });

  it('serves the v1 projection + identity registries after migration, 304 when since matches', async () => {
    const env = await migratedEnv();
    const res = await worker.fetch(request('GET', '/api/public/planner?since=0'), env);
    const body = await res.json();
    expect(body).toMatchObject({ revision: 1, migrated: true });
    expect(Object.keys(body.doc).sort()).toEqual(['allocations', 'assignmentIds', 'bundles', 'customDimensions', 'customQtys', 'customTools', 'equipmentIds', 'removedItems']);
    expect(res.headers.get('ETag')).toBe('"1"');
    const same = await worker.fetch(request('GET', '/api/public/planner?since=1'), env);
    expect(same.status).toBe(304);
    expect(await same.text()).toBe('');
    const inm = await worker.fetch(request('GET', '/api/public/planner', { headers: { 'If-None-Match': '"1"' } }), env);
    expect(inm.status).toBe(304);
  });

  it('is public (no sign-in needed)', async () => {
    expect((await worker.fetch(request('GET', '/api/public/planner'), makeEnv())).status).toBe(200);
  });
});

describe('POST /api/planner/ops', () => {
  it('requires an editor and refuses writes before migration', async () => {
    const env = makeEnv({ kv: { allocations: v1Fixture() } });
    const body = { baseRevision: 0, clientOpId: 'op_00000001', ops: [setSlot('LS3', 0, '1 Ton Griphoist')] };
    expect((await worker.fetch(request('POST', '/api/planner/ops', { json: body, origin: ORIGIN }), env)).status).toBe(401);
    const res = await ops(env, body);
    expect(res.status).toBe(409);
    const err = (await res.json()).error;
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('Planner migration pending');
  });

  it('applies ops, bumps revision, records history and audit', async () => {
    const env = await migratedEnv();
    const res = await ops(env, { baseRevision: 1, clientOpId: 'op_00000002', ops: [setSlot('LS3', 0, FOG, '')] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ revision: 2, applied: [0], conflicts: [] });
    expect(body.doc.allocations.LS3[0]).toBe(FOG);
    const hist = await env.DB.prepare('SELECT revision, client_op_id, actor FROM planner_history').all();
    expect(hist.results).toEqual([{ revision: 2, client_op_id: 'op_00000002', actor: 'editor@example.com' }]);
    const audit = await env.DB.prepare("SELECT actor FROM audit_log WHERE action = 'planner.ops'").all();
    expect(audit.results).toHaveLength(1);
    const read = await (await worker.fetch(request('GET', '/api/public/planner?since=1'), env)).json();
    expect(read.revision).toBe(2);
  });

  it('dedupes by clientOpId and returns the recorded result without writing again', async () => {
    const env = await migratedEnv();
    const body = { baseRevision: 1, clientOpId: 'op_00000003', ops: [setSlot('LS3', 1, FOG, '')] };
    const first = await (await ops(env, body)).json();
    const again = await (await ops(env, body)).json();
    expect(again).toMatchObject({ revision: 2, applied: first.applied, conflicts: [], deduped: true });
    const row = await env.DB.prepare("SELECT revision FROM planner_doc WHERE id = 'main'").first();
    expect(row.revision).toBe(2);
  });

  it('reports precondition and QUANTITY conflicts but still applies the rest', async () => {
    const env = await migratedEnv();
    // '1 Ton Griphoist' has qty 1 in the master inventory but is already assigned twice in the fixture (2 slots): no room.
    const res = await ops(env, { baseRevision: 1, clientOpId: 'op_00000004', ops: [
      setSlot('LS3', 0, '1 Ton Griphoist', ''),            // QUANTITY
      setSlot('LS4', 0, 'Custom Wrench', 'stale-value'),   // PRECONDITION
      setSlot('LS4', 1, 'Custom Wrench', ''),              // ok (qty 2, 2 assigned already -> QUANTITY too)
      { op: 'setCustomQty', name: 'Custom Wrench', qty: 5 },
    ] });
    const body = await res.json();
    expect(body.conflicts.map(c => [c.index, c.reason])).toEqual([[0, 'QUANTITY'], [1, 'PRECONDITION'], [2, 'QUANTITY']]);
    expect(body.applied).toEqual([3]);
    expect(body.doc.customQtys['Custom Wrench']).toBe(5);
    expect(body.revision).toBe(2);
  });

  it('does not bump the revision when nothing changed', async () => {
    const env = await migratedEnv();
    const res = await ops(env, { baseRevision: 1, clientOpId: 'op_00000005', ops: [setSlot('LS1', 0, '1 Ton Griphoist')] });
    expect((await res.json()).revision).toBe(1);
  });

  it('retries on a CAS miss caused by a concurrent write and still applies', async () => {
    const env = await migratedEnv();
    const realBatch = env.DB.batch.bind(env.DB);
    let raced = false;
    env.DB.batch = async statements => {
      if (!raced) {
        raced = true; // a competing writer commits revision 2 between our read and our batch
        const rival = await applyPlannerOpsInBatch(env.DB, { ops: [setSlot('RS5', 0, FOG, '')], actor: { kind: 'user', email: 'rival@example.com', roles: ['editor'] }, clientOpId: 'op_rival001' });
        await realBatch(rival.statements);
      }
      return realBatch(statements);
    };
    const res = await ops(env, { baseRevision: 1, clientOpId: 'op_00000006', ops: [setSlot('RS4', 0, FOG, '')] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(raced).toBe(true);
    expect(body.revision).toBe(3);
    expect(body.doc.allocations.RS5[0]).toBe(FOG); // the rival edit survived
    expect(body.doc.allocations.RS4[0]).toBe(FOG);
    const revs = (await env.DB.prepare('SELECT revision FROM planner_history ORDER BY revision').all()).results.map(r => r.revision);
    expect(revs).toEqual([2, 3]);
  });

  it('gives up with REVISION_CONFLICT after repeated CAS misses', async () => {
    const env = await migratedEnv();
    const realBatch = env.DB.batch.bind(env.DB);
    let n = 0;
    env.DB.batch = async statements => {
      const rival = await applyPlannerOpsInBatch(env.DB, { ops: [{ op: 'setCustomQty', name: 'x', qty: ++n }], actor: { kind: 'user', email: 'r@example.com', roles: ['editor'] }, clientOpId: `op_rival${String(n).padStart(4, '0')}` });
      await realBatch(rival.statements);
      return realBatch(statements);
    };
    const res = await ops(env, { baseRevision: 1, clientOpId: 'op_00000007', ops: [setSlot('RS4', 0, FOG, '')] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('REVISION_CONFLICT');
  });

  it.each([
    ['missing clientOpId', { baseRevision: 1, ops: [setSlot('LS1', 0, '')] }],
    ['bad baseRevision', { baseRevision: 'x', clientOpId: 'op_00000008', ops: [setSlot('LS1', 0, '')] }],
    ['empty ops', { baseRevision: 1, clientOpId: 'op_00000008', ops: [] }],
    ['too many ops', { baseRevision: 1, clientOpId: 'op_00000008', ops: Array(201).fill(setSlot('LS1', 0, '')) }],
    ['invalid op', { baseRevision: 1, clientOpId: 'op_00000008', ops: [{ op: 'dropEverything' }] }],
  ])('rejects %s with 400', async (_n, body) => {
    const env = await migratedEnv();
    expect((await ops(env, body)).status).toBe(400);
  });

  it('applyPlannerOpsInBatch lets another module batch planner ops with its own statements atomically', async () => {
    const env = await migratedEnv();
    const { statements, result } = await applyPlannerOpsInBatch(env.DB, { ops: [setSlot('LS3', 2, FOG, '')], actor: { kind: 'user', email: 'e@example.com', roles: ['editor'] }, clientOpId: 'op_asset001', now: 5 });
    expect(result).toMatchObject({ revision: 2, changed: true });
    await env.DB.batch([env.DB.prepare("INSERT INTO audit_log (at, action) VALUES (1, 'asset.commit')"), ...statements]);
    expect((await env.DB.prepare("SELECT revision FROM planner_doc WHERE id='main'").first()).revision).toBe(2);
    // a stale second batch fails as a whole (its own statement is rolled back)
    const stale = await applyPlannerOpsInBatch(env.DB, { ops: [setSlot('LS3', 3, FOG, '')], actor: { kind: 'user', email: 'e@example.com', roles: ['editor'] }, clientOpId: 'op_asset002' });
    await env.DB.batch(stale.statements);
    const stale2 = { ...stale };
    await expect(env.DB.batch([env.DB.prepare("INSERT INTO audit_log (at, action) VALUES (2, 'should-roll-back')"), ...stale2.statements])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='should-roll-back'").first()).n).toBe(0);
  });
});
