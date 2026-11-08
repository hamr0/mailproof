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
// two concurrent first builds serialise on it, and the second finds the HEAD already stored. `record()` never touches
// the index: a new commit reaches it through the catch-up of the next query.
//
// No handle lives between calls. Each query opens the file, checks HEAD, catches up or rebuilds, answers, and closes
// the file, all inside one call (a throw closes it too), so nothing is left open for `close()` to chase. Only the
// loaded addon (the driver class) is cached, never a connection.
//
// One code path: if better-sqlite3 cannot load there is no fallback to a full read, `list`/`copies` reject with
// `ERR_INDEX_UNAVAILABLE`. A rebuild lists every committed record id through one `git ls-tree` call whose output is
// capped at 16 MB (about 350,000 records); a trail past that rejects with `ERR_INDEX_REBUILD`. Catch-up lists only the
// changed paths under the same cap; if that overflows it falls back to the rebuild, which then rejects the same way.

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
const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

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

/**
 * @param {unknown} cause
 * @param {number} limit  The output cap that was hit, in bytes.
 * @returns {Error & { code: string }}
 */
function rebuildTooLarge(cause, limit) {
  return Object.assign(new Error(`trail index rebuild failed: the list of committed records exceeds the ${limit}-byte git output limit (about ${Math.floor(limit / 47).toLocaleString('en-US')} records); the trail is too large to index`), { code: 'ERR_INDEX_REBUILD', cause });
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
 * @typedef {Object} IndexCfg
 * @property {string} root  The trail repo directory.
 * @property {string} trail  The trail name.
 * @property {number} lockTimeoutMs
 * @property {number} [gitMaxBuffer]  Internal (tests): the output cap, in bytes, for the git listings of a catch-up or rebuild.
 */

/** The loaded driver class: cached after the first successful load. A class, not a handle. @type {any} */
let Driver = null;

/** Load the addon and probe that the native binding works; only this step means "unavailable". @returns {Promise<any>} */
async function loadDriver() {
  if (Driver) return Driver;
  try {
    const D = (await import('better-sqlite3')).default;
    new D(':memory:').close(); // the native binding loads on the first construction
    Driver = D;
    return D;
  } catch (e) { throw unavailable(e); }
}

/** @param {string} file @returns {string[]} */
const filesOf = (file) => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];

/**
 * One open index: the connection plus its prepared statements. Built per query, closed in the same call.
 * @param {Db} d
 */
function session(d) {
  const st = {
    getMeta: d.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: d.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)'),
    putRec: d.prepare('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?,?,?,?,?)'),
    delRec: d.prepare('DELETE FROM rec WHERE id = ?'),
    delAtt: d.prepare('DELETE FROM att WHERE rec_id = ?'),
    putAtt: d.prepare('INSERT OR IGNORE INTO att VALUES (?,?)'),
  };
  return {
    d,
    /** @param {string} k @returns {string | undefined} */
    meta: (k) => st.getMeta.get(k)?.v,
    /** @param {string} k @param {string} v */
    setMeta: (k, v) => { st.setMeta.run(k, v); },
    /** @param {string} id */
    del: (id) => { st.delRec.run(id); st.delAtt.run(id); },
    /** @param {{ row: Array<string | null>, att: string[] }} x */
    put: (x) => {
      st.putRec.run(...x.row);
      st.delAtt.run(x.row[0]);
      for (const k of x.att) st.putAtt.run(k, x.row[0]);
    },
  };
}

/**
 * Open the file and create the tables. A damaged file is deleted (under the trail lock) and created again.
 * @param {IndexCfg} cfg @param {string} file @returns {Promise<Db>}
 */
async function openFile({ root, trail, lockTimeoutMs }, file) {
  const Database = await loadDriver();
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
      await withTrailLock(root, trailLockFile(trail), lockTimeoutMs, async () => { for (const f of filesOf(file)) await fs.rm(f, { force: true }); });
    }
  }
}

/**
 * Bring the index to `head`. Caller holds the trail lock.
 * @param {ReturnType<typeof session>} s @param {IndexCfg} cfg @param {string} head
 */
