// Processor API for the AIW image service (service identity only; the router enforces auth, we enforce leases).
import { ASSET_LIMITS, ASSET_VARIANTS, JOB_KINDS, JOB_TIMING, PROCESSOR_REPORTABLE_STATES, UPLOAD_MIME } from '../../shared/contracts.js';
import { selectReferences } from '../../shared/scene-spec.js';
import { actualCost } from '../../shared/cost.js';
import { HttpError, SECURITY_HEADERS, json, readBytes, readJson } from './http.js';
import { sniffImage, KNOWN_EXTENSIONS, TYPE_BY_EXT } from './media.js';
import { getSettings } from './settings.js';
import { loadPlannerDoc } from './planner.js';
import { newId } from '../../shared/ids.js';
import { releaseStatement, settleStatement } from './spend.js';
import { auditIfExists, changes, parseJson, requireVariant } from './studio/common.js';
import { backoffMs, recoverExpiredLeases } from './studio/recovery.js';
import { parseRecognition } from './studio/recognition.js';
import { variantKey } from './assets.js';

const RANK = ['claimed', 'preparing', 'generating', 'saving'];
const MAX_BY_VARIANT = { original: ASSET_LIMITS.originalMaxBytes, display: ASSET_LIMITS.displayMaxBytes, thumb: ASSET_LIMITS.thumbMaxBytes };
const SERVICE_AUDIT = 'service:image-processor';

/** Output asset/version ids are derived from the job id, so they are server-chosen yet stable across calls. */
export const outputAssetId = jobId => `ast_${jobId.slice(jobId.indexOf('_') + 1)}`;
export const outputVersionId = jobId => `iv_${jobId.slice(jobId.indexOf('_') + 1)}`;

const noContent = () => new Response(null, { status: 204, headers: SECURITY_HEADERS });
const assetPath = (id, jobId) => `/api/processor/assets/${id}/original?job=${jobId}`;

function readNode(body) {
  if (typeof body?.node !== 'string' || !body.node || body.node.length > 64) throw new HttpError('INVALID_REQUEST', 'node is required.');
  return body.node;
}

/** Load a job and verify the caller holds its lease. `node` may be null for raw endpoints that carry no body. */
async function leasedJob(db, jobId, node) {
  const job = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(jobId).first();
  if (!job) throw new HttpError('NOT_FOUND', 'Job not found.');
  if (!RANK.includes(job.status) || (node && job.lease_owner !== node)) {
    throw new HttpError('LEASE_LOST', 'This job is no longer assigned to this worker.');
  }
  return job;
}

const nodeHint = (request, url) => request.headers.get('X-L1-Node') || url?.searchParams?.get('node') || null;

async function buildClaim(db, job) {
  const spec = parseJson(job.spec, {});
  delete spec.request;
  const allowed = new Set([...parseJson(job.reference_asset_ids, []), job.subject_asset_id].filter(Boolean));
  let references; let contactSheets = [];
  if (job.kind === 'recognize') {
    references = [{ assetId: job.subject_asset_id, variant: 'original', role: 'subject', label: 'Photo to identify', url: assetPath(job.subject_asset_id, job.id) }];
  } else {
    const { 'references.maxPerRequest': max } = await getSettings(db, ['references.maxPerRequest']);
    const sel = selectReferences(spec, max ?? 10);
    const mk = r => ({ assetId: r.assetId, variant: 'original', role: r.role, label: r.label, url: assetPath(r.assetId, job.id) });
    references = sel.direct.filter(r => allowed.has(r.assetId)).map(mk);
    contactSheets = (sel.contactSheets || []).map(s => ({ label: s.label, items: (s.items || []).filter(i => allowed.has(i.assetId)).map(i => ({ assetId: i.assetId, label: i.label, url: assetPath(i.assetId, job.id) })) }));
  }
  return {
    job: {
      id: job.id, kind: job.kind, mode: job.mode, model: job.model, quality: job.quality, complexity: job.complexity, size: job.size,
      outputFormat: job.output_format, prompt: job.prompt, attempts: job.attempts,
    },
    spec, references, contactSheets, leaseExpiresAt: job.lease_expires_at,
  };
}

