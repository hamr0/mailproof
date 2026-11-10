// The only module that imports better-sqlite3 (SPEC B5, F19). The trail index: one SQLite file beside the trail's
// lock file, outside the git repo, never committed. A CACHE of the records for `list()`, `copies()`, `counterparties()`
// and `linked()` (participants and thread links, M3 step 2, SPEC B8): the JSON
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
// `ERR_INDEX_UNAVAILABLE`. Every git listing (`ls-tree`, `diff`, `log`) is streamed line by line through `gitLines`, so
// the rebuild has no output-size ceiling; memory holds one READ_BATCH of records plus the id -> adding-commit map.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitLines } from './git.js';
import { parseRecordPath, assertTrailLayout } from './layout.js';
import { RECORD_ID_RE, readRecord, withTrailLock, trailLockFile, trailIndexFile } from './trail.js';
import { LINKED_CHILDREN_DEFAULT, REPLY_FACTS_MAX } from './limits.js';
import { participantsOf, linksOf, directParents, hasSignedThreading, ROLES } from './participants.js';
import { verifyRecord } from './recheck.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {{ run: (...p: any[]) => any, get: (...p: any[]) => any, all: (...p: any[]) => any[] }} Stmt */
/** @typedef {{ exec: (sql: string) => any, prepare: (sql: string) => Stmt, close: () => void, open: boolean, transaction: <F extends (...a: any[]) => any>(f: F) => F & { immediate: F } }} Db */
/** @typedef {{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }} ListRow */
/** @typedef {{ id: string, captured: string, direction: string, copy: string, body_status: string, live: string, portable: string }} CopyRow */

/** Bump when the table layout or what a column holds changes: an index of another version is rebuilt. */
const SCHEMA = 4;
const READ_BATCH = 500;
const BUSY_TIMEOUT_MS = 10000;

