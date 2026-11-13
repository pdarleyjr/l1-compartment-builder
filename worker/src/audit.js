// Append-only audit log (owner after P0: part E1; `auditStatement`/`audit` signatures are a contract for E2).
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