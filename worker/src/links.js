// Asset ↔ inventory links: atomic replace of the confirmed set, and confirm/reject of recognition suggestions.
import { LINK_STATES } from '../../shared/contracts.js';
import { validateLinks } from '../../shared/validation.js';
import { HttpError, actorLabel, json, readJson } from './http.js';
import { auditStatement } from './audit.js';
import { assetDto, changes, linkDto, linksFor, requireCommittedAsset, validated } from './studio/common.js';
import { linkInsertStatements, resolveLinks, resolvePlannerContext } from './studio/link-logic.js';

/** POST /api/assets/:assetId/links — body {links, plannerOps?, baseRevision?}; replaces the confirmed link set. */
export async function putLinks({ request, db, actor, params, now }) {
  const body = await readJson(request);
  const asset = await requireCommittedAsset(db, params.assetId);
  const input = validated(validateLinks(body));
  const ctx = await resolvePlannerContext(db, {
    ops: input.plannerOps, baseRevision: input.baseRevision, clientOpId: `links:${asset.id}:${now}`, actor, now,
  });
  const rows = await resolveLinks(db, { doc: ctx.doc, compId: asset.compartment_id, links: input.links });
  await db.batch([
    ...ctx.statements,
    db.prepare("DELETE FROM asset_links WHERE asset_id = ? AND state = 'confirmed'").bind(asset.id),
    ...linkInsertStatements(db, asset.id, rows, actor, now),
    auditStatement(db, { actor: actorLabel(actor), action: 'asset.links.replace', entityType: 'asset', entityId: asset.id, detail: { links: rows.length } }, now),
  ]);
  const out = { asset: assetDto(asset, { links: (await linksFor(db, [asset.id])).get(asset.id) }) };
  out.links = out.asset.links;
  if (ctx.revision != null) out.plannerRevision = ctx.revision;
  return json(out);
}

/** PATCH /api/links/:linkId — body {state:'confirmed'|'rejected', quantity?, region?}. Confirming validates like putLinks. */
export async function updateLink({ request, db, actor, params, now }) {
  const body = await readJson(request);
  if (!LINK_STATES.includes(body.state) || body.state === 'suggested') throw new HttpError('INVALID_REQUEST', 'state must be "confirmed" or "rejected".');
  const link = await db.prepare('SELECT * FROM asset_links WHERE id = ?').bind(params.linkId).first();
  if (!link) throw new HttpError('NOT_FOUND', 'Link not found.');
  const asset = await requireCommittedAsset(db, link.asset_id);
  const me = actorLabel(actor);
  let quantity = link.quantity;
  let region = link.region;
  let equipmentId = link.equipment_id;
  if (body.state === 'confirmed') {
    const merged = {
      targetType: link.target_type, targetId: link.target_id,
      quantity: body.quantity ?? link.quantity,
      region: body.region !== undefined ? body.region : (link.region ? JSON.parse(link.region) : null),
    };
    const loaded = await resolvePlannerContext(db, { ops: [], actor, now });
    const [row] = await resolveLinks(db, { doc: loaded.doc, compId: asset.compartment_id, links: [merged] });
    quantity = row.quantity; region = row.region ? JSON.stringify(row.region) : null; equipmentId = row.equipmentId ?? equipmentId;
  }
  const res = await db.prepare('UPDATE asset_links SET state = ?, quantity = ?, region = ?, equipment_id = ?, updated_at = ? WHERE id = ?')
    .bind(body.state, quantity, region, equipmentId, now, link.id).run();
  if (!changes(res)) throw new HttpError('NOT_FOUND', 'Link not found.');
  await auditStatement(db, { actor: me, action: `link.${body.state}`, entityType: 'asset_link', entityId: link.id, detail: { assetId: asset.id } }, now).run();
  const fresh = await db.prepare('SELECT * FROM asset_links WHERE id = ?').bind(link.id).first();
  return json({ link: linkDto(fresh) });
}
