import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jobs from '../../src/jobs.js';
import * as spend from '../../src/spend.js';
import { NOW, admin, call, editor, insertAsset, insertVersion, jsonOf, makeEnv, setSetting } from './helpers/harness.js';
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
  setSetting(t.db, 'ai.enabled', true);
  setSetting(t.db, 'jobs.maxConcurrent', 50);
  setSetting(t.db, 'jobs.userMaxConcurrent', 50);
});

let keySeq = 0;
const create = (body, o = {}) => call(jobs.createJob, t.env, { method: 'POST', body, params: { compId: 'LS1' }, headers: { 'Idempotency-Key': o.key ?? `key-${keySeq += 1}` }, ...o });
const render = (extra = {}, o) => create({ kind: 'render', mode: 'plan', preset: 'preview', ...extra }, o);
const ledger = () => t.db.query('SELECT job_id, actor, state, estimated_usd, actual_usd, day, month FROM spend_ledger ORDER BY rowid');
const jobRow = id => t.db.one('SELECT * FROM generation_jobs WHERE id = ?', id);

describe('createJob', () => {
  it('queues a render job, reserves the estimate and audits, returning 202 {job, estimate}', async () => {
    insertAsset(t, 'ast_1', 'LS1', { title: 'Spanner photo' });
    const res = await render({ instructions: 'Put it on the left' });
    expect(res.status).toBe(202);
    const { job, estimate } = await jsonOf(res);
    expect(job).toMatchObject({ kind: 'render', mode: 'plan', preset: 'preview', model: 'gpt-image-2.6-flare', status: 'queued', attempts: 0, requestedBy: 'ed@mbfd.test', compartmentId: 'LS1' });
    expect(estimate.usd).toBe(0.06);
    expect(job.estimatedCostUsd).toBe(0.06);
    const row = jobRow(job.id);
    expect(row).toMatchObject({ quality: 'low', size: '1536x1024', output_format: 'jpeg', max_attempts: 2, planner_revision: 1 });
    expect(row.prompt).toContain('LS1');
    expect(JSON.parse(row.spec).request).toMatchObject({ kind: 'render', instructions: 'Put it on the left' });
    expect(JSON.parse(row.reference_asset_ids)).toEqual(['ast_1']);
    expect(ledger()).toEqual([expect.objectContaining({ job_id: job.id, actor: 'ed@mbfd.test', state: 'reserved', estimated_usd: 0.06, day: '2026-11-12', month: '2026-11' })]);
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.create'").n).toBe(1);
  });

  it('buckets the ledger day/month in America/New_York', async () => {
    const lateNight = Date.UTC(2026, 11, 1, 3, 30); // Nov 30 22:30 in New York
    await render({}, { now: lateNight });
    expect(ledger()[0]).toMatchObject({ day: '2026-11-30', month: '2026-11' });
  });

  it('requires an Idempotency-Key header and is idempotent per user+key (no second reservation)', async () => {
    expect((await call(jobs.createJob, t.env, { method: 'POST', body: { kind: 'render' }, params: { compId: 'LS1' } })).status).toBe(400);
    const a = await jsonOf(await render({}, { key: 'same' }));
    const b = await render({}, { key: 'same' });
    expect(b.status).toBe(202);
    expect((await jsonOf(b)).job.id).toBe(a.job.id);
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(1);
    expect(ledger()).toHaveLength(1);
    const other = await jsonOf(await render({}, { key: 'same', actor: editor('b@x') }));
    expect(other.job.id).not.toBe(a.job.id);
    const mismatch = await call(jobs.createJob, t.env, { method: 'POST', body: { kind: 'render' }, params: { compId: 'LS2' }, headers: { 'Idempotency-Key': 'same' } });
    expect(mismatch.status).toBe(409);
  });

  it('parallel requests with the same key create one job', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => render({}, { key: 'dup' })));
    expect(new Set((await Promise.all(results.map(jsonOf))).map(r => r.job.id)).size).toBe(1);
    expect(ledger()).toHaveLength(1);
  });

  it('honours the kill switches: AI disabled → 503 AI_DISABLED, Studio disabled → 503 STUDIO_DISABLED', async () => {
    setSetting(t.db, 'ai.enabled', false);
    const off = await render();
    expect(off.status).toBe(503);
    expect((await jsonOf(off)).error.code).toBe('AI_DISABLED');
    setSetting(t.db, 'ai.enabled', true); setSetting(t.db, 'studio.enabled', false);
    expect((await jsonOf(await render())).error.code).toBe('STUDIO_DISABLED');
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(0);
  });

  it('enforces the preset allowlist and request validation', async () => {
    expect((await render({ preset: 'ultra' })).status).toBe(400);
    expect((await render({ mode: 'bogus' })).status).toBe(400);
    expect((await create({ kind: 'nope' })).status).toBe(400);
    expect((await render({ parentVersionId: 'iv_x' })).status).toBe(400);   // parent only in edit mode
    setSetting(t.db, 'presets', { preview: { model: 'gpt-image-2.6-flare', quality: 'low', complexity: 'low', outputFormat: 'jpeg', confirm: false } });
    expect((await render({ preset: 'high' })).status).toBe(400);
    expect((await render({ preset: 'preview' })).status).toBe(202);
    expect((await call(jobs.createJob, t.env, { method: 'POST', body: { kind: 'render' }, params: { compId: 'NOPE' }, headers: { 'Idempotency-Key': 'z' } })).status).toBe(404);
  });

  it('confirm presets need confirmEstimateUsd >= the estimate (409 with the estimate)', async () => {
    const refused = await render({ preset: 'max' });
    expect(refused.status).toBe(409);
    expect((await jsonOf(refused)).error.details.estimate.usd).toBe(1.2);
    expect((await render({ preset: 'max', confirmEstimateUsd: 0.5 })).status).toBe(409);
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(0);
    const ok = await render({ preset: 'max', confirmEstimateUsd: 1.2 });
    expect(ok.status).toBe(202);
    expect((await jsonOf(ok)).job.model).toBe('gpt-image-2.6-sunburst');
  });

  it('edit mode needs a parent version of this compartment; markup must be a markup asset of this compartment', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering' }); insertAsset(t, 'ast_r2', 'LS2', { category: 'rendering' });
    insertAsset(t, 'ast_mk', 'LS1', { category: 'markup' }); insertAsset(t, 'ast_mk2', 'LS2', { category: 'markup' }); insertAsset(t, 'ast_tool', 'LS1');
    insertVersion(t, 'iv_1', 'LS1', 'ast_r'); insertVersion(t, 'iv_2', 'LS2', 'ast_r2'); insertVersion(t, 'iv_del', 'LS1', 'ast_r', { status: 'deleted' });
    const edit = extra => render({ mode: 'edit', ...extra });
    expect((await edit({})).status).toBe(400);
    expect((await edit({ parentVersionId: 'iv_2' })).status).toBe(400);
    expect((await edit({ parentVersionId: 'iv_del' })).status).toBe(400);
    expect((await edit({ parentVersionId: 'iv_1', markupAssetId: 'ast_mk2' })).status).toBe(400);
    expect((await edit({ parentVersionId: 'iv_1', markupAssetId: 'ast_tool' })).status).toBe(400);
    const ok = await edit({ parentVersionId: 'iv_1', markupAssetId: 'ast_mk', instructions: 'move axe' });
    expect(ok.status).toBe(202);
    const row = jobRow((await jsonOf(ok)).job.id);
    expect(row).toMatchObject({ parent_version_id: 'iv_1', subject_asset_id: 'ast_mk', mode: 'edit' });
    expect(JSON.parse(row.reference_asset_ids).sort()).toEqual(['ast_mk', 'ast_r', 'ast_tool']);
  });

  it('recognize jobs: asset of this compartment, model from settings, needs recognition.enabled', async () => {
    insertAsset(t, 'ast_t', 'LS1'); insertAsset(t, 'ast_o', 'LS2'); insertAsset(t, 'ast_r', 'LS1', { category: 'rendering' });
    expect((await create({ kind: 'recognize' })).status).toBe(400);
    expect((await create({ kind: 'recognize', assetId: 'ast_o' })).status).toBe(400);
    expect((await create({ kind: 'recognize', assetId: 'ast_r' })).status).toBe(400);
    const ok = await create({ kind: 'recognize', assetId: 'ast_t' });
    expect(ok.status).toBe(202);
    const { job } = await jsonOf(ok);
    expect(job).toMatchObject({ kind: 'recognize', mode: null, model: 'gpt-5.4-mini' });
    expect(jobRow(job.id)).toMatchObject({ subject_asset_id: 'ast_t', size: null });
    setSetting(t.db, 'recognition.model', 'gpt-5.4-nano');
    expect((await jsonOf(await create({ kind: 'recognize', assetId: 'ast_t' }))).job.model).toBe('gpt-5.4-nano');
    setSetting(t.db, 'recognition.enabled', false);
    expect((await jsonOf(await create({ kind: 'recognize', assetId: 'ast_t' }))).error.code).toBe('AI_DISABLED');
  });

  it('includes only confirmed links in the spec inputs, never suggested ones', async () => {
    insertAsset(t, 'ast_1', 'LS1');
    t.db.sqlite.prepare("INSERT INTO asset_links (id, asset_id, target_type, target_id, equipment_id, state, created_at, updated_at) VALUES ('al_1', 'ast_1', 'equipment', 'eq_axe00000000000002', 'eq_axe00000000000002', 'suggested', 1, 1)").run();
    const { job } = await jsonOf(await render());
    expect(job.status).toBe('queued');
    expect(JSON.parse(jobRow(job.id).spec).references[0].assetId).toBe('ast_1');
  });
});

