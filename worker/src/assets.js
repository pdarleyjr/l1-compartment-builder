// Asset upload lifecycle, serving and library endpoints (architecture §5, §6).
import { ASSET_LIMITS, ASSET_VARIANTS, ID_PREFIX, UPLOAD_MIME, USER_ASSET_CATEGORIES } from '../../shared/contracts.js';
import { newId, sha256Hex } from '../../shared/ids.js';
import { validateAssetCreate, validateAssetUpdate, validateLinks } from '../../shared/validation.js';
import { HttpError, SECURITY_HEADERS, actorLabel, errorResponse, json, readBytes, readJson } from './http.js';
import { auditStatement } from './audit.js';
import { sniffImage, TYPE_BY_EXT } from './media.js';
import {
  assetDto, assetUrl, auditIfChanged, changes, linksFor, ownerOrAdmin, parseJson, requireCompartment, requireVariant, validated,
} from './studio/common.js';
import { linkInsertStatements, resolveLinks, resolvePlannerContext } from './studio/link-logic.js';

const MAX_BY_VARIANT = { original: ASSET_LIMITS.originalMaxBytes, display: ASSET_LIMITS.displayMaxBytes, thumb: ASSET_LIMITS.thumbMaxBytes };
const KEY_COL = { original: 'original_key', display: 'display_key', thumb: 'thumb_key' };

/** R2 object key for one variant. */
export const variantKey = (compId, assetId, variant, ext) => `assets/${compId}/${assetId}/${variant}.${ext}`;

async function loadAsset(db, id) {
  const row = await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError('NOT_FOUND', 'Photo not found.');
  return row;
}

const uploadUrls = id => Object.fromEntries(ASSET_VARIANTS.map(v => [v, assetUrl(id, v)]));

