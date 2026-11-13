// Gallery item = {id (== ref: preset path | asset id | version id), kind, url, thumbUrl, title, provenance, status?, ...}.
// Public/editor galleries and the server-authoritative main image per compartment (architecture §9).
import { COMPARTMENTS } from '../../shared/apparatus.js';
import { COMPARTMENT_IDS, MAIN_IMAGE_KINDS } from '../../shared/contracts.js';
import { inventoryFingerprint } from '../../shared/fingerprint.js';
import { HttpError, actorLabel, json, readJson } from './http.js';
import { auditIfExists, assetUrl, parseJson, requireCompartment } from './studio/common.js';
import { loadPlannerDoc } from './planner.js';

const presetsOf = compId => COMPARTMENTS.find(c => c.id === compId)?.images ?? [];
const presetProvenance = img => (/render/i.test(img.src) || /render/i.test(img.title || '') ? 'ai_concept' : 'user_photo');

function presetItem(compId, img) {
  return { id: img.src, kind: 'preset', ref: img.src, compartmentId: compId, title: img.title ?? null, url: img.src, thumbUrl: img.src, provenance: presetProvenance(img) };
}

function assetItem(r, pub) {
  return {
    id: r.id, kind: 'asset', ref: r.id, assetId: r.id, compartmentId: r.compartment_id, title: r.title ?? null,
    category: r.category, visibility: r.visibility, url: assetUrl(r.id, 'display', pub), thumbUrl: assetUrl(r.id, 'thumb', pub),
    provenance: r.provenance, createdAt: r.created_at,
  };
}

async function currentFingerprint(doc, compId) {
  return doc ? inventoryFingerprint(doc, compId) : null;
}

/** Resolve a main_images row to the MainImage contract (null when the target vanished). */
async function toMainImage(db, row, fp) {
  let url; let thumbUrl; let provenance;
  if (row.kind === 'preset') {
    const img = presetsOf(row.compartment_id).find(i => i.src === row.ref);
    if (!img) return null;
    url = img.src; thumbUrl = img.src; provenance = presetProvenance(img);
  } else if (row.kind === 'asset') {
    const a = await db.prepare("SELECT id, provenance FROM assets WHERE id = ? AND status = 'committed'").bind(row.ref).first();
    if (!a) return null;
    url = assetUrl(a.id, 'display', true); thumbUrl = assetUrl(a.id, 'thumb', true); provenance = a.provenance;
  } else {
    const v = await db.prepare("SELECT asset_id FROM image_versions WHERE id = ? AND status != 'deleted'").bind(row.ref).first();
    if (!v) return null;
    url = assetUrl(v.asset_id, 'display', true); thumbUrl = assetUrl(v.asset_id, 'thumb', true); provenance = 'approved_concept';
  }
  const stale = row.kind === 'version' && fp != null && !!row.inventory_fingerprint && row.inventory_fingerprint !== fp;
  return {
    compartmentId: row.compartment_id, revision: row.revision, kind: row.kind, ref: row.ref, url, thumbUrl, provenance, stale,
    previous: parseJson(row.previous, null),
  };
}

async function mainFor(db, compId, doc) {
  const row = await db.prepare('SELECT * FROM main_images WHERE compartment_id = ?').bind(compId).first();
  return row ? toMainImage(db, row, await currentFingerprint(doc, compId)) : null;
}

/** GET /api/public/main-images → {mainImages: {[compId]: MainImage}} (only compartments with a main_images row). */
export async function getMainImages({ db }) {
  const loaded = await loadPlannerDoc(db);
  const { results } = await db.prepare('SELECT * FROM main_images').all();
  const out = {};
  for (const row of results || []) {
    if (!COMPARTMENT_IDS.includes(row.compartment_id)) continue;
    const m = await toMainImage(db, row, await currentFingerprint(loaded?.doc, row.compartment_id));
    if (m) out[row.compartment_id] = m;
  }
  return json({ mainImages: out });
}

/** GET /api/public/compartments/:compId/gallery */
export async function getPublicGallery({ db, params }) {
  const compId = requireCompartment(params.compId);
  const loaded = await loadPlannerDoc(db);
  const { results } = await db.prepare(
    "SELECT * FROM assets WHERE compartment_id = ? AND status = 'committed' AND visibility = 'public' ORDER BY created_at, id",
  ).bind(compId).all();
  return json({
    compartmentId: compId,
    main: await mainFor(db, compId, loaded?.doc),
    items: [...presetsOf(compId).map(i => presetItem(compId, i)), ...(results || []).map(r => assetItem(r, true))],
  });
}