describe('budget and concurrency caps', () => {
  it('monthly cap → 402 BUDGET_EXCEEDED with a human message including what is left', async () => {
    setSetting(t.db, 'budget.monthlyUsd', 0.1);
    expect((await render()).status).toBe(202);
    const res = await render();
    expect(res.status).toBe(202);
    const refused = await render();
    expect(refused.status).toBe(402);
    const err = (await jsonOf(refused)).error;
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.message).toMatch(/monthly AI budget/);
    expect(err.message).toMatch(/\$0\.00 left of \$0\.10/);
    expect(err.details).toMatchObject({ scope: 'month', estimateUsd: 0.05 });
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(2);
    expect(ledger()).toHaveLength(2);
  });

  it('daily cap and per-user daily cap are separate scopes', async () => {
    setSetting(t.db, 'budget.dailyUsd', 0.1); setSetting(t.db, 'budget.userDailyUsd', 5);
    await render({}, { actor: editor('a@x') }); await render({}, { actor: editor('b@x') });
    const day = await render({}, { actor: editor('c@x') });
    expect(day.status).toBe(402);
    expect((await jsonOf(day)).error.details.scope).toBe('day');
    setSetting(t.db, 'budget.dailyUsd', 100); setSetting(t.db, 'budget.userDailyUsd', 0.1);
    await render({}, { actor: editor('d@x') }); await render({}, { actor: editor('d@x') });
    const user = await render({}, { actor: editor('d@x') });
    expect(user.status).toBe(402);
    expect((await jsonOf(user)).error).toMatchObject({ details: { scope: 'user' } });
    expect((await render({}, { actor: editor('e@x') })).status).toBe(202);
  });

  it('released and settled spend change what counts toward the caps; yesterday does not count against today', async () => {
    setSetting(t.db, 'budget.dailyUsd', 0.1);
    const a = await jsonOf(await render());
    await render();
    expect((await render()).status).toBe(402);
    t.db.sqlite.prepare("UPDATE spend_ledger SET state = 'released' WHERE job_id = ?").run(a.job.id);
    expect((await render()).status).toBe(202);
    expect((await render({}, { now: NOW + 24 * 3600 * 1000 })).status).toBe(202);
  });

  it('concurrency: global and per-user limits → 429 CONCURRENCY_LIMIT', async () => {
    setSetting(t.db, 'jobs.maxConcurrent', 2); setSetting(t.db, 'jobs.userMaxConcurrent', 1);
    expect((await render({}, { actor: editor('a@x') })).status).toBe(202);
    const mine = await render({}, { actor: editor('a@x') });
    expect(mine.status).toBe(429);
    expect((await jsonOf(mine)).error).toMatchObject({ code: 'CONCURRENCY_LIMIT', details: { scope: 'user' } });
    expect((await render({}, { actor: editor('b@x') })).status).toBe(202);
    const global = await render({}, { actor: editor('c@x') });
    expect(global.status).toBe(429);
    expect((await jsonOf(global)).error.details.scope).toBe('global');
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'completed'").run();
    expect((await render({}, { actor: editor('a@x') })).status).toBe(202);
  });

  it('parallel createJob calls cannot exceed the concurrency cap or the budget', async () => {
    setSetting(t.db, 'jobs.maxConcurrent', 1);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => render({}, { actor: editor(`u${i}@x`) })));
    expect(res.map(r => r.status).sort()).toEqual([202, 429, 429, 429, 429, 429]);
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(1);
    expect(ledger()).toHaveLength(1);

    setSetting(t.db, 'jobs.maxConcurrent', 50); setSetting(t.db, 'budget.monthlyUsd', 0.15);
    const second = await Promise.all(Array.from({ length: 8 }, (_, i) => render({}, { actor: editor(`v${i}@x`) })));
    const spent = t.db.one("SELECT SUM(estimated_usd) AS s FROM spend_ledger WHERE state = 'reserved'").s;
    expect(spent).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(second.filter(r => r.status === 402).length).toBeGreaterThanOrEqual(5);
  });
});

