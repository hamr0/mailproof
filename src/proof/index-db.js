// The only module that imports better-sqlite3 (SPEC B5, F19). The trail index: one SQLite file beside the trail's
// lock file, outside the git repo, never committed. A CACHE of the records for `list()` and `copies()`: the JSON
// records in the trail stay the single source of truth, deleting the file loses nothing, and no proof path (`record`,
// `check`, `get`, `verify`, `matchBody`, `matchFile`, `sync` capture) ever loads this module or the addon.
//
// The index stores the trail git HEAD it reflects. Each query first compares that with the trail's HEAD:
//   equal                         use it;
//   stored head is an ancestor    catch up from the records `git diff` names between the two;
//   anything else                 rebuild from every committed record (restore, rewrite, missing, corrupt file,
//                                 schema-version mismatch).
// Catch-up and rebuild run under the trail lock (the one `record()` holds), so they never read a half-written commit;
// a record commit inserts itself in the same lock (`applyCommitted`). A failed index write never fails a record: the
// record is already committed, and the next query catches up through the HEAD mismatch.
//
// One code path: if better-sqlite3 cannot load there is no fallback to a full read, `list`/`copies` reject with
// `ERR_INDEX_UNAVAILABLE`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import { RECORD_ID_RE, readRecord, withTrailLock, trailLockFile, trailIndexFile } from './trail.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {{ run: (...p: any[]) => any, get: (...p: any[]) => any, all: (...p: any[]) => any[] }} Stmt */
/** @typedef {{ exec: (sql: string) => any, prepare: (sql: string) => Stmt, close: () => void, open: boolean, transaction: <F extends (...a: any[]) => any>(f: F) => F & { immediate: F } }} Db */
/** @typedef {{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }} ListRow */
/** @typedef {{ id: string, captured: string, direction: string, copy: string, body_status: string, live: string, portable: string }} CopyRow */

/** Bump when the table layout or what a column holds changes: an index of another version is rebuilt. */
const SCHEMA = 1;
const RECORD_PATH_RE = /^records\/([0-9a-f]{32})\.json$/;
const READ_BATCH = 500;
const BUSY_TIMEOUT_MS = 10000;

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

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' ? v : null);

/**
 * @param {unknown} cause
 * @returns {Error & { code: string }}
 */
function unavailable(cause) {
  const why = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
  return Object.assign(new Error(`trail index unavailable: the better-sqlite3 native addon could not be loaded${why}`), { code: 'ERR_INDEX_UNAVAILABLE', cause });
}

/** @param {unknown} e @returns {boolean} A damaged index file (rebuilt from the records), as opposed to any other failure. */
const isCorrupt = (e) => typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(e.code);

/**
 * The HEAD commit of the trail repo, or null when the trail does not exist yet (no repo, no commit). Never throws.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function headOf(root) {
  try {
    await fs.access(path.join(root, '.git')); // a trail dir inside some other repo must not resolve that repo's HEAD
    return await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch { return null; }
}

/** The ids of the record files named by a NUL-separated git path list. @param {string} out @returns {string[]} */
function idsFromPaths(out) {
  /** @type {string[]} */
  const ids = [];
  for (const p of out.split('\0')) { const m = RECORD_PATH_RE.exec(p); if (m) ids.push(m[1]); }
  return ids;
}

/**
 * Index row for a record, or null when it is not a usable record (not an object, or its `id` is not its file name).
 * Every column is a string or null, so one odd record can never make a bind fail and sink a rebuild.
 * @param {string} id  The record's file name.
 * @param {MpRecord | null} r
 * @returns {{ row: Array<string | null>, att: string[] } | null}
 */
function rowOf(id, r) {
  if (!r || typeof r !== 'object' || r.id !== id) return null;
  const evidence = r.copy?.evidence?.attached_original;
  /** @type {string[]} */
  const att = [];
  if (Array.isArray(evidence)) for (const o of evidence) { const k = o && typeof o === 'object' ? str(o.message_key) : null; if (k) att.push(k); }
  return {
    row: [id, str(r.captured) ?? '', str(r.direction), str(r.verdicts?.live?.trust), str(r.verdicts?.portable?.trust),
      str(r.message?.message_id), str(r.message_key), str(r.copy?.kind), str(r.body_status)],
    att,
  };
}

/**
 * Read records in bounded batches (memory stays flat in the number of files read at once).
 * @param {string} root
 * @param {string[]} ids
 * @returns {Promise<Array<[string, MpRecord | null]>>}
 */
async function readMany(root, ids) {
  /** @type {Array<[string, MpRecord | null]>} */
  const out = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = await Promise.all(ids.slice(i, i + READ_BATCH).map(async (id) => /** @type {[string, MpRecord | null]} */ ([id, await readRecord(root, id)])));
    out.push(...batch);
  }
  return out;
}

