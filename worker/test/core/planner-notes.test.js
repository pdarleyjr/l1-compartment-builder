import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { EDITOR, makeEnv, ORIGIN, request, v1Fixture } from '../helpers/index.js';

vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron: async () => {} }));

async function migratedEnv() {
  const env = makeEnv({ kv: { allocations: v1Fixture() } });
  const res = await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: 'user:owner@example.com,admin', origin: ORIGIN }), env);
  expect((await res.json()).done).toBe(true);
  return env;
}
const post = (env, body) => worker.fetch(request('POST', '/api/planner/ops', { actor: EDITOR, json: body, origin: ORIGIN }), env);
const FOG = '1 3/4 in Fog Nozzle (Elkhart Chief XD 175 GPM @ 75psi)';

describe('planner notes and verification (real shared engine)', () => {
  it('setNote and setUnverified succeed for an editor and appear in the public planner', async () => {
    const env = await migratedEnv();
    const res = await post(env, { baseRevision: 1, clientOpId: 'op_notes001', ops: [
      { op: 'setNote', comp: 'LS1', text: 'Strap on the left\nCheck latch', expect: '' },
      { op: 'setUnverified', name: FOG, reason: 'Model unconfirmed' },
    ] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ applied: [0, 1], conflicts: [] });
    const read = await (await worker.fetch(request('GET', '/api/public/planner'), env)).json();
    expect(read.doc.notes.LS1.text).toBe('Strap on the left\nCheck latch');
    expect(typeof read.doc.notes.LS1.updatedAt).toBe('number');
    expect(read.doc.unverified).toEqual({ [FOG]: 'Model unconfirmed' });
  });

  it('RS3 takes a note like any other compartment', async () => {
    const env = await migratedEnv();
    const res = await post(env, { baseRevision: 1, clientOpId: 'op_notes002', ops: [{ op: 'setNote', comp: 'RS3', text: 'RS3 note', expect: '' }] });
    const body = await res.json();
    expect(body.applied).toEqual([0]);
    expect(body.conflicts).toEqual([]);
    const read = await (await worker.fetch(request('GET', '/api/public/planner'), env)).json();
    expect(read.doc.notes.RS3.text).toBe('RS3 note');
  });

  it('a stale expect returns PRECONDITION with the current text', async () => {
    const env = await migratedEnv();
    await post(env, { baseRevision: 1, clientOpId: 'op_notes003', ops: [{ op: 'setNote', comp: 'LS2', text: 'first', expect: '' }] });
    const res = await post(env, { baseRevision: 2, clientOpId: 'op_notes004', ops: [{ op: 'setNote', comp: 'LS2', text: 'second', expect: '' }] });
    expect((await res.json()).conflicts[0]).toMatchObject({ reason: 'PRECONDITION', current: 'first' });
  });
});
