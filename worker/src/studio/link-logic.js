// Link target validation and planner-op application shared by commit, putLinks and updateLink.
import { compartmentAssignments } from '../../../shared/planner.js';
import { newId } from '../../../shared/ids.js';
import { ID_PREFIX, LINK_TARGETS } from '../../../shared/contracts.js';
import { applyPlannerOpsInBatch, loadPlannerDoc } from '../planner.js';
import { HttpError, actorLabel } from '../http.js';

/** Apply optional planner ops (via E1's batch builder). Conflicts abort with 409 and nothing is written.
 * @returns {Promise<{statements:any[], doc:object, revision:number|null}>} */
export async function resolvePlannerContext(db, { ops, baseRevision, clientOpId, actor, now }) {
  if (Array.isArray(ops) && ops.length) {
    const { statements, result } = await applyPlannerOpsInBatch(db, { ops, actor, clientOpId, now, baseRevision });
    if (result.conflicts?.length) {
      throw new HttpError('CONFLICT', 'The inventory changed on another device. Nothing was saved.', {
        conflicts: result.conflicts, plannerRevision: result.revision,
      });
    }
    return { statements, doc: result.doc, revision: result.revision };
  }
  const loaded = await loadPlannerDoc(db);
  if (!loaded) throw new HttpError('INTERNAL', 'The planner document is not initialised.');
  return { statements: [], doc: loaded.doc, revision: null };
}

const sameRegion = r => r && ['x', 'y', 'w', 'h'].every(k => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1);

/**
 * Validate link targets against the (post-ops) planner doc and this compartment. Returns normalized rows.
 * @param {*} db
 * @param {{doc:object, compId:string, links:{targetType:string, targetId:string, quantity?:number, region?:object|null}[]}} p
 * @returns {Promise<{targetType:string, targetId:string, equipmentId:string|null, quantity:number, region:object|null}[]>}
 */
export async function resolveLinks(db, { doc, compId, links }) {
  const assignments = compartmentAssignments(doc, compId);
  const registry = new Set(Object.values(doc.equipmentIds || {}));
  const bundles = new Set((doc.bundles?.[compId] || []).map(b => b.id));
  const seen = new Set();
  const out = [];
  for (const [i, l] of links.entries()) {
    const where = `Link ${i + 1}`;
    if (!LINK_TARGETS.includes(l.targetType) || typeof l.targetId !== 'string' || !l.targetId) {
      throw new HttpError('INVALID_REQUEST', `${where}: unknown target.`);
    }
    const key = `${l.targetType}:${l.targetId}`;
    if (seen.has(key)) throw new HttpError('INVALID_REQUEST', `${where}: duplicate target.`);
    seen.add(key);
    const quantity = l.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new HttpError('INVALID_REQUEST', `${where}: quantity must be a whole number from 1 to 500.`);
    if (l.region != null && !sameRegion(l.region)) throw new HttpError('INVALID_REQUEST', `${where}: region must be normalized 0..1.`);
    let equipmentId = null;
    if (l.targetType === 'equipment') {
      if (!registry.has(l.targetId)) throw new HttpError('INVALID_REQUEST', `${where}: unknown equipment.`);
      equipmentId = l.targetId;
    } else if (l.targetType === 'assignment') {
      const row = assignments.find(a => a.assignmentId === l.targetId);
      if (!row) throw new HttpError('INVALID_REQUEST', `${where}: that item is not assigned in this compartment.`);
      equipmentId = row.equipmentId;
    } else if (l.targetType === 'bundle') {
      if (!bundles.has(l.targetId)) throw new HttpError('INVALID_REQUEST', `${where}: unknown bundle for this compartment.`);
    } else {
      const m = await db.prepare('SELECT id FROM mounts WHERE id = ? AND compartment_id = ? AND deleted_at IS NULL').bind(l.targetId, compId).first();
      if (!m) throw new HttpError('INVALID_REQUEST', `${where}: unknown mount for this compartment.`);
    }
    if (equipmentId) {
      const assigned = assignments.filter(a => a.equipmentId === equipmentId).length;
      if (quantity > assigned) {
        throw new HttpError('INVALID_REQUEST', `${where}: quantity ${quantity} is more than the ${assigned} assigned in this compartment.`);
      }
    }
    out.push({ targetType: l.targetType, targetId: l.targetId, equipmentId, quantity, region: l.region ?? null });
  }
  return out;
}

/** INSERT statements for confirmed link rows. */
export function linkInsertStatements(db, assetId, rows, actor, now, state = 'confirmed') {
  return rows.map(r => db.prepare(
    `INSERT INTO asset_links (id, asset_id, target_type, target_id, equipment_id, quantity, region, state, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId(ID_PREFIX.link), assetId, r.targetType, r.targetId, r.equipmentId, r.quantity,
    r.region ? JSON.stringify(r.region) : null, state, actorLabel(actor), now, now));
}
