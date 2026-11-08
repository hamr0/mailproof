// The candidate trail index (POC). One SQLite file beside the trail, OUTSIDE git, a rebuildable cache of the
// records: rebuilt (or caught up) when the trail's git HEAD differs from the HEAD it was built from.
// Two engines behind one tiny adapter: 'node-sqlite' (node:sqlite DatabaseSync) and 'better-sqlite3'.
// Reuses the library's own listIds/readRecord (trail.js) and git() (git.js): no second reader of record files.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listIds, readRecord, RECORD_ID_RE } from '../../src/proof/trail.js';
import { git } from '../../src/proof/git.js';

export const SCHEMA = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rec(
  id TEXT PRIMARY KEY, captured TEXT NOT NULL, direction TEXT, live TEXT, portable TEXT,
  message_id TEXT, message_key TEXT, copy_kind TEXT, body_status TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS att(att_key TEXT NOT NULL, rec_id TEXT NOT NULL, PRIMARY KEY(att_key, rec_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rec_cap ON rec(captured);
CREATE INDEX IF NOT EXISTS rec_dir_cap ON rec(direction, captured);
CREATE INDEX IF NOT EXISTS rec_key ON rec(message_key, captured);
CREATE INDEX IF NOT EXISTS rec_mid ON rec(message_id, captured);
`;

/** Open `file` with the named engine; returns { exec, prepare, close } (prepare(sql) -> { run, get, all }). */
export async function openDb(engine, file) {
  let db;
  if (engine === 'node-sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(file);
  } else if (engine === 'better-sqlite3') {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    db = new Database(file);
  } else throw new Error('unknown engine ' + engine);
  // same pragmas for both: rebuildable cache, so durability is traded for speed (as litectx does)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;');
  db.exec(DDL);
  return db;
}

const idxFile = (trailDir, trail, engine) => path.join(trailDir, `.${trail}.index.${engine}.sqlite`);
export { idxFile };

export async function headOf(root) { return git(root, ['rev-parse', 'HEAD']); }

function stmts(db) {
  return {
    putRec: db.prepare('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?,?,?,?,?)'),
    delAtt: db.prepare('DELETE FROM att WHERE rec_id = ?'),
    putAtt: db.prepare('INSERT OR IGNORE INTO att VALUES (?,?)'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
  };
}

function insertRecord(s, r) {
  s.putRec.run(r.id, r.captured, r.direction ?? null, r.verdicts?.live?.trust ?? null, r.verdicts?.portable?.trust ?? null,
    r.message?.message_id ?? null, r.message_key ?? null, r.copy?.kind ?? null, r.body_status ?? null);
  s.delAtt.run(r.id);
  for (const o of r.copy?.evidence?.attached_original || []) if (o.message_key) s.putAtt.run(o.message_key, r.id);
}

/** Open the index for a trail and bring it up to date with HEAD. Returns { db, s, mode, head }: mode is 'fresh' (nothing to do), 'catchup' or 'rebuild'. */
export async function openIndex(engine, trailDir, trail) {
  const root = path.join(trailDir, trail);
  const db = await openDb(engine, idxFile(trailDir, trail, engine));
  const s = stmts(db);
  const head = await headOf(root);
  const stored = s.getMeta.get('head')?.v;
  const ver = s.getMeta.get('schema')?.v;
  let mode = 'fresh';
  if (stored !== head || ver !== String(SCHEMA)) {
    mode = 'rebuild';
    if (stored && ver === String(SCHEMA)) {
      try {
        const out = await git(root, ['diff', '--name-only', '--diff-filter=AM', '-z', stored, head, '--', 'records']);
        const files = out.split('\0').filter((f) => f.endsWith('.json'));
        db.exec('BEGIN');
        for (const f of files) { const r = await readRecord(root, path.basename(f, '.json')); if (r) insertRecord(s, r); }
        s.setMeta.run('head', head);
        db.exec('COMMIT');
        mode = 'catchup';
      } catch { try { db.exec('ROLLBACK'); } catch { /* none open */ } mode = 'rebuild'; }
    }
    if (mode === 'rebuild') await rebuild(db, s, root, head);
  }
  return { db, s, mode, head, root };
}

async function rebuild(db, s, root, head) {
  const ids = await listIds(root);
  db.exec('BEGIN; DELETE FROM rec; DELETE FROM att; DELETE FROM meta;');
  for (let i = 0; i < ids.length; i += 500) { // bounded concurrency: memory stays flat in N
    const batch = await Promise.all(ids.slice(i, i + 500).map((id) => readRecord(root, id)));
    for (const r of batch) if (r) insertRecord(s, r);
  }
  s.setMeta.run('schema', String(SCHEMA));
  s.setMeta.run('head', head);
  db.exec('COMMIT');
}

/** After a record commit: insert it and move the stored HEAD to the new commit, in one transaction. */
export function onCommitted(ix, record, newHead) {
  ix.db.exec('BEGIN');
  insertRecord(ix.s, record);
  ix.s.setMeta.run('head', newHead);
  ix.db.exec('COMMIT');
}

const SUM = 'id, captured, direction, copy_kind, body_status, live, portable';
const sum = (r) => ({ id: r.id, captured: r.captured, direction: r.direction, copy: r.copy_kind ?? 'unknown', body_status: r.body_status ?? undefined, live: r.live ?? undefined, portable: r.portable ?? undefined });

export function queries(ix) {
  const { db } = ix;
  const qList = db.prepare('SELECT id, captured, direction, live, portable, message_id FROM rec ORDER BY captured DESC LIMIT ?');
  const qListDir = db.prepare('SELECT id, captured, direction, live, portable, message_id FROM rec WHERE direction = ? ORDER BY captured DESC LIMIT ?');
  const qSelf = db.prepare(`SELECT ${SUM}, message_key FROM rec WHERE id = ?`);
  const qCopies = db.prepare(`SELECT ${SUM} FROM rec WHERE message_key = ? ORDER BY captured`);
  const qIn = db.prepare(`SELECT ${SUM.split(', ').map((c) => 'r.' + c).join(', ')} FROM att a JOIN rec r ON r.id = a.rec_id WHERE a.att_key = ? AND r.message_key IS NOT ? ORDER BY r.captured`);
  const qMid = db.prepare('SELECT id FROM rec WHERE message_id = ? ORDER BY captured');
  const row = (r) => ({ id: r.id, captured: r.captured, direction: r.direction, live: r.live ?? undefined, portable: r.portable ?? undefined, message_id: r.message_id ?? null });
  return {
    list({ limit, direction } = {}) {
      const n = limit || -1;
      return (direction ? qListDir.all(direction, n) : qList.all(n)).map(row);
    },
    copies(idOrKey) {
      const self = typeof idOrKey === 'string' ? qSelf.get(idOrKey) : undefined;
      const key = self ? self.message_key : (typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null);
      const copies = key ? qCopies.all(key) : self ? [self] : [];
      const contained = key ? qIn.all(key, key) : [];
      const original = copies.find((r) => r.copy_kind === 'direct' && r.body_status === 'matched');
      return { message_key: key, original: original ? original.id : null, copies: copies.map(sum), contained_in: contained.map(sum) };
    },
    byMessageId(mid) { return qMid.all(mid).map((r) => r.id); },
    count() { return db.prepare('SELECT count(*) AS n FROM rec').get().n; },
  };
}
export const closeIndex = (ix) => ix.db.close();
