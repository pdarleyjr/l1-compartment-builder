// Legacy hostname (*.workers.dev): read-only v1 projections for old open tabs; every write answers 409 APP_UPDATED.
// Keeps the old CORS policy so old tabs can read the 409 body. Never writes KV.
import { projectV1 } from '../../shared/planner.js';
import { readKvText } from './kv-legacy.js';

const ALLOWED_ORIGINS = new Set([
  'https://l1.mbfdhub.com',
  'https://l1-compartment-builder.pages.dev',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
]);
const DEFAULT_PUBLIC_ORIGIN = 'https://l1.mbfdhub.com';

/** CORS + baseline headers for the legacy hostname (unchanged policy from the pre-Studio Worker). */
export function getCorsHeaders(origin = '') {
  const isPagesPreview = /^https:\/\/[a-z0-9-]+\.l1-compartment-builder\.pages\.dev$/i.test(origin);
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) || isPagesPreview ? origin : undefined;
  return {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
}

const KNOWN = {
  '/state': ['GET', 'PUT'],
  '/images': ['GET', 'PUT'],
  '/generate-image': ['POST'],
};

const jsonResponse = (body, status, headers) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
});

async function readState(env) {
  const row = env.DB ? await env.DB.prepare("SELECT revision, doc, updated_at FROM planner_doc WHERE id = 'main'").first() : null;
  if (row) return JSON.stringify({ ...projectV1(JSON.parse(row.doc)), _serverTs: row.updated_at });
  return (await readKvText(env, 'allocations')) ?? 'null';
}

async function isImagesMigrated(env) {
  const row = env.DB && await env.DB.prepare("SELECT report FROM migrations_meta WHERE name = 'legacy-migration'").first();
  if (!row) return false;
  try { return JSON.parse(row.report)?.done === true; } catch { return false; }
}

async function readImages(env) {
  if (!(await isImagesMigrated(env))) return (await readKvText(env, 'images')) ?? 'null';
  const base = String(env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, '');
  const { results } = await env.DB.prepare(
    `SELECT id, compartment_id, title, legacy_uid FROM assets
     WHERE status = 'committed' AND visibility = 'public' AND legacy_uid IS NOT NULL AND deleted_at IS NULL
     ORDER BY created_at, id`).all();
  const uploadedImages = {};
  const uidByAsset = new Map();
  for (const r of results ?? []) {
    (uploadedImages[r.compartment_id] ??= []).push({
      uid: r.legacy_uid, title: r.title ?? undefined, dataUrl: `${base}/api/public/assets/${r.id}/display`,
    });
    uidByAsset.set(r.id, r.legacy_uid);
  }
  const featuredImages = {};
  const mains = await env.DB.prepare('SELECT compartment_id, kind, ref FROM main_images').all();
  for (const m of mains.results ?? []) {
    if (m.kind === 'preset') { featuredImages[m.compartment_id] = { kind: 'preset', src: m.ref }; continue; }
    if (m.kind === 'asset' && uidByAsset.has(m.ref)) { featuredImages[m.compartment_id] = { kind: 'uploaded', uid: uidByAsset.get(m.ref) }; continue; }
    // Studio images (a user photo or an approved AI version) have no legacy uid: project them as an uploaded image whose
    // uid is the asset id, so an old open tab still shows the current main image.
    const assetId = m.kind === 'version'
      ? (await env.DB.prepare("SELECT asset_id FROM image_versions WHERE id = ? AND status != 'deleted'").bind(m.ref).first())?.asset_id
      : m.ref;
    const a = assetId && await env.DB.prepare("SELECT id, title FROM assets WHERE id = ? AND status = 'committed' AND visibility = 'public' AND deleted_at IS NULL").bind(assetId).first();
    if (!a) continue;
    (uploadedImages[m.compartment_id] ??= []).push({ uid: a.id, title: a.title ?? undefined, dataUrl: `${base}/api/public/assets/${a.id}/display` });
    featuredImages[m.compartment_id] = { kind: 'uploaded', uid: a.id };
  }
  return JSON.stringify({ uploadedImages, featuredImages });
}

/** Handle one request on the legacy hostname. */
export async function handleLegacy(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const cors = getCorsHeaders(origin);
  const isMutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
  if ((origin && !cors['Access-Control-Allow-Origin']) || (isMutation && !cors['Access-Control-Allow-Origin'])) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
  }
  const { pathname } = new URL(request.url);
  const methods = KNOWN[pathname];
  if (!methods) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404, cors);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET' && pathname !== '/generate-image') {
    try {
      const text = pathname === '/state' ? await readState(env) : await readImages(env);
      return jsonResponse(text, 200, cors);
    } catch {
      return jsonResponse({ error: { code: 'INTERNAL', message: 'Something went wrong.' } }, 500, cors);
    }
  }
  if (methods.includes(request.method)) {
    return jsonResponse({ error: { code: 'APP_UPDATED', message: 'This page is out of date. Reload to continue.' } }, 409, cors);
  }
  return jsonResponse({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405, { ...cors, Allow: [...methods, 'OPTIONS'].join(', ') });
}