/** GET /api/compartments/:compId/gallery — adds private photos and draft/rejected versions. */
export async function getEditorGallery({ db, params }) {
  const compId = requireCompartment(params.compId);
  const loaded = await loadPlannerDoc(db);
  const { results: assets } = await db.prepare(
    "SELECT * FROM assets WHERE compartment_id = ? AND status = 'committed' AND category NOT IN ('markup', 'rendering') ORDER BY created_at, id",
  ).bind(compId).all();
  const { results: versions } = await db.prepare(
    "SELECT * FROM image_versions WHERE compartment_id = ? AND status IN ('draft','rejected') ORDER BY created_at, id",
  ).bind(compId).all();
  const fp = await currentFingerprint(loaded?.doc, compId);
  const { results: publicRenders } = await db.prepare(
    "SELECT * FROM assets WHERE compartment_id = ? AND status = 'committed' AND category = 'rendering' AND visibility = 'public' ORDER BY created_at, id",
  ).bind(compId).all();
  return json({
    compartmentId: compId,
    main: await mainFor(db, compId, loaded?.doc),
    items: [
      ...presetsOf(compId).map(i => presetItem(compId, i)),
      ...(assets || []).map(r => assetItem(r, r.visibility === 'public')),
      ...(publicRenders || []).map(r => assetItem(r, true)),
      ...(versions || []).map(v => ({
        id: v.id, kind: 'version', ref: v.id, versionId: v.id, assetId: v.asset_id, compartmentId: compId, status: v.status,
        title: 'AI concept', url: assetUrl(v.asset_id, 'display'), thumbUrl: assetUrl(v.asset_id, 'thumb'), provenance: 'ai_concept',
        stale: !!fp && v.inventory_fingerprint !== fp, createdAt: v.created_at,
      })),
    ],
  });
}

async function validateTarget(db, compId, kind, ref) {
  if (kind === 'preset') {
    if (!presetsOf(compId).some(i => i.src === ref)) throw new HttpError('INVALID_REQUEST', 'That image does not belong to this compartment.');
    return { fingerprint: null };
  }
  if (kind === 'asset') {
    const a = await db.prepare("SELECT * FROM assets WHERE id = ? AND status = 'committed'").bind(ref).first();
    if (!a || a.compartment_id !== compId || a.category === 'markup') throw new HttpError('INVALID_REQUEST', 'That photo does not belong to this compartment.');
    return { fingerprint: null, asset: a };
  }
  const v = await db.prepare('SELECT * FROM image_versions WHERE id = ?').bind(ref).first();
  if (!v || v.compartment_id !== compId || !['draft', 'approved'].includes(v.status)) throw new HttpError('INVALID_REQUEST', 'That version is not available for this compartment.');
  return { fingerprint: v.inventory_fingerprint, version: v };
}

/** Compare-and-set the main_images row plus conditional follow-up statements, all in one batch. */
async function writeMain(db, { compId, kind, ref, fingerprint, expect, current, actor, now, followUps, action }) {
  const me = actorLabel(actor);
  const same = current && current.kind === kind && current.ref === ref;
  const previous = same ? current.previous : current ? JSON.stringify({ kind: current.kind, ref: current.ref }) : null;
  const newRev = (current?.revision ?? 0) + 1;
  const cas = current
    ? db.prepare('UPDATE main_images SET revision = ?, kind = ?, ref = ?, inventory_fingerprint = ?, previous = ?, updated_by = ?, updated_at = ? WHERE compartment_id = ? AND revision = ?')
      .bind(newRev, kind, ref, fingerprint, previous, me, now, compId, expect)
    : db.prepare('INSERT INTO main_images (compartment_id, revision, kind, ref, inventory_fingerprint, previous, updated_by, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(compartment_id) DO NOTHING')
      .bind(compId, kind, ref, fingerprint, previous, me, now);
  const cond = 'SELECT 1 FROM main_images WHERE compartment_id = ? AND revision = ? AND updated_at = ? AND ref = ?';
  const condArgs = [compId, newRev, now, ref];
  await db.batch([
    cas,
    ...followUps(cond, condArgs),
    auditIfExists(db, { actor: me, action, entityType: 'main_image', entityId: compId, detail: { kind, ref, revision: newRev } }, now, cond, condArgs),
  ]);
  const after = await db.prepare('SELECT * FROM main_images WHERE compartment_id = ?').bind(compId).first();
  if (!after || after.revision !== newRev || after.ref !== ref) {
    throw new HttpError('REVISION_CONFLICT', 'The main image was changed by someone else. Reload and try again.');
  }
  return after;
}

