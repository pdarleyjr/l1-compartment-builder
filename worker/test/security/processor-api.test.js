// Security review 2026-11 — the processor-facing API: lease ownership, asset scoping, claim contents, output validation.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createStack, device, JPEG, migrateUntilDone, one, SERVICE, uploadPhoto, v1Fixture, WEBP } from '../../../tests/integration/harness.js';
import { recoverExpiredLeases } from '../../src/studio/recovery.js';

let stack; let alice; let admin; let svc;
const N1 = { 'X-L1-Node': 'node-1' };
const N2 = { 'X-L1-Node': 'node-2' };

beforeEach(async () => {
  stack = createStack({ kv: { allocations: v1Fixture() } });
  alice = device(stack, 'user:alice@example.com'); admin = device(stack, ADMIN); svc = device(stack, SERVICE);
  await migrateUntilDone(admin);
  const cur = (await admin.get('/api/admin/settings')).body.settings['ai.enabled'].revision;
  await admin.put('/api/admin/settings/ai.enabled', { value: true, expectRevision: cur });
});

async function renderJob(references = []) {
  const made = await alice.call('POST', '/api/compartments/LS1/jobs', {
    json: { kind: 'render', mode: 'plan', referenceAssetIds: references }, headers: { 'Idempotency-Key': `lease-key-${Math.random().toString(36).slice(2)}` },
  });
  expect(made.status).toBe(202);
  return made.body.job.id;
}
const claim = (node = 'node-1') => svc.call('POST', '/api/processor/claim', { json: { node, kinds: ['render', 'recognize'] } });
const beat = (id, node, status) => svc.post(`/api/processor/jobs/${id}/heartbeat`, { node, status });

describe('lease ownership', () => {
  it('another node cannot heartbeat, upload, complete, fail or read assets for a job it does not hold', async () => {
    const { assetId } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'compartment' });
    const id = await renderJob([assetId]);
    expect((await claim('node-1')).status).toBe(200);
    expect((await beat(id, 'node-1', 'preparing')).status).toBe(200);
    expect((await beat(id, 'node-1', 'generating')).status).toBe(200);
    expect((await beat(id, 'node-1', 'saving')).status).toBe(200);
    // node-2 holds a valid service identity but not the lease
    expect((await beat(id, 'node-2', 'saving')).status).toBe(409);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, JPEG, 'image/jpeg', { headers: N2 })).status).toBe(409);
    expect((await svc.get(`/api/processor/assets/${assetId}/original?job=${id}`, { headers: N2 })).status).toBe(409);
    expect((await svc.post(`/api/processor/jobs/${id}/complete`, { node: 'node-2' })).status).toBe(409);
    expect((await svc.post(`/api/processor/jobs/${id}/fail`, { node: 'node-2', code: 'X', retryable: false })).status).toBe(409);
    expect(one(stack, 'SELECT status, lease_owner FROM generation_jobs WHERE id = ?', id)).toEqual({ status: 'saving', lease_owner: 'node-1' });
    // the owner is unaffected
    expect((await svc.get(`/api/processor/assets/${assetId}/original?job=${id}`, { headers: N1 })).status).toBe(200);
  });

  it('raw endpoints refuse requests that name no node at all (the lease check cannot be skipped by omission)', async () => {
    const { assetId } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'compartment' });
    const id = await renderJob([assetId]);
    await claim('node-1'); await beat(id, 'node-1', 'saving');
    expect((await svc.get(`/api/processor/assets/${assetId}/original?job=${id}`)).status).toBe(400);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, JPEG, 'image/jpeg')).status).toBe(400);
    expect((await svc.get(`/api/processor/assets/${assetId}/original?job=${id}`, { headers: { 'X-L1-Node': 'n'.repeat(65) } })).status).toBe(400);
    expect(one(stack, 'SELECT COUNT(*) n FROM assets WHERE category = ?', 'rendering').n).toBe(0);
  });

  it('after the lease expires and another node re-claims the job, the first node is locked out', async () => {
    const id = await renderJob();
    await claim('node-1');
    await beat(id, 'node-1', 'preparing');
    await recoverExpiredLeases(stack.env.DB, Date.now() + 3_600_000);
    stack.sql.exec('UPDATE generation_jobs SET next_attempt_at = NULL');
    expect((await claim('node-2')).status).toBe(200);
    expect((await beat(id, 'node-1', 'preparing')).status).toBe(409);
    expect((await beat(id, 'node-2', 'preparing')).status).toBe(200);
  });

  it('a heartbeat can never move a job backwards or to an unreportable state', async () => {
    const id = await renderJob();
    await claim('node-1');
    expect((await beat(id, 'node-1', 'generating')).status).toBe(200);
    expect((await beat(id, 'node-1', 'preparing')).status).toBe(400);
    for (const status of ['completed', 'queued', 'failed', 'cancelled', '__proto__']) expect((await beat(id, 'node-1', status)).status).toBe(400);
  });
});