/** POST /api/assets */
export async function createAsset({ request, db, actor, now }) {
  const body = await readJson(request);
  const v = validated(validateAssetCreate(body));
  requireCompartment(v.compartmentId);
  if (!USER_ASSET_CATEGORIES.includes(v.category) && v.category !== 'markup') {
    throw new HttpError('INVALID_REQUEST', 'Choose a photo category: compartment, tool, tool group, mount, arrangement or other.');
  }
  const me = actorLabel(actor);
  if (v.idempotencyKey) {
    const existing = await db.prepare('SELECT * FROM assets WHERE created_by = ? AND idempotency_key = ?').bind(me, v.idempotencyKey).first();
    if (existing) {
      if (existing.compartment_id !== v.compartmentId || existing.sha256 !== v.sha256) {
        throw new HttpError('CONFLICT', 'That upload key was already used for a different photo.');
      }
      return json({ asset: assetDto(existing), upload: uploadUrls(existing.id), replayed: true }, 201);
    }
  }
  const count = await db.prepare(
    "SELECT COUNT(*) AS n FROM assets WHERE compartment_id = ? AND status != 'deleted' AND category IN ('compartment','tool','tool_group','mount','arrangement','other')",
  ).bind(v.compartmentId).first();
  if ((count?.n ?? 0) >= ASSET_LIMITS.maxPerCompartment && v.category !== 'markup') {
    throw new HttpError('CONFLICT', `This compartment already has ${ASSET_LIMITS.maxPerCompartment} photos. Delete some before adding more.`);
  }
  const id = newId(ID_PREFIX.asset);
  const provenance = v.category === 'other' ? 'reference' : 'user_photo';
  await db.batch([
    db.prepare(
      `INSERT INTO assets (id, compartment_id, category, provenance, status, visibility, title, notes, width, height, bytes, sha256,
         idempotency_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'private', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, v.compartmentId, v.category, provenance, v.title ?? null, v.notes ?? null, v.width ?? null, v.height ?? null,
      v.bytes ?? null, v.sha256 ?? null, v.idempotencyKey ?? null, me, now, now),
    auditStatement(db, { actor: me, action: 'asset.create', entityType: 'asset', entityId: id, detail: { compartmentId: v.compartmentId, category: v.category } }, now),
  ]);
  return json({ asset: assetDto(await loadAsset(db, id)), upload: uploadUrls(id) }, 201);
}

/** PUT /api/assets/:assetId/:variant — raw image bytes, verified by magic bytes, size and (original) sha256. */
export async function putVariant({ request, env, db, actor, params, now }) {
  const variant = requireVariant(params.variant);
  const asset = await loadAsset(db, params.assetId);
  ownerOrAdmin(actor, asset.created_by, 'upload');
  if (asset.status !== 'pending') throw new HttpError('CONFLICT', 'This photo is already saved; its files cannot change.');
  const ct = request.headers.get('Content-Type');
  if (ct && !/^image\//i.test(ct)) throw new HttpError('UNSUPPORTED_MEDIA', 'Only JPEG, PNG or WebP images can be uploaded.');
  const bytes = await readBytes(request, MAX_BY_VARIANT[variant]);
  if (!bytes.length) throw new HttpError('INVALID_REQUEST', 'The upload was empty.');
  const sniff = sniffImage(bytes);
  if (!sniff || !UPLOAD_MIME[variant].includes(sniff.type)) {
    throw new HttpError('UNSUPPORTED_MEDIA', variant === 'original'
      ? 'Only JPEG, PNG or WebP images can be uploaded (convert HEIC photos first).'
      : 'Display and thumbnail images must be WebP or JPEG.');
  }
  if (variant === 'original' && asset.sha256 && (await sha256Hex(bytes)) !== asset.sha256) {
    throw new HttpError('INVALID_REQUEST', 'The upload does not match its checksum. Please retry the upload.');
  }
  const key = variantKey(asset.compartment_id, asset.id, variant, sniff.ext);
  const oldKey = asset[KEY_COL[variant]];
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: sniff.type } });
  if (oldKey && oldKey !== key) await env.ASSETS.delete(oldKey);
  const ready = new Set(parseJson(asset.variants_ready, []));
  ready.add(variant);
  const original = variant === 'original';
  const res = await db.prepare(
    `UPDATE assets SET ${KEY_COL[variant]} = ?, variants_ready = ?, updated_at = ?${original ? ', original_type = ?, bytes = ?, width = ?, height = ?' : ''}
     WHERE id = ? AND status = 'pending'`,
  ).bind(key, JSON.stringify([...ready]), now, ...(original ? [sniff.type, bytes.length, sniff.width, sniff.height] : []), asset.id).run();
  if (!changes(res)) throw new HttpError('CONFLICT', 'This photo is no longer accepting uploads.');
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

async function linkInput(body) {
  if (body.links === undefined) return [];
  const v = validated(validateLinks(Array.isArray(body.links) ? body.links : body.links));
  return Array.isArray(v) ? v : v.links ?? [];
}

/** POST /api/assets/:assetId/commit — links and planner ops apply in one D1 batch with the status flip. */
export async function commitAsset({ request, db, actor, params, now }) {
  const body = await readJson(request);
  const asset = await loadAsset(db, params.assetId);
  ownerOrAdmin(actor, asset.created_by, 'upload');
  if (asset.status === 'deleted') throw new HttpError('NOT_FOUND', 'Photo not found.');
  if (asset.status === 'committed') return json({ asset: assetDto(asset, { links: (await linksFor(db, [asset.id])).get(asset.id) }) });
  const ready = parseJson(asset.variants_ready, []);
  const missing = ASSET_VARIANTS.filter(v => !ready.includes(v));
  if (missing.length) throw new HttpError('CONFLICT', `Upload is not complete (missing: ${missing.join(', ')}).`, { missing });
  const links = await linkInput(body);
  const ctx = await resolvePlannerContext(db, {
    ops: body.plannerOps, baseRevision: body.baseRevision, clientOpId: `commit:${asset.id}`, actor, now,
  });
  const rows = await resolveLinks(db, { doc: ctx.doc, compId: asset.compartment_id, links });
  const me = actorLabel(actor);
  await db.batch([
    ...ctx.statements,
    db.prepare("UPDATE assets SET status = 'committed', committed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'pending'")
      .bind(now, now, asset.id),
    ...linkInsertStatements(db, asset.id, rows, actor, now),
    auditStatement(db, { actor: me, action: 'asset.commit', entityType: 'asset', entityId: asset.id, detail: { links: rows.length, plannerOps: body.plannerOps?.length ?? 0 } }, now),
  ]);
  const fresh = await loadAsset(db, asset.id);
  const out = { asset: assetDto(fresh, { links: (await linksFor(db, [asset.id])).get(asset.id) }) };
  if (ctx.revision != null) out.plannerRevision = ctx.revision;
  return json(out);
}

/** PATCH /api/assets/:assetId */
export async function updateAsset({ request, db, actor, params, now }) {
  const body = await readJson(request);
  const v = validated(validateAssetUpdate(body));
  const asset = await loadAsset(db, params.assetId);
  if (asset.status === 'deleted') throw new HttpError('NOT_FOUND', 'Photo not found.');
  if (!USER_ASSET_CATEGORIES.includes(asset.category)) throw new HttpError('FORBIDDEN', 'This image is managed by the Studio and cannot be edited here.');
  if (v.category !== undefined && !USER_ASSET_CATEGORIES.includes(v.category)) throw new HttpError('INVALID_REQUEST', 'Choose a valid photo category.');
  const expect = body.expectRevision ?? v.expectRevision;
  if (!Number.isInteger(expect)) throw new HttpError('INVALID_REQUEST', 'expectRevision is required.');
  const sets = [];
  const args = [];
  for (const [col, key] of [['title', 'title'], ['notes', 'notes'], ['category', 'category']]) {
    if (v[key] !== undefined) { sets.push(`${col} = ?`); args.push(v[key]); }
  }
  if (!sets.length) throw new HttpError('INVALID_REQUEST', 'Nothing to update.');
  const [res] = await db.batch([
    db.prepare(`UPDATE assets SET ${sets.join(', ')}, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status != 'deleted'`)
      .bind(...args, now, asset.id, expect),
    auditIfChanged(db, { actor: actorLabel(actor), action: 'asset.update', entityType: 'asset', entityId: asset.id, detail: { fields: Object.keys(v) } }, now),
  ]);
  if (!changes(res)) throw new HttpError('REVISION_CONFLICT', 'This photo was changed by someone else. Reload and try again.');
  const fresh = await loadAsset(db, asset.id);
  return json({ asset: assetDto(fresh, { links: (await linksFor(db, [asset.id])).get(asset.id) }) });
}

/** DELETE /api/assets/:assetId — soft delete (tombstone); the current main image cannot be deleted. */
export async function deleteAsset({ db, actor, params, now }) {
  const asset = await loadAsset(db, params.assetId);
  if (asset.status === 'deleted') return json({ ok: true });
  if (asset.category === 'rendering') throw new HttpError('CONFLICT', 'Delete AI images from the version history instead.');
  const main = await db.prepare(
    `SELECT m.compartment_id FROM main_images m WHERE (m.kind = 'asset' AND m.ref = ?)
       OR (m.kind = 'version' AND m.ref IN (SELECT id FROM image_versions WHERE asset_id = ?))`,
  ).bind(asset.id, asset.id).first();
  if (main) throw new HttpError('CONFLICT', 'This photo is the current main image. Choose another main image before deleting it.');
  const me = actorLabel(actor);
  await db.batch([
    db.prepare("UPDATE assets SET status = 'deleted', deleted_at = ?, deleted_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status != 'deleted'")
      .bind(now, me, now, asset.id),
    auditIfChanged(db, { actor: me, action: 'asset.delete', entityType: 'asset', entityId: asset.id }, now),
  ]);
  return json({ ok: true });
}

async function serve(env, asset, variant, headers) {
  const key = asset[KEY_COL[variant]];
  if (!key) throw new HttpError('NOT_FOUND', 'Image not available.');
  const obj = await env.ASSETS.get(key);
  if (!obj) throw new HttpError('NOT_FOUND', 'Image not available.');
  const type = obj.httpMetadata?.contentType || TYPE_BY_EXT[key.split('.').pop()] || 'application/octet-stream';
  return new Response(obj.body, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': type, ...headers } });
}

/** GET /api/assets/:assetId/:variant (editors; private, never cached) */
export async function getVariant({ env, db, params }) {
  const variant = requireVariant(params.variant);
  const asset = await loadAsset(db, params.assetId);
  if (asset.status === 'deleted') throw new HttpError('NOT_FOUND', 'Photo not found.');
  return serve(env, asset, variant, { 'Cache-Control': 'private, no-store' });
}

/** GET /api/public/assets/:assetId/:variant — only public + committed assets, immutable caching. */
export async function getPublicVariant({ request, env, db, params }) {
  const variant = requireVariant(params.variant);
  const asset = await db.prepare("SELECT * FROM assets WHERE id = ? AND status = 'committed' AND visibility = 'public'").bind(params.assetId).first();
  if (!asset) return errorResponse('NOT_FOUND', 'Image not found.');
  const etag = `"${asset.id}-${variant}-${asset.committed_at ?? 0}"`;
  const headers = { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...SECURITY_HEADERS, ...headers } });
  return serve(env, asset, variant, headers);
}

/** GET /api/compartments/:compId/assets?category= */
export async function listAssets({ db, params, url }) {
  const compId = requireCompartment(params.compId);
  const category = url?.searchParams?.get('category');
  const where = ["compartment_id = ?", "status = 'committed'"];
  const args = [compId];
  if (category) { where.push('category = ?'); args.push(category); } else where.push("category NOT IN ('rendering','markup')");
  const { results } = await db.prepare(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`).bind(...args).all();
  const rows = results || [];
  const links = await linksFor(db, rows.map(r => r.id));
  return json({ assets: rows.map(r => assetDto(r, { links: links.get(r.id) })) });
}

