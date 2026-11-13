// Mounting hardware / equipment-holder records and their links.
import { ID_PREFIX, MOUNT_CLASSIFICATIONS, MOUNT_STATUSES } from '../../shared/contracts.js';
import { newId } from '../../shared/ids.js';
import { compartmentAssignments } from '../../shared/planner.js';
import { validateMount } from '../../shared/validation.js';
import { HttpError, actorLabel, json, readJson } from './http.js';
import { auditStatement } from './audit.js';
import { auditIfChanged, changes, parseJson, requireCompartment, validated } from './studio/common.js';
import { loadPlannerDoc } from './planner.js';

const MOUNT_LINK_TYPES = ['equipment', 'assignment', 'asset'];
const FIELDS = ['name', 'manufacturer', 'model', 'description', 'orientation', 'zone', 'capacity', 'classification', 'status', 'notes'];

function mountDto(r, links = []) {
  return {
    id: r.id, compartmentId: r.compartment_id, name: r.name ?? null, manufacturer: r.manufacturer ?? null, model: r.model ?? null,
    description: r.description ?? null, dimensions: parseJson(r.dimensions, null), orientation: r.orientation ?? null,
    zone: r.zone ?? null, capacity: r.capacity ?? null, classification: r.classification, status: r.status,
    equipmentId: r.equipment_id ?? null, notes: r.notes ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at,
    updatedAt: r.updated_at, revision: r.revision, links,
  };
}

async function linksOf(db, mountIds) {
  const map = new Map(mountIds.map(id => [id, []]));
  if (!mountIds.length) return map;
  const { results } = await db.prepare(
    `SELECT * FROM mount_links WHERE mount_id IN (${mountIds.map(() => '?').join(',')}) ORDER BY created_at, target_id`,
  ).bind(...mountIds).all();
  for (const r of results || []) map.get(r.mount_id)?.push({ targetType: r.target_type, targetId: r.target_id });
  return map;
}

async function checkLinks(db, doc, compId, links) {
  if (links === undefined) return undefined;
  if (!Array.isArray(links) || links.length > 100) throw new HttpError('INVALID_REQUEST', 'links must be a list of up to 100 targets.');
  const assignments = compartmentAssignments(doc, compId);
  const registry = new Set(Object.values(doc.equipmentIds || {}));
  const seen = new Set();
  for (const l of links) {
    if (!l || !MOUNT_LINK_TYPES.includes(l.targetType) || typeof l.targetId !== 'string') throw new HttpError('INVALID_REQUEST', 'Unknown mount link target.');
    const key = `${l.targetType}:${l.targetId}`;
    if (seen.has(key)) throw new HttpError('INVALID_REQUEST', 'Duplicate mount link.');
    seen.add(key);
    let ok;
    if (l.targetType === 'equipment') ok = registry.has(l.targetId);
    else if (l.targetType === 'assignment') ok = assignments.some(a => a.assignmentId === l.targetId);
    else ok = !!(await db.prepare("SELECT id FROM assets WHERE id = ? AND compartment_id = ? AND status = 'committed'").bind(l.targetId, compId).first());
    if (!ok) throw new HttpError('INVALID_REQUEST', `Mount link ${l.targetType} ${l.targetId} does not belong to this compartment.`);
  }
  return links;
}

function checkEnums(v) {
  if (v.classification !== undefined && !MOUNT_CLASSIFICATIONS.includes(v.classification)) throw new HttpError('INVALID_REQUEST', 'Unknown mount classification.');
  if (v.status !== undefined && !MOUNT_STATUSES.includes(v.status)) throw new HttpError('INVALID_REQUEST', 'Unknown mount status.');
}

async function checkInventory(doc, classification, equipmentId) {
  if (classification !== 'inventory') return;
  if (!equipmentId || !Object.values(doc.equipmentIds || {}).includes(equipmentId)) {
    throw new HttpError('INVALID_REQUEST', 'An inventory mount needs an existing inventory item. Create the item first.');
  }
}

/** Replace-the-link-set statements; with `guardRevision` they only take effect when the mount is at that revision. */
function linkStatements(db, mountId, links, now, guardRevision = null) {
  const guard = guardRevision == null ? '' : ' AND EXISTS (SELECT 1 FROM mounts WHERE id = ? AND revision = ? AND deleted_at IS NULL)';
  const gargs = guardRevision == null ? [] : [mountId, guardRevision];
  return [
    db.prepare(`DELETE FROM mount_links WHERE mount_id = ?${guard}`).bind(mountId, ...gargs),
    ...links.map(l => db.prepare(
      `INSERT INTO mount_links (mount_id, target_type, target_id, created_at) SELECT ?, ?, ?, ? WHERE 1 = 1${guard}`,
    ).bind(mountId, l.targetType, l.targetId, now, ...gargs)),
  ];
}

