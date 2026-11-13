// (e) job → real processor → draft version + settled ledger; (f) cancel and lease expiry; (g) recognize → suggestions only;
// (h) publish, staleness, restore, public projections. The processor under test is processor/src run in-process against the
// Worker through a fetch shim (service actor) and a node:http OpenAI stand-in.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JOB_TIMING } from '../../shared/contracts.js';
import { actualCost } from '../../shared/cost.js';
import { SETTINGS_DEFAULTS } from '../../shared/contracts.js';
import {
  ADMIN, EDITOR, EDITOR_B, SERVICE, all, createStack, device, makeOutputImage, migrateUntilDone, one, plannerOf, runProcessorOnce,
  startMockOpenAI, uploadPhoto,
} from './harness.js';

const USAGE = { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } }; // Images API shape
const FLARE_COST = (10 * 5 + 40 * 8 + 50 * 30) / 1e6; // textIn 5 + imageIn 8 + imageOut 30 $/M tokens (default price table)

describe('jobs ↔ processor', () => {
  let stack; let admin; let ed; let other; let anon; let svc; let mock; let photoId;
  const ctx = {};
  const jobRow = id => one(stack, 'SELECT * FROM generation_jobs WHERE id = ?', id);
  const ledger = jobId => one(stack, 'SELECT * FROM spend_ledger WHERE job_id = ?', jobId);
  const create = (body, key, dev = ed) => dev.call('POST', '/api/compartments/LS1/jobs', { json: body, headers: { 'Idempotency-Key': key } });
  const run = (o = {}) => runProcessorOnce(stack, { openaiBase: mock.baseUrl, ...o });
  const lastClaim = r => r.claims.at(-1);

  beforeAll(async () => {
    stack = createStack();
    admin = device(stack, ADMIN); ed = device(stack, EDITOR); other = device(stack, EDITOR_B); anon = device(stack, null); svc = device(stack, SERVICE);
    await migrateUntilDone(admin);
    mock = await startMockOpenAI({ png: await makeOutputImage(), usage: USAGE });
    photoId = (await uploadPhoto(ed, { compartmentId: 'LS1', category: 'compartment', title: 'Empty compartment' })).assetId;
  });
  afterAll(async () => { await mock.close(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses job creation while AI is off, then an admin switches it on (revisioned setting)', async () => {
    const off = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-ai-off-0001');
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('AI_DISABLED');
    expect((await ed.put('/api/admin/settings/ai.enabled', { value: true, expectRevision: 0 })).status).toBe(403);
    const got = (await admin.get('/api/admin/settings')).body.settings['ai.enabled'];
    expect(got).toEqual(expect.objectContaining({ value: false, revision: 0, default: false }));
    const set = await admin.put('/api/admin/settings/ai.enabled', { value: true, expectRevision: got.revision });
    expect(set.body).toEqual({ key: 'ai.enabled', value: true, revision: 1 });
    expect((await admin.put('/api/admin/settings/ai.enabled', { value: false, expectRevision: 0 })).status).toBe(409);
    const hist = (await admin.get('/api/admin/settings/ai.enabled/history')).body;
    expect(hist.history).toEqual([expect.objectContaining({ revision: 1, value: true, updatedBy: 'owner@example.com' })]);
    expect((await ed.get('/api/session')).body).toMatchObject({ email: 'editor@example.com', studioEnabled: true, aiEnabled: true });
  });

  it('estimate → {estimate:{usd,basis}, requiresConfirm}; the confirm preset answers 409 CONFLICT with details.estimate', async () => {
    const est = await ed.post('/api/compartments/LS1/estimate', { kind: 'render', mode: 'plan', preset: 'preview' });
    expect(est.status).toBe(200);
    expect(est.body.estimate).toEqual({ usd: expect.any(Number), basis: expect.any(String) });
    expect(est.body.requiresConfirm).toBe(false);
    ctx.estimateUsd = est.body.estimate.usd;
    const max = await ed.post('/api/compartments/LS1/estimate', { kind: 'render', mode: 'plan', preset: 'max' });
    expect(max.body.requiresConfirm).toBe(true);

    const refused = await create({ kind: 'render', mode: 'plan', preset: 'max' }, 'job-max-confirm-1');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(refused.body.error.details).toEqual({ estimate: { usd: max.body.estimate.usd, basis: expect.any(String) }, requiresConfirm: true });
    expect(one(stack, 'SELECT COUNT(*) n FROM generation_jobs').n).toBe(0);
    const confirmed = await create({ kind: 'render', mode: 'plan', preset: 'max', confirmEstimateUsd: max.body.estimate.usd }, 'job-max-confirm-2');
    expect(confirmed.status).toBe(202);
    expect((await ed.post(`/api/jobs/${confirmed.body.job.id}/cancel`, {})).body.job.status).toBe('cancelled'); // free the concurrency slot
  });

  it('referenceAssetIds (≤ 4 committed photos of the compartment) become role "other" references; singular/foreign ids are refused', async () => {
    const body = { kind: 'render', mode: 'plan', preset: 'preview', referenceAssetIds: [photoId] };
    const made = await create(body, 'job-refs-0001');
    expect(made.status).toBe(202);
    const spec = JSON.parse(jobRow(made.body.job.id).spec);
    expect(spec.references).toContainEqual({ assetId: photoId, role: 'compartment', label: 'Compartment photo', equipmentIds: [] });
    const { assetId: refPhoto } = await uploadPhoto(ed, { compartmentId: 'LS1', category: 'other', title: 'Manufacturer sheet' });
    expect((await ed.post(`/api/jobs/${made.body.job.id}/cancel`, {})).body.job.status).toBe('cancelled');
    const withRef = await create({ ...body, referenceAssetIds: [refPhoto] }, 'job-refs-0002');
    expect(withRef.status).toBe(202);
    const refs = JSON.parse(jobRow(withRef.body.job.id).spec).references;
    expect(refs).toContainEqual({ assetId: refPhoto, role: 'other', label: 'Manufacturer sheet', equipmentIds: [] });
    expect(JSON.parse(jobRow(withRef.body.job.id).reference_asset_ids)).toContain(refPhoto);
    await ed.post(`/api/jobs/${withRef.body.job.id}/cancel`, {});
    const { assetId: foreign } = await uploadPhoto(ed, { compartmentId: 'LS2', category: 'tool' });
    expect((await create({ ...body, referenceAssetIds: [foreign] }, 'job-refs-0003')).status).toBe(400);
    expect((await create({ ...body, referenceAssetIds: undefined, referenceAssetId: refPhoto }, 'job-refs-0004')).status).toBe(400);
    expect((await create({ ...body, referenceAssetIds: Array(5).fill(refPhoto) }, 'job-refs-0005')).status).toBe(400);
  });

  it('(e) create (idempotent replay) → the real processor claims, calls the model once, uploads the derivatives and completes', async () => {
    const first = await create({ kind: 'render', mode: 'plan', preset: 'preview', instructions: 'Show the shelves clearly.' }, 'job-main-0001');
    expect(first.status).toBe(202);
    expect(first.body.estimate).toEqual({ usd: ctx.estimateUsd, basis: expect.any(String) });
    const replay = await create({ kind: 'render', mode: 'plan', preset: 'preview', instructions: 'Show the shelves clearly.' }, 'job-main-0001');
    expect(replay.status).toBe(202);
    expect(replay.body.job.id).toBe(first.body.job.id);
    expect(one(stack, "SELECT COUNT(*) n FROM generation_jobs WHERE status = 'queued'").n).toBe(1);
    expect(all(stack, 'SELECT * FROM spend_ledger WHERE job_id = ?', first.body.job.id)).toHaveLength(1);
    expect(ledger(first.body.job.id)).toMatchObject({ state: 'reserved', estimated_usd: ctx.estimateUsd, actor: 'editor@example.com' });
    ctx.jobId = first.body.job.id;
    const callsBefore = mock.calls.length;

    const result = await run();
    expect(result.claims).toHaveLength(1);

    // claim payload contract (#6)
    const claim = lastClaim(result);
    expect(Object.keys(claim).sort()).toEqual(['job', 'leaseExpiresAt', 'maxReferences', 'references', 'spec']);
    expect(claim.job).toEqual({
      id: ctx.jobId, kind: 'render', mode: 'plan', model: 'gpt-image-2.6-flare', quality: 'low', complexity: 'medium', size: '1200x2560',
      outputFormat: 'jpeg', prompt: expect.stringContaining('LS1'), attempts: 1, moderation: 'auto',
    });
    expect(claim.maxReferences).toBe(SETTINGS_DEFAULTS['references.maxPerRequest']);
    expect(claim.references).toEqual([{ assetId: photoId, url: `/api/processor/assets/${photoId}/original?job=${ctx.jobId}`, role: 'compartment', label: 'Compartment photo', sheet: null }]);
    expect(claim.spec).toMatchObject({ schema: 'l1.scene/1', compartment: { id: 'LS1' } });
    expect(claim.spec.request).toBeUndefined();

    // every raw processor request identified the node (X-L1-Node); status flowed claimed → preparing → generating → saving
    const raw = result.requests.filter(r => /\/processor\/assets\/|\/output\//.test(r.path));
    expect(raw.length).toBe(4); // 1 reference download + 3 output variants
    expect(raw.every(r => r.headers['X-L1-Node'] === 'k8-test')).toBe(true);
    const beats = result.requests.filter(r => r.path.endsWith('/heartbeat'));
    expect(beats.length).toBeGreaterThanOrEqual(3);

    // the provider was called exactly once, with the API key, as an edit (compartment photo reference)
    const provider = mock.calls.slice(callsBefore);
    expect(provider).toHaveLength(1);
    expect(provider[0].path).toBe('/v1/images/edits');
    expect(provider[0].auth).toBe('Bearer sk-synthetic-test-key');
    expect(provider[0].contentType).toMatch(/^multipart\/form-data/);
    expect(provider[0].body.toString('latin1')).toContain('name="image[]"');
    expect(result.logs.join('\n')).not.toMatch(/sk-synthetic-test-key|synthetic-secret/);

    // job completed, draft version created, cost settled from the provider's snake_case usage
    const job = jobRow(ctx.jobId);
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(1);
    expect(JSON.parse(job.usage)).toEqual(USAGE);
    expect(actualCost(USAGE, 'gpt-image-2.6-flare', SETTINGS_DEFAULTS.pricing)).toBeCloseTo(FLARE_COST, 10);
    expect(job.actual_cost_usd).toBeCloseTo(FLARE_COST, 10);
    expect(job.actual_cost_usd).toBeLessThan(ctx.estimateUsd);
    expect(ledger(ctx.jobId)).toMatchObject({ state: 'settled' });
    expect(ledger(ctx.jobId).actual_usd).toBeCloseTo(FLARE_COST, 10);
    expect(JSON.parse(ledger(ctx.jobId).usage)).toEqual(USAGE);

    const versions = (await ed.get('/api/compartments/LS1/versions')).body.versions;
    expect(versions).toHaveLength(1);
    const v = versions[0];
    expect(v).toMatchObject({ id: job.result_version_id, status: 'draft', jobId: ctx.jobId, stale: false, isMain: false, parentVersionId: null });
    ctx.v1 = v;
    const jobs = (await ed.get('/api/compartments/LS1/jobs')).body.jobs;
    expect(jobs.find(j => j.id === ctx.jobId)).toMatchObject({ status: 'completed', resultVersionId: v.id, actualCostUsd: expect.closeTo(FLARE_COST, 8), attempts: 1 });
    const detail = (await ed.get(`/api/jobs/${ctx.jobId}`)).body;
    expect(detail.job.status).toBe('completed');
    expect(detail.version).toMatchObject({ id: v.id, status: 'draft' });
    for (const variant of ['display', 'thumb', 'original']) {
      const img = await ed.get(v.variants[variant]);
      expect(img.status).toBe(200);
      expect(img.headers.get('Content-Type')).toMatch(/^image\//);
    }
    expect((await anon.get(v.variants.display)).status).toBe(401); // drafts are private
    expect((await anon.get(`/api/public/assets/${v.assetId}/display`)).status).toBe(404);
    const usage = (await ed.get('/api/usage')).body;
    expect(usage.today.spent).toBeCloseTo(FLARE_COST, 8);
    expect(usage.today.reserved).toBe(0);
    expect(usage.jobs.userActive).toBe(0);
  });

  it('(f) cancelling a queued job ends it at once and releases the reservation; the processor finds nothing', async () => {
    const made = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-cancel-queued');
    const id = made.body.job.id;
    expect((await other.post(`/api/jobs/${id}/cancel`, {})).status).toBe(403); // not the requester
    const cancelled = await ed.post(`/api/jobs/${id}/cancel`, {});
    expect(cancelled.body.job).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' });
    expect(ledger(id).state).toBe('released');
    const calls = mock.calls.length;
    const r = await run();
    expect(r.claims).toHaveLength(0);
    expect(mock.calls.length).toBe(calls);
    expect((await ed.post(`/api/jobs/${id}/cancel`, {})).status).toBe(409); // already terminal
  });

  it('(f) cancelling after the claim but before generating: the processor stops, never calls the provider, ledger released', async () => {
    const made = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-cancel-claimed');
    const id = made.body.job.id;
    const calls = mock.calls.length;
    let cancelled = false;
    const r = await run({
      onRequest: async u => {
        if (!cancelled && u.pathname.endsWith('/heartbeat')) { cancelled = true; expect((await ed.post(`/api/jobs/${id}/cancel`, {})).body.job.status).toBe('claimed'); }
      },
    });
    expect(r.claims).toHaveLength(1);
    expect(mock.calls.length).toBe(calls); // never reached the provider
    const failCall = r.requests.find(q => q.path.endsWith('/fail'));
    expect(failCall).toBeTruthy();
    expect(jobRow(id)).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED', lease_owner: null });
    expect(ledger(id).state).toBe('released'); // CANCELLED with providerCalled=false releases the ledger
    expect(one(stack, 'SELECT COUNT(*) n FROM assets WHERE id = ?', `ast_${id.slice(3)}`).n).toBe(0);
  });

  it('(f) lease expiry BEFORE generating requeues with backoff and releases nothing', async () => {
    const made = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-lease-before');
    const id = made.body.job.id;
    const claim = await svc.post('/api/processor/claim', { node: 'k8-a', kinds: ['render'] });
    expect(claim.status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + JOB_TIMING.leaseMs + 5_000);
    expect((await svc.post('/api/processor/claim', { node: 'k8-b', kinds: ['render'] })).status).toBe(204); // recovery ran; backoff keeps it queued
    expect(jobRow(id)).toMatchObject({ status: 'queued', error_code: 'LEASE_EXPIRED', lease_owner: null, attempts: 1 });
    expect(ledger(id).state).toBe('reserved');
    vi.useRealTimers();
    expect((await ed.post(`/api/jobs/${id}/cancel`, {})).body.job.status).toBe('cancelled');
    expect(ledger(id).state).toBe('released');
  });

  it('(f) lease expiry AFTER generating → OUTCOME_UNKNOWN, ledger settled at the estimate, never requeued or resubmitted', async () => {
    const made = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-lease-after');
    const id = made.body.job.id;
    expect((await svc.post('/api/processor/claim', { node: 'k8-a', kinds: ['render'] })).status).toBe(200);
    expect((await svc.post(`/api/processor/jobs/${id}/heartbeat`, { node: 'k8-a', status: 'preparing' })).status).toBe(200);
    expect((await svc.post(`/api/processor/jobs/${id}/heartbeat`, { node: 'k8-a', status: 'generating' })).status).toBe(200);
    expect(jobRow(id).provider_called_at).toBeGreaterThan(0);
    // another node cannot touch a leased job
    expect((await svc.post(`/api/processor/jobs/${id}/heartbeat`, { node: 'k8-other', status: 'saving' })).status).toBe(409);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + JOB_TIMING.leaseMs + 5_000);
    expect((await svc.post('/api/processor/claim', { node: 'k8-b', kinds: ['render'] })).status).toBe(204);
    vi.useRealTimers();
    expect(jobRow(id)).toMatchObject({ status: 'failed', error_code: 'OUTCOME_UNKNOWN', lease_owner: null });
    expect(ledger(id)).toMatchObject({ state: 'settled', actual_usd: ctx.estimateUsd });
    expect(one(stack, "SELECT COUNT(*) n FROM generation_jobs WHERE status = 'queued'").n).toBe(0);
    const calls = mock.calls.length;
    expect((await run()).claims).toHaveLength(0);
    expect(mock.calls.length).toBe(calls);
    // the late processor cannot complete it either
    expect((await svc.post(`/api/processor/jobs/${id}/complete`, { node: 'k8-a', usage: USAGE })).status).toBe(409);
    expect((await ed.get(`/api/jobs/${id}`)).body.job).toMatchObject({ status: 'failed', errorCode: 'OUTCOME_UNKNOWN' });
  });

  it('(g) recognize → the photo is a "subject" reference, candidates come from the inventory, results are SUGGESTED links only', async () => {
    const planner = await plannerOf(ed);
    const { assetId } = await uploadPhoto(ed, { compartmentId: 'LS1', category: 'tool_group', title: 'Shelf photo' });
    const recMock = await startMockOpenAI({
      png: Buffer.alloc(0),
      recognition: catalogue => {
        const g = catalogue.find(c => c.name === '1 Ton Griphoist');
        const w = catalogue.find(c => c.name === 'Custom Wrench');
        return { objects: [
          { label: 'hoist', quantity: 1, region: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, candidates: [{ equipmentId: g.equipmentId, confidence: 0.91 }, { equipmentId: 'eq_notintheinventory0000', confidence: 0.4 }] },
          { label: 'wrench', quantity: 1, region: null, candidates: [{ equipmentId: w.equipmentId, confidence: 0.6 }] },
        ] };
      },
    });
    try {
      const made = await create({ kind: 'recognize', assetId }, 'job-recognize-01');
      expect(made.status).toBe(202);
      const r = await runProcessorOnce(stack, { openaiBase: recMock.baseUrl });
      const claim = lastClaim(r);
      expect(claim.job).toMatchObject({ kind: 'recognize', model: 'gpt-5.4-mini', moderation: 'auto' });
      expect(claim.references).toEqual([{ assetId, url: `/api/processor/assets/${assetId}/original?job=${made.body.job.id}`, role: 'subject', label: 'Photo to identify', sheet: null }]);
      expect(claim.spec.candidates).toEqual(expect.arrayContaining([{ equipmentId: planner.doc.equipmentIds['1 Ton Griphoist'], name: '1 Ton Griphoist' }]));
      expect(claim.spec.candidates.length).toBe(Object.keys(planner.doc.equipmentIds).length);
      expect(recMock.calls.map(c => c.path)).toEqual(['/v1/responses']);

      expect(jobRow(made.body.job.id)).toMatchObject({ status: 'completed' });
      expect(ledger(made.body.job.id).state).toBe('settled');
      const asset = (await ed.get('/api/compartments/LS1/assets')).body.assets.find(a => a.id === assetId);
      expect(asset.links.map(l => l.state)).toEqual(['suggested', 'suggested']); // the unknown candidate was dropped
      expect(asset.links.every(l => l.targetType === 'equipment' && l.confidence > 0)).toBe(true);
      expect(one(stack, "SELECT COUNT(*) n FROM asset_links WHERE asset_id = ? AND state = 'confirmed'", assetId).n).toBe(0);
      expect((await plannerOf(ed)).revision).toBe(planner.revision); // recognition never edits the planner

      // suggestions do not feed generation until a person confirms them
      const hoist = asset.links.find(l => l.equipmentId === planner.doc.equipmentIds['1 Ton Griphoist']);
      const confirm = await ed.patch(`/api/links/${hoist.id}`, { state: 'confirmed' });
      expect(confirm.status).toBe(200);
      expect(confirm.body.link).toMatchObject({ state: 'confirmed', equipmentId: hoist.equipmentId });
      const refreshed = (await ed.get('/api/compartments/LS1/assets')).body.assets.find(a => a.id === assetId);
      expect(refreshed.links.map(l => l.state).sort()).toEqual(['confirmed', 'suggested']);
      const reject = await ed.patch(`/api/links/${asset.links.find(l => l.id !== hoist.id).id}`, { state: 'rejected' });
      expect(reject.body.link.state).toBe('rejected');
    } finally { await recMock.close(); }
  });

  it('(h) publish: the version becomes the main image; optimistic revisions; public main-images, gallery and legacy /images reflect it', async () => {
    const v1 = ctx.v1;
    const before = (await anon.get('/api/public/main-images')).body.mainImages.LS1;
    expect(before).toMatchObject({ kind: 'asset', revision: 1 });
    expect((await ed.post('/api/compartments/LS1/main-image', { kind: 'version', ref: v1.id, expectRevision: 0 })).status).toBe(409);
    const pub = await ed.post('/api/compartments/LS1/main-image', { kind: 'version', ref: v1.id, expectRevision: before.revision });
    expect(pub.status).toBe(200);
    expect(pub.body.main).toMatchObject({ kind: 'version', ref: v1.id, revision: 2, stale: false, provenance: 'approved_concept', previous: { kind: 'asset', ref: before.ref } });
    expect(one(stack, 'SELECT status FROM image_versions WHERE id = ?', v1.id).status).toBe('approved');

    const mains = (await anon.get('/api/public/main-images')).body;
    expect(Object.keys(mains)).toEqual(['mainImages']);
    expect(mains.mainImages.LS1).toMatchObject({ kind: 'version', ref: v1.id, url: `/api/public/assets/${v1.assetId}/display`, thumbUrl: `/api/public/assets/${v1.assetId}/thumb`, stale: false });
    expect((await anon.get(mains.mainImages.LS1.url)).status).toBe(200); // approved renders are public
    const gallery = (await anon.get('/api/public/compartments/LS1/gallery')).body;
    expect(gallery.main).toMatchObject({ kind: 'version', ref: v1.id, stale: false });
    expect(gallery.items.some(i => i.kind === 'preset')).toBe(true);
    expect(gallery.items.find(i => i.id === v1.assetId)).toMatchObject({ kind: 'asset', provenance: 'approved_concept', url: expect.stringContaining('/api/public/assets/') });
    for (const item of gallery.items) expect(item).toEqual(expect.objectContaining({ id: expect.any(String), kind: expect.stringMatching(/^(preset|asset|version)$/), url: expect.any(String), provenance: expect.any(String) }));
    const editorGallery = (await ed.get('/api/compartments/LS1/gallery')).body;
    expect(editorGallery.main.ref).toBe(v1.id);

    const legacy = device(stack, null, { host: 'l1-state-sync.pdarleyjr.workers.dev' });
    const images = (await legacy.get('/images')).body;
    expect(images.featuredImages.LS1).toEqual({ kind: 'uploaded', uid: v1.assetId });
    expect(images.uploadedImages.LS1.find(u => u.uid === v1.assetId).dataUrl).toContain(`/api/public/assets/${v1.assetId}/display`);
    expect(images.featuredImages.LS2).toEqual({ kind: 'preset', src: '/images/LS2_rendering.webp' });
    // the current main image cannot be deleted or rejected
    expect((await ed.patch(`/api/versions/${v1.id}`, { status: 'deleted' })).status).toBe(409);
    expect((await ed.del(`/api/assets/${v1.assetId}`)).status).toBe(409);
  });

  it('(h) an inventory change marks the main image stale; a stale version is refused (STALE_SOURCE) unless acknowledged; restore previous', async () => {
    const start = await plannerOf(ed);
    const bump = (index, value) => ed.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: `stale-bump-${index}-${Date.now()}`, ops: [{ op: 'setSlot', comp: 'LS1', index, value, expect: '' }] });
    expect((await bump(10, '2.5 in Gate Valve')).body.applied).toEqual([0]);
    expect((await anon.get('/api/public/main-images')).body.mainImages.LS1.stale).toBe(true);
    expect((await anon.get('/api/public/compartments/LS1/gallery')).body.main.stale).toBe(true);

    // a new version made from the CURRENT inventory…
    const made = await create({ kind: 'render', mode: 'plan', preset: 'preview' }, 'job-second-0001');
    expect(made.status).toBe(202);
    await run();
    const v2 = (await ed.get('/api/compartments/LS1/versions')).body.versions.find(v => v.status === 'draft');
    expect(v2).toMatchObject({ stale: false });
    // …then the inventory changes again before it is published
    expect((await bump(11, '2.5 in Gate Valve')).body.applied).toEqual([0]);
    expect((await ed.get('/api/compartments/LS1/versions')).body.versions.find(v => v.id === v2.id).stale).toBe(true);

    const rev = (await anon.get('/api/public/main-images')).body.mainImages.LS1.revision;
    const refused = await ed.post('/api/compartments/LS1/main-image', { kind: 'version', ref: v2.id, expectRevision: rev });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('STALE_SOURCE');
    expect(refused.body.error.details).toEqual({ current: expect.any(String), version: v2.inventoryFingerprint });
    expect(one(stack, 'SELECT status FROM image_versions WHERE id = ?', v2.id).status).toBe('draft'); // nothing changed
    const ok = await ed.post('/api/compartments/LS1/main-image', { kind: 'version', ref: v2.id, expectRevision: rev, acknowledgeStale: true });
    expect(ok.status).toBe(200);
    expect(ok.body.main).toMatchObject({ kind: 'version', ref: v2.id, stale: true, previous: { kind: 'version', ref: ctx.v1.id } });

    const restored = await ed.post('/api/compartments/LS1/main-image/restore', { expectRevision: ok.body.main.revision });
    expect(restored.status).toBe(200);
    expect(restored.body.main).toMatchObject({ kind: 'version', ref: ctx.v1.id });
    expect((await anon.get('/api/public/main-images')).body.mainImages.LS1.ref).toBe(ctx.v1.id);
    expect((await ed.post('/api/compartments/LS1/main-image/restore', { expectRevision: 1 })).status).toBe(409);
    expect(one(stack, "SELECT COUNT(*) n FROM audit_log WHERE action IN ('main_image.set','main_image.restore')").n).toBe(3);
  });
});
