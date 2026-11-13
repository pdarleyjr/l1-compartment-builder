// node:sqlite-backed D1 fake: applies worker/migrations/*.sql, supports bind/run/first/all/batch (transactional) and RETURNING.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  exec() {
    const s = this.db.sqlite.prepare(this.sql);
    const norm = this.args.map(a => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
    const results = s.all(...norm);
    const changes = this.db.sqlite.prepare('SELECT changes() AS c').get().c;
    return { results, success: true, meta: { changes: /^\s*(insert|update|delete)/i.test(this.sql) ? changes : 0 } };
  }
  async run() { return this.exec(); }
  async all() { return this.exec(); }
  async first() { return this.exec().results[0] ?? null; }
  async raw() { return this.exec().results.map(r => Object.values(r)); }
}

/** @returns {{prepare:Function, batch:Function, sqlite:DatabaseSync, failNextBatch:()=>void}} */
export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  const db = {
    sqlite,
    prepare: sql => new Stmt(db, sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map(s => s.exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    query: (sql, ...args) => sqlite.prepare(sql).all(...args),
    one: (sql, ...args) => sqlite.prepare(sql).get(...args),
  };
  return db;
}
