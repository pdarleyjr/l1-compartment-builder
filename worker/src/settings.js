// Admin-editable settings (revisioned, CAS-written, history + audit).
//
// Exports used by other parts:
//   getSetting(db, key)        -> value (SETTINGS_DEFAULTS applied when unset)
//   getSettings(db, keys?)     -> {key: value}  (all known keys when `keys` omitted)
// `getSettings` is ALSO the route handler for GET /api/admin/settings (ROUTES names it 'settings.getSettings'): when its
// first argument is a request ctx it returns the Response; when it is a D1 binding it returns the value map.
// Reads are cached 5 s per isolate per database and the cache is dropped after every write.
import { SETTINGS_DEFAULTS, SETTINGS_KEYS } from '../../shared/contracts.js';
import { validateSettingValue } from '../../shared/validation.js';
import { auditStatement } from './audit.js';
import { actorLabel, HttpError, json, readJson } from './http.js';

const CACHE_MS = 5000;
const cache = new WeakMap(); // db -> {at, rows: Map<key,{value,revision,updatedBy,updatedAt}>}
const isKnown = key => typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key);

/** Drop the per-isolate cache (after writes, and in tests). */
export function clearSettingsCache(db) {
  if (db) cache.delete(db);
}

async function loadRows(db, now = Date.now()) {
  const hit = cache.get(db);
  if (hit && now - hit.at < CACHE_MS && now >= hit.at) return hit.rows;
  const { results } = await db.prepare('SELECT key, value, revision, updated_by, updated_at FROM settings').all();
  const rows = new Map();
  for (const r of results ?? []) {
    try {
      rows.set(r.key, { value: JSON.parse(r.value), revision: r.revision, updatedBy: r.updated_by, updatedAt: r.updated_at });
    } catch { /* corrupt row: fall back to the default */ }
  }
  cache.set(db, { at: now, rows });
  return rows;
}

/** @returns {Promise<any>} the stored value or the SETTINGS_DEFAULTS entry */
export async function getSetting(db, key) {
  const rows = await loadRows(db);
  return rows.has(key) ? rows.get(key).value : structuredClone(SETTINGS_DEFAULTS[key]);
}

async function readSettingsMap(db, keys) {
  const rows = await loadRows(db);
  const out = {};
  for (const key of keys ?? SETTINGS_KEYS) out[key] = rows.has(key) ? rows.get(key).value : structuredClone(SETTINGS_DEFAULTS[key]);
  return out;
}

/** Dual-use, see file header. */
export async function getSettings(arg, keys) {
  if (typeof arg?.prepare === 'function') return readSettingsMap(arg, keys);
  const rows = await loadRows(arg.db);
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    const row = rows.get(key);
    settings[key] = row
      ? { value: row.value, revision: row.revision, updatedBy: row.updatedBy, updatedAt: row.updatedAt, isDefault: false }
      : { value: structuredClone(SETTINGS_DEFAULTS[key]), revision: 0, updatedBy: null, updatedAt: null, isDefault: true };
  }
  return json({ settings });
}

const isConstraint = err => /UNIQUE|constraint|PRIMARY KEY/i.test(String(err?.message ?? err));

/** PUT /api/admin/settings/:key  body {value, expectRevision} */
export async function putSetting(ctx) {
  const { db, params, actor, now } = ctx;
  const key = params.key;
  if (!isKnown(key)) throw new HttpError('NOT_FOUND', 'Unknown setting.');
  const body = await readJson(ctx.request, 200_000);
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectRevision) || body.expectRevision < 0 || !('value' in body)) {
    throw new HttpError('INVALID_REQUEST', 'Body must be {value, expectRevision}.');
  }
  const checked = validateSettingValue(key, body.value);
  if (!checked?.ok) throw new HttpError('INVALID_REQUEST', checked?.error || 'Invalid setting value.');
  const value = 'value' in checked ? checked.value : body.value;
  const serialized = JSON.stringify(value);

  const current = await db.prepare('SELECT revision FROM settings WHERE key = ?').bind(key).first();
  const currentRevision = current?.revision ?? 0;
  const conflict = () => new HttpError('REVISION_CONFLICT', 'This setting was changed by someone else. Reload and try again.', { currentRevision });
  if (currentRevision !== body.expectRevision) { clearSettingsCache(db); throw conflict(); }

  const revision = currentRevision + 1;
  const who = actorLabel(actor);
  const write = currentRevision === 0
    ? db.prepare('INSERT INTO settings (key, value, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)').bind(key, serialized, who, now)
    : db.prepare('UPDATE settings SET value = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE key = ? AND revision = ?')
      .bind(serialized, who, now, key, currentRevision);
  try {
    // The history primary key (key, revision) makes a lost CAS race abort the whole batch (rolled back).
    await db.batch([
      write,
      db.prepare('INSERT INTO settings_history (key, revision, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').bind(key, revision, serialized, who, now),
      auditStatement(db, { actor: who, action: 'settings.update', entityType: 'setting', entityId: key, detail: { revision } }, now),
    ]);
  } catch (err) {
    clearSettingsCache(db);
    if (isConstraint(err)) throw conflict();
    throw err;
  }
  clearSettingsCache(db);
  return json({ key, value, revision });
}

/** GET /api/admin/settings/:key/history?limit= */
export async function getHistory(ctx) {
  const { db, params, url } = ctx;
  if (!isKnown(params.key)) throw new HttpError('NOT_FOUND', 'Unknown setting.');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const { results } = await db.prepare(
    'SELECT revision, value, updated_by, updated_at FROM settings_history WHERE key = ? ORDER BY revision DESC LIMIT ?',
  ).bind(params.key, limit).all();
  const history = (results ?? []).map(r => ({ revision: r.revision, value: JSON.parse(r.value), updatedBy: r.updated_by, updatedAt: r.updated_at }));
  return json({ key: params.key, history });
}