/**
 * @typedef {Object} TrailIndex
 * @property {(opts?: { limit?: number, direction?: 'in' | 'out' }) => Promise<ListRow[]>} list
 * @property {(idOrKey: string) => Promise<{ message_key: string | null, original: string | null, copies: CopyRow[], contained_in: CopyRow[] }>} copies
 * @property {(record: MpRecord, commit: string) => Promise<void>} applyCommitted  Call under the trail lock, right after the commit.
 * @property {() => Promise<void>} close
 */

/**
 * A handle on the trail's index. Nothing is touched until the first query: the addon is loaded and the file created
 * then, and only when the trail has a commit.
 * @param {{ root: string, trail: string, lockTimeoutMs: number }} cfg
 * @returns {TrailIndex}
 */
export function createIndex({ root, trail, lockTimeoutMs }) {
  const file = path.join(path.dirname(root), trailIndexFile(trail));
  const lockFile = trailLockFile(trail);
  /** @type {Db | null} */
  let db = null;
  /** @type {Promise<Db> | null} */
  let opening = null;
  /** @type {Record<string, Stmt>} */
  let st = {};

  const files = [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];

  /** Open the file, create the tables. A damaged file is deleted (under the trail lock) and created again. @returns {Promise<Db>} */
  async function openFile() {
    /** @type {any} */
    let Database;
    try {
      Database = (await import('better-sqlite3')).default;
      new Database(':memory:').close(); // the native binding loads on the first construction: probe it here, so only this step means "unavailable"
    } catch (e) { throw unavailable(e); }
    for (let attempt = 0; ; attempt++) {
      /** @type {Db | null} */
      let d = null;
      try {
        d = new Database(file);
        const opened = /** @type {Db} */ (d);
        opened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;`);
        opened.exec(DDL);
        opened.prepare('SELECT v FROM meta WHERE k = ?').get('head');
        return opened;
      } catch (e) {
        try { d?.close(); } catch { /* already unusable */ }
        if (!isCorrupt(e) || attempt > 0) throw e;
        await withTrailLock(root, lockFile, lockTimeoutMs, async () => { for (const f of files) await fs.rm(f, { force: true }); });
      }
    }
  }

  /** @returns {Promise<Db>} */
  function ensureOpen() {
    if (db && db.open) return Promise.resolve(db);
    db = null;
    opening ??= openFile().then((d) => {
      db = d;
      st = {
        getMeta: d.prepare('SELECT v FROM meta WHERE k = ?'),
        setMeta: d.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)'),
        putRec: d.prepare('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?,?,?,?,?)'),
        delRec: d.prepare('DELETE FROM rec WHERE id = ?'),
        delAtt: d.prepare('DELETE FROM att WHERE rec_id = ?'),
        putAtt: d.prepare('INSERT OR IGNORE INTO att VALUES (?,?)'),
      };
      return d;
    }).finally(() => { opening = null; });
    return opening;
  }

  /** @param {string} k @returns {string | undefined} */
  const meta = (k) => st.getMeta.get(k)?.v;

  /** @param {{ row: Array<string | null>, att: string[] }} x */
  function put(x) {
    st.putRec.run(...x.row);
    st.delAtt.run(x.row[0]);
    for (const k of x.att) st.putAtt.run(k, x.row[0]);
  }

  /**
   * Bring the index to `head`. Caller holds the trail lock.
   * @param {Db} d @param {string} head
   */
  async function reconcile(d, head) {
    const stored = meta('head');
    const versionOk = meta('schema') === String(SCHEMA);
    if (stored === head && versionOk) return;
    /** @type {string[] | null} */
    let changed = null;
    if (stored && versionOk) {
      try {
        await git(root, ['merge-base', '--is-ancestor', stored, head]);
        changed = idsFromPaths(await git(root, ['diff', '--name-only', '-z', stored, head, '--', 'records']));
      } catch { changed = null; }
    }
    if (changed) {
      const read = await readMany(root, changed);
      d.transaction(() => {
        for (const [id, r] of read) {
          const x = rowOf(id, r);
          if (x) put(x); else { st.delRec.run(id); st.delAtt.run(id); }
        }
        st.setMeta.run('head', head);
      }).immediate();
      return;
    }
    const read = await readMany(root, idsFromPaths(await git(root, ['ls-tree', '-r', '--name-only', '-z', head, '--', 'records'])));
    d.transaction(() => {
      d.exec('DELETE FROM rec; DELETE FROM att; DELETE FROM meta;');
      for (const [id, r] of read) { const x = rowOf(id, r); if (x) put(x); }
      st.setMeta.run('schema', String(SCHEMA));
      st.setMeta.run('head', head);
    }).immediate();
  }

  /**
   * An open index that reflects the trail's HEAD, or null when the trail has no commit yet (nothing to list).
   * @returns {Promise<Db | null>}
   */
  async function fresh() {
    const head = await headOf(root);
    if (head === null) return null;
    const d = await ensureOpen();
    if (meta('head') === head && meta('schema') === String(SCHEMA)) return d;
    await withTrailLock(root, lockFile, lockTimeoutMs, async () => {
      const h = await headOf(root); // re-read under the lock: a writer may have moved it
      if (h !== null) await reconcile(d, h);
    });
    return d;
  }

  /**
   * Run a query against a fresh index. A damaged file is deleted and rebuilt once.
   * @template T
   * @param {(d: Db) => T} fn
   * @param {T} empty  The answer for a trail with no commit.
   * @returns {Promise<T>}
   */
  async function query(fn, empty) {
    for (let attempt = 0; ; attempt++) {
      try {
        const d = await fresh();
        return d ? fn(d) : empty;
      } catch (e) {
        if (!isCorrupt(e) || attempt > 0) throw e;
        try { db?.close(); } catch { /* already unusable */ }
        db = null;
        await withTrailLock(root, lockFile, lockTimeoutMs, async () => { for (const f of files) await fs.rm(f, { force: true }); });
      }
    }
  }

  const SUM = 'id, captured, direction, copy_kind, body_status, live, portable';
  /** @param {any} r @returns {CopyRow} */
  const sum = (r) => ({
    id: r.id, captured: r.captured, direction: r.direction, copy: r.copy_kind ?? 'unknown',
    body_status: r.body_status ?? undefined, live: r.live ?? undefined, portable: r.portable ?? undefined,
  });

  return {
    async list({ limit, direction } = {}) {
      if (direction && typeof direction !== 'string') return [];
      // A positive number is a SQL LIMIT; any other truthy value keeps Array#slice's meaning on the full ordered list.
      const sql = typeof limit === 'number' && limit > 0;
      const n = sql ? (Number.isFinite(limit) ? Math.floor(/** @type {number} */ (limit)) : -1) : -1;
      return query((d) => {
        const cols = 'id, captured, direction, live, portable, message_id';
        // newest capture first; equal captures in ascending id order (the old full read left that to the file system)
        const rows = direction
          ? d.prepare(`SELECT ${cols} FROM rec WHERE direction = ? ORDER BY captured DESC, id LIMIT ?`).all(direction, n)
          : d.prepare(`SELECT ${cols} FROM rec ORDER BY captured DESC, id LIMIT ?`).all(n);
        return (limit && !sql ? rows.slice(0, /** @type {any} */ (limit)) : rows).map((r) => ({
          id: r.id, captured: r.captured, direction: r.direction,
          live: r.live ?? undefined, portable: r.portable ?? undefined, message_id: r.message_id ?? null,
        }));
      }, []);
    },

    async copies(idOrKey) {
      return query((d) => {
        const self = typeof idOrKey === 'string' ? d.prepare(`SELECT ${SUM}, message_key FROM rec WHERE id = ?`).get(idOrKey) : undefined;
        const key = self ? self.message_key : (typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null);
        const copies = key ? d.prepare(`SELECT ${SUM} FROM rec WHERE message_key = ? ORDER BY captured, id`).all(key) : self ? [self] : [];
        const contained = key
          ? d.prepare(`SELECT ${SUM.split(', ').map((c) => `r.${c}`).join(', ')} FROM att a JOIN rec r ON r.id = a.rec_id WHERE a.att_key = ? AND r.message_key IS NOT ? ORDER BY r.captured, r.id`).all(key, key)
          : [];
        const original = copies.find((r) => r.copy_kind === 'direct' && r.body_status === 'matched');
        return { message_key: key ?? null, original: original ? original.id : null, copies: copies.map(sum), contained_in: contained.map(sum) };
      }, { message_key: typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null, original: null, copies: [], contained_in: [] });
    },

    async applyCommitted(record, commit) {
      const d = db;
      if (!d || !d.open) return; // not open: the first query will catch up
      const stored = meta('head');
      if (!stored || meta('schema') !== String(SCHEMA)) return;
      if (stored !== (await git(root, ['rev-parse', `${commit}^`]))) return; // not exactly one commit behind: catch up on the next query
      const x = rowOf(record.id, JSON.parse(JSON.stringify(record))); // the record as the file holds it
      if (!x) return;
      d.transaction(() => { put(x); st.setMeta.run('head', commit); }).immediate();
    },

    async close() {
      const d = db;
      db = null;
      try { d?.close(); } catch { /* already closed */ }
    },
  };
}
