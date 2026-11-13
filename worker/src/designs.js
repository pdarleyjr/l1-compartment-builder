// Per-compartment layout designs (zones + placements), revisioned with compare-and-set.
import { compartmentGeometry } from '../../shared/apparatus-render.js';
import { compartmentAssignments } from '../../shared/planner.js';
import { validateDesign } from '../../shared/validation.js';
import { HttpError, actorLabel, json, readJson } from './http.js';
import { auditIfChanged, changes, parseJson, requireCompartment, validated } from './studio/common.js';
import { getSetting } from './settings.js';
import { loadPlannerDoc } from './planner.js';

async function defaultLayout(db, compId) {
  const overrides = (await getSetting(db, 'compartments.overrides')) || {};
  const geo = compartmentGeometry(compId, overrides[compId] || {});
  return { zones: geo.zones, placements: [] };
}

/** GET /api/compartments/:compId/design */
export async function getDesign({ db, params }) {
  const compId = requireCompartment(params.compId);
  const row = await db.prepare('SELECT * FROM designs WHERE compartment_id = ?').bind(compId).first();
  if (!row) return json({ design: { compartmentId: compId, revision: 0, layout: await defaultLayout(db, compId), updatedBy: null, updatedAt: null } });
  return json({ design: { compartmentId: compId, revision: row.revision, layout: parseJson(row.layout, {}), updatedBy: row.updated_by, updatedAt: row.updated_at } });
}

async function checkPlacements(db, compId, layout) {
  const placements = layout.placements ?? [];
  if (!placements.length) return;
  const loaded = await loadPlannerDoc(db);
  if (!loaded) throw new HttpError('INTERNAL', 'The planner document is not initialised.');
  const assignments = compartmentAssignments(loaded.doc, compId);
  for (const [i, p] of placements.entries()) {
    let ok = false;
    if (p.targetType === 'assignment') ok = assignments.some(a => a.assignmentId === p.targetId);
    else if (p.targetType === 'equipment') ok = assignments.some(a => a.equipmentId === p.targetId);
    else if (p.targetType === 'mount') {
      ok = !!(await db.prepare('SELECT id FROM mounts WHERE id = ? AND compartment_id = ? AND deleted_at IS NULL').bind(p.targetId, compId).first());
    }
    if (!ok) throw new HttpError('INVALID_REQUEST', `Placement ${i + 1} refers to an item that is not in this compartment.`);
  }
}

/** PUT /api/compartments/:compId/design — body {layout|…, expectRevision}. */
export async function putDesign({ request, db, actor, params, now }) {
  const compId = requireCompartment(params.compId);
  const body = await readJson(request);
  const expect = body.expectRevision;
  if (!Number.isInteger(expect) || expect < 0) throw new HttpError('INVALID_REQUEST', 'expectRevision is required.');
  const v = validated(validateDesign(body));
  const layout = v.layout ?? v;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new HttpError('INVALID_REQUEST', 'layout must be an object.');
  await checkPlacements(db, compId, layout);
  const me = actorLabel(actor);
  const layoutText = JSON.stringify({ zones: layout.zones ?? [], placements: layout.placements ?? [], ...(layout.notes ? { notes: layout.notes } : {}) });
  const first = expect === 0
    ? db.prepare('INSERT INTO designs (compartment_id, revision, layout, updated_by, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(compartment_id) DO NOTHING').bind(compId, layoutText, me, now)
    : db.prepare('UPDATE designs SET layout = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE compartment_id = ? AND revision = ?').bind(layoutText, me, now, compId, expect);
  const [res] = await db.batch([first, auditIfChanged(db, { actor: me, action: 'design.update', entityType: 'design', entityId: compId, detail: { revision: expect + 1 } }, now)]);
  if (!changes(res)) throw new HttpError('REVISION_CONFLICT', 'This layout was changed by someone else. Reload and try again.');
  return json({ design: { compartmentId: compId, revision: expect + 1, layout: JSON.parse(layoutText), updatedBy: me, updatedAt: now } });
}
