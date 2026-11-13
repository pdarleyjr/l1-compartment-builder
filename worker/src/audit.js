// Append-only audit log (owner after P0: part E1; `auditStatement`/`audit` signatures are a contract for E2).
import { json } from './http.js';

const MAX_STRING = 500;

function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object' || depth > 4) return typeof value === 'object' ? '[truncated]' : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/key|secret|token|authorization|password|dataurl|bytes/i.test(k)) continue;
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/** Prepared statement for inclusion in a D1 batch. entry = {actor, action, entityType?, entityId?, detail?} */
export function auditStatement(db, entry, now = Date.now()) {
  return db
    .prepare('INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(now, entry.actor ?? null, entry.action, entry.entityType ?? null, entry.entityId ?? null,
      entry.detail === undefined ? null : JSON.stringify(redact(entry.detail)));
}

export async function audit(db, entry, now = Date.now()) {
  await auditStatement(db, entry, now).run();
}

/** GET /api/admin/audit?limit=&before=<id>&action=  (admin). Newest first. */
export async function listAudit(ctx) {
  const { db, url } = ctx;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const before = parseInt(url.searchParams.get('before') ?? '', 10);
  const action = url.searchParams.get('action');
  const where = [];
  const binds = [];
  if (Number.isFinite(before)) { where.push('id < ?'); binds.push(before); }
  if (action) { where.push('action = ?'); binds.push(action.slice(0, 100)); }
  const { results } = await db
    .prepare(`SELECT id, at, actor, action, entity_type, entity_id, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, limit).all();
  const entries = (results ?? []).map(r => ({
    id: r.id, at: r.at, actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
    detail: r.detail ? JSON.parse(r.detail) : null,
  }));
  return json({ entries });
}
