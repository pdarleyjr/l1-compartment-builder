// Test harness: env (D1 + R2), seeded planner doc, ctx builder and request helpers.
import { createD1 } from './d1.js';
import { createR2 } from './r2.js';

export const NOW = Date.UTC(2026, 10, 12, 15, 0, 0);
export const editor = (email = 'ed@mbfd.test') => ({ kind: 'user', email, roles: ['editor'] });
export const admin = (email = 'admin@mbfd.test') => ({ kind: 'user', email, roles: ['editor', 'admin'] });
export const service = () => ({ kind: 'service', serviceId: 'l1-image-processor' });

export const EQ = { spanner: 'eq_spanner0000000001', axe: 'eq_axe00000000000002', hose: 'eq_hose0000000000003' };

export function seedDoc() {
  const slots = n => Array.from({ length: n }, () => '');
  const doc = {
    schema: 2,
    allocations: { LS1: slots(15), LS2: slots(15) },
    assignmentIds: { LS1: Array(15).fill(null), LS2: Array(15).fill(null) },
    equipmentIds: { Spanner: EQ.spanner, Axe: EQ.axe, Hose: EQ.hose },
    bundles: { LS1: [{ id: 'bd_one', name: 'Forcible entry', colorIdx: 0, slotIndices: [0, 1] }] },
  };
  doc.allocations.LS1[0] = 'Spanner'; doc.assignmentIds.LS1[0] = 'as_ls1_s0';
  doc.allocations.LS1[1] = 'Spanner'; doc.assignmentIds.LS1[1] = 'as_ls1_s1';
  doc.allocations.LS1[2] = 'Axe'; doc.assignmentIds.LS1[2] = 'as_ls1_axe';
  doc.allocations.LS2[0] = 'Axe'; doc.assignmentIds.LS2[0] = 'as_ls2_axe';
  return doc;
}

export function makeEnv() {
  const db = createD1();
  const r2 = createR2();
  db.sqlite.prepare("INSERT INTO planner_doc (id, revision, doc, updated_at, updated_by) VALUES ('main', 1, ?, 0, 'seed')").run(JSON.stringify(seedDoc()));
  return { env: { DB: db, ASSETS: r2 }, db, r2 };
}

export function setSetting(db, key, value) {
  db.sqlite.prepare('INSERT OR REPLACE INTO settings (key, value, revision, updated_at) VALUES (?, ?, 1, 0)').run(key, JSON.stringify(value));
}

/** Build a ctx and invoke a handler. Handlers may throw HttpError; `call` converts to a Response like the router does. */
export async function call(handler, env, { method = 'GET', path = '/', body, raw, headers = {}, params = {}, actor = editor(), now = NOW, query = '' } = {}) {
  const h = { ...headers };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = h['Content-Type'] || 'application/json'; }
  const url = new URL(`https://l1.test/api${path}${query}`);
  const request = new Request(url, { method, headers: h, body: ['GET', 'HEAD'].includes(method) ? undefined : payload });
  try {
    return await handler({ request, env, params, url, actor, db: env.DB, now });
  } catch (err) {
    if (err?.name !== 'HttpError') throw err;
    const { errorResponse } = await import('../../../src/http.js');
    return errorResponse(err.code, err.message, err.details);
  }
}

export const jsonOf = async res => (res.status === 204 ? null : JSON.parse(await res.text()));

/** Insert a committed asset row (+ R2 objects) without going through the upload API. */
export function insertAsset(t, id, comp = 'LS1', o = {}) {
  const { category = 'tool', visibility = 'private', status = 'committed', provenance = 'user_photo', createdBy = 'ed@mbfd.test' } = o;
  t.db.sqlite.prepare(
    `INSERT INTO assets (id, compartment_id, category, provenance, status, visibility, title, original_key, display_key, thumb_key, variants_ready, created_by, created_at, updated_at, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '["original","display","thumb"]', ?, ?, ?, ?)`,
  ).run(id, comp, category, provenance, status, visibility, o.title ?? id, `assets/${comp}/${id}/original.png`, `assets/${comp}/${id}/display.webp`, `assets/${comp}/${id}/thumb.webp`, createdBy, o.createdAt ?? NOW - 1000, NOW, NOW);
  for (const [v, ext, type] of [['original', 'png', 'image/png'], ['display', 'webp', 'image/webp'], ['thumb', 'webp', 'image/webp']]) {
    t.r2.store.set(`assets/${comp}/${id}/${v}.${ext}`, { bytes: new Uint8Array([1, 2, 3]), httpMetadata: { contentType: type } });
  }
}

export function insertVersion(t, id, comp, assetId, o = {}) {
  t.db.sqlite.prepare(
    `INSERT INTO image_versions (id, compartment_id, parent_version_id, job_id, asset_id, spec, spec_hash, model, settings, inventory_fingerprint, status, cost_usd, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'h', 'gpt-image-2.6-flare', '{}', ?, ?, 0.1, 'ed@mbfd.test', ?, ?)`,
  ).run(id, comp, o.parent ?? null, o.jobId ?? `gj_${id}`, assetId, o.fingerprint ?? 'old-fp', o.status ?? 'draft', o.createdAt ?? NOW, NOW);
}