describe('estimate', () => {
  it('returns the same estimate as createJob without reserving or inserting, even when AI is off', async () => {
    const est = await call(jobs.estimate, t.env, { method: 'POST', body: { kind: 'render', preset: 'max' }, params: { compId: 'LS1' } });
    expect(est.status).toBe(200);
    expect(await jsonOf(est)).toMatchObject({ estimate: { usd: 1.2 }, model: 'gpt-image-2.6-sunburst', size: '1536x1024', requiresConfirm: true });
    setSetting(t.db, 'ai.enabled', false);
    expect((await call(jobs.estimate, t.env, { method: 'POST', body: { kind: 'render', preset: 'preview' }, params: { compId: 'LS1' } })).status).toBe(200);
    expect(t.db.one('SELECT COUNT(*) AS n FROM generation_jobs').n).toBe(0);
    expect(ledger()).toHaveLength(0);
    expect((await call(jobs.estimate, t.env, { method: 'POST', body: { kind: 'render', preset: 'zzz' }, params: { compId: 'LS1' } })).status).toBe(400);
  });
});

describe('list / get / cancel / retry', () => {
  it('lists active jobs first then recent ones, capped at 50', async () => {
    const ins = t.db.sqlite.prepare("INSERT INTO generation_jobs (id, compartment_id, kind, model, idempotency_key, requested_by, status, spec, spec_hash, created_at, updated_at) VALUES (?, 'LS1', 'render', 'm', ?, 'x', ?, '{}', 'h', ?, ?)");
    for (let i = 0; i < 55; i += 1) ins.run(`gj_old${i}`, `k${i}`, 'completed', 1000 + i, 1000 + i);
    ins.run('gj_active', 'ka', 'generating', 10, 10);
    const { jobs: list } = await jsonOf(await call(jobs.listJobs, t.env, { params: { compId: 'LS1' } }));
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe('gj_active');
    expect(list[1].id).toBe('gj_old54');
  });

  it('getJob returns the job and its version summary', async () => {
    const { job } = await jsonOf(await render());
    expect((await jsonOf(await call(jobs.getJob, t.env, { params: { jobId: job.id } }))).version).toBeNull();
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering' }); insertVersion(t, 'iv_1', 'LS1', 'ast_r');
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'completed', result_version_id = 'iv_1' WHERE id = ?").run(job.id);
    const got = await jsonOf(await call(jobs.getJob, t.env, { params: { jobId: job.id } }));
    expect(got.version).toMatchObject({ id: 'iv_1', thumbUrl: '/api/assets/ast_r/thumb' });
    expect((await call(jobs.getJob, t.env, { params: { jobId: 'gj_nope' } })).status).toBe(404);
  });

  it('cancelling a queued job ends it immediately and releases the reservation', async () => {
    const { job } = await jsonOf(await render());
    const res = await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: job.id } });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).job).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' });
    expect(ledger()[0].state).toBe('released');
    expect((await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: job.id } })).status).toBe(409);
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.cancel'").n).toBe(1);
  });

  it('only the requester or an admin may cancel; a running job gets cancel_requested', async () => {
    const { job } = await jsonOf(await render());
    expect((await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: job.id }, actor: editor('other@x') })).status).toBe(403);
    expect(jobRow(job.id).status).toBe('queued');
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'generating', lease_owner = 'n1', provider_called_at = 1 WHERE id = ?").run(job.id);
    const res = await call(jobs.cancelJob, t.env, { method: 'POST', params: { jobId: job.id }, actor: admin() });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).job).toMatchObject({ status: 'generating', cancelRequested: true });
    expect(ledger()[0].state).toBe('reserved');
  });

  it('retry: failed/cancelled only, owner/admin only, creates a NEW job with a NEW reservation, once per failed job', async () => {
    const { job } = await jsonOf(await render({ instructions: 'again' }));
    const retry = (id, o) => call(jobs.retryJob, t.env, { method: 'POST', params: { jobId: id }, ...o });
    expect((await retry(job.id)).status).toBe(409);                      // queued
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'failed', error_code = 'X' WHERE id = ?").run(job.id);
    t.db.sqlite.prepare("UPDATE spend_ledger SET state = 'released'").run();
    expect((await retry(job.id, { actor: editor('other@x') })).status).toBe(403);
    const res = await retry(job.id);
    expect(res.status).toBe(202);
    const again = await jsonOf(res);
    expect(again.job.id).not.toBe(job.id);
    expect(jobRow(again.job.id).status).toBe('queued');
    expect(JSON.parse(jobRow(again.job.id).spec).request.instructions).toBe('again');
    expect(ledger().map(l => l.state)).toEqual(['released', 'reserved']);
    expect((await jsonOf(await retry(job.id))).job.id).toBe(again.job.id);   // double-click does not double-spend
    expect(ledger()).toHaveLength(2);
    expect((await retry('gj_nope')).status).toBe(404);
  });

  it('retry respects caps and preset confirmation', async () => {
    setSetting(t.db, 'budget.monthlyUsd', 0.05);
    const { job } = await jsonOf(await render());
    t.db.sqlite.prepare("UPDATE generation_jobs SET status = 'failed' WHERE id = ?").run(job.id);
    t.db.sqlite.prepare("UPDATE spend_ledger SET state = 'settled', actual_usd = 0.05").run();
    const res = await call(jobs.retryJob, t.env, { method: 'POST', params: { jobId: job.id } });
    expect(res.status).toBe(402);
  });
});