/** POST /api/processor/claim — body {node, kinds}. 204 when nothing is queued. */
export async function claim({ request, db, now }) {
  const body = await readJson(request);
  const node = readNode(body);
  const kinds = (Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['render', 'recognize']).filter(k => JOB_KINDS.includes(k));
  if (!kinds.length) throw new HttpError('INVALID_REQUEST', 'kinds must include render, recognize or verify.');
  await recoverExpiredLeases(db, now, kinds);
  const job = await db.prepare(
    `UPDATE generation_jobs SET status = 'claimed', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM generation_jobs WHERE status = 'queued' AND kind IN (${kinds.map(() => '?').join(',')})
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND cancel_requested = 0 ORDER BY created_at LIMIT 1)
     RETURNING *`,
  ).bind(node, now + JOB_TIMING.leaseMs, now, now, ...kinds, now).first();
  if (!job) return noContent();
  return json(await buildClaim(db, job));
}

/** POST /api/processor/jobs/:jobId/heartbeat — body {node, status?}. */
export async function heartbeat({ request, db, params, now }) {
  const body = await readJson(request);
  const node = readNode(body);
  const status = body.status;
  if (status !== undefined && !PROCESSOR_REPORTABLE_STATES.includes(status)) throw new HttpError('INVALID_REQUEST', 'status must be preparing, generating or saving.');
  const job = await leasedJob(db, params.jobId, node);
  const target = status ?? job.status;
  if (RANK.indexOf(target) < RANK.indexOf(job.status)) throw new HttpError('INVALID_REQUEST', `A job cannot move back from ${job.status} to ${target}.`);
  const res = await db.prepare(
    `UPDATE generation_jobs SET status = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?,
       provider_called_at = CASE WHEN ? = 'generating' THEN COALESCE(provider_called_at, ?) ELSE provider_called_at END
     WHERE id = ? AND lease_owner = ? AND status = ?`,
  ).bind(target, now + JOB_TIMING.leaseMs, now, now, target, now, job.id, node, job.status).run();
  if (!changes(res)) throw new HttpError('LEASE_LOST', 'This job is no longer assigned to this worker.');
  const fresh = await db.prepare('SELECT cancel_requested, lease_expires_at, status FROM generation_jobs WHERE id = ?').bind(job.id).first();
  return json({ leaseExpiresAt: fresh.lease_expires_at, cancelRequested: !!fresh.cancel_requested, status: fresh.status });
}