const DDL = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rec(
  id TEXT PRIMARY KEY, captured TEXT NOT NULL, direction TEXT, live TEXT, portable TEXT,
  message_id TEXT, message_key TEXT, copy_kind TEXT, body_status TEXT, commit_id TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS att(att_key TEXT NOT NULL, rec_id TEXT NOT NULL, PRIMARY KEY(att_key, rec_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS participants(
  rec_id TEXT NOT NULL, address TEXT NOT NULL, raw TEXT NOT NULL, role TEXT NOT NULL, signed INTEGER NOT NULL,
  PRIMARY KEY(rec_id, role, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS links(
  rec_id TEXT NOT NULL, mid TEXT NOT NULL, via TEXT NOT NULL, strength TEXT NOT NULL, pos INTEGER NOT NULL, direct INTEGER NOT NULL,
  PRIMARY KEY(rec_id, mid)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS part_addr ON participants(address, rec_id);
CREATE INDEX IF NOT EXISTS links_mid ON links(mid, rec_id);
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

/**
 * Index row for a record, or null when it is not a usable record (not an object, or its `id` is not its file name).
 * Every column is a string or null, so one odd record can never make a bind fail and sink a rebuild.
 * @param {string} id  The record's file name.
 * @param {MpRecord | null} r
 * @param {string | null} commit  The commit that added the record file (SPEC B5), or null when unknown.
 * @returns {{ row: Array<string | null>, att: string[], parts: Array<Array<string | number>>, links: Array<Array<string | number>> } | null}
 */
function rowOf(id, r, commit) {
  if (!r || typeof r !== 'object' || r.id !== id) return null;
  const evidence = r.copy?.evidence?.attached_original;
  /** @type {string[]} */
  const att = [];
  if (Array.isArray(evidence)) for (const o of evidence) { const k = o && typeof o === 'object' ? str(o.message_key) : null; if (k) att.push(k); }
  // The DKIM re-check (which signatures verify and align) is paid only by a record that has a signed In-Reply-To or
  // References line to grade; the other records never run it.
  const passing = hasSignedThreading(r) ? verifyRecord(r).passing : [];
  const directs = directParents(r);
  return {
    row: [id, str(r.captured) ?? '', str(r.direction), str(r.verdicts?.live?.trust), str(r.verdicts?.portable?.trust),
      str(r.message?.message_id), str(r.message_key), str(r.copy?.kind), str(r.body_status), commit],
    att,
    parts: participantsOf(r).map((p) => [id, p.address, p.raw, p.role, p.signed ? 1 : 0]),
    links: linksOf(r, passing).map((l, i) => [id, l.mid, l.via, l.strength, i, directs.has(l.mid) ? 1 : 0]),
  };
}

/**
 * The commit that ADDED each record file (one commit per record, SPEC B3), from one streamed `git log` over `range`
 * (default: the whole history). Paths are plain hex names, so the unquoted `--name-only` listing is safe to parse line by line.
 * @param {string} root @param {string | null} range  `<stored>..<head>` or null.
 * @returns {Promise<Map<string, string>>}  record id -> commit
 */
async function addedCommits(root, range) {
  /** @type {Map<string, string>} */
  const map = new Map();
  let commit = '';
  await gitLines(root, ['log', '--diff-filter=A', '--name-only', '--no-renames', '--format=%H', ...(range ? [range] : []), '--', 'records'], (line) => {
    if (/^[0-9a-f]{40,64}$/.test(line)) { commit = line; return; }
    const r = parseRecordPath(line);
    if (r && !r.ots && commit) map.set(r.id, commit); // log is newest first: the oldest add wins
  });
  return map;
}

/**
 * Stream the record ids git lists for `args` (a NUL-separated `-z` path listing) to `onIds` in chunks of at most
 * READ_BATCH, awaiting each chunk before the next is read.
 * @param {string} root @param {string[]} args @param {(ids: string[]) => Promise<void> | void} onIds
 * @returns {Promise<void>}
 */
async function eachListedBatch(root, args, onIds) {
  /** @type {string[]} */
  let ids = [];
  await gitLines(root, args, async (p) => {
    const r = parseRecordPath(p);
    if (!r || r.ots) return;
    ids.push(r.id);
    if (ids.length >= READ_BATCH) { const b = ids; ids = []; await onIds(b); }
  }, { sep: '\0' });
  if (ids.length) await onIds(ids);
}

/**
 * Read records in batches of READ_BATCH and hand each batch to `fn` before reading the next, so only one batch of
 * parsed records is alive at a time: peak memory does not grow with the number of ids.
 * @param {string} root
 * @param {string[]} ids
 * @param {(batch: Array<[string, MpRecord | null]>) => void} fn
 * @returns {Promise<void>}
 */
async function eachBatch(root, ids, fn) {
  for (let i = 0; i < ids.length; i += READ_BATCH) fn(await readBatch(root, ids.slice(i, i + READ_BATCH)));
}

/** @param {string} root @param {string[]} ids @returns {Promise<Array<[string, MpRecord | null]>>} */
function readBatch(root, ids) {
  return Promise.all(ids.map(async (id) => /** @type {[string, MpRecord | null]} */ ([id, await readRecord(root, id)])));
}

/**
 * Run `fn` inside one write transaction that stays open across its awaits (the connection is ours alone and the
 * caller holds the trail lock; better-sqlite3 statements are synchronous, so nothing interleaves). Commits when `fn`
 * returns. On a throw the transaction is left open and the error propagates; `query()` always closes the connection
 * in its `finally`, and SQLite rolls an open transaction back on close, so a failed rebuild or catch-up leaves the
 * previous rows and the previous head.
 * @param {Db} d @param {() => Promise<void>} fn @returns {Promise<void>}
 */
async function atomic(d, fn) {
  d.exec('BEGIN IMMEDIATE');
  await fn();
  d.exec('COMMIT');
}

/**
 * @typedef {Object} IndexCfg
 * @property {string} root  The trail repo directory.
 * @property {string} trail  The trail name.
 * @property {number} lockTimeoutMs
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
    putRec: d.prepare('INSERT OR REPLACE INTO rec VALUES (?,?,?,?,?,?,?,?,?,?)'),
    getCommit: d.prepare('SELECT commit_id FROM rec WHERE id = ?'),
    delRec: d.prepare('DELETE FROM rec WHERE id = ?'),
    delAtt: d.prepare('DELETE FROM att WHERE rec_id = ?'),
    putAtt: d.prepare('INSERT OR IGNORE INTO att VALUES (?,?)'),
    delPart: d.prepare('DELETE FROM participants WHERE rec_id = ?'),
    putPart: d.prepare('INSERT OR IGNORE INTO participants VALUES (?,?,?,?,?)'),
    delLink: d.prepare('DELETE FROM links WHERE rec_id = ?'),
    putLink: d.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?,?,?,?)'),
  };
  return {
    d,
    /** @param {string} k @returns {string | undefined} */
    meta: (k) => st.getMeta.get(k)?.v,
    /** @param {string} k @param {string} v */
    setMeta: (k, v) => { st.setMeta.run(k, v); },
    /** @param {string} id @returns {string | null} */
    commitOf: (id) => st.getCommit.get(id)?.commit_id ?? null,
    /** @param {string} id */
    del: (id) => { st.delRec.run(id); st.delAtt.run(id); st.delPart.run(id); st.delLink.run(id); },
    /** @param {NonNullable<ReturnType<typeof rowOf>>} x */
    put: (x) => {
      st.putRec.run(...x.row);
      st.delAtt.run(x.row[0]); st.delPart.run(x.row[0]); st.delLink.run(x.row[0]);
      for (const k of x.att) st.putAtt.run(k, x.row[0]);
      for (const p of x.parts) st.putPart.run(...p);
      for (const l of x.links) st.putLink.run(...l);
    },
  };
}

/**
 * A file made by an older schema has the old shape of `rec` and `links` (CREATE TABLE IF NOT EXISTS keeps them): add the
 * columns schema 4 appended, so the statements prepare; the rows are rebuilt by the schema mismatch. Idempotent and
 * safe against a concurrent opener (a duplicate column is ignored).
 * @param {Db} d
 */
function addColumns(d) {
  for (const [table, col, def] of [['rec', 'commit_id', 'TEXT'], ['links', 'direct', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) continue;
    try { d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { if (!/duplicate column/i.test(String(/** @type {any} */ (e)?.message))) throw e; }
  }
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
      addColumns(opened);
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
async function reconcile(s, { root }, head) {
  const stored = s.meta('head');
  const versionOk = s.meta('schema') === String(SCHEMA);
  if (stored === head && versionOk) return;
  /** @type {string[] | null} */
  let changed = null;
  /** @type {Map<string, string>} */
  let added = new Map();
  if (stored && versionOk) {
    try {
      await git(root, ['merge-base', '--is-ancestor', stored, head]);
      /** @type {string[]} */
      const ids = [];
      await eachListedBatch(root, ['diff', '--name-only', '--no-renames', '-z', stored, head, '--', 'records'], (b) => { for (const id of b) ids.push(id); });
      added = await addedCommits(root, `${stored}..${head}`);
      changed = ids;
    } catch { changed = null; } // not an ancestor (or git failed): rebuild
  }
  if (changed) {
    await atomic(s.d, async () => {
      await eachBatch(root, changed, (batch) => {
        for (const [id, r] of batch) {
          const x = rowOf(id, r, added.get(id) ?? s.commitOf(id));
          if (x) s.put(x); else s.del(id);
        }
      });
      s.setMeta('head', head);
    });
    return;
  }
  const commits = await addedCommits(root, head);
  await atomic(s.d, async () => {
    s.d.exec('DELETE FROM rec; DELETE FROM att; DELETE FROM participants; DELETE FROM links; DELETE FROM meta;');
    await eachListedBatch(root, ['ls-tree', '-r', '--name-only', '-z', head, '--', 'records'], async (ids) => {
      for (const [id, r] of await readBatch(root, ids)) { const x = rowOf(id, r, commits.get(id) ?? null); if (x) s.put(x); }
    });
    s.setMeta('schema', String(SCHEMA));
    s.setMeta('head', head);
  });
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
    await assertTrailLayout(root);
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

/** @param {unknown} v @param {string} what @returns {string} An ISO time, for comparing with `captured`. */
function isoOf(v, what) {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`list: ${what} must be a Date, a timestamp or an ISO date string`);
  return new Date(ms).toISOString();
}

/**
 * Whether the index file exists and reflects the trail's HEAD. Read-only: opens the file read-only, never creates,
 * migrates or rebuilds it, takes no lock (the CLI `status` uses it).
 * @param {IndexCfg} cfg
 * @param {string} file  The index file (`trailIndexFile`).
 * @returns {Promise<'absent' | 'present' | 'stale'>}  `present`: it reflects HEAD; `stale`: the next `list` will bring it up to date.
 */
export async function indexState(cfg, file) {
  try { await fs.access(file); } catch { return 'absent'; }
  const Database = await loadDriver();
  /** @type {Db | null} */
  let d = null;
  try {
    const opened = /** @type {Db} */ (new Database(file, { readonly: true, fileMustExist: true }));
    d = opened;
    const row = /** @type {{ v?: string } | undefined} */ (opened.prepare('SELECT v FROM meta WHERE k = ?').get('head'));
    const schema = /** @type {{ v?: string } | undefined} */ (opened.prepare('SELECT v FROM meta WHERE k = ?').get('schema'));
    return row?.v && row.v === (await headOf(cfg.root)) && schema?.v === String(SCHEMA) ? 'present' : 'stale';
  } catch { return 'stale'; }
  finally { try { d?.close(); } catch { /* already closed */ } }
}

/**
 * `Mailproof#list` from the index (opened and closed inside this call).
 * @param {IndexCfg} cfg
 * @param {{ limit?: number, direction?: 'in' | 'out', with?: string, role?: 'from' | 'to' | 'cc' | 'reply-to', before?: Date | number | string, after?: Date | number | string }} [opts]
 * @returns {Promise<ListRow[]>}
 */
export async function listIndex(cfg, { limit, direction, with: who, role, before, after } = {}) {
  // The counterparty options are strict (a wrong type throws); `direction` keeps its old lenient meaning.
  if (who !== undefined && (typeof who !== 'string' || !who.trim())) throw new TypeError('list: with must be an address string');
  if (role !== undefined && (typeof role !== 'string' || !ROLES.includes(/** @type {any} */ (role)))) throw new TypeError(`list: role must be one of ${ROLES.join(', ')}`);
  if (role !== undefined && who === undefined) throw new TypeError('list: role needs with');
  const hi = before === undefined ? null : isoOf(before, 'before');
  const lo = after === undefined ? null : isoOf(after, 'after');
  if (direction && typeof direction !== 'string') return [];
  // A positive number is a SQL LIMIT; any other truthy value keeps Array#slice's meaning on the full ordered list.
  const sql = typeof limit === 'number' && limit > 0;
  const n = sql ? (Number.isFinite(limit) ? Math.floor(/** @type {number} */ (limit)) : -1) : -1;
  /** @type {string[]} */
  const where = [];
  /** @type {Array<string | number>} */
  const args = [];
  if (direction) { where.push('direction = ?'); args.push(direction); }
  // The counterparty's record ids drive the query (a DISTINCT subquery is not flattened), so an address seen on a few
  // records costs those records, not a scan of the whole trail.
  let from = 'rec';
  /** @type {Array<string | number>} */
  const pre = [];
  if (who !== undefined) {
    from = `(SELECT DISTINCT rec_id FROM participants WHERE address = ?${role ? ' AND role = ?' : ''}) AS p JOIN rec ON rec.id = p.rec_id`;
    pre.push(who.trim().toLowerCase());
    if (role) pre.push(role);
  }
  if (lo !== null) { where.push('captured >= ?'); args.push(lo); }
  if (hi !== null) { where.push('captured < ?'); args.push(hi); }
  return query(cfg, (d) => {
    const cols = 'rec.id AS id, captured, direction, live, portable, message_id';
    // newest capture first; equal captures in ascending id order (the old full read left that to the file system)
    const rows = d.prepare(`SELECT ${cols} FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY captured DESC, rec.id LIMIT ?`).all(...pre, ...args, n);
    return (limit && !sql ? rows.slice(0, /** @type {any} */ (limit)) : rows).map((r) => ({
      id: r.id, captured: r.captured, direction: r.direction,
      live: r.live ?? undefined, portable: r.portable ?? undefined, message_id: r.message_id ?? null,
    }));
  }, []);
}

/**
 * `Mailproof#counterparties` from the index: one row per exact address.
 * @param {IndexCfg} cfg
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ address: string, records: number, first: string, last: string }>>}
 */
export async function counterpartiesIndex(cfg, { limit } = {}) {
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) throw new TypeError('counterparties: limit must be a positive number');
  const n = limit === undefined ? -1 : Math.floor(limit);
  return query(cfg, (d) => d.prepare(
    `SELECT p.address AS address, COUNT(DISTINCT p.rec_id) AS records, MIN(r.captured) AS first, MAX(r.captured) AS last
       FROM participants p JOIN rec r ON r.id = p.rec_id GROUP BY p.address ORDER BY last DESC, address LIMIT ?`,
  ).all(n).map((r) => ({ address: r.address, records: r.records, first: r.first, last: r.last })), []);
}

/**
 * `Mailproof#linked` from the index: the records this one points at (parents) and the records that point at it (children).
 * @param {IndexCfg} cfg
 * @param {string} id
 * @param {{ limit?: number }} [opts]  `limit`: most children returned (default LINKED_CHILDREN_DEFAULT, a positive integer); `more` says the list was cut.
 * @returns {Promise<{ id: string, message_id: string | null, parents: Array<{ id: string | null, message_id: string, via: string, strength: string }>, children: Array<{ id: string, message_id: string | null, via: string, strength: string }>, more: boolean } | null>}
 */
export async function linkedIndex(cfg, id, { limit } = {}) {
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new TypeError('linked: limit must be a positive integer');
  const n = limit ?? LINKED_CHILDREN_DEFAULT;
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null;
  return query(cfg, (d) => {
    const self = d.prepare('SELECT id, message_id FROM rec WHERE id = ?').get(id);
    if (!self) return null;
    const find = d.prepare('SELECT id FROM rec WHERE message_id = ? ORDER BY captured, id LIMIT 1'); // the earliest copy; `copies()` has the rest
    const parents = d.prepare('SELECT mid, via, strength FROM links WHERE rec_id = ? ORDER BY pos').all(id)
      .map((l) => ({ id: find.get(l.mid)?.id ?? null, message_id: l.mid, via: l.via, strength: l.strength }));
    const children = self.message_id
      ? d.prepare('SELECT r.id AS id, r.message_id AS message_id, l.via AS via, l.strength AS strength FROM links l JOIN rec r ON r.id = l.rec_id WHERE l.mid = ? AND r.id != ? ORDER BY r.captured, r.id LIMIT ?').all(self.message_id, id, n + 1)
      : [];
    const more = children.length > n;
    return { id, message_id: self.message_id ?? null, parents, children: more ? children.slice(0, n) : children, more };
  }, null);
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

/**
 * The direct replies to a Message-ID, for `Mailproof#replyFacts` (SPEC B10): the inbound records whose In-Reply-To
 * names it or whose last References entry is it, earliest capture first (ties by id), with the commit that added each.
 * At most REPLY_FACTS_MAX + 1 rows come back, so the caller can tell the list was cut.
 * @param {IndexCfg} cfg
 * @param {string} messageId  As stored, with the angle brackets.
 * @returns {Promise<Array<{ id: string, captured: string, commit: string }>>}
 */
export async function repliesIndex(cfg, messageId) {
  return query(cfg, (d) => d.prepare(
    `SELECT r.id AS id, r.captured AS captured, r.commit_id AS commit_id FROM links l JOIN rec r ON r.id = l.rec_id
      WHERE l.mid = ? AND l.direct = 1 AND r.direction = 'in' ORDER BY r.captured, r.id LIMIT ?`,
  ).all(messageId, REPLY_FACTS_MAX + 1).map((r) => ({ id: r.id, captured: r.captured, commit: r.commit_id ?? '' })), []);
}
