// IMAP capture (SPEC B4): a fetcher in front of `record()`. It reads raw messages from one mailbox through a
// plain-data session (imap.js, or a fake in tests) and hands each to the Mailproof instance's record path: gate,
// worker backstop, trail lock, dedup by id. It adds no second way to build a record. The one piece of state it
// owns is the resume cursor, a sidecar file beside the trail (B4.2).
//
// The server is untrusted input. The order is: size first, then bytes, then the gate; every bound is in limits.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_TOTAL_BYTES, SYNC_UID_WINDOW, SYNC_MAX_MESSAGES, SYNC_MAX_BYTES, SYNC_MAX_MESSAGE_BYTES, SYNC_MAX_MS,
  SYNC_CONNECT_MS, SYNC_SOCKET_MS, SYNC_FETCH_MS, SYNC_MAX_RECONNECTS, SYNC_RECONNECT_BACKOFF_MS,
} from './limits.js';
import { withTrailLock, syncLockFile, SYNC_LOCK, serialise } from './trail.js';
import { git } from './git.js';

/** Empty UID windows between cursor writes (each write spawns git and fsyncs). */
const EMPTY_WINDOWS_PER_PERSIST = 100;

/**
 * @typedef {Object} SyncOptions
 * @property {string} host
 * @property {number} [port]  Default 993 (implicit TLS only).
 * @property {string} user
 * @property {{ pass: string } | { accessToken: string }} auth  Exactly one of `pass` (app password) or `accessToken` (OAuth2, XOAUTH2).
 * @property {string[]} [folders]  Default `['INBOX']`; each is a folder or label path as the server names it; direction `in`.
 * @property {boolean | string} [sent]  `true` (default): the folder with the `\Sent` special-use flag; a string: that exact path; `false`: skip. Direction `out`.
 * @property {number} [maxMessages]  Per folder per run; can only lower the limits.js value.
 * @property {number} [maxBytes]  Per folder per run; can only lower the limits.js value.
 * @property {{ ca?: string | Buffer | Array<string | Buffer> }} [tls]  Extra CA (private server, tests). Certificate checking is never off.
 */

/**
 * @typedef {Object} SyncFolderResult
 * @property {string} folder
 * @property {'in' | 'out'} direction
 * @property {boolean} attempted  False: the run stopped before this folder.
 * @property {string | null} uidvalidity  Decimal string, never a Number.
 * @property {null | 'uidvalidity' | 'unreadable' | 'trail'} reset  Why the cursor was discarded and the folder rescanned from UID 1 (`trail`: the trail was restored or replaced, so the cursor could be ahead of it).
 * @property {number | null} last_uid  The cursor after this run.
 * @property {number} seen  Messages listed in the window(s) fetched this run.
 * @property {number} recorded  New records, over-limit ones included.
 * @property {number} duplicate  The id already existed.
 * @property {number} over_limit  Subset of `recorded` with `reason: "over limit: ..."`.
 * @property {Array<{ uid: number, size: number, why: string }>} skipped  Not recorded at all.
 * @property {number} bytes  Message bytes read from the server (buffered or streamed).
 * @property {boolean} complete  False when a cap was hit, an error stopped it, or it was not attempted.
 * @property {{ code: string, message: string } | null} error
 */

/**
 * @typedef {Object} SyncResult
 * @property {boolean} complete  True when every folder reached the server's end with no error and no cap hit.
 * @property {SyncFolderResult[]} folders
 */

/**
 * The plain-data session imap.js provides (B4.6); tests provide a fake.
 * @typedef {Object} ImapSession
 * @property {() => Promise<string | null>} findSent
 * @property {(path: string) => Promise<{ uidvalidity: string, uidNext: number }>} select
 * @property {(lo: number, hi: number) => Promise<Array<{ uid: number, size: number }>>} list
 * @property {(uid: number, max: number) => Promise<Buffer>} fetch
 * @property {(uid: number, max?: number) => Promise<{ sha256: string | null, size: number, over: boolean }>} hash
 *   Streams the message through a sha256, keeping nothing. Past `max` bytes it stops: `over: true`, `sha256: null`.
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {Object} OpenSessionArgs
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {{ pass: string } | { accessToken: string }} auth
 * @property {{ ca?: string | Buffer | Array<string | Buffer> }} [tls]
 * @property {{ connectMs: number, socketMs: number }} timeouts
 */