/** GET /api/processor/assets/:assetId/:variant?job= — only assets the leased job references. */
export async function getAsset({ request, env, db, params, url }) {
  const variant = requireVariant(params.variant);
  const jobId = url?.searchParams?.get('job');
  if (!jobId) throw new HttpError('INVALID_REQUEST', 'job query parameter is required.');
  const job = await leasedJob(db, jobId, nodeHint(request, url));
  const allowed = new Set([...parseJson(job.reference_asset_ids, []), job.subject_asset_id].filter(Boolean));
  if (!allowed.has(params.assetId)) throw new HttpError('FORBIDDEN', 'This job does not reference that image.');
  const asset = await db.prepare("SELECT * FROM assets WHERE id = ? AND status = 'committed'").bind(params.assetId).first();
  const key = asset?.[`${variant}_key`];
  const obj = key ? await env.ASSETS.get(key) : null;
  if (!obj) throw new HttpError('NOT_FOUND', 'Image not available.');
  return new Response(obj.body, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': obj.httpMetadata?.contentType || TYPE_BY_EXT[key.split('.').pop()] || 'application/octet-stream' } });
}

/** PUT /api/processor/jobs/:jobId/output/:variant — raw bytes for the job's result asset (status must be saving). */
export async function putOutput({ request, env, db, params, url }) {
  const variant = requireVariant(params.variant);
  const job = await leasedJob(db, params.jobId, nodeHint(request, url));
  if (job.kind !== 'render') throw new HttpError('INVALID_REQUEST', 'Only render jobs produce image output.');
  if (job.status !== 'saving') throw new HttpError('CONFLICT', 'Report status "saving" before uploading output.');
  const bytes = await readBytes(request, MAX_BY_VARIANT[variant]);
  const sniff = sniffImage(bytes);
  if (!sniff || !UPLOAD_MIME[variant].includes(sniff.type)) throw new HttpError('UNSUPPORTED_MEDIA', 'Output must be a JPEG, PNG or WebP image.');
  const assetId = outputAssetId(job.id);
  for (const ext of KNOWN_EXTENSIONS) if (ext !== sniff.ext) await env.ASSETS.delete(variantKey(job.compartment_id, assetId, variant, ext));
  await env.ASSETS.put(variantKey(job.compartment_id, assetId, variant, sniff.ext), bytes, { httpMetadata: { contentType: sniff.type } });
  return noContent();
}

async function findVariant(bucket, comp, assetId, variant) {
  for (const ext of KNOWN_EXTENSIONS) {
    const key = variantKey(comp, assetId, variant, ext);
    const head = await bucket.head(key);
    if (head) return { key, type: head.httpMetadata?.contentType || TYPE_BY_EXT[ext], size: head.size ?? null };
  }
  return null;
}

async function cleanupOutput(bucket, job) {
  try {
    const listed = await bucket.list({ prefix: `assets/${job.compartment_id}/${outputAssetId(job.id)}/` });
    const keys = (listed.objects || []).map(o => o.key);
    if (keys.length) await bucket.delete(keys);
  } catch { /* best effort; the pending-asset sweep does not cover these, they are small and private */ }
}

function costOf(job, usage, pricing, hint) {
  try {
    const v = usage ? actualCost(usage, job.model, pricing) : NaN;
    if (Number.isFinite(v) && v >= 0) return v;
  } catch { /* fall through to estimate */ }
  return Number.isFinite(hint) && hint >= 0 && !usage ? hint : job.estimated_cost_usd;
}

const guardSql = "SELECT 1 FROM generation_jobs WHERE id = ? AND lease_owner = ? AND status IN ('generating','saving')";

async function completeRender(ctx, job, body, node, cost) {
  const { db, env, now } = ctx;
  const comp = job.compartment_id;
  const assetId = outputAssetId(job.id);
  const found = {};
  for (const v of ASSET_VARIANTS) {
    found[v] = await findVariant(env.ASSETS, comp, assetId, v);
    if (!found[v]) throw new HttpError('CONFLICT', `Output is incomplete (missing ${v}).`);
  }
  const [w, h] = (job.size || '').split('x').map(Number);
  const width = Number.isInteger(body.width) ? body.width : (w || null);
  const height = Number.isInteger(body.height) ? body.height : (h || null);
  const versionId = outputVersionId(job.id);
  const spec = parseJson(job.spec, {});
  const settings = { preset: job.preset, quality: job.quality, complexity: job.complexity, size: job.size, outputFormat: job.output_format };
  const g = "SELECT 1 FROM generation_jobs WHERE id = ? AND lease_owner = ? AND status = 'saving'";
  const gargs = [job.id, node];
  const completedCond = "SELECT 1 FROM generation_jobs WHERE id = ? AND status = 'completed' AND completed_at = ?";
  await db.batch([
    db.prepare(
      `INSERT INTO assets (id, compartment_id, category, provenance, status, visibility, title, width, height, bytes, original_key, original_type,
         display_key, thumb_key, variants_ready, created_by, created_at, updated_at, committed_at)
       SELECT ?, ?, 'rendering', 'ai_concept', 'committed', 'private', 'AI concept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${g})`,
    ).bind(assetId, comp, width, height, found.original.size, found.original.key, found.original.type, found.display.key, found.thumb.key,
      JSON.stringify(ASSET_VARIANTS), job.requested_by, now, now, now, ...gargs),
    db.prepare(
      `INSERT INTO image_versions (id, compartment_id, parent_version_id, job_id, asset_id, spec, spec_hash, prompt, instructions, model, settings,
         inventory_fingerprint, planner_revision, design_revision, status, usage, cost_usd, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ? WHERE EXISTS (${g})`,
    ).bind(versionId, comp, job.parent_version_id, job.id, assetId, job.spec, job.spec_hash, job.prompt, spec.request?.instructions ?? null, job.model,
      JSON.stringify(settings), job.inventory_fingerprint ?? '', job.planner_revision, job.design_revision,
      body.usage ? JSON.stringify(body.usage) : null, cost, job.requested_by, now, now, ...gargs),
    db.prepare(
      `UPDATE generation_jobs SET status = 'completed', actual_cost_usd = ?, usage = ?, provider_request_id = ?, result_version_id = ?, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL,
         provider_called_at = COALESCE(provider_called_at, ?)
       WHERE id = ? AND lease_owner = ? AND status = 'saving' AND EXISTS (SELECT 1 FROM image_versions WHERE id = ?)`,
    ).bind(cost, body.usage ? JSON.stringify(body.usage) : null, body.providerRequestId ?? null, versionId, now, now, now, job.id, node, versionId),
    settleStatement(db, job.id, cost, body.usage ?? null, now, 'completed'),
    auditIfExists(db, { actor: SERVICE_AUDIT, action: 'job.complete', entityType: 'job', entityId: job.id, detail: { versionId, costUsd: cost } }, now, completedCond, [job.id, now]),
  ]);
  return versionId;
}

async function completeRecognize(ctx, job, body, node, cost) {
  const { db, now } = ctx;
  const result = parseRecognition(body.result);
  const loaded = await loadPlannerDoc(db);
  const registry = new Set(Object.values(loaded?.doc?.equipmentIds || {}));
  const suggestions = [];
  for (const o of result.objects) {
    for (const c of o.candidates) {
      if (c.equipmentId && registry.has(c.equipmentId)) suggestions.push({ o, c });
    }
  }
  const completedCond = "SELECT 1 FROM generation_jobs WHERE id = ? AND status = 'completed' AND completed_at = ?";
  await db.batch([
    ...suggestions.map(({ o, c }) => db.prepare(
      `INSERT INTO asset_links (id, asset_id, target_type, target_id, equipment_id, quantity, region, state, label, confidence, created_by, created_at, updated_at)
       SELECT ?, ?, 'equipment', ?, ?, ?, ?, 'suggested', ?, ?, ?, ?, ? WHERE EXISTS (${guardSql})`,
    ).bind(newId('al'), job.subject_asset_id, c.equipmentId, c.equipmentId, o.quantity, o.region ? JSON.stringify(o.region) : null,
      o.label, c.confidence, SERVICE_AUDIT, now, now, job.id, node)),
    db.prepare(
      `UPDATE generation_jobs SET status = 'completed', result = ?, actual_cost_usd = ?, usage = ?, provider_request_id = ?, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL,
         provider_called_at = COALESCE(provider_called_at, ?)
       WHERE id = ? AND lease_owner = ? AND status IN ('generating','saving')`,
    ).bind(JSON.stringify(result), cost, body.usage ? JSON.stringify(body.usage) : null, body.providerRequestId ?? null, now, now, now, job.id, node),
    settleStatement(db, job.id, cost, body.usage ?? null, now, 'completed'),
    auditIfExists(db, { actor: SERVICE_AUDIT, action: 'job.complete', entityType: 'job', entityId: job.id, detail: { suggestions: suggestions.length, costUsd: cost } }, now, completedCond, [job.id, now]),
  ]);
}

/** POST /api/processor/jobs/:jobId/complete */
export async function complete(ctx) {
  const { request, db, params } = ctx;
  const body = await readJson(request);
  const node = readNode(body);
  const job = await leasedJob(db, params.jobId, node);
  if (!['generating', 'saving'].includes(job.status)) throw new HttpError('CONFLICT', 'Report generating/saving before completing.');
  if (job.kind === 'render' && job.status !== 'saving') throw new HttpError('CONFLICT', 'Report status "saving" and upload the output first.');
  const { pricing } = await getSettings(db, ['pricing']);
  const cost = costOf(job, body.usage, pricing, Number(body.actualCostUsd));
  if (job.kind === 'render') await completeRender(ctx, job, body, node, cost);
  else await completeRecognize(ctx, job, body, node, cost);
  const fresh = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(job.id).first();
  if (fresh.status !== 'completed') throw new HttpError('LEASE_LOST', 'This job is no longer assigned to this worker.');
  return json({ ok: true, jobId: job.id, versionId: fresh.result_version_id, costUsd: cost });
}

const PROVIDER_MESSAGES = {
  rate_limit: 'OpenAI is rate-limiting requests right now. Please try again in a few minutes.',
  rate_limit_exceeded: 'OpenAI is rate-limiting requests right now. Please try again in a few minutes.',
  insufficient_quota: 'OpenAI account has no available credit. An administrator needs to add credit.',
  billing: 'OpenAI account has no available credit. An administrator needs to add credit.',
  billing_hard_limit_reached: 'OpenAI account has no available credit. An administrator needs to add credit.',
  moderation_blocked: 'OpenAI blocked this request for safety reasons. Adjust the instructions and try again.',
  invalid_request: 'OpenAI rejected the request as invalid. Simplify the instructions or reduce the number of reference photos.',
};

/** @param {string} code @param {string} [message] */
export function humanFailure(code, message) {
  if (PROVIDER_MESSAGES[code]) return PROVIDER_MESSAGES[code];
  return String(message || 'Image generation failed. Please try again.').slice(0, 300);
}

/** POST /api/processor/jobs/:jobId/fail — body {node, code, message, retryable, providerCalled}. */
export async function fail({ request, env, db, params, now }) {
  const body = await readJson(request);
  const node = readNode(body);
  const job = await leasedJob(db, params.jobId, node);
  const code = String(body.code || 'PROCESSOR_ERROR').slice(0, 64);
  const providerCalled = body.providerCalled === true;
  const message = humanFailure(code, body.message);
  const cancelled = !!job.cancel_requested;
  const requeue = !cancelled && body.retryable === true && !providerCalled && job.attempts < job.max_attempts;
  const guard = "WHERE id = ? AND lease_owner = ? AND status IN ('claimed','preparing','generating','saving')";
  const audit = { actor: SERVICE_AUDIT, action: requeue ? 'job.requeue' : 'job.fail', entityType: 'job', entityId: job.id, detail: { code, providerCalled, requeue } };
  let stmts;
  if (requeue) {
    stmts = [db.prepare(`UPDATE generation_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, provider_called_at = NULL, next_attempt_at = ?, error_code = ?, error_message = ?, updated_at = ? ${guard}`)
      .bind(now + backoffMs(job.attempts), code, message, now, job.id, node)];
  } else {
    const status = cancelled ? 'cancelled' : 'failed';
    stmts = [
      db.prepare(`UPDATE generation_jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?,
        provider_called_at = CASE WHEN ? = 1 THEN COALESCE(provider_called_at, ?) ELSE NULL END ${guard}`)
        .bind(status, cancelled ? 'CANCELLED' : code, cancelled ? 'Cancelled by the requester.' : message, now, now, providerCalled ? 1 : 0, now, job.id, node),
      providerCalled ? settleStatement(db, job.id, job.estimated_cost_usd, null, now, status) : releaseStatement(db, job.id, now, status),
    ];
  }
  stmts.push(auditIfExists(db, audit, now, 'SELECT 1 FROM generation_jobs WHERE id = ? AND updated_at = ?', [job.id, now]));
  await db.batch(stmts);
  const fresh = await db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(job.id).first();
  if (fresh.status === job.status && fresh.lease_owner === node) throw new HttpError('LEASE_LOST', 'This job is no longer assigned to this worker.');
  if (!requeue && job.kind === 'render') await cleanupOutput(env.ASSETS, job);
  return json({ ok: true, status: fresh.status, willRetry: requeue });
}
