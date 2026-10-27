import { DatabaseSync } from 'node:sqlite';
import { safePath } from '../paths.js';
import type { Message } from '../types.js';

export class Store {
  db: DatabaseSync;
  constructor(root: string, filename='fish.sqlite') {
    if(!/^[a-z-]+\.sqlite$/.test(filename))throw new Error('INVALID_DATABASE_NAME');
    this.db = new DatabaseSync(safePath(root, 'runtime/data/'+filename));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT,grp TEXT,usr TEXT,text TEXT,at INTEGER,mentioned INTEGER,event TEXT,PRIMARY KEY(grp,id));
      CREATE TABLE IF NOT EXISTS seen(grp TEXT,id TEXT,at INTEGER,PRIMARY KEY(grp,id));
      CREATE TABLE IF NOT EXISTS replies(grp TEXT,id TEXT,count INTEGER,at INTEGER,PRIMARY KEY(grp,id));
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,day TEXT,grp TEXT,usr TEXT,kind TEXT,input INTEGER,output INTEGER,ms INTEGER,state TEXT);
      CREATE TABLE IF NOT EXISTS image_jobs(codex_id TEXT PRIMARY KEY,image_id TEXT,day TEXT,spent_ms INTEGER,reset INTEGER);
      CREATE TABLE IF NOT EXISTS counters(day TEXT,scope TEXT,metric TEXT,value INTEGER,PRIMARY KEY(day,scope,metric));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER,kind TEXT,grp TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,grp TEXT,usr TEXT,request TEXT,brief TEXT,state TEXT,created INTEGER,started INTEGER,result TEXT,manifest TEXT,reservation TEXT,source TEXT);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,expires INTEGER,value TEXT);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string} | undefined)?.value; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value); }
  observe(m: Message, hours: number, max: number): boolean {
    return this.transaction(() => {
      const fresh = this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?)').run(m.group, m.id, Date.now()).changes;
      if (!fresh) return false;
      this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?)').run(m.id, m.group, m.user, redact(m.text).slice(0, 2000), m.at, Number(m.mentioned), m.event);
      this.prune(hours, max);
      return true;
    });
  }
  prune(hours: number, max: number): void {
    this.db.prepare('DELETE FROM messages WHERE at<?').run(Date.now() - hours * 3600000);
    this.db.prepare('DELETE FROM seen WHERE at<?').run(Date.now() - 86400000);
    this.db.prepare('DELETE FROM replies WHERE at<?').run(Date.now() - 300000);
    this.db.exec(`DELETE FROM messages WHERE rowid IN (SELECT rowid FROM (SELECT rowid,row_number() OVER (PARTITION BY grp ORDER BY at DESC,rowid DESC) AS rn FROM messages) WHERE rn>${Math.max(1, Math.min(100, Math.floor(max)))});
      DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 200);
      DELETE FROM cache WHERE expires<strftime('%s','now')*1000;
      UPDATE tasks SET request='',brief='',source='' WHERE created<(strftime('%s','now')-86400)*1000 AND state NOT IN ('running','waiting');
      UPDATE tasks SET state='cancelled',request='',brief='',source='',result='EXPIRED' WHERE created<(strftime('%s','now')-86400)*1000 AND state='waiting';`);
  }
  history(group: string, count: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE grp=? ORDER BY at DESC,rowid DESC LIMIT ?').all(group, count) as any[]).reverse().map(r => ({ id:r.id, group:r.grp, user:r.usr, text:r.text, at:r.at, mentioned:!!r.mentioned, event:r.event }));
  }
  clear(group: string): void { this.db.prepare('DELETE FROM messages WHERE grp=?').run(group); }
  audit(kind: string, group = '', detail = ''): void {
    this.db.prepare('INSERT INTO audit(at,kind,grp,detail) VALUES (?,?,?,?)').run(Date.now(), kind, group, redact(detail).slice(0, 1000));
    this.db.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 200)');
  }
  close(): void { this.db.close(); }
}
export function redact(text: string): string {
  return text.replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|app[_-]?secret|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
