import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as processor from '../../src/processor.js';
import * as jobs from '../../src/jobs.js';
import * as assets from '../../src/assets.js';
import { studioCron } from '../../src/studio-handlers.js';
import { ASSET_LIMITS, JOB_TIMING } from '../../../shared/contracts.js';
import { EQ, NOW, admin, call, editor, insertAsset, jsonOf, makeEnv, service, setSetting } from './helpers/harness.js';
import { jpeg, png, webp, heic } from './helpers/images.js';
import { resetIds } from './helpers/fakes.js';

vi.mock('../../../shared/ids.js', async () => (await import('./helpers/fakes.js')).idsFake);
vi.mock('../../../shared/planner.js', async () => (await import('./helpers/fakes.js')).plannerSharedFake);
vi.mock('../../../shared/fingerprint.js', async () => (await import('./helpers/fakes.js')).fingerprintFake);
vi.mock('../../../shared/apparatus-render.js', async () => (await import('./helpers/fakes.js')).apparatusRenderFake);
vi.mock('../../../shared/cost.js', async () => (await import('./helpers/fakes.js')).costFake);
vi.mock('../../../shared/scene-spec.js', async () => (await import('./helpers/fakes.js')).sceneSpecFake);
vi.mock('../../../shared/validation.js', async () => (await import('./helpers/fakes.js')).validationFake);
vi.mock('../../src/settings.js', async () => (await import('./helpers/fakes.js')).settingsFake());
vi.mock('../../src/planner.js', async () => (await import('./helpers/fakes.js')).plannerModuleFake);

let t;
beforeEach(() => {
  resetIds(); t = makeEnv();
  setSetting(t.db, 'ai.enabled', true); setSetting(t.db, 'jobs.maxConcurrent', 50); setSetting(t.db, 'jobs.userMaxConcurrent', 50);
});

let seq = 0;
// Raw endpoints must identify the node (X-L1-Node); a request without it is rejected (see worker/test/security).
const svc = (handler, o) => call(handler, t.env, { actor: service(), method: 'POST', ...o, headers: { 'X-L1-Node': 'k8', ...o?.headers } });
const claim = (node = 'k8', kinds, now = NOW) => svc(processor.claim, { body: { node, kinds }, now });
const heartbeat = (id, body, now = NOW) => svc(processor.heartbeat, { body, params: { jobId: id }, now });
const output = (id, variant, bytes, o) => svc(processor.putOutput, { method: 'PUT', raw: bytes, params: { jobId: id, variant }, ...o });
const complete = (id, body, now = NOW) => svc(processor.complete, { body, params: { jobId: id }, now });
const fail = (id, body, now = NOW) => svc(processor.fail, { body, params: { jobId: id }, now });
const job = id => t.db.one('SELECT * FROM generation_jobs WHERE id = ?', id);
const ledger = id => t.db.one('SELECT * FROM spend_ledger WHERE job_id = ?', id);

async function newJob(body = { kind: 'render', mode: 'plan', preset: 'preview' }, actor = editor(), comp = 'LS1') {
  const res = await call(jobs.createJob, t.env, { method: 'POST', body, params: { compId: comp }, headers: { 'Idempotency-Key': `k${seq += 1}` }, actor });
  expect(res.status).toBe(202);
  return (await jsonOf(res)).job.id;
}

async function uploadOutput(id) {
  expect((await output(id, 'original', png(1536, 1024, 10))).status).toBe(204);
  expect((await output(id, 'display', webp(1536, 1024))).status).toBe(204);
  expect((await output(id, 'thumb', jpeg(400, 267))).status).toBe(204);
}

async function toSaving(id, node = 'k8') {
  for (const status of ['preparing', 'generating', 'saving']) expect((await heartbeat(id, { node, status })).status).toBe(200);
}

