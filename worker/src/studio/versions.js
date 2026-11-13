// Image version tree: listing and reject / soft-delete (versions are otherwise immutable).
import { inventoryFingerprint } from '../../../shared/fingerprint.js';
import { HttpError, actorLabel, json, readJson } from '../http.js';
import { auditIfChanged, assetUrl, changes, parseJson, requireCompartment } from './common.js';
import { loadPlannerDoc } from '../planner.js';

/** GET /api/compartments/:compId/versions */
export async function listVersions({ db, params }) {
  const compId = requireCompartment(params.compId);
  const loaded = await loadPlannerDoc(db);
  const fp = loaded ? await inventoryFingerprint(loaded.doc, compId) : null;
  const main = await db.prepare('SELECT kind, ref FROM main_images WHERE compartment_id = ?').bind(compId).first();
  const { results } = await db.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM image_versions c WHERE c.parent_version_id = v.id AND c.status != 'deleted') AS children
     FROM image_versions v WHERE v.compartment_id = ? AND v.status != 'deleted' ORDER BY v.created_at, v.id`,
  ).bind(compId).all();
  return json({
    versions: (results || []).map(v => ({
      id: v.id, compartmentId: compId, parentVersionId: v.parent_version_id ?? null, childCount: v.children, jobId: v.job_id, assetId: v.asset_id,
      status: v.status, model: v.model, settings: parseJson(v.settings, {}), instructions: v.instructions ?? null, costUsd: v.cost_usd ?? null,
      createdBy: v.created_by, createdAt: v.created_at, approvedAt: v.approved_at ?? null, inventoryFingerprint: v.inventory_fingerprint,
      stale: !!fp && v.inventory_fingerprint !== fp, isMain: main?.kind === 'version' && main.ref === v.id,
      variants: { thumb: assetUrl(v.asset_id, 'thumb'), display: assetUrl(v.asset_id, 'display'), original: assetUrl(v.asset_id, 'original') },
    })),
  });
}

/** PATCH /api/versions/:versionId — body {status:'rejected'|'deleted'}. */
export async function updateVersion({ request, db, actor, params, now }) {
  const body = await readJson(request);
  if (!['rejected', 'deleted'].includes(body.status)) throw new HttpError('INVALID_REQUEST', 'status must be "rejected" or "deleted".');
  const v = await db.prepare('SELECT * FROM image_versions WHERE id = ?').bind(params.versionId).first();
  if (!v || v.status === 'deleted') throw new HttpError('NOT_FOUND', 'Version not found.');
  const main = await db.prepare("SELECT 1 AS x FROM main_images WHERE kind = 'version' AND ref = ?").bind(v.id).first();
  if (main) throw new HttpError('CONFLICT', 'This is the current main image. Approve another image first.');
  if (body.status === 'rejected' && v.status !== 'draft') throw new HttpError('CONFLICT', 'Only drafts can be rejected.');
  const me = actorLabel(actor);
  const stmts = [
    db.prepare('UPDATE image_versions SET status = ?, updated_at = ? WHERE id = ? AND status = ?').bind(body.status, now, v.id, v.status),
    auditIfChanged(db, { actor: me, action: `version.${body.status}`, entityType: 'image_version', entityId: v.id }, now),
  ];
  if (body.status === 'deleted') {
    stmts.push(db.prepare("UPDATE assets SET status = 'deleted', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND status = 'committed' AND EXISTS (SELECT 1 FROM image_versions WHERE id = ? AND status = 'deleted')")
      .bind(now, me, now, v.asset_id, v.id));
  }
  const [res] = await db.batch(stmts);
  if (!changes(res)) throw new HttpError('CONFLICT', 'This version changed. Reload and try again.');
  return json({ version: { id: v.id, status: body.status } });
}
