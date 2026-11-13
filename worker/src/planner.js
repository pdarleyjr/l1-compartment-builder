// Planner document endpoints and the reusable op-application helper.
//
//   GET  /api/public/planner?since=<rev>  -> 304 when unchanged, else {revision, migrated, doc}
//   POST /api/planner/ops                 -> {revision, doc, applied, conflicts}
//
// applyPlannerOpsInBatch(db, {ops, actor, clientOpId, now}) -> Promise<{statements, result}>
//   Loads the current doc, applies ops (shared/planner.js applyOps), and returns D1 prepared statements
//   [CAS update, planner_history insert, audit insert] for the caller to include in ITS OWN db.batch([...own, ...statements]).
//   result = {revision, doc, applied, conflicts, changed, deduped}. `changed:false` => statements is [] (nothing to write,
//   e.g. all ops already satisfied/conflicting, or clientOpId was already recorded => deduped:true).
//   A lost CAS race aborts the whole batch (the history row for revision+1 already exists -> PRIMARY KEY violation, rolled
//   back); callers detect it with isPlannerRaceError(err) and call the helper again (re-reads the doc).
//   Throws HttpError CONFLICT "Planner migration pending" before the doc is migrated.
//   planner_history.conflicts stores JSON {applied, conflicts} so a deduped retry can return the recorded result.
import { PLANNER_LIMITS } from '../../shared/contracts.js';
import { newId } from '../../shared/ids.js';
import { applyOps, projectV1, validateOp } from '../../shared/planner.js';
import { auditStatement } from './audit.js';
import { actorLabel, empty, HttpError, json, readJson } from './http.js';
import { readKvJson } from './kv-legacy.js';

const MAX_ATTEMPTS = 4; // first try + up to 3 retries on a CAS miss
const CLIENT_OP_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

/** v1 projection plus the v2 identity registries (what clients consume). */
export function publicDoc(doc) {
  return { ...projectV1(doc), equipmentIds: doc.equipmentIds ?? {}, assignmentIds: doc.assignmentIds ?? {} };
}

/** @returns {Promise<{revision:number, doc:object, updatedAt:number}|null>} */
export async function loadPlannerDoc(db) {
  const row = await db.prepare("SELECT revision, doc, updated_at FROM planner_doc WHERE id = 'main'").first();
  return row ? { revision: row.revision, doc: JSON.parse(row.doc), updatedAt: row.updated_at } : null;
}

/** True when a batch failed because another writer won the planner CAS or reused the clientOpId. */
export function isPlannerRaceError(err) {
  return /UNIQUE|constraint|PRIMARY KEY/i.test(String(err?.message ?? err));
}

/** See file header. */
export async function applyPlannerOpsInBatch(db, { ops, actor, clientOpId, now = Date.now() }) {
  const current = await loadPlannerDoc(db);
  if (!current) throw new HttpError('CONFLICT', 'Planner migration pending');
  if (clientOpId) {
    const prior = await db.prepare('SELECT revision, conflicts FROM planner_history WHERE client_op_id = ?').bind(clientOpId).first();
    if (prior) {
      let recorded = {};
      try { recorded = JSON.parse(prior.conflicts ?? '{}') ?? {}; } catch { /* legacy row */ }
      return {
        statements: [],
        result: {
          revision: current.revision, doc: publicDoc(current.doc), appliedRevision: prior.revision,
          applied: recorded.applied ?? [], conflicts: recorded.conflicts ?? [], changed: false, deduped: true,
        },
      };
    }
  }
  const out = applyOps(structuredClone(current.doc), ops, { newId, now });
  const before = JSON.stringify(current.doc);
  const after = JSON.stringify(out.doc);
  const changed = after !== before;
  const result = {
    revision: current.revision, doc: publicDoc(changed ? out.doc : current.doc),
    applied: out.applied, conflicts: out.conflicts, changed, deduped: false,
  };
  if (!changed) return { statements: [], result };
  const next = current.revision + 1;
  const who = actorLabel(actor);
  result.revision = next;
  return {
    result,
    statements: [
      db.prepare("UPDATE planner_doc SET doc = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 'main' AND revision = ?")
        .bind(after, now, who, current.revision),
      db.prepare('INSERT INTO planner_history (revision, client_op_id, ops, conflicts, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(next, clientOpId ?? null, JSON.stringify(ops), JSON.stringify({ applied: out.applied, conflicts: out.conflicts }), who, now),
      auditStatement(db, {
        actor: who, action: 'planner.ops', entityType: 'planner', entityId: String(next),
        detail: { revision: next, ops: ops.length, applied: out.applied.length, conflicts: out.conflicts.length },
      }, now),
    ],
  };
}

/** GET /api/public/planner */
export async function getPlanner(ctx) {
  const { db, env, url, request } = ctx;
  const row = await loadPlannerDoc(db);
  let revision = 0;
  let body;
  if (row) {
    revision = row.revision;
    body = { revision, migrated: true, doc: publicDoc(row.doc) };
  } else {
    const legacy = await readKvJson(env, 'allocations');
    body = { revision: 0, migrated: false, doc: legacy ? legacy.value : null };
  }
  const etag = `"${revision}"`;
  const since = url.searchParams.get('since');
  const sinceMatches = since !== null && /^\d+$/.test(since) && Number(since) === revision;
  if (sinceMatches || request.headers.get('If-None-Match') === etag) return empty(304, { ETag: etag });
  return json(body, 200, { ETag: etag });
}

/** POST /api/planner/ops */
export async function postOps(ctx) {
  const { db, actor, now } = ctx;
  const body = await readJson(ctx.request, 500_000);
  if (!body || typeof body !== 'object') throw new HttpError('INVALID_REQUEST', 'Body must be an object.');
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) throw new HttpError('INVALID_REQUEST', 'baseRevision must be a non-negative integer.');
  if (typeof body.clientOpId !== 'string' || !CLIENT_OP_RE.test(body.clientOpId)) throw new HttpError('INVALID_REQUEST', 'clientOpId is required (8-100 URL-safe characters).');
  if (!Array.isArray(body.ops) || body.ops.length === 0) throw new HttpError('INVALID_REQUEST', 'ops must be a non-empty array.');
  if (body.ops.length > PLANNER_LIMITS.maxOpsPerRequest) throw new HttpError('INVALID_REQUEST', `At most ${PLANNER_LIMITS.maxOpsPerRequest} ops per request.`);
  for (let i = 0; i < body.ops.length; i++) {
    const v = validateOp(body.ops[i]);
    if (!v?.ok) throw new HttpError('INVALID_REQUEST', `Invalid op at index ${i}: ${v?.error ?? 'invalid'}`, { index: i });
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { statements, result } = await applyPlannerOpsInBatch(db, { ops: body.ops, actor, clientOpId: body.clientOpId, now });
    if (!statements.length) return json(pick(result));
    try {
      await db.batch(statements);
      return json(pick(result));
    } catch (err) {
      if (!isPlannerRaceError(err)) throw err;
    }
  }
  throw new HttpError('REVISION_CONFLICT', 'The plan is being edited by several people at once. Try again.');
}

const pick = r => ({ revision: r.revision, doc: r.doc, applied: r.applied, conflicts: r.conflicts, ...(r.deduped ? { deduped: true } : {}) });