describe('claim', () => {
  it('returns 204 when nothing is queued and claims the oldest queued job atomically with a lease', async () => {
    expect((await claim()).status).toBe(204);
    insertAsset(t, 'ast_1', 'LS1', { title: 'Tool' });
    const a = await newJob();
    const b = await newJob();
    const res = await claim('k8', ['render'], NOW + 5);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.job).toMatchObject({ id: a, kind: 'render', mode: 'plan', model: 'gpt-image-2.6-flare', quality: 'low', complexity: 'medium', size: '1536x1024', outputFormat: 'jpeg', attempts: 1 });
    expect(body.job.prompt).toContain('LS1');
    expect(body.spec).toMatchObject({ schema: 'l1.scene/1' });
    expect(body.spec.request).toBeUndefined();
    expect(body.job.moderation).toBe('auto');
    expect(body.maxReferences).toBe(10);
    expect(body).not.toHaveProperty('contactSheets'); // sheet items are flattened into references
    expect(body.references).toEqual([{ assetId: 'ast_1', role: 'tool', label: 'Tool', url: `/api/processor/assets/ast_1/original?job=${a}`, sheet: null }]);
    expect(body.leaseExpiresAt).toBe(NOW + 5 + JOB_TIMING.leaseMs);
    expect(job(a)).toMatchObject({ status: 'claimed', lease_owner: 'k8', attempts: 1, heartbeat_at: NOW + 5 });
    expect(job(b).status).toBe('queued');
    expect((await claim('k8-b')).status).toBe(200);
    expect((await claim('k8-c')).status).toBe(204);
  });

  it('puts overflow references into contact sheets (still authorized)', async () => {
    setSetting(t.db, 'references.maxPerRequest', 2);
    for (let i = 0; i < 4; i += 1) insertAsset(t, `ast_${i}`, 'LS1');
    await newJob();
    const body = await jsonOf(await claim());
    expect(body.maxReferences).toBe(2);
    expect(body.references).toHaveLength(4);
    expect(body.references.filter(r => r.sheet === null).map(r => r.assetId)).toEqual(['ast_0', 'ast_1']);
    const sheeted = body.references.filter(r => r.sheet !== null);
    expect(sheeted.map(r => r.assetId).sort()).toEqual(['ast_2', 'ast_3']);
    expect(new Set(sheeted.map(r => r.sheet)).size).toBe(1);
    expect(sheeted.every(r => typeof r.role === 'string' && r.url.includes('/api/processor/assets/'))).toBe(true);
  });

  it('honours kinds, next_attempt_at backoff and cancel_requested; validates the body', async () => {
    const id = await newJob();
    expect((await claim('k8', ['recognize'])).status).toBe(204);
    t.db.sqlite.prepare('UPDATE generation_jobs SET next_attempt_at = ? WHERE id = ?').run(NOW + 1000, id);
    expect((await claim()).status).toBe(204);
    expect((await claim('k8', undefined, NOW + 1000)).status).toBe(200);
    const id2 = await newJob();
    t.db.sqlite.prepare('UPDATE generation_jobs SET cancel_requested = 1 WHERE id = ?').run(id2);
    expect((await claim()).status).toBe(204);
    expect((await svc(processor.claim, { body: {} })).status).toBe(400);
    expect((await svc(processor.claim, { body: { node: 'n', kinds: ['bogus'] } })).status).toBe(400);
  });

  it('recognize claims carry the subject photo as the only reference', async () => {
    insertAsset(t, 'ast_t', 'LS1');
    const id = await newJob({ kind: 'recognize', assetId: 'ast_t' });
    const body = await jsonOf(await claim('k8', ['recognize']));
    expect(body.job).toMatchObject({ id, kind: 'recognize', model: 'gpt-5.4-mini' });
    expect(body.references).toEqual([expect.objectContaining({ assetId: 'ast_t', role: 'subject' })]);
  });
});

describe('heartbeat', () => {
  it('moves forward only, extends the lease, sets provider_called_at on generating and reports cancelRequested', async () => {
    const id = await newJob();
    await claim();
    const prep = await heartbeat(id, { node: 'k8', status: 'preparing' }, NOW + 20_000);
    expect(await jsonOf(prep)).toMatchObject({ leaseExpiresAt: NOW + 20_000 + JOB_TIMING.leaseMs, cancelRequested: false, status: 'preparing' });
    expect(job(id).provider_called_at).toBeNull();
    await heartbeat(id, { node: 'k8', status: 'generating' }, NOW + 40_000);
    expect(job(id)).toMatchObject({ status: 'generating', provider_called_at: NOW + 40_000 });
    await heartbeat(id, { node: 'k8' }, NOW + 50_000);
    await heartbeat(id, { node: 'k8', status: 'generating' }, NOW + 60_000);
    expect(job(id).provider_called_at).toBe(NOW + 40_000);
    expect((await heartbeat(id, { node: 'k8', status: 'preparing' })).status).toBe(400);
    t.db.sqlite.prepare('UPDATE generation_jobs SET cancel_requested = 1 WHERE id = ?').run(id);
    expect((await jsonOf(await heartbeat(id, { node: 'k8' }))).cancelRequested).toBe(true);
    expect((await heartbeat(id, { node: 'k8', status: 'completed' })).status).toBe(400);
  });

  it('only the lease owner of an active job may heartbeat (409 LEASE_LOST otherwise)', async () => {
    const id = await newJob();
    expect((await heartbeat(id, { node: 'k8' })).status).toBe(409);   // queued
    await claim('k8');
    const stolen = await heartbeat(id, { node: 'other' });
    expect(stolen.status).toBe(409);
    expect((await jsonOf(stolen)).error.code).toBe('LEASE_LOST');
    expect((await heartbeat(id, {})).status).toBe(400);
    expect((await heartbeat('gj_nope', { node: 'k8' })).status).toBe(404);
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'completed' WHERE id = ?").run(id);
    expect((await heartbeat(id, { node: 'k8' })).status).toBe(409);
  });
});