describe('asset scoping and claim contents', () => {
  it('a job can read only the assets it references; other private photos are 403, even from the right node', async () => {
    const { assetId: mine } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'compartment' });
    const { assetId: other } = await uploadPhoto(alice, { compartmentId: 'LS2', category: 'compartment' });
    const id = await renderJob([mine]);
    await claim('node-1');
    expect((await svc.get(`/api/processor/assets/${mine}/original?job=${id}`, { headers: N1 })).status).toBe(200);
    expect((await svc.get(`/api/processor/assets/${other}/original?job=${id}`, { headers: N1 })).status).toBe(403);
    expect((await svc.get(`/api/processor/assets/${mine}/original`, { headers: N1 })).status).toBe(400); // ?job= is required
    expect((await svc.get(`/api/processor/assets/${mine}/original?job=gj_00000000000000000000zzzzzz`, { headers: N1 })).status).toBe(404);
  });

  it('a queued (unclaimed) job exposes nothing', async () => {
    const { assetId } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'compartment' });
    const id = await renderJob([assetId]);
    expect((await svc.get(`/api/processor/assets/${assetId}/original?job=${id}`, { headers: N1 })).status).toBe(409);
  });

  it('claim URLs are relative processor-asset paths built from ids (no attacker-controlled host), and leak no e-mail or request body', async () => {
    const { assetId } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'compartment', title: 'http://evil.example/x' });
    await renderJob([assetId]);
    const c = await claim('node-1');
    expect(c.status).toBe(200);
    expect(c.body.references.length).toBeGreaterThan(0);
    for (const r of c.body.references) {
      expect(r.url).toMatch(/^\/api\/processor\/assets\/ast_[0-9a-z]+\/original\?job=gj_[0-9a-z]+$/);
      expect(new URL(r.url, 'https://worker.test').origin).toBe('https://worker.test');
    }
    expect(c.text).not.toMatch(/alice@example\.com/);
    expect(c.body.spec.request).toBeUndefined();
  });
});

describe('output validation', () => {
  const bomb = (w, h) => { const b = new Uint8Array(48); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); b.set([0x49, 0x48, 0x44, 0x52], 12); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
  async function savingJob() {
    const id = await renderJob();
    await claim('node-1');
    for (const status of ['preparing', 'generating', 'saving']) await beat(id, 'node-1', status);
    return id;
  }

  it('output that is not an image, or declares a decode-bomb size, is refused and stored nowhere', async () => {
    const id = await savingJob();
    const before = stack.env.ASSETS.store.size;
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, html, 'image/png', { headers: N1 })).status).toBe(415);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, bomb(60000, 60000), 'image/png', { headers: N1 })).status).toBe(413);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, bomb(9000, 100), 'image/png', { headers: N1 })).status).toBe(413);
    expect(stack.env.ASSETS.store.size).toBe(before);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, bomb(1536, 1024), 'image/png', { headers: N1 })).status).toBe(204);
  });

  it('output is only accepted for a job in "saving" and is written under the server-derived asset id', async () => {
    const id = await renderJob();
    await claim('node-1');
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/original`, JPEG, 'image/jpeg', { headers: N1 })).status).toBe(409);
    for (const status of ['preparing', 'generating', 'saving']) await beat(id, 'node-1', status);
    expect((await svc.putBytes(`/api/processor/jobs/${id}/output/display`, WEBP, 'image/webp', { headers: N1 })).status).toBe(204);
    const keys = [...stack.env.ASSETS.store.keys()].filter(k => k.includes(`ast_${id.slice(3)}`));
    expect(keys).toEqual([`assets/LS1/ast_${id.slice(3)}/display.webp`]);
  });

  it('recognition results are validated: oversized lists, bad regions and out-of-range numbers are rejected; unknown equipment ids are dropped', async () => {
    const { assetId } = await uploadPhoto(alice, { compartmentId: 'LS1', category: 'tool' });
    const made = await alice.call('POST', '/api/compartments/LS1/jobs', { json: { kind: 'recognize', assetId }, headers: { 'Idempotency-Key': 'recog-validate-key-1' } });
    const id = made.body.job.id;
    await svc.call('POST', '/api/processor/claim', { json: { node: 'node-1', kinds: ['recognize'] } });
    for (const status of ['preparing', 'generating', 'saving']) await beat(id, 'node-1', status);
    const complete = result => svc.post(`/api/processor/jobs/${id}/complete`, { node: 'node-1', result });
    expect((await complete({ objects: new Array(51).fill({ label: 'x' }) })).status).toBe(400);
    expect((await complete({ objects: [{ label: 'x', quantity: 1e9 }] })).status).toBe(400);
    expect((await complete({ objects: [{ label: 'x', region: { x: 2, y: 0, w: 1, h: 1 } }] })).status).toBe(400);
    expect((await complete({ objects: [{ label: '<img src=x onerror=alert(1)>', candidates: [{ equipmentId: 'eq_notinregistry000000', name: 'x', confidence: 0.9 }] }] })).status).toBe(200);
    expect(one(stack, 'SELECT COUNT(*) n FROM asset_links WHERE asset_id = ?', assetId).n).toBe(0); // unknown equipment id never becomes a link
  });
});
