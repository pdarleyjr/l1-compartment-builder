// Legacy KV -> D1/R2 migration (admin, idempotent, resumable; docs §12). KV is only ever read.
//   POST /api/admin/migrate-legacy  -> {done:false, next, remaining, processed} until every image is imported,
//                                      then {done:true, report}. Call again while done is false.
//   GET  /api/admin/migration-report -> {migrated, report}
// `next` = number of legacy images still to import; the client simply repeats the POST until done:true.
import { COMPARTMENT_IDS } from '../../shared/contracts.js';
import { COMPARTMENTS } from '../../shared/apparatus.js';
import { newId } from '../../shared/ids.js';
import { emptyDocV2, migrateV1toV2, projectV1 } from '../../shared/planner.js';
import { auditStatement } from './audit.js';
import { actorLabel, HttpError, json } from './http.js';
import { readKvJson } from './kv-legacy.js';

const CHUNK_IMAGES = 6;
const CHUNK_BYTES = 12_000_000;
const META_NAME = 'legacy-migration';
const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Detect image type from magic bytes. @returns {{ext:string, type:string}|null} */
export function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

function decodeDataUrl(dataUrl) {
  const m = typeof dataUrl === 'string' ? DATA_URL_RE.exec(dataUrl) : null;
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const kind = sniffImage(bytes);
    return kind ? { bytes, ...kind } : null;
  } catch {
    return null;
  }
}

/** Counts used for the before/after report; works on a v1 view. */
export function countPlanner(v1) {
  const allocations = v1?.allocations && typeof v1.allocations === 'object' ? v1.allocations : {};
  const names = new Set();
  let occupiedSlots = 0;
  for (const slots of Object.values(allocations)) {
    for (const s of Array.isArray(slots) ? slots : []) if (typeof s === 'string' && s !== '') { occupiedSlots++; names.add(s); }
  }
  for (const t of Array.isArray(v1?.customTools) ? v1.customTools : []) if (t?.name) names.add(t.name);
  const bundles = Object.values(v1?.bundles && typeof v1.bundles === 'object' ? v1.bundles : {})
    .reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  return { compartments: Object.keys(allocations).length, occupiedSlots, equipment: names.size, bundles };
}

async function backupKv(env, key, doc, now) {
  if (!doc) return { key, status: 'absent' };
  const hash = await sha256Hex(doc.text);
  const listing = await env.ASSETS.list({ prefix: 'backups/kv/', include: ['customMetadata'] });
  const exists = (listing.objects ?? []).some(o => o.key.endsWith(`/${key}.json`) && o.customMetadata?.sha256 === hash);
  if (exists) return { key, status: 'exists', sha256: hash };
  const r2Key = `backups/kv/${new Date(now).toISOString()}/${key}.json`;
  await env.ASSETS.put(r2Key, doc.text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: hash } });
  return { key, status: 'written', r2Key, sha256: hash };
}

async function seedAdmins(db, env, now) {
  const existing = await db.prepare("SELECT 1 AS x FROM settings WHERE key = 'access.admins'").first();
  if (existing) return false;
  const owners = String(env.OWNER_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!owners.length) return false;
  const value = JSON.stringify(owners);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO settings (key, value, revision, updated_by, updated_at) VALUES ('access.admins', ?, 1, 'migration', ?)").bind(value, now),
    db.prepare("INSERT OR IGNORE INTO settings_history (key, revision, value, updated_by, updated_at) VALUES ('access.admins', 1, ?, 'migration', ?)").bind(value, now),
  ]);
  return true;
}

async function importImages(env, images, now) {
  const db = env.DB;
  const { results } = await db.prepare('SELECT legacy_uid FROM assets WHERE legacy_uid IS NOT NULL').all();
  const have = new Set((results ?? []).map(r => r.legacy_uid));
  const todo = [];
  const skipped = [];
  for (const [compId, list] of Object.entries(images?.uploadedImages ?? {})) {
    for (const img of Array.isArray(list) ? list : []) {
      if (!COMPARTMENT_IDS.includes(compId) || typeof img?.uid !== 'string' || !img.uid) { skipped.push({ compId, uid: img?.uid ?? null, reason: 'invalid entry' }); continue; }
      if (!have.has(img.uid)) todo.push({ compId, img });
    }
  }
  let processed = 0;
  let bytesDone = 0;
  let remaining = todo.length;
  for (const { compId, img } of todo) {
    if (processed >= CHUNK_IMAGES || bytesDone >= CHUNK_BYTES) break;
    remaining--;
    const decoded = decodeDataUrl(img.dataUrl);
    if (!decoded) { skipped.push({ compId, uid: img.uid, reason: 'not a valid image data URL' }); continue; }
    processed++;
    bytesDone += decoded.bytes.length;
    const assetId = newId('ast');
    const key = `assets/${compId}/${assetId}/original.${decoded.ext}`;
    await env.ASSETS.put(key, decoded.bytes, { httpMetadata: { contentType: decoded.type } });
    const title = typeof img.title === 'string' && img.title ? img.title : (typeof img.fileName === 'string' ? img.fileName : null);
    const res = await db.prepare(
      `INSERT OR IGNORE INTO assets (id, compartment_id, category, provenance, status, visibility, title, bytes, sha256,
         original_key, original_type, display_key, thumb_key, variants_ready, legacy_uid, created_by, created_at, updated_at, committed_at, revision)
       VALUES (?, ?, 'legacy_upload', 'legacy_upload', 'committed', 'public', ?, ?, ?, ?, ?, ?, ?, '["original","display","thumb"]', ?, 'migration', ?, ?, ?, 1)`,
    ).bind(assetId, compId, title, decoded.bytes.length, await sha256Hex(decoded.bytes), key, decoded.type, key, key, img.uid, now, now, now).run();
    if (!res?.meta?.changes) await env.ASSETS.delete(key); // lost a race with a parallel run
  }
  return { remaining, processed, skipped };
}