describe('getAsset', () => {
  it('serves only assets referenced by the job to the lease owner', async () => {
    insertAsset(t, 'ast_ref', 'LS1');
    const id = await newJob();
    insertAsset(t, 'ast_other', 'LS1');   // created after the job: not part of its references
    const get = (assetId, query = `?job=${id}`, headers) => svc(processor.getAsset, { method: 'GET', params: { assetId, variant: 'original' }, query, headers });
    expect((await get('ast_ref')).status).toBe(409);       // not claimed yet
    await claim('k8');
    const ok = await get('ast_ref');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect((await get('ast_other')).status).toBe(403);
    expect((await get('ast_ref', '')).status).toBe(400);
    expect((await get('ast_ref', `?job=${id}`, { 'X-L1-Node': 'someone-else' })).status).toBe(409);
    expect((await get('ast_ref', `?job=${id}`, { 'X-L1-Node': 'k8' })).status).toBe(200);
    expect((await get('ast_ref', '?job=gj_nope')).status).toBe(404);
  });
});

describe('putOutput + complete (render)', () => {
  it('stores output under the server-chosen asset id and completes in one batch: asset, draft version, job, settled ledger, audit', async () => {
    const id = await newJob({ kind: 'render', mode: 'plan', preset: 'high', instructions: 'brighter' });
    const estimate = ledger(id).estimated_usd;
    await claim();
    await toSaving(id);
    await uploadOutput(id);
    const assetId = processor.outputAssetId(id);
    expect([...t.r2.store.keys()].sort()).toEqual([`assets/LS1/${assetId}/display.webp`, `assets/LS1/${assetId}/original.png`, `assets/LS1/${assetId}/thumb.jpg`]);
    const usage = { inputTokens: 1000, outputTokens: 5000 };
    const res = await complete(id, { node: 'k8', usage, providerRequestId: 'req_1', width: 1536, height: 1024 }, NOW + 90_000);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, versionId: processor.outputVersionId(id), costUsd: 0.158 });

    expect(t.db.one('SELECT * FROM assets WHERE id = ?', assetId)).toMatchObject({
      category: 'rendering', provenance: 'ai_concept', status: 'committed', visibility: 'private', width: 1536, height: 1024,
      original_type: 'image/png', created_by: 'ed@mbfd.test', thumb_key: `assets/LS1/${assetId}/thumb.jpg`,
    });
    const v = t.db.one('SELECT * FROM image_versions WHERE job_id = ?', id);
    expect(v).toMatchObject({ id: processor.outputVersionId(id), asset_id: assetId, status: 'draft', model: 'gpt-image-2.6-sunburst', instructions: 'brighter', cost_usd: 0.158, created_by: 'ed@mbfd.test', planner_revision: 1 });
    expect(JSON.parse(v.settings)).toMatchObject({ preset: 'high', quality: 'high', size: '1536x1024' });
    expect(v.inventory_fingerprint).toBeTruthy();
    expect(job(id)).toMatchObject({ status: 'completed', actual_cost_usd: 0.158, provider_request_id: 'req_1', result_version_id: v.id, lease_owner: null });
    expect(ledger(id)).toMatchObject({ state: 'settled', actual_usd: 0.158 });
    expect(0.158).not.toBe(estimate);
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.complete'").n).toBe(1);
    expect((await complete(id, { node: 'k8', usage })).status).toBe(409);     // no longer leased: no double completion
    expect(t.db.one('SELECT COUNT(*) AS n FROM image_versions').n).toBe(1);
  });

  it('falls back to the estimate when usage is missing or unusable', async () => {
    const id = await newJob();
    const estimate = ledger(id).estimated_usd;
    await claim(); await toSaving(id); await uploadOutput(id);
    expect((await complete(id, { node: 'k8' })).status).toBe(200);
    expect(ledger(id)).toMatchObject({ state: 'settled', actual_usd: estimate });
  });

  it('putOutput: magic bytes, per-variant caps, status saving and lease owner are enforced', async () => {
    const id = await newJob();
    await claim();
    expect((await output(id, 'original', png())).status).toBe(409);                // not saving yet
    await toSaving(id);
    expect((await output(id, 'original', heic())).status).toBe(415);
    expect((await output(id, 'original', new TextEncoder().encode('<html>hello world</html>'))).status).toBe(415);
    expect((await output(id, 'display', png(10, 10, 20))).status).toBe(415);       // derivatives are webp/jpeg
    expect((await output(id, 'thumb', webp(10, 10, ASSET_LIMITS.thumbMaxBytes + 5))).status).toBe(413);
    expect((await output(id, 'bogus', png())).status).toBe(404);
    expect((await output(id, 'original', png(), { headers: { 'X-L1-Node': 'intruder' } })).status).toBe(409);
    expect((await output('gj_nope', 'original', png())).status).toBe(404);
    expect(t.r2.store.size).toBe(0);
    const rec = await newJob({ kind: 'recognize', assetId: (insertAsset(t, 'ast_t', 'LS1'), 'ast_t') });
    expect(rec).toBeTruthy();
  });

  it('complete refuses an incomplete upload, a wrong owner, and a job that is not saving', async () => {
    const id = await newJob();
    await claim();
    expect((await complete(id, { node: 'k8' })).status).toBe(409);                  // claimed
    await toSaving(id);
    await output(id, 'original', png(10, 10, 20));
    const res = await complete(id, { node: 'k8' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.message).toMatch(/missing display/);
    expect((await complete(id, { node: 'imposter' })).status).toBe(409);
    expect(t.db.one('SELECT COUNT(*) AS n FROM image_versions').n).toBe(0);
    expect(job(id).status).toBe('saving');
    expect(ledger(id).state).toBe('reserved');
  });

  it('a cancel requested during generation does not discard a paid result', async () => {
    const id = await newJob();
    await claim(); await toSaving(id);
    await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: id } });
    expect(job(id).cancel_requested).toBe(1);
    expect((await jsonOf(await heartbeat(id, { node: 'k8' }))).cancelRequested).toBe(true);
    await uploadOutput(id);
    expect((await complete(id, { node: 'k8', usage: { inputTokens: 1, outputTokens: 1 } })).status).toBe(200);
    expect(job(id).status).toBe('completed');
  });
});