const SYNC_LIMITS = Object.freeze({
  SYNC_UID_WINDOW, SYNC_MAX_MESSAGES, SYNC_MAX_BYTES, SYNC_MAX_MESSAGE_BYTES, SYNC_MAX_MS,
  SYNC_CONNECT_MS, SYNC_SOCKET_MS, SYNC_FETCH_MS, SYNC_MAX_RECONNECTS, SYNC_RECONNECT_BACKOFF_MS, MAX_TOTAL_BYTES,
});
/** @typedef {{ [K in keyof typeof SYNC_LIMITS]: (typeof SYNC_LIMITS)[K] extends readonly number[] ? number[] : number }} SyncLimits */

const SYNC_KEYS = new Set(['host', 'port', 'user', 'auth', 'folders', 'sent', 'maxMessages', 'maxBytes', 'tls']);
const ERROR_MESSAGE_MAX = 300;

/** @param {string} code @param {string} message @returns {Error & { code: string }} */
const codedError = (code, message) => Object.assign(new Error(message), { code });

/** @param {unknown} v @returns {v is number} */
const posInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * Validate the caller's options. Throws a TypeError before any connection.
 * @param {unknown} opts
 * @returns {{ host: string, port: number, user: string, auth: { pass: string } | { accessToken: string }, folders: string[],
 *   sent: boolean | string, maxMessages: number | null, maxBytes: number | null, tls: { ca?: string | Buffer | Array<string | Buffer> } | undefined }}
 */
function parseSyncOptions(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('sync: options object required');
  const o = /** @type {Record<string, any>} */ (opts);
  for (const k of Object.keys(o)) if (!SYNC_KEYS.has(k)) throw new TypeError(`sync: unknown option "${k}"`);
  if (typeof o.host !== 'string' || !o.host) throw new TypeError('sync: host required');
  const port = o.port === undefined ? 993 : o.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('sync: port must be an integer 1-65535');
  if (typeof o.user !== 'string' || !o.user) throw new TypeError('sync: user required');
  const a = o.auth;
  if (!a || typeof a !== 'object') throw new TypeError('sync: auth required: { pass } or { accessToken }');
  const hasPass = a.pass !== undefined;
  const hasToken = a.accessToken !== undefined;
  if (hasPass === hasToken) throw new TypeError('sync: auth needs exactly one of pass or accessToken');
  for (const k of Object.keys(a)) if (k !== 'pass' && k !== 'accessToken') throw new TypeError(`sync: unknown auth field "${k}"`);
  const secret = hasPass ? a.pass : a.accessToken;
  if (typeof secret !== 'string' || !secret) throw new TypeError(`sync: auth.${hasPass ? 'pass' : 'accessToken'} must be a non-empty string`);
  const folders = o.folders === undefined ? ['INBOX'] : o.folders;
  if (!Array.isArray(folders) || folders.some((f) => typeof f !== 'string' || !f)) throw new TypeError('sync: folders must be an array of non-empty strings');
  const sent = o.sent === undefined ? true : o.sent;
  if (typeof sent !== 'boolean' && !(typeof sent === 'string' && sent)) throw new TypeError('sync: sent must be a boolean or a folder path');
  for (const k of /** @type {const} */ (['maxMessages', 'maxBytes'])) {
    if (o[k] !== undefined && !posInt(o[k])) throw new TypeError(`sync: ${k} must be a positive integer`);
  }
  let tls;
  if (o.tls !== undefined) {
    if (!o.tls || typeof o.tls !== 'object') throw new TypeError('sync: tls must be an object');
    for (const k of Object.keys(o.tls)) if (k !== 'ca') throw new TypeError(`sync: unknown tls option "${k}" (certificate checking is never off; only tls.ca can be added)`);
    tls = o.tls.ca === undefined ? {} : { ca: o.tls.ca };
  }
  return {
    host: o.host, port, user: o.user,
    auth: hasPass ? { pass: a.pass } : { accessToken: a.accessToken },
    folders: [...folders], sent, maxMessages: o.maxMessages ?? null, maxBytes: o.maxBytes ?? null, tls,
  };
}