async function reconcile(s, { root, gitMaxBuffer = DEFAULT_GIT_MAX_BUFFER }, head) {
  const stored = s.meta('head');
  const versionOk = s.meta('schema') === String(SCHEMA);
  if (stored === head && versionOk) return;
  /** @type {string[] | null} */
  let changed = null;
  if (stored && versionOk) {
    try {
      await git(root, ['merge-base', '--is-ancestor', stored, head]);
      changed = idsFromPaths(await git(root, ['diff', '--name-only', '-z', stored, head, '--', 'records'], { maxBuffer: gitMaxBuffer }));
    } catch { changed = null; } // not an ancestor, or a list too big for the cap: rebuild (which rejects if it is too big too)
  }
  if (changed) {
    const read = await readMany(root, changed);
    s.d.transaction(() => {
      for (const [id, r] of read) {
        const x = rowOf(id, r);
        if (x) s.put(x); else s.del(id);
      }
      s.setMeta('head', head);
    }).immediate();
    return;
  }
  /** @type {string} */
  let listing;
  try {
    listing = await git(root, ['ls-tree', '-r', '--name-only', '-z', head, '--', 'records'], { maxBuffer: gitMaxBuffer });
  } catch (e) {
    const c = e instanceof Error ? /** @type {{ code?: string }} */ (e.cause) : null;
    throw c?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? rebuildTooLarge(e, gitMaxBuffer) : e;
  }
  const read = await readMany(root, idsFromPaths(listing));
  s.d.transaction(() => {
    s.d.exec('DELETE FROM rec; DELETE FROM att; DELETE FROM meta;');
    for (const [id, r] of read) { const x = rowOf(id, r); if (x) s.put(x); }
    s.setMeta('schema', String(SCHEMA));
    s.setMeta('head', head);
  }).immediate();
}

/**
 * Run `fn` against an index that reflects the trail's HEAD, then close it: open, check, catch up or rebuild, answer,
 * close, all in this call. A trail with no commit answers `empty` and touches nothing. A damaged file is deleted and
 * rebuilt once.
 * @template T
 * @param {IndexCfg} cfg
 * @param {(d: Db) => T} fn
 * @param {T} empty
 * @returns {Promise<T>}
 */
async function query(cfg, fn, empty) {
  const { root, trail, lockTimeoutMs } = cfg;
  const file = path.join(path.dirname(root), trailIndexFile(trail));
  for (let attempt = 0; ; attempt++) {
    if ((await headOf(root)) === null) return empty;
    /** @type {Db | null} */
    let d = null;
    try {
      d = await openFile(cfg, file);
      const s = session(d);
      if (s.meta('head') !== (await headOf(root)) || s.meta('schema') !== String(SCHEMA)) {
        await withTrailLock(root, trailLockFile(trail), lockTimeoutMs, async () => {
          const h = await headOf(root); // re-read under the lock: a writer may have moved it
          if (h !== null) await reconcile(s, cfg, h);
        });
      }
      return fn(d);
    } catch (e) {
      if (!isCorrupt(e) || attempt > 0) throw e;
    } finally {
      try { d?.close(); } catch { /* already unusable */ }
    }
    await withTrailLock(root, trailLockFile(trail), lockTimeoutMs, async () => { for (const f of filesOf(file)) await fs.rm(f, { force: true }); });
  }
}

const SUM = 'id, captured, direction, copy_kind, body_status, live, portable';
/** @param {any} r @returns {CopyRow} */
const sum = (r) => ({
  id: r.id, captured: r.captured, direction: r.direction, copy: r.copy_kind ?? 'unknown',
  body_status: r.body_status ?? undefined, live: r.live ?? undefined, portable: r.portable ?? undefined,
});

/**
 * `Mailproof#list` from the index (opened and closed inside this call).
 * @param {IndexCfg} cfg
 * @param {{ limit?: number, direction?: 'in' | 'out' }} [opts]
 * @returns {Promise<ListRow[]>}
 */
export async function listIndex(cfg, { limit, direction } = {}) {
  if (direction && typeof direction !== 'string') return [];
  // A positive number is a SQL LIMIT; any other truthy value keeps Array#slice's meaning on the full ordered list.
  const sql = typeof limit === 'number' && limit > 0;
  const n = sql ? (Number.isFinite(limit) ? Math.floor(/** @type {number} */ (limit)) : -1) : -1;
  return query(cfg, (d) => {
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
}

/**
 * `Mailproof#copies` from the index (opened and closed inside this call).
 * @param {IndexCfg} cfg
 * @param {string} idOrKey
 * @returns {Promise<{ message_key: string | null, original: string | null, copies: CopyRow[], contained_in: CopyRow[] }>}
 */
export async function copiesIndex(cfg, idOrKey) {
  return query(cfg, (d) => {
    const self = typeof idOrKey === 'string' ? d.prepare(`SELECT ${SUM}, message_key FROM rec WHERE id = ?`).get(idOrKey) : undefined;
    const key = self ? self.message_key : (typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null);
    const copies = key ? d.prepare(`SELECT ${SUM} FROM rec WHERE message_key = ? ORDER BY captured, id`).all(key) : self ? [self] : [];
    const contained = key
      ? d.prepare(`SELECT ${SUM.split(', ').map((c) => `r.${c}`).join(', ')} FROM att a JOIN rec r ON r.id = a.rec_id WHERE a.att_key = ? AND r.message_key IS NOT ? ORDER BY r.captured, r.id`).all(key, key)
      : [];
    const original = copies.find((r) => r.copy_kind === 'direct' && r.body_status === 'matched');
    return { message_key: key ?? null, original: original ? original.id : null, copies: copies.map(sum), contained_in: contained.map(sum) };
  }, { message_key: typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null, original: null, copies: [], contained_in: [] });
}