describe('complete (recognize)', () => {
  const setup = async () => {
    insertAsset(t, 'ast_t', 'LS1');
    const id = await newJob({ kind: 'recognize', assetId: 'ast_t' });
    await claim('k8', ['recognize']);
    await heartbeat(id, { node: 'k8', status: 'generating' });
    return id;
  };
  const result = { objects: [
    { label: 'axe', quantity: 1, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, candidates: [{ equipmentId: EQ.axe, name: 'Axe', confidence: 0.9 }, { equipmentId: 'eq_ghost', name: 'Ghost', confidence: 0.4 }] },
    { label: 'mystery', quantity: 2, candidates: [{ name: 'Unknown thing', confidence: 0.2 }] },
  ] };

  it('stores the result and creates suggested links only (never confirmed), skipping unknown equipment', async () => {
    const id = await setup();
    const res = await complete(id, { node: 'k8', usage: { inputTokens: 2000, outputTokens: 500 }, result });
    expect(res.status).toBe(200);
    expect(job(id)).toMatchObject({ status: 'completed', result_version_id: null });
    expect(JSON.parse(job(id).result).objects).toHaveLength(2);
    const links = t.db.query('SELECT * FROM asset_links');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ asset_id: 'ast_t', target_type: 'equipment', target_id: EQ.axe, state: 'suggested', label: 'axe', confidence: 0.9, quantity: 1 });
    expect(JSON.parse(links[0].region)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(t.db.one("SELECT COUNT(*) AS n FROM asset_links WHERE state = 'confirmed'").n).toBe(0);
    expect(ledger(id).state).toBe('settled');
    expect(t.db.one('SELECT COUNT(*) AS n FROM image_versions').n).toBe(0);
    // a suggestion becomes a link only when a user confirms it
    const listed = await jsonOf(await call(assets.listAssets, t.env, { params: { compId: 'LS1' } }));
    expect(listed.assets[0].links[0].state).toBe('suggested');
  });

  it('rejects malformed results without changing the job', async () => {
    const id = await setup();
    for (const bad of [undefined, { objects: 'x' }, { objects: [{ label: '' }] }, { objects: [{ label: 'a', quantity: 0 }] },
      { objects: [{ label: 'a', region: { x: 2, y: 0, w: 1, h: 1 } }] }, { objects: [{ label: 'a', candidates: [{ name: 'n', confidence: 5 }] }] },
      { objects: [{ label: 'a', candidates: Array(6).fill({ name: 'n', confidence: 0.5 }) }] }]) {
      expect((await complete(id, { node: 'k8', result: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(job(id).status).toBe('generating');
    expect(t.db.one('SELECT COUNT(*) AS n FROM asset_links').n).toBe(0);
  });
});

describe('fail', () => {
  it('retryable failure before the provider call requeues with backoff (attempts < max) and keeps the reservation', async () => {
    const id = await newJob();
    await claim();
    await heartbeat(id, { node: 'k8', status: 'preparing' });
    const res = await fail(id, { node: 'k8', code: 'network_error', message: 'socket hang up', retryable: true, providerCalled: false }, NOW + 1000);
    expect((await jsonOf(res)).willRetry).toBe(true);
    const row = job(id);
    expect(row).toMatchObject({ status: 'queued', lease_owner: null, provider_called_at: null, error_code: 'network_error', attempts: 1 });
    expect(row.next_attempt_at).toBeGreaterThanOrEqual(NOW + 1000 + JOB_TIMING.backoffBaseMs * 2);
    expect(ledger(id).state).toBe('reserved');
    expect((await claim('k8', undefined, NOW + 1500)).status).toBe(204);
    expect((await claim('k8', undefined, NOW + 1_000_000)).status).toBe(200);
    expect(job(id).attempts).toBe(2);
  });

  it('after the last attempt it fails for good and releases the reservation', async () => {
    const id = await newJob();
    t.db.sqlite.prepare('UPDATE generation_jobs SET attempts = 1 WHERE id = ?').run(id);
    await claim();
    expect(job(id).attempts).toBe(2);
    const res = await fail(id, { node: 'k8', code: 'network_error', message: 'boom', retryable: true, providerCalled: false });
    expect((await jsonOf(res)).willRetry).toBe(false);
    expect(job(id)).toMatchObject({ status: 'failed', completed_at: NOW, error_message: 'Image generation failed. Please try again.' });
    expect(ledger(id).state).toBe('released');
  });

  it('a failure after the provider was called is terminal and settles the ledger at the estimate', async () => {
    const id = await newJob();
    const estimate = ledger(id).estimated_usd;
    await claim(); await heartbeat(id, { node: 'k8', status: 'generating' });
    await fail(id, { node: 'k8', code: 'server_error', message: 'upstream 500', retryable: true, providerCalled: true });
    expect(job(id)).toMatchObject({ status: 'failed', error_code: 'server_error' });
    expect(job(id).provider_called_at).toBe(NOW);
    expect(ledger(id)).toMatchObject({ state: 'settled', actual_usd: estimate });
  });

  it('maps provider codes to human messages', async () => {
    const cases = [
      ['rate_limit', /rate-limiting/], ['insufficient_quota', /OpenAI account has no available credit/], ['billing_hard_limit_reached', /no available credit/],
      ['moderation_blocked', /blocked this request for safety/], ['invalid_request', /rejected the request as invalid/],
    ];
    for (const [code, pattern] of cases) {
      const id = await newJob();
      await claim('k8');
      await fail(id, { node: 'k8', code, message: 'raw provider text sk-secret', retryable: false, providerCalled: false });
      expect(job(id).error_message, code).toMatch(pattern);
      expect(job(id).error_message).not.toMatch(/sk-secret/);
      expect(job(id).status).toBe('failed');
      t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'completed' WHERE id = ?").run(id);
    }
    // Processor-supplied text is never echoed to users: unknown codes get the generic message.
    expect((await import('../../src/processor.js')).humanFailure('weird', 'x'.repeat(500))).toMatch(/failed/);
    expect((await import('../../src/processor.js')).humanFailure('weird')).toMatch(/failed/);
  });

  it('a cancel requested before the provider call ends as cancelled with the reservation released', async () => {
    const id = await newJob();
    await claim(); await heartbeat(id, { node: 'k8', status: 'preparing' });
    await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: id } });
    await fail(id, { node: 'k8', code: 'CANCELLED', message: 'cancelled', retryable: false, providerCalled: false });
    expect(job(id)).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED' });
    expect(ledger(id).state).toBe('released');
  });

  it('cancel during generating (provider already called) settles at the estimate', async () => {
    const id = await newJob();
    await claim(); await heartbeat(id, { node: 'k8', status: 'generating' });
    await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: id } });
    await fail(id, { node: 'k8', code: 'CANCELLED', message: 'cancelled', retryable: false, providerCalled: true });
    expect(job(id).status).toBe('cancelled');
    expect(ledger(id).state).toBe('settled');
  });

  it('removes partial output of a failed render and enforces the lease', async () => {
    const id = await newJob();
    await claim(); await toSaving(id);
    await output(id, 'original', png(10, 10, 20));
    expect(t.r2.store.size).toBe(1);
    expect((await fail(id, { node: 'other', code: 'x', retryable: false, providerCalled: false })).status).toBe(409);
    expect(t.r2.store.size).toBe(1);
    await fail(id, { node: 'k8', code: 'x', message: 'nope', retryable: false, providerCalled: true });
    expect(t.r2.store.size).toBe(0);
    expect((await fail(id, { node: 'k8', code: 'x', retryable: false, providerCalled: true })).status).toBe(409);
  });
});