async function importFeatured(db, images, now) {
  const skipped = [];
  for (const [compId, f] of Object.entries(images?.featuredImages ?? {})) {
    const comp = COMPARTMENTS.find(c => c.id === compId);
    let ref = null;
    let kind = null;
    if (comp && f?.kind === 'preset' && comp.images.some(i => i.src === f.src)) { kind = 'preset'; ref = f.src; }
    else if (comp && f?.kind === 'uploaded') {
      const a = await db.prepare('SELECT id FROM assets WHERE legacy_uid = ?').bind(f.uid).first();
      if (a) { kind = 'asset'; ref = a.id; }
    }
    if (!kind) { skipped.push({ compId, reason: 'featured image not resolvable' }); continue; }
    await db.prepare(
      "INSERT OR IGNORE INTO main_images (compartment_id, revision, kind, ref, inventory_fingerprint, previous, updated_by, updated_at) VALUES (?, 1, ?, ?, NULL, NULL, 'migration', ?)",
    ).bind(compId, kind, ref, now).run();
  }
  return skipped;
}

/** POST /api/admin/migrate-legacy */
export async function migrateLegacy(ctx) {
  const { env, db, now, actor } = ctx;
  if (!env.L1_STATE || !env.ASSETS) throw new HttpError('INTERNAL', 'Storage bindings are not configured.');
  const allocations = await readKvJson(env, 'allocations');
  const images = await readKvJson(env, 'images');

  const backups = [await backupKv(env, 'allocations', allocations, now), await backupKv(env, 'images', images, now)];

  const hasDoc = await db.prepare("SELECT 1 AS x FROM planner_doc WHERE id = 'main'").first();
  if (!hasDoc) {
    const v1 = allocations ? structuredClone(allocations.value) : null;
    if (v1) delete v1._serverTs;
    const doc = v1 ? (await migrateV1toV2(v1)).doc : emptyDocV2();
    await db.prepare("INSERT OR IGNORE INTO planner_doc (id, revision, doc, updated_at, updated_by) VALUES ('main', 1, ?, ?, 'migration')")
      .bind(JSON.stringify(doc), now).run();
  }
  const adminsSeeded = await seedAdmins(db, env, now);
  const chunk = await importImages(env, images?.value, now);
  if (chunk.remaining > 0) return json({ done: false, next: chunk.remaining, remaining: chunk.remaining, processed: chunk.processed });

  const featuredSkipped = await importFeatured(db, images?.value, now);
  const docRow = await db.prepare("SELECT doc FROM planner_doc WHERE id = 'main'").first();
  const uploadedBefore = Object.values(images?.value?.uploadedImages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  const report = {
    done: true,
    ranAt: now,
    before: {
      ...countPlanner(allocations?.value), uploadedImages: uploadedBefore,
      featured: Object.keys(images?.value?.featuredImages ?? {}).length,
    },
    after: {
      ...countPlanner(docRow ? projectV1(JSON.parse(docRow.doc)) : null),
      uploadedImages: (await db.prepare("SELECT COUNT(*) AS n FROM assets WHERE legacy_uid IS NOT NULL AND status = 'committed'").first()).n,
      featured: (await db.prepare('SELECT COUNT(*) AS n FROM main_images').first()).n,
    },
    skipped: [...chunk.skipped, ...featuredSkipped],
    backups,
    adminsSeeded,
  };
  await db.batch([
    db.prepare('INSERT OR REPLACE INTO migrations_meta (name, ran_at, report) VALUES (?, ?, ?)').bind(META_NAME, now, JSON.stringify(report)),
    auditStatement(db, { actor: actorLabel(actor), action: 'migration.legacy', entityType: 'migration', entityId: META_NAME, detail: { before: report.before, after: report.after } }, now),
  ]);
  return json({ done: true, report });
}

/** GET /api/admin/migration-report */
export async function report(ctx) {
  const row = await ctx.db.prepare('SELECT ran_at, report FROM migrations_meta WHERE name = ?').bind(META_NAME).first();
  return json({ migrated: Boolean(row), ranAt: row?.ran_at ?? null, report: row ? JSON.parse(row.report) : null });
}
