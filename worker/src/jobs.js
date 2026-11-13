// Generation jobs: estimate, create (atomic budget reservation), list/get, cancel, retry (architecture §8).
import { ID_PREFIX, JOB_TIMING, TERMINAL_JOB_STATES } from '../../shared/contracts.js';
import { newId } from '../../shared/ids.js';
import { validateJobRequest } from '../../shared/validation.js';
import { HttpError, actorLabel, json, readJson } from './http.js';
import { auditIfExists, changes, jobDto, ownerOrAdmin, parseJson, requireCompartment, validated, assetUrl } from './studio/common.js';
import { assertEnabled, loadPlanSettings, planJob } from './studio/job-spec.js';
import { ACTIVE_SQL, releaseStatement, reservationStatement, usageFor } from './spend.js';

export { listVersions, updateVersion } from './studio/versions.js';

const money = n => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

function insertJob(db, id, p, compId, key, me, now) {
  return db.prepare(
    `INSERT INTO generation_jobs (id, compartment_id, kind, mode, preset, model, quality, complexity, size, output_format, idempotency_key,
       requested_by, status, spec, spec_hash, prompt, inventory_fingerprint, planner_revision, design_revision, parent_version_id,
       subject_asset_id, reference_asset_ids, attempts, max_attempts, estimated_cost_usd, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM spend_ledger WHERE job_id = ?)`,
  ).bind(id, compId, p.kind, p.mode, p.preset, p.model, p.quality, p.complexity, p.size, p.outputFormat, key, me,
    JSON.stringify(p.spec), p.specHash, p.prompt, p.fingerprint, p.plannerRevision, p.designRevision, p.parentVersionId,
    p.subjectAssetId, JSON.stringify(p.referenceAssetIds), JOB_TIMING.maxAttempts,
    p.estimate.usd, now, now, id);
}

async function explainRefusal(db, me, est, now) {
  const u = await usageFor(db, me, now);
  const left = (cap) => Math.max(0, cap.cap - cap.spent - cap.reserved);
  if (u.month.spent + u.month.reserved + est > u.month.cap) {
    throw new HttpError('BUDGET_EXCEEDED', `The monthly AI budget would be exceeded (${money(left(u.month))} left of ${money(u.month.cap)}; this request is about ${money(est)}).`, { scope: 'month', remainingUsd: left(u.month), estimateUsd: est });
  }
  if (u.today.spent + u.today.reserved + est > u.today.cap) {
    throw new HttpError('BUDGET_EXCEEDED', `The daily AI budget would be exceeded (${money(left(u.today))} left today; this request is about ${money(est)}).`, { scope: 'day', remainingUsd: left(u.today), estimateUsd: est });
  }
  if (u.user.spent + u.user.reserved + est > u.user.cap) {
    throw new HttpError('BUDGET_EXCEEDED', `Your daily AI budget would be exceeded (${money(left(u.user))} left today; this request is about ${money(est)}).`, { scope: 'user', remainingUsd: left(u.user), estimateUsd: est });
  }
  if (u.jobs.userActive >= u.jobs.userMax) throw new HttpError('CONCURRENCY_LIMIT', 'You already have an image generating. Wait for it to finish or cancel it.', { scope: 'user' });
  throw new HttpError('CONCURRENCY_LIMIT', 'The Studio is busy generating other images. Try again in a minute.', { scope: 'global' });
}

/** Shared by createJob and retryJob: plan → reserve → insert in one D1 batch. Returns {job, estimate}. */
async function createJobCore({ db, actor, now }, { compId, req, key, confirmEstimateUsd, auditAction, auditDetail }) {
  const settings = await loadPlanSettings(db);
  assertEnabled(settings, true);
  const me = actorLabel(actor);
  const existing = await db.prepare('SELECT * FROM generation_jobs WHERE requested_by = ? AND idempotency_key = ?').bind(me, key).first();
  if (existing) return replay(existing, compId);
  const plan = await planJob(db, compId, req, settings);
  if (plan.presetCfg?.confirm && !(Number.isFinite(confirmEstimateUsd) && confirmEstimateUsd >= plan.estimate.usd)) {
    throw new HttpError('CONFLICT', `This preset needs confirmation: estimated cost ${money(plan.estimate.usd)}.`, { estimate: plan.estimate, requiresConfirm: true });
  }
  const id = newId(ID_PREFIX.job);
  const caps = {
    monthly: settings['budget.monthlyUsd'], daily: settings['budget.dailyUsd'], user: settings['budget.userDailyUsd'],
    maxConcurrent: settings['jobs.maxConcurrent'], userMaxConcurrent: settings['jobs.userMaxConcurrent'],
  };
  const exists = 'SELECT 1 FROM generation_jobs WHERE id = ?';
  try {
    await db.batch([
      reservationStatement(db, { ledgerId: newId(ID_PREFIX.ledger), jobId: id, actor: me, estimateUsd: plan.estimate.usd, model: plan.model, now, caps }),
      insertJob(db, id, plan, compId, key, me, now),
      auditIfExists(db, { actor: me, action: auditAction, entityType: 'job', entityId: id, detail: { compartmentId: compId, kind: plan.kind, preset: plan.preset, estimateUsd: plan.estimate.usd, ...auditDetail } }, now, exists, [id]),
    ]);
  } catch (err) {
    const raced = await db.prepare('SELECT * FROM generation_jobs WHERE requested_by = ? AND idempotency_key = ?').bind(me, key).first();
    if (raced) return replay(raced, compId);
    throw err;
  }
  const row = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(id).first();
  if (!row) await explainRefusal(db, me, plan.estimate.usd, now);
  return { job: jobDto(row), estimate: plan.estimate };
}

