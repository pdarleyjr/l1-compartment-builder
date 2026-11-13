// D1 fake backed by node:sqlite. Applies worker/migrations/*.sql; D1-compatible result shapes; batch = transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const norm = v => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const returnsRows = sql => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params.map(norm)); }
  _rows() { return this.db.prepare(this.sql).all(...this.params).map(r => ({ ...r })); }
  _meta(changes = 0, rows = 0) { return { changes, last_row_id: 0, rows_read: rows, rows_written: changes, duration: 0, changed_db: changes > 0 }; }
  async first(col) {
    const row = this._rows()[0] ?? null;
    return col && row ? row[col] : row;
  }
  async all() {
    const results = this._rows();
    return { results, success: true, meta: this._meta(0, results.length) };
  }
  async raw() { return this._rows().map(r => Object.values(r)); }
  async run() { return this._exec(); }
  _exec() {
    if (returnsRows(this.sql) && !/\bRETURNING\b/i.test(this.sql)) {
      const results = this._rows();
      return { results, success: true, meta: this._meta(0, results.length) };
    }
    const stmt = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = stmt.all(...this.params).map(r => ({ ...r }));
      return { results, success: true, meta: this._meta(results.length) };
    }
    const info = stmt.run(...this.params);
    return { results: [], success: true, meta: this._meta(Number(info.changes)) };
  }
}

/** @returns {{prepare:Function, batch:Function, exec:Function, raw:DatabaseSync}} */
export function createD1() {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  return {
    raw,
    prepare: sql => new Statement(raw, sql),
    async exec(sql) { raw.exec(sql); return { count: 1, duration: 0 }; },
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const out = statements.map(s => s._exec());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    },
  };
}