function readExpect(body, current) {
  const expect = body.expectRevision ?? (current ? undefined : 0);
  if (current && !Number.isInteger(expect)) throw new HttpError('INVALID_REQUEST', 'expectRevision is required.');
  if (current && expect !== current.revision) throw new HttpError('REVISION_CONFLICT', 'The main image was changed by someone else. Reload and try again.');
  if (!current && expect !== undefined && expect !== 0) throw new HttpError('REVISION_CONFLICT', 'The main image was changed by someone else. Reload and try again.');
  return expect;
}

/** POST /api/compartments/:compId/main-image — body {kind, ref, expectRevision, acknowledgeStale}. */
export async function setMainImage({ request, db, actor, params, now }) {
  const compId = requireCompartment(params.compId);
  const body = await readJson(request);
  if (!MAIN_IMAGE_KINDS.includes(body.kind) || typeof body.ref !== 'string' || !body.ref) throw new HttpError('INVALID_REQUEST', 'kind and ref are required.');
  const target = await validateTarget(db, compId, body.kind, body.ref);
  const current = await db.prepare('SELECT * FROM main_images WHERE compartment_id = ?').bind(compId).first();
  const expect = readExpect(body, current);
  if (body.kind === 'version') {
    const loaded = await loadPlannerDoc(db);
    const fp = await currentFingerprint(loaded?.doc, compId);
    if (fp && target.fingerprint !== fp && body.acknowledgeStale !== true) {
      throw new HttpError('STALE_SOURCE', 'The equipment assignments changed since this image was generated. Approve anyway or regenerate.', { current: fp, version: target.fingerprint });
    }
  }
  const me = actorLabel(actor);
  const after = await writeMain(db, {
    compId, kind: body.kind, ref: body.ref, fingerprint: target.fingerprint, expect, current, actor, now, action: 'main_image.set',
    followUps: (cond, condArgs) => {
      const out = [];
      if (target.version) {
        out.push(db.prepare(`UPDATE image_versions SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND EXISTS (${cond})`)
          .bind(me, now, now, target.version.id, ...condArgs));
        out.push(db.prepare(`UPDATE assets SET visibility = 'public', provenance = 'approved_concept', updated_at = ? WHERE id = ? AND EXISTS (${cond})`)
          .bind(now, target.version.asset_id, ...condArgs));
      } else if (target.asset) {
        out.push(db.prepare(`UPDATE assets SET visibility = 'public', updated_at = ? WHERE id = ? AND EXISTS (${cond})`).bind(now, target.asset.id, ...condArgs));
      }
      return out;
    },
  });
  const loaded = await loadPlannerDoc(db);
  return json({ main: await toMainImage(db, after, await currentFingerprint(loaded?.doc, compId)) });
}

/** POST /api/compartments/:compId/main-image/restore — swaps current and previous. Body {expectRevision}. */
export async function restorePreviousMainImage({ request, db, actor, params, now }) {
  const compId = requireCompartment(params.compId);
  const body = await readJson(request);
  const current = await db.prepare('SELECT * FROM main_images WHERE compartment_id = ?').bind(compId).first();
  const prev = parseJson(current?.previous, null);
  if (!current || !prev) throw new HttpError('CONFLICT', 'There is no previous main image to restore.');
  readExpect(body, current);
  let target;
  try { target = await validateTarget(db, compId, prev.kind, prev.ref); } catch {
    throw new HttpError('CONFLICT', 'The previous main image is no longer available.');
  }
  const after = await writeMain(db, {
    compId, kind: prev.kind, ref: prev.ref, fingerprint: target.fingerprint, expect: current.revision, current, actor, now,
    action: 'main_image.restore', followUps: () => [],
  });
  const loaded = await loadPlannerDoc(db);
  return json({ main: await toMainImage(db, after, await currentFingerprint(loaded?.doc, compId)) });
}