describe('versions', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c', 'd']) insertAsset(t, `ast_${id}`, 'LS1', { category: 'rendering' });
  });
  const list = async () => (await jsonOf(await call(jobs.listVersions, t.env, { params: { compId: 'LS1' } }))).versions;
  const patch = (id, body, o) => call(jobs.updateVersion, t.env, { method: 'PATCH', body, params: { versionId: id }, ...o });

  it('lists the version tree with parent, children, status, thumbs, cost, model, createdBy, stale and main flags', async () => {
    const fp = await (await import('./helpers/fakes.js')).fingerprintFake.inventoryFingerprint(JSON.parse(t.db.one('SELECT doc FROM planner_doc').doc), 'LS1');
    insertVersion(t, 'iv_root', 'LS1', 'ast_a', { fingerprint: fp, createdAt: 1 });
    insertVersion(t, 'iv_child', 'LS1', 'ast_b', { parent: 'iv_root', fingerprint: 'old', createdAt: 2 });
    insertVersion(t, 'iv_gone', 'LS1', 'ast_c', { parent: 'iv_root', status: 'deleted', createdAt: 3 });
    t.db.sqlite.prepare("INSERT INTO main_images (compartment_id, revision, kind, ref, updated_at) VALUES ('LS1', 1, 'version', 'iv_root', 1)").run();
    const versions = await list();
    expect(versions.map(v => v.id)).toEqual(['iv_root', 'iv_child']);
    expect(versions[0]).toMatchObject({ parentVersionId: null, childCount: 1, status: 'draft', stale: false, isMain: true, model: 'gpt-image-2.6-flare', costUsd: 0.1, createdBy: 'ed@mbfd.test' });
    expect(versions[0].variants.thumb).toBe('/api/assets/ast_a/thumb');
    expect(versions[1]).toMatchObject({ parentVersionId: 'iv_root', childCount: 0, stale: true, isMain: false });
  });

  it('rejects drafts and soft-deletes versions (and their asset); the current main cannot be deleted or rejected', async () => {
    insertVersion(t, 'iv_1', 'LS1', 'ast_a'); insertVersion(t, 'iv_2', 'LS1', 'ast_b'); insertVersion(t, 'iv_3', 'LS1', 'ast_c', { status: 'approved' });
    t.db.sqlite.prepare("INSERT INTO main_images (compartment_id, revision, kind, ref, updated_at) VALUES ('LS1', 1, 'version', 'iv_3', 1)").run();
    expect((await patch('iv_1', { status: 'rejected' })).status).toBe(200);
    expect(t.db.one("SELECT status FROM image_versions WHERE id = 'iv_1'").status).toBe('rejected');
    expect((await patch('iv_1', { status: 'rejected' })).status).toBe(409);
    expect((await patch('iv_1', { status: 'deleted' })).status).toBe(200);
    expect(t.db.one("SELECT status FROM assets WHERE id = 'ast_a'").status).toBe('deleted');
    expect((await patch('iv_2', { status: 'deleted' })).status).toBe(200);
    expect((await patch('iv_2', { status: 'deleted' })).status).toBe(404);
    const blocked = await patch('iv_3', { status: 'deleted' });
    expect(blocked.status).toBe(409);
    expect((await jsonOf(blocked)).error.message).toMatch(/main image/);
    expect((await patch('iv_3', { status: 'rejected' })).status).toBe(409);
    expect((await patch('iv_x', { status: 'deleted' })).status).toBe(404);
    expect((await patch('iv_3', { status: 'approved' })).status).toBe(400);
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'version.%'").n).toBe(3);
  });

  it('an approved non-main version can be deleted but not rejected', async () => {
    insertVersion(t, 'iv_old', 'LS1', 'ast_d', { status: 'approved' });
    expect((await patch('iv_old', { status: 'rejected' })).status).toBe(409);
    expect((await patch('iv_old', { status: 'deleted' })).status).toBe(200);
  });
});