describe('lease recovery (claim path and cron)', () => {
  const expireAt = NOW + JOB_TIMING.leaseMs + 1;

  it('before the provider call: requeues with backoff while attempts remain, then fails and releases', async () => {
    const id = await newJob();
    await claim('k8');
    const res = await claim('k8-b', undefined, expireAt);                // recovery runs first, but backoff keeps it queued
    expect(res.status).toBe(204);
    expect(job(id)).toMatchObject({ status: 'queued', lease_owner: null, error_code: 'LEASE_EXPIRED' });
    expect(job(id).next_attempt_at).toBeGreaterThanOrEqual(expireAt + JOB_TIMING.backoffBaseMs * 2);
    const again = await claim('k8-b', undefined, job(id).next_attempt_at);
    expect(again.status).toBe(200);
    expect(job(id).attempts).toBe(2);
    await studioCron(t.env, job(id).lease_expires_at + 1);
    expect(job(id)).toMatchObject({ status: 'failed', error_code: 'LEASE_EXPIRED' });
    expect(job(id).error_message).toMatch(/Nothing was charged/);
    expect(ledger(id).state).toBe('released');
  });

  it('after the provider call (generating/saving): OUTCOME_UNKNOWN, never resubmitted, ledger settled at estimate', async () => {
    for (const status of ['generating', 'saving']) {
      const id = await newJob();
      const estimate = ledger(id).estimated_usd;
      await claim('k8');
      await toSaving(id);
      if (status === 'generating') t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'generating' WHERE id = ?").run(id);
      await claim('k8-b', undefined, expireAt + 10_000);
      expect(job(id)).toMatchObject({ status: 'failed', error_code: 'OUTCOME_UNKNOWN', lease_owner: null });
      expect(job(id).error_message).toMatch(/may have been charged/);
      expect(ledger(id)).toMatchObject({ state: 'settled', actual_usd: estimate });
      expect(job(id).attempts).toBe(1);
      expect((await claim('k8-b', undefined, expireAt + 20_000)).status).toBe(204);
      t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'completed' WHERE id = ?").run(id);
    }
  });

  it('a live lease is left alone; heartbeats keep it alive', async () => {
    const id = await newJob();
    await claim();
    await heartbeat(id, { node: 'k8' }, NOW + 100_000);
    await studioCron(t.env, NOW + JOB_TIMING.leaseMs + 50_000);
    expect(job(id).status).toBe('claimed');
    await studioCron(t.env, NOW + 100_000 + JOB_TIMING.leaseMs + 1);
    expect(job(id).status).toBe('queued');
  });

  it('a late heartbeat from the former owner after recovery gets LEASE_LOST', async () => {
    const id = await newJob();
    await claim('k8');
    await claim('k8-b', undefined, expireAt);
    expect((await heartbeat(id, { node: 'k8' }, expireAt)).status).toBe(409);
  });

  it('expired lease on a cancel-requested job ends as cancelled (before provider call)', async () => {
    const id = await newJob();
    await claim();
    t.db.sqlite.prepare('UPDATE generation_jobs SET cancel_requested = 1 WHERE id = ?').run(id);
    await studioCron(t.env, expireAt);
    expect(job(id).status).toBe('cancelled');
    expect(ledger(id).state).toBe('released');
  });

  it('claim only recovers jobs of the requested kinds', async () => {
    insertAsset(t, 'ast_t', 'LS1');
    const rid = await newJob({ kind: 'recognize', assetId: 'ast_t' });
    await claim('k8', ['recognize']);
    await claim('k8-b', ['render'], expireAt);
    expect(job(rid).status).toBe('claimed');
    await claim('k8-b', ['recognize'], expireAt);
    expect(job(rid).status).toBe('queued');
  });
});