/**
 * The caps in force for one folder: a caller can only lower the limits.js value (B4.3).
 * @param {{ maxMessages?: number | null, maxBytes?: number | null }} opts
 * @param {Pick<SyncLimits, 'SYNC_MAX_MESSAGES' | 'SYNC_MAX_BYTES'>} [limits]
 * @returns {{ maxMessages: number, maxBytes: number }}
 */
function effectiveCaps(opts, limits = SYNC_LIMITS) {
  return {
    maxMessages: Math.min(opts.maxMessages ?? Infinity, limits.SYNC_MAX_MESSAGES),
    maxBytes: Math.min(opts.maxBytes ?? Infinity, limits.SYNC_MAX_BYTES),
  };
}

// ---- cursor file (B4.2) ----

/** @typedef {{ uidvalidity: string, last_uid: number, updated: string }} CursorEntry */
/** @typedef {{ v: 1, head: string | null, accounts: Record<string, Record<string, CursorEntry>> }} CursorFile  `head`: the trail's git HEAD when the file was last written (null: no commits yet). */

/** @param {string} trailDir @param {string} trail @returns {string} */
const cursorPath = (trailDir, trail) => path.join(trailDir, `.${trail}.sync.json`);

/**
 * Read the cursor file. Absent is normal; unparseable or wrong-`v` counts as absent but is reported, so every
 * folder rescans (`reset: 'unreadable'`).
 * @param {string} file
 * @returns {Promise<{ data: CursorFile, unreadable: boolean }>}
 */
async function readCursorFile(file) {
  /** @type {CursorFile} */
  const empty = { v: 1, head: null, accounts: {} };
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { data: empty, unreadable: false };
    return { data: empty, unreadable: true };
  }
  try {
    const j = JSON.parse(text);
    if (j && j.v === 1 && j.accounts && typeof j.accounts === 'object' && !Array.isArray(j.accounts)) return { data: j, unreadable: false };
  } catch { /* fall through */ }
  return { data: empty, unreadable: true };
}

/**
 * The trail's git HEAD, or null when it has no commits (or is not initialised yet).
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function trailHead(root) {
  try { await fs.access(path.join(root, '.git')); } catch { return null; } // never pick up an enclosing repo's HEAD
  try { return await git(root, ['rev-parse', '--verify', '-q', 'HEAD']) || null; } catch { return null; }
}

/**
 * Is the cursor file consistent with the trail? False when the trail was restored from an older backup or replaced
 * (the file's `head` is not the current HEAD or an ancestor of it) or is now empty: the cursor could then be ahead
 * of the trail. A file written while the trail had no commits (`head: null`) is consistent with any trail.
 * @param {string} root
 * @param {CursorFile} data
 * @returns {Promise<boolean>}
 */
async function cursorMatchesTrail(root, data) {
  const now = await trailHead(root);
  if (data.head === null) return true; // written while the trail had no commits: nothing it points at can be missing
  if (now === null || typeof data.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(data.head)) return false;
  try { await git(root, ['merge-base', '--is-ancestor', data.head, now]); return true; } catch { return false; }
}

/**
 * Write the cursor file whole: temp file in the same directory, fsync, rename. A reader sees the old or the new
 * file, never half.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeCursorFile(file, text) {
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
}

/**
 * @param {unknown} e
 * @returns {e is CursorEntry}
 */
