import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const db = this.db;
    return { bind(...args) {
      return {
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
      };
    } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const result = []; for (const stmt of statements) result.push(await stmt.run()); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