function replay(row, compId) {
  if (row.compartment_id !== compId) throw new HttpError('CONFLICT', 'That Idempotency-Key was already used for a different request.');
  return { job: jobDto(row), estimate: { usd: row.estimated_cost_usd, basis: 'replay' }, replayed: true };
}

function idempotencyKey(request) {
  const key = request.headers.get('Idempotency-Key');
  if (!key || key.length > 128) throw new HttpError('INVALID_REQUEST', 'An Idempotency-Key header (up to 128 characters) is required.');
  return key;
}

/** POST /api/compartments/:compId/estimate */
export async function estimate({ request, db, params }) {
  const compId = requireCompartment(params.compId);
  const body = await readJson(request);
  const req = validated(validateJobRequest(body));
  const settings = await loadPlanSettings(db);
  assertEnabled(settings, false);
  const plan = await planJob(db, compId, req, settings);
  return json({ estimate: plan.estimate, model: plan.model, size: plan.size, requiresConfirm: !!plan.presetCfg?.confirm });
}

/** POST /api/compartments/:compId/jobs */
export async function createJob(ctx) {
  const compId = requireCompartment(ctx.params.compId);
  const key = idempotencyKey(ctx.request);
  const body = await readJson(ctx.request);
  const req = validated(validateJobRequest(body));
  const out = await createJobCore(ctx, { compId, req, key, confirmEstimateUsd: body.confirmEstimateUsd, auditAction: 'job.create', auditDetail: {} });
  return json({ job: out.job, estimate: out.estimate }, 202);
}

/** GET /api/compartments/:compId/jobs — active first, then the 50 most recent. */
export async function listJobs({ db, params }) {
  const compId = requireCompartment(params.compId);
  const { results } = await db.prepare(
    `SELECT * FROM generation_jobs WHERE compartment_id = ?
     ORDER BY CASE WHEN status IN (${ACTIVE_SQL}) THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 50`,
  ).bind(compId).all();
  return json({ jobs: (results || []).map(jobDto) });
}

/** GET /api/jobs/:jobId */
export async function getJob({ db, params }) {
  const row = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(params.jobId).first();
  if (!row) throw new HttpError('NOT_FOUND', 'Job not found.');
  let version = null;
  if (row.result_version_id) {
    const v = await db.prepare('SELECT id, asset_id, status, created_at FROM image_versions WHERE id = ?').bind(row.result_version_id).first();
    if (v) version = { id: v.id, status: v.status, createdAt: v.created_at, assetId: v.asset_id, thumbUrl: assetUrl(v.asset_id, 'thumb'), displayUrl: assetUrl(v.asset_id, 'display') };
  }
  return json({ job: jobDto(row), version });
}

/** POST /api/jobs/:jobId/cancel — queued jobs end immediately; running ones are asked to stop. */
export async function cancelJob({ db, actor, params, now }) {
  const row = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(params.jobId).first();
  if (!row) throw new HttpError('NOT_FOUND', 'Job not found.');
  ownerOrAdmin(actor, row.requested_by, 'job');
  if (TERMINAL_JOB_STATES.includes(row.status)) throw new HttpError('CONFLICT', `This job already ${row.status === 'completed' ? 'finished' : row.status}.`);
  const me = actorLabel(actor);
  if (row.status === 'queued') {
    const [res] = await db.batch([
      db.prepare("UPDATE generation_jobs SET status = 'cancelled', error_code = 'CANCELLED', error_message = 'Cancelled by the requester.', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .bind(now, now, row.id),
      releaseStatement(db, row.id, now, 'cancelled'),
      auditIfExists(db, { actor: me, action: 'job.cancel', entityType: 'job', entityId: row.id, detail: { immediate: true } }, now, "SELECT 1 FROM generation_jobs WHERE id = ? AND status = 'cancelled'", [row.id]),
    ]);
    if (changes(res)) return json({ job: jobDto(await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(row.id).first()) });
  }
  await db.batch([
    db.prepare(`UPDATE generation_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN (${ACTIVE_SQL})`).bind(now, row.id),
    auditIfExists(db, { actor: me, action: 'job.cancel_requested', entityType: 'job', entityId: row.id }, now, 'SELECT 1 FROM generation_jobs WHERE id = ? AND cancel_requested = 1', [row.id]),
  ]);
  return json({ job: jobDto(await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(row.id).first()) });
}

/** POST /api/jobs/:jobId/retry — only failed/cancelled jobs; makes a NEW job with a new reservation. */
export async function retryJob(ctx) {
  const { db, actor, params, request } = ctx;
  const row = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(params.jobId).first();
  if (!row) throw new HttpError('NOT_FOUND', 'Job not found.');
  ownerOrAdmin(actor, row.requested_by, 'job');
  if (!['failed', 'cancelled'].includes(row.status)) throw new HttpError('CONFLICT', 'Only failed or cancelled jobs can be retried.');
  const original = parseJson(row.spec, {})?.request;
  if (!original) throw new HttpError('CONFLICT', 'This job cannot be retried; start a new request instead.');
  const body = request.headers.get('Content-Length') === '0' || !request.body ? {} : await readJson(request).catch(() => ({}));
  const out = await createJobCore(ctx, {
    compId: row.compartment_id, req: original, key: request.headers.get('Idempotency-Key') ? idempotencyKey(request) : `retry:${row.id}`,
    confirmEstimateUsd: body.confirmEstimateUsd, auditAction: 'job.retry', auditDetail: { retryOf: row.id },
  });
  return json({ job: out.job, estimate: out.estimate }, 202);
}