function validCursorEntry(e) {
  const c = /** @type {Record<string, unknown> | null} */ (e);
  return Boolean(c) && typeof c === 'object' && typeof c?.uidvalidity === 'string' && /^\d{1,20}$/.test(c.uidvalidity)
    && typeof c.last_uid === 'number' && Number.isSafeInteger(c.last_uid) && c.last_uid >= 0;
}

// ---- failures (internal control flow) ----

/** An IMAP-side failure classified for the policy: `retryable` means the connection is gone and a reconnect may help. */
class ImapFailure extends Error {
  /** @param {string} code @param {string} message @param {boolean} retryable */
  constructor(code, message, retryable) { super(message); this.code = code; this.retryable = retryable; }
}
/** A record() or cursor-write failure: the trail is shared by every folder, so the run stops. */
class TrailFailure extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}
/** Makes the whole run pointless (auth refused on a reconnect): rethrown to the caller. */
class RunFailure extends Error {
  /** @param {Error & { code: string }} cause */
  constructor(cause) { super(cause.message); this.cause = cause; this.code = cause.code; }
}

/**
 * Run an operation under a wall deadline. On expiry the session is closed (so the pending call settles and the
 * connection is not reused) and the result is a retryable timeout.
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {() => Promise<void>} onExpire
 * @returns {Promise<T>}
 */
function withDeadline(p, ms, onExpire) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onExpire().catch(() => {});
      reject(new ImapFailure('ERR_IMAP_TIMEOUT', `reading one message took longer than ${ms} ms`, true));
    }, ms);
  });
  p.catch(() => {}); // the loser of the race must not become an unhandled rejection
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer));
}

/** @param {number} ms @returns {Promise<void>} */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {Object} SyncDeps
 * @property {(args: OpenSessionArgs) => Promise<ImapSession>} openSession
 * @property {(ms: number) => Promise<void>} [sleep]  Backoff wait (tests inject a no-op).
 * @property {Partial<SyncLimits>} [limits]  Lowered limits (tests); defaults are the limits.js values.
 * @property {(file: string, text: string) => Promise<void>} [writeCursorFile]  Cursor writer (tests inject faults).
 * @property {() => number} [clock]  Milliseconds (tests inject).
 */

/**
 * @typedef {Object} SyncHost  The part of a Mailproof instance that sync uses.
 * @property {string} root
 * @property {string} trail
 * @property {(raw: Buffer, ctx: { direction: 'in' | 'out', source: string }) => Promise<{ duplicate: boolean, record?: import('./types.js').MpRecord }>} record
 * @property {() => Promise<unknown>} [expireContent]  Retention sweep of the content store, called once at the end of a run (errors ignored).
 * @property {(digest: { raw_sha256: string, size: number }, ctx: { direction: 'in' | 'out', source: string }) => Promise<{ duplicate: boolean, record?: import('./types.js').MpRecord }>} recordDigest
 */

/**
 * Run one sync (SPEC B4). Holds the sync lock for the whole call (fail-fast) and never the trail lock across IMAP I/O.
 * @param {SyncHost} host
 * @param {unknown} rawOpts
 * @param {SyncDeps} deps
 * @returns {Promise<SyncResult>}
 * @throws {TypeError} on bad options, before any connection.
 * @throws {Error & { code: 'ERR_IMAP_AUTH' | 'ERR_IMAP_CONNECT' | 'ERR_SYNC_LOCKED' }}
 */