async function requireMount(db, id) {
  const row = await db.prepare('SELECT * FROM mounts WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!row) throw new HttpError('NOT_FOUND', 'Mount not found.');
  return row;
}

/** GET /api/compartments/:compId/mounts */
export async function listMounts({ db, params }) {
  const compId = requireCompartment(params.compId);
  const { results } = await db.prepare('SELECT * FROM mounts WHERE compartment_id = ? AND deleted_at IS NULL ORDER BY created_at, id').bind(compId).all();
  const links = await linksOf(db, (results || []).map(r => r.id));
  return json({ mounts: (results || []).map(r => mountDto(r, links.get(r.id))) });
}

/** POST /api/compartments/:compId/mounts */
export async function createMount({ request, db, actor, params, now }) {
  const compId = requireCompartment(params.compId);
  const body = await readJson(request);
  const v = validated(validateMount(body));
  checkEnums(v);
  const loaded = await loadPlannerDoc(db);
  if (!loaded) throw new HttpError('INTERNAL', 'The planner document is not initialised.');
  const classification = v.classification ?? 'mounting';
  await checkInventory(loaded.doc, classification, v.equipmentId);
  const links = (await checkLinks(db, loaded.doc, compId, body.links)) ?? [];
  const id = newId(ID_PREFIX.mount);
  const me = actorLabel(actor);
  await db.batch([
    db.prepare(
      `INSERT INTO mounts (id, compartment_id, name, manufacturer, model, description, dimensions, orientation, zone, capacity,
         classification, status, equipment_id, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, compId, v.name ?? null, v.manufacturer ?? null, v.model ?? null, v.description ?? null,
      v.dimensions ? JSON.stringify(v.dimensions) : null, v.orientation ?? null, v.zone ?? null, v.capacity ?? null,
      classification, v.status ?? 'proposed', classification === 'inventory' ? v.equipmentId : null, v.notes ?? null, me, now, now),
    ...linkStatements(db, id, links, now),
    auditStatement(db, { actor: me, action: 'mount.create', entityType: 'mount', entityId: id, detail: { compartmentId: compId } }, now),
  ]);
  const row = await requireMount(db, id);
  return json({ mount: mountDto(row, links) }, 201);
}

/** PATCH /api/mounts/:mountId — body fields + expectRevision (+ links to replace the link set). */
export async function updateMount({ request, db, actor, params, now }) {
  const body = await readJson(request);
  if (!Number.isInteger(body.expectRevision)) throw new HttpError('INVALID_REQUEST', 'expectRevision is required.');
  const v = validated(validateMount(body, { partial: true }));
  checkEnums(v);
  const mount = await requireMount(db, params.mountId);
  const loaded = await loadPlannerDoc(db);
  if (!loaded) throw new HttpError('INTERNAL', 'The planner document is not initialised.');
  const classification = v.classification ?? mount.classification;
  const equipmentId = v.equipmentId !== undefined ? v.equipmentId : mount.equipment_id;
  await checkInventory(loaded.doc, classification, equipmentId);
  const links = await checkLinks(db, loaded.doc, mount.compartment_id, body.links);
  const sets = [];
  const args = [];
  for (const f of FIELDS) if (v[f] !== undefined) { sets.push(`${f} = ?`); args.push(v[f]); }
  if (v.dimensions !== undefined) { sets.push('dimensions = ?'); args.push(v.dimensions ? JSON.stringify(v.dimensions) : null); }
  sets.push('equipment_id = ?'); args.push(classification === 'inventory' ? equipmentId : null);
  const me = actorLabel(actor);
  const results = await db.batch([
    db.prepare(`UPDATE mounts SET ${sets.join(', ')}, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
      .bind(...args, now, mount.id, body.expectRevision),
    auditIfChanged(db, { actor: me, action: 'mount.update', entityType: 'mount', entityId: mount.id }, now),
    ...(links ? linkStatements(db, mount.id, links, now, body.expectRevision + 1) : []),
  ]);
  if (!changes(results[0])) throw new HttpError('REVISION_CONFLICT', 'This mount was changed by someone else. Reload and try again.');
  const row = await requireMount(db, mount.id);
  return json({ mount: mountDto(row, (await linksOf(db, [mount.id])).get(mount.id)) });
}

/** DELETE /api/mounts/:mountId — soft delete. */
export async function deleteMount({ db, actor, params, now }) {
  const mount = await requireMount(db, params.mountId);
  await db.batch([
    db.prepare('UPDATE mounts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL').bind(now, now, mount.id),
    auditIfChanged(db, { actor: actorLabel(actor), action: 'mount.delete', entityType: 'mount', entityId: mount.id }, now),
  ]);
  return json({ ok: true });
}