describe('studioCron', () => {
  it('garbage-collects pending assets older than the TTL (R2 objects and rows) and keeps fresh/committed ones', async () => {
    const mk = async (key, comp = 'LS1') => {
      const res = await call(assets.createAsset, t.env, { method: 'POST', body: { compartmentId: comp, category: 'tool', width: 10, height: 10, bytes: 33, sha256: 'a'.repeat(64), idempotencyKey: key }, now: NOW });
      return (await jsonOf(res)).asset.id;
    };
    const old = await mk('old'); const fresh = await mk('fresh');
    t.db.sqlite.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run(NOW - ASSET_LIMITS.pendingTtlMs - 1, old);
    t.r2.store.set(`assets/LS1/${old}/original.png`, { bytes: new Uint8Array(3), httpMetadata: {} });
    t.r2.store.set(`assets/LS1/${old}/thumb.webp`, { bytes: new Uint8Array(3), httpMetadata: {} });
    t.r2.store.set(`assets/LS1/${fresh}/original.png`, { bytes: new Uint8Array(3), httpMetadata: {} });
    insertAsset(t, 'ast_committed', 'LS1', { createdAt: 1 });
    const report = await studioCron(t.env, NOW);
    expect(report).toMatchObject({ gcAssets: 1, errors: [] });
    expect(t.db.query('SELECT id FROM assets ORDER BY id').map(r => r.id).sort()).toEqual([fresh, 'ast_committed'].sort());
    expect([...t.r2.store.keys()].filter(k => k.includes(old))).toEqual([]);
    expect(t.r2.store.has(`assets/LS1/${fresh}/original.png`)).toBe(true);
    expect(t.r2.store.has('assets/LS1/ast_committed/original.png')).toBe(true);
  });

  it('sweeps reservations of jobs that ended without a provider call (released) or with one (settled at estimate)', async () => {
    const a = await newJob(); const b = await newJob(); const c = await newJob();
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'failed' WHERE id = ?").run(a);
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'failed', provider_called_at = 5 WHERE id = ?").run(b);
    await studioCron(t.env, NOW);
    expect(ledger(a).state).toBe('released');
    expect(ledger(b)).toMatchObject({ state: 'settled', actual_usd: ledger(b).estimated_usd });
    expect(ledger(c).state).toBe('reserved');
  });

  it('one failing step does not block the others', async () => {
    const id = await newJob();
    await claim();
    const broken = { DB: t.env.DB, ASSETS: { ...t.r2, list: async () => { throw new Error('r2 down'); } } };
    t.db.sqlite.prepare("INSERT INTO assets (id, compartment_id, category, provenance, status, created_at, updated_at) VALUES ('ast_p', 'LS1', 'tool', 'user_photo', 'pending', 1, 1)").run();
    const report = await studioCron(broken, expireAtFor());
    expect(report.errors).toEqual([expect.stringContaining('r2 down')]);
    expect(job(id).status).toBe('queued');
  });
});

function expireAtFor() { return NOW + JOB_TIMING.leaseMs + 1; }

describe('service/user separation at record level', () => {
  it('user cancel/retry of another user\'s jobs is refused even for editors; admins may', async () => {
    const id = await newJob({ kind: 'render', preset: 'preview' }, editor('a@x'));
    expect((await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: id }, actor: editor('b@x') })).status).toBe(403);
    expect((await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: id }, actor: admin() })).status).toBe(200);
  });
});
