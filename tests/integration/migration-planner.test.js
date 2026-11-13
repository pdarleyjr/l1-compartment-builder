// (a) legacy KV fixture → migrate-legacy until done; (b) planner ops from two devices.
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, EDITOR, EDITOR_B, createStack, device, migrateUntilDone, plannerOf, one } from './harness.js';

describe('legacy migration → planner', () => {
  let stack; let admin; let a; let b; let anon;
  beforeAll(() => {
    stack = createStack();
    admin = device(stack, ADMIN); a = device(stack, EDITOR); b = device(stack, EDITOR_B); anon = device(stack, null);
  });

  it('is not migrated yet: the public planner serves the legacy KV document with revision 0', async () => {
    const r = await anon.get('/api/public/planner');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ revision: 0, migrated: false });
    expect(r.body.doc.allocations.LS1[0]).toBe('1 Ton Griphoist');
    expect((await a.post('/api/planner/ops', { baseRevision: 0, clientOpId: 'op-before-migration', ops: [{ op: 'setSlot', comp: 'LS3', index: 0, value: 'x', expect: '' }] })).status).toBe(409);
  });

  it('(a) migrates in chunks until done and the counts match', async () => {
    expect((await a.post('/api/admin/migrate-legacy')).status).toBe(403); // editors may not
    const { last } = await migrateUntilDone(admin);
    expect(last.done).toBe(true);
    const { before, after, skipped } = last.report;
    expect(before).toEqual({ compartments: 11, occupiedSlots: 4, equipment: 2, bundles: 1, uploadedImages: 3, featured: 3 });
    expect(after).toEqual({ ...before, featured: 2 });
    expect(skipped).toEqual([{ compId: 'LS3', reason: 'featured image not resolvable' }]);
    expect((await migrateUntilDone(admin)).last.done).toBe(true); // idempotent
    expect(one(stack, 'SELECT COUNT(*) n FROM assets').n).toBe(3);

    const planner = await plannerOf(anon);
    expect(planner).toMatchObject({ revision: 1, migrated: true });
    expect(planner.doc.allocations.LS1.slice(0, 2)).toEqual(['1 Ton Griphoist', 'Custom Wrench']);
    expect(Object.keys(planner.doc.equipmentIds).length).toBeGreaterThan(60); // every inventory item has an id
    expect(planner.doc.assignmentIds.LS1[0]).toMatch(/^as_/);

    const mains = (await anon.get('/api/public/main-images')).body;
    expect(Object.keys(mains.mainImages).sort()).toEqual(['LS1', 'LS2']);
    expect(mains.mainImages.LS2).toMatchObject({ kind: 'preset', ref: '/images/LS2_rendering.webp', revision: 1 });
    expect(mains.mainImages.LS1.url).toMatch(/^\/api\/public\/assets\/ast_/);
  });

  it('serves 304 with an ETag when `since` matches', async () => {
    const full = await anon.get('/api/public/planner');
    expect(full.headers.get('ETag')).toBe('"1"');
    expect((await anon.get('/api/public/planner?since=1')).status).toBe(304);
    expect((await anon.get('/api/public/planner?since=0')).status).toBe(200);
  });

  it('keeps the legacy hostname read-only and equal to the v1 projection', async () => {
    const legacy = device(stack, null, { host: 'l1-state-sync.pdarleyjr.workers.dev' });
    const state = await legacy.get('/state');
    expect(state.status).toBe(200);
    expect(state.body.allocations.LS1.slice(0, 2)).toEqual(['1 Ton Griphoist', 'Custom Wrench']);
    expect(state.body.customTools).toEqual([{ name: 'Custom Wrench', qty: 2, dimensions: '12 in' }]);
    const write = await legacy.call('PUT', '/state', { json: { allocations: {} }, headers: { Origin: 'https://l1.mbfdhub.com' }, actor: null });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe('APP_UPDATED');
  });

  it('(b) ops from two devices on different compartments both persist (b is stale and still applies)', async () => {
    const start = await plannerOf(a);
    const opA = await a.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'dev-a-op-0001', ops: [{ op: 'setSlot', comp: 'LS3', index: 0, value: '2.5 in Gate Valve', expect: '' }] });
    expect(opA.status).toBe(200);
    expect(opA.body).toMatchObject({ applied: [0], conflicts: [], revision: start.revision + 1 });
    // device B still believes `start.revision`
    const opB = await b.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'dev-b-op-0001', ops: [{ op: 'setSlot', comp: 'RS3', index: 2, value: '6 lb Flathead Axe', expect: '' }] });
    expect(opB.status).toBe(200);
    expect(opB.body).toMatchObject({ applied: [0], conflicts: [], revision: start.revision + 2 });
    const doc = (await plannerOf(anon)).doc;
    expect(doc.allocations.LS3[0]).toBe('2.5 in Gate Valve');
    expect(doc.allocations.RS3[2]).toBe('6 lb Flathead Axe');
    expect(doc.assignmentIds.LS3[0]).toMatch(/^as_/);
    // an offline retry of the same op is deduplicated, not applied twice
    const replay = await a.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'dev-a-op-0001', ops: [{ op: 'setSlot', comp: 'LS3', index: 0, value: '2.5 in Gate Valve', expect: '' }] });
    expect(replay.body).toMatchObject({ deduped: true, applied: [0] });
    expect((await plannerOf(anon)).revision).toBe(start.revision + 2);
    expect(one(stack, "SELECT COUNT(*) n FROM audit_log WHERE action = 'planner.ops'").n).toBe(2);
  });

  it('(b) the last unit of an item can be assigned once: the second device gets a QUANTITY conflict', async () => {
    const NAME = '2.5 gal Water Extinguisher'; // inventory quantity 1
    const start = await plannerOf(a);
    const first = await a.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'last-unit-a-01', ops: [{ op: 'setSlot', comp: 'LS4', index: 0, value: NAME, expect: '' }] });
    expect(first.body.applied).toEqual([0]);
    const second = await b.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'last-unit-b-01', ops: [{ op: 'setSlot', comp: 'RS4', index: 0, value: NAME, expect: '' }] });
    expect(second.status).toBe(200);
    expect(second.body.applied).toEqual([]);
    expect(second.body.conflicts).toHaveLength(1);
    expect(second.body.conflicts[0]).toMatchObject({ index: 0, reason: 'QUANTITY' });
    const doc = (await plannerOf(anon)).doc;
    expect(doc.allocations.LS4[0]).toBe(NAME);
    expect(doc.allocations.RS4[0]).toBe('');
    // a stale slot precondition is a PRECONDITION conflict, not an overwrite
    const clash = await b.post('/api/planner/ops', { baseRevision: 0, clientOpId: 'precondition-b1', ops: [{ op: 'setSlot', comp: 'LS4', index: 0, value: '2.5 in Gate Valve', expect: '' }] });
    expect(clash.body.conflicts[0].reason).toBe('PRECONDITION');
  });

  it('rejects malformed and unauthenticated writes', async () => {
    expect((await anon.post('/api/planner/ops', { baseRevision: 0, clientOpId: 'anon-op-0001', ops: [{ op: 'setSlot', comp: 'LS1', index: 0, value: '', expect: '' }] })).status).toBe(401);
    expect((await a.post('/api/planner/ops', { baseRevision: 0, clientOpId: 'bad-op-00001', ops: [{ op: 'nope' }] })).status).toBe(400);
    expect((await a.post('/api/planner/ops', { baseRevision: 0, ops: [] })).status).toBe(400);
  });
});