async function runSync(host, rawOpts, deps) {
  const opts = parseSyncOptions(rawOpts);
  /** @type {SyncLimits} */
  const L = /** @type {SyncLimits} */ ({ ...SYNC_LIMITS, ...deps.limits });
  const caps = effectiveCaps(opts, L);
  const secret = 'pass' in opts.auth ? opts.auth.pass : opts.auth.accessToken;
  const sleep = deps.sleep ?? realSleep;
  const clock = deps.clock ?? Date.now;
  const writeFile = deps.writeCursorFile ?? writeCursorFile;
  const trailDir = path.dirname(host.root);
  const account = `${opts.host}/${opts.user}`;
  const file = cursorPath(trailDir, host.trail);

  /** Never let the credential reach a message, whoever built it. @param {unknown} s @returns {string} */
  const clean = (s) => String(s ?? '').split(secret).join('[redacted]').slice(0, ERROR_MESSAGE_MAX);

  /** @param {unknown} err @returns {ImapFailure} */
  const classify = (err) => {
    const e = /** @type {any} */ (err);
    if (e instanceof ImapFailure) return new ImapFailure(e.code, clean(e.message), e.retryable);
    const code = typeof e?.code === 'string' && e.code.startsWith('ERR_IMAP_') ? e.code : 'ERR_IMAP_PROTOCOL';
    return new ImapFailure(code, clean(e?.message), e?.retryable === true);
  };

  return withTrailLock(host.root, syncLockFile(host.trail), 0, async () => {
    const start = clock();
    const cur = await readCursorFile(file);
    // A trail restored or replaced under a surviving cursor: drop the cursor, remember which folders had one (B4.2).
    /** @type {Set<string>} */
    const staleFolders = new Set();
    if (!cur.unreadable && Object.keys(cur.data.accounts).length > 0 && !(await cursorMatchesTrail(host.root, cur.data))) {
      for (const f of Object.keys(cur.data.accounts[account] ?? {})) staleFolders.add(f);
      cur.data.accounts = {};
    }
    const openArgs = /** @type {OpenSessionArgs} */ ({
      host: opts.host, port: opts.port, user: opts.user, auth: opts.auth,
      ...(opts.tls ? { tls: opts.tls } : {}),
      timeouts: { connectMs: L.SYNC_CONNECT_MS, socketMs: L.SYNC_SOCKET_MS },
    });

    /** @type {ImapSession | null} */
    let sess = null;
    let reconnects = 0;
    /** @type {ImapFailure} */
    let lastDrop = new ImapFailure('ERR_IMAP_PROTOCOL', 'connection lost', true);

    /** The first connection: any failure makes the run pointless. @returns {Promise<ImapSession>} */
    const openFirst = async () => {
      try { return await deps.openSession(openArgs); }
      catch (err) {
        const f = classify(err);
        throw codedError(f.code === 'ERR_IMAP_AUTH' ? 'ERR_IMAP_AUTH' : 'ERR_IMAP_CONNECT', f.message);
      }
    };

    /** A usable session, reconnecting (with backoff, within the run's budget) when the last one dropped. @returns {Promise<ImapSession>} */
    const session = async () => {
      if (sess) return sess;
      for (;;) {
        if (reconnects >= L.SYNC_MAX_RECONNECTS) {
          throw new ImapFailure(lastDrop.code, clean(`reconnect limit reached: ${lastDrop.message}`), false);
        }
        await sleep(L.SYNC_RECONNECT_BACKOFF_MS[Math.min(reconnects, L.SYNC_RECONNECT_BACKOFF_MS.length - 1)] ?? 0);
        reconnects++;
        try { sess = await deps.openSession(openArgs); return sess; }
        catch (err) {
          const f = classify(err);
          if (f.code === 'ERR_IMAP_AUTH') throw new RunFailure(codedError('ERR_IMAP_AUTH', f.message));
          lastDrop = f.retryable ? f : new ImapFailure(f.code === 'ERR_IMAP_CONNECT' ? 'ERR_IMAP_TIMEOUT' : f.code, f.message, true);
        }
      }
    };

    /** @param {ImapFailure} why */
    const dropSession = (why) => {
      lastDrop = why;
      const s = sess;
      sess = null;
      s?.close().catch(() => {});
    };

    /**
     * One IMAP call, its failure classified. @template T @param {() => Promise<T>} fn @returns {Promise<T>}
     */
    const io = async (fn) => {
      try { return await fn(); } catch (err) { throw classify(err); }
    };

    sess = await openFirst();
    /** @type {SyncFolderResult[]} */
    const results = [];
    let stopped = false;

    /** @param {string} folder @param {'in' | 'out'} direction @returns {SyncFolderResult} */
    const newEntry = (folder, direction) => ({
      folder, direction, attempted: true, uidvalidity: null, reset: null, last_uid: null, seen: 0, recorded: 0,
      duplicate: 0, over_limit: 0, skipped: [], bytes: 0, complete: false, error: null,
    });

    /**
     * Store a folder's cursor and rewrite the file.
     * @param {string} folder @param {string} uidvalidity @param {number} lastUid
     */
    const persist = async (folder, uidvalidity, lastUid) => {
      const acct = (cur.data.accounts[account] ??= {});
      acct[folder] = { uidvalidity, last_uid: lastUid, updated: new Date(clock()).toISOString() };
      /** @type {CursorFile} */
      const out = { v: 1, head: await trailHead(host.root), accounts: {} };
      for (const [a, folders] of Object.entries(cur.data.accounts)) out.accounts[a] = folders;
      try { await writeFile(file, serialise(out)); }
      catch (err) { throw new TrailFailure(typeof (/** @type {any} */ (err))?.code === 'string' ? /** @type {any} */ (err).code : 'ERR_SYNC_CURSOR', clean(/** @type {any} */ (err)?.message)); }
    };

    /**
     * Sync one folder, reconnecting on drops. @param {string} folderPath @param {'in' | 'out'} direction
     * @returns {Promise<SyncFolderResult>}
     */
    const syncFolder = async (folderPath, direction) => {
      const e = newEntry(folderPath, direction);
      const source = `imap:${folderPath}`;
      let last = 0;
      let handled = 0;
      let firstPass = true;
      let dirty = false; // `last` moved past empty windows without being stored
      let emptyWindows = 0;
      /** @type {ImapFailure | TrailFailure | null} */
      let failure = null;

      // eslint-disable-next-line no-constant-condition
      for (;;) {
        try {
          const s = await session();
          const sel = await io(() => s.select(folderPath));
          if (firstPass) {
            firstPass = false;
            const stored = cur.data.accounts[account]?.[folderPath];
            if (cur.unreadable || (stored !== undefined && !validCursorEntry(stored))) { e.reset = 'unreadable'; last = 0; }
            else if (stored === undefined && staleFolders.has(folderPath)) { e.reset = 'trail'; last = 0; }
            else if (stored !== undefined && stored.uidvalidity !== sel.uidvalidity) { e.reset = 'uidvalidity'; last = 0; }
            else if (stored !== undefined) last = stored.last_uid;
            e.uidvalidity = sel.uidvalidity;
            e.last_uid = last;
            if (e.reset !== null || stored === undefined) await persist(folderPath, sel.uidvalidity, last);
          } else if (sel.uidvalidity !== e.uidvalidity) {
            throw new ImapFailure('ERR_IMAP_UIDVALIDITY', 'UIDVALIDITY changed during the run; the next run rescans the folder', false);
          }

          const target = sel.uidNext - 1;
          /** Store the cursor if empty windows moved it (at-least-once plus dedup covers a crash before this). */
          const flush = async () => { if (dirty) { dirty = false; emptyWindows = 0; await persist(folderPath, sel.uidvalidity, last); } };
          while (last < target) {
            // the run clock is checked per window too: a huge UIDNEXT over an empty folder is many windows, no messages
            if (clock() - start > L.SYNC_MAX_MS) { stopped = true; await flush(); e.last_uid = last; return e; }
            const hi = Math.min(last + L.SYNC_UID_WINDOW, target);
            const lo = last + 1;
            const listed = await io(() => s.list(lo, hi));
            // The server is untrusted about its own range handling (the `N:*` quirk, F17.5): keep only (last, hi].
            const byUid = new Map();
            for (const m of Array.isArray(listed) ? listed : []) {
              if (m && Number.isSafeInteger(m.uid) && m.uid > last && m.uid <= hi && !byUid.has(m.uid)) {
                byUid.set(m.uid, Number.isSafeInteger(m.size) && m.size >= 0 ? m.size : 0);
              }
            }
            const msgs = [...byUid.entries()].sort((a, b) => a[0] - b[0]).slice(0, L.SYNC_UID_WINDOW);
            e.seen += msgs.length;
            for (const [uid, size] of msgs) {
              if (handled >= caps.maxMessages || e.bytes >= caps.maxBytes) { await flush(); e.last_uid = last; return e; }
              if (clock() - start > L.SYNC_MAX_MS) { stopped = true; await flush(); e.last_uid = last; return e; }
              await handleMessage(s, e, uid, size, source, direction);
              handled++;
              last = uid;
              e.last_uid = last;
              await persist(folderPath, sel.uidvalidity, last);
            }
            last = hi; // everything in (last, hi] was handled; UIDs with no message are gone
            e.last_uid = last;
            // an empty window only advances the cursor in memory; store it every EMPTY_WINDOWS_PER_PERSIST windows
            if (msgs.length === 0 && ++emptyWindows < EMPTY_WINDOWS_PER_PERSIST) dirty = true;
            else { dirty = false; emptyWindows = 0; await persist(folderPath, sel.uidvalidity, last); }
          }
          await flush();
          e.complete = true;
          return e;
        } catch (err) {
          if (err instanceof RunFailure) throw err.cause;
          if (err instanceof TrailFailure) { failure = err; stopped = true; }
          else {
            const f = classify(err);
            if (f.code === 'ERR_IMAP_AUTH') throw codedError('ERR_IMAP_AUTH', f.message);
            if (f.retryable) { dropSession(f); continue; }
            failure = f;
          }
          e.error = { code: /** @type {string} */ (failure.code), message: clean(failure.message) };
          e.complete = false;
          return e;
        }
      }
    };

    /**
     * One message: size first, then bytes, then the gate (B4.3). Updates the folder's counters; throws on a drop
     * (ImapFailure) or a trail failure (TrailFailure).
     * @param {ImapSession} s @param {SyncFolderResult} e @param {number} uid @param {number} size
     * @param {string} source @param {'in' | 'out'} direction
     */
    const handleMessage = async (s, e, uid, size, source, direction) => {
      const ctx = { direction, source };
      /** @param {{ duplicate: boolean, record?: import('./types.js').MpRecord }} r */
      const count = (r) => {
        if (r.duplicate) { e.duplicate++; return; }
        e.recorded++;
        if (r.record?.verdicts?.live?.reason?.startsWith('over limit')) e.over_limit++;
      };
      /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
      const guarded = (fn) => io(() => withDeadline(fn(), L.SYNC_FETCH_MS, () => s.close()));
      /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
      const trail = async (fn) => {
        try { return await fn(); }
        catch (err) { throw new TrailFailure(typeof (/** @type {any} */ (err))?.code === 'string' ? /** @type {any} */ (err).code : 'ERR_RECORD', clean(/** @type {any} */ (err)?.message)); }
      };
      /** @param {string} why */
      const skip = (why) => { e.skipped.push({ uid, size, why }); };

      if (size > L.SYNC_MAX_MESSAGE_BYTES) { skip(`larger than SYNC_MAX_MESSAGE_BYTES (${L.SYNC_MAX_MESSAGE_BYTES})`); return; }

      /** Stream-hash the message and record the over-limit record from its digest. @returns {Promise<boolean>} True when handled. */
      const viaHash = async () => {
        const h = await guarded(() => s.hash(uid, L.SYNC_MAX_MESSAGE_BYTES));
        e.bytes += h.size;
        if (h.over || h.sha256 === null) { skip(`larger than SYNC_MAX_MESSAGE_BYTES (${L.SYNC_MAX_MESSAGE_BYTES})`); return true; }
        if (h.size === 0) { skip('empty or no longer on the server'); return true; }
        if (h.size <= L.MAX_TOTAL_BYTES) return false; // the listed size was wrong and the message is small: read it for real
        count(await trail(() => host.recordDigest({ raw_sha256: `sha256:${h.sha256}`, size: h.size }, ctx)));
        return true;
      };

      if (size > L.MAX_TOTAL_BYTES && await viaHash()) return;

      const buf = await guarded(() => s.fetch(uid, L.MAX_TOTAL_BYTES + 1));
      e.bytes += buf.length;
      if (buf.length > L.MAX_TOTAL_BYTES) { // the server lied about the size: at most the gate limit plus one byte was read
        if (await viaHash()) return;
        throw new ImapFailure('ERR_IMAP_PROTOCOL', 'the server gave inconsistent sizes for one message', false);
      }
      if (buf.length === 0) { skip('empty or no longer on the server'); return; }
      count(await trail(() => host.record(buf, ctx)));
    };

    try {
      // The \Sent lookup is only needed to find the Sent folder (sent: true) and to tag a listed one as `out`. A failure
      // is tolerated when it is not needed (sent off, or a path given): no Sent folder is known, listed folders stay `in`.
      // When Sent is requested, a connect or auth failure ends the run; anything else (throttled, protocol, timeout) lands
      // on the \Sent entry like ERR_IMAP_NO_SENT, and the other folders still sync.
      /** @type {{ failure: ImapFailure | null }} */
      const sentLookup = { failure: null };
      const known = await io(() => /** @type {ImapSession} */ (sess).findSent()).catch((err) => {
        const f = classify(err);
        if (opts.sent === false || typeof opts.sent === 'string') return null;
        if (f.code === 'ERR_IMAP_CONNECT' || f.code === 'ERR_IMAP_AUTH') throw codedError(f.code, f.message);
        sentLookup.failure = f;
        return null;
      });
      /** @type {Array<{ path: string, direction: 'in' | 'out' }>} */
      const plan = [];
      const seen = new Set();
      const add = (/** @type {string} */ p, /** @type {'in' | 'out'} */ direction) => { if (!seen.has(p)) { seen.add(p); plan.push({ path: p, direction }); } };
      // a folder that is the \Sent one (or the chosen sent path) is `out` wherever it was listed
      const sentPath = typeof opts.sent === 'string' ? opts.sent : known;
      for (const f of opts.folders) add(f, f === sentPath ? 'out' : 'in');
      /** @type {SyncFolderResult | null} */
      let noSent = null;
      if (opts.sent !== false) {
        if (sentPath) add(sentPath, 'out');
        else {
          noSent = newEntry('\\Sent', 'out');
          noSent.error = sentLookup.failure
            ? { code: sentLookup.failure.code, message: sentLookup.failure.message }
            : { code: 'ERR_IMAP_NO_SENT', message: 'no folder with the \\Sent special-use flag; pass sent: "<path>" or sent: false' };
        }
      }
      for (const item of plan) {
        if (stopped) {
          const skippedEntry = newEntry(item.path, item.direction);
          skippedEntry.attempted = false;
          results.push(skippedEntry);
          continue;
        }
        results.push(await syncFolder(item.path, item.direction));
      }
      if (noSent) { if (stopped) noSent.attempted = false; results.push(noSent); }
    } finally {
      const s = sess;
      sess = null;
      if (s) await s.close().catch(() => {});
    }
    // Retention (SPEC B7): once per run, after the mailbox work. A failure here never fails the run (records are in).
    if (host.expireContent) await host.expireContent().catch(() => {});
    return { complete: results.every((r) => r.complete), folders: results };
  }, SYNC_LOCK);
}

export { runSync, parseSyncOptions, effectiveCaps, readCursorFile, writeCursorFile, cursorPath, withDeadline };
