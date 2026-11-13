// Helpers shared by the studio handler modules: DTO mappers, validation glue, guarded audit statements.
import { COMPARTMENT_IDS, ASSET_VARIANTS } from '../../../shared/contracts.js';
import { HttpError, actorLabel } from '../http.js';

/** @param {string|null|undefined} text @param {*} fallback */
export function parseJson(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Throw 404 unless compId is one of the eleven compartments. */
export function requireCompartment(compId) {
  if (!COMPARTMENT_IDS.includes(compId)) throw new HttpError('NOT_FOUND', 'Compartment not found.');
  return compId;
}

export function requireVariant(variant) {
  if (!ASSET_VARIANTS.includes(variant)) throw new HttpError('NOT_FOUND', 'Unknown image variant.');
  return variant;
}

/** Unwrap a shared/validation.js result ({ok, value|error}) or raise 400. */
export function validated(result) {
  if (!result || result.ok !== true) throw new HttpError('INVALID_REQUEST', (result && result.error) || 'Invalid request.');
  return result.value;
}

/** Rows changed by a D1 run() result. */
export const changes = res => res?.meta?.changes ?? 0;

/** Requester (or admin) may act on records they created. */
export function ownerOrAdmin(actor, createdBy, what = 'record') {
  if (actor?.kind === 'user' && actor.roles?.includes('admin')) return;
  if (actorLabel(actor) !== createdBy) throw new HttpError('FORBIDDEN', `Only the person who created this ${what}, or an administrator, can do that.`);
}

/** Audit row inserted only when the previous statement in the batch changed a row. */
export function auditIfChanged(db, entry, now) {
  return db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
  ).bind(now, entry.actor ?? null, entry.action, entry.entityType ?? null, entry.entityId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail));
}

/** Audit row inserted only when `existsSql` (with `args`) returns a row. */
export function auditIfExists(db, entry, now, existsSql, args) {
  return db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${existsSql})`,
  ).bind(now, entry.actor ?? null, entry.action, entry.entityType ?? null, entry.entityId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail), ...args);
}

export const assetUrl = (id, variant, pub = false) => `/api/${pub ? 'public/' : ''}assets/${id}/${variant}`;

/** @returns {import('../../../shared/contracts.js').Link} */
export function linkDto(r) {
  return {
    id: r.id, assetId: r.asset_id, targetType: r.target_type, targetId: r.target_id, equipmentId: r.equipment_id ?? null,
    quantity: r.quantity, region: parseJson(r.region, null), state: r.state, label: r.label ?? undefined,
    confidence: r.confidence ?? undefined,
  };
}

/** @returns {import('../../../shared/contracts.js').Asset} */
export function assetDto(r, { links, pub = false } = {}) {
  const ready = parseJson(r.variants_ready, []);
  const variants = {};
  for (const v of ASSET_VARIANTS) if (ready.includes(v)) variants[v] = assetUrl(r.id, v, pub);
  const dto = {
    id: r.id, compartmentId: r.compartment_id, category: r.category, provenance: r.provenance, status: r.status,
    visibility: r.visibility, title: r.title ?? null, notes: r.notes ?? null, width: r.width ?? null, height: r.height ?? null,
    bytes: r.bytes ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at, revision: r.revision, variants,
  };
  if (links) dto.links = links;
  return dto;
}

/** @returns {import('../../../shared/contracts.js').Job} */
export function jobDto(r) {
  return {
    id: r.id, compartmentId: r.compartment_id, kind: r.kind, mode: r.mode ?? null, preset: r.preset ?? null, model: r.model,
    status: r.status, attempts: r.attempts, errorCode: r.error_code ?? null, errorMessage: r.error_message ?? null,
    estimatedCostUsd: r.estimated_cost_usd, actualCostUsd: r.actual_cost_usd ?? null, resultVersionId: r.result_version_id ?? null,
    result: parseJson(r.result, null), createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at ?? null,
    requestedBy: r.requested_by, parentVersionId: r.parent_version_id ?? null, cancelRequested: !!r.cancel_requested,
    size: r.size ?? null, quality: r.quality ?? null, nextAttemptAt: r.next_attempt_at ?? null,
  };
}

/** @param {*} db @param {string} id @param {string} comp @returns {Promise<object>} committed, not-deleted asset of the compartment */
export async function requireCommittedAsset(db, id, comp) {
  const row = await db.prepare("SELECT * FROM assets WHERE id = ? AND status = 'committed'").bind(id).first();
  if (!row || (comp && row.compartment_id !== comp)) throw new HttpError('NOT_FOUND', 'Photo not found in this compartment.');
  return row;
}

/** Map of assetId → links[] for the given asset rows (confirmed + suggested; rejected hidden). */
export async function linksFor(db, assetIds, states = ['confirmed', 'suggested']) {
  const map = new Map(assetIds.map(id => [id, []]));
  if (!assetIds.length) return map;
  const ph = assetIds.map(() => '?').join(',');
  const sph = states.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM asset_links WHERE asset_id IN (${ph}) AND state IN (${sph}) ORDER BY created_at, id`,
  ).bind(...assetIds, ...states).all();
  for (const r of results || []) map.get(r.asset_id)?.push(linkDto(r));
  return map;
}