describe('spend.getUsage', () => {
  it('reports today/month/user figures against caps plus the last 20 ledger rows', async () => {
    setSetting(t.db, 'budget.monthlyUsd', 10); setSetting(t.db, 'budget.dailyUsd', 4); setSetting(t.db, 'budget.userDailyUsd', 2);
    for (let i = 0; i < 22; i += 1) await render({}, { actor: editor(i < 21 ? 'me@x' : 'you@x'), now: NOW + i });
    t.db.sqlite.prepare("UPDATE spend_ledger SET state = 'settled', actual_usd = 0.2 WHERE rowid <= 2").run();
    const usage = await jsonOf(await call(spend.getUsage, t.env, { actor: editor('me@x') }));
    expect(usage.today.cap).toBe(4);
    expect(usage.month.cap).toBe(10);
    expect(usage.user.cap).toBe(2);
    expect(usage.month.spent).toBeCloseTo(0.4, 5);
    expect(usage.month.reserved).toBeCloseTo(20 * 0.05, 5);
    expect(usage.user.spent + usage.user.reserved).toBeCloseTo(0.4 + 19 * 0.05, 5);
    expect(usage.recent).toHaveLength(20);
    expect(usage.recent[0].actor).toBe('you@x');
    expect(usage.jobs).toMatchObject({ active: 22, max: 50 });
  });
});
