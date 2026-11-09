// The on-disk trail (SPEC Part B3): one git repo per trail, one commit per
// record. Records and archived keys are plain files in the working tree, so a
// `git clone` is the portable proof. A trail has a single writer at a time:
// in-process by a mutex keyed on the trail path, across processes (Postfix runs
// one process per mail) by a lock file `<trailDir>/.<trail>.lock` beside the
// repo, so it also guards the first `git init`. The lock is held across the
// whole critical section (duplicate check, file writes, git add/commit, OTS).
// Local filesystems only: O_EXCL is not reliable on NFS.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, GIT_IDENTITY } from './git.js';
import { DKIM_LABEL_RE } from './keys.js';
import { withMutex } from './mutex.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */

const TRAIL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RECORD_ID_RE = /^[0-9a-f]{32}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 30000;

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Stable serialisation: insertion order, 2-space indent, trailing newline.
 * @param {unknown} obj
 * @returns {string}
 */
function serialise(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is `pid` alive on this host? EPERM means it exists but is not ours.
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code !== 'ESRCH'; }
}

/**
 * Parse a `{pid, host, started}` lock file's text, or null when it is not one.
 * @param {string} text
 * @returns {{ pid: number, host: string } | null}
 */
function parseLock(text) {
  try {
    const info = JSON.parse(text);
    if (info && typeof info === 'object' && Number.isInteger(info.pid) && typeof info.host === 'string') return info;
  } catch { /* unparseable */ }
  return null;
}

/** A break lock is held for milliseconds; past this age it is stale whoever owns it. */
const BREAK_MIN_STALE_MS = 10000;

/**
 * Remove an abandoned break lock by a plain unlink (never by taking it over
 * through another lock: that would recurse). Stale = same host with a dead pid,
 * or older than max(timeoutMs, 10 s). The content is re-read just before the
 * unlink so a break lock re-acquired in between is left alone.
 * @param {string} breakPath
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}  True when the break lock is gone or was removed (caller retries).
 */
async function clearStaleBreakLock(breakPath, timeoutMs) {
  let text;
  let mtimeMs;
  try { text = await fs.readFile(breakPath, 'utf8'); mtimeMs = (await fs.stat(breakPath)).mtimeMs; }
  catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT'; } // vanished: retry; unreadable (EISDIR, EACCES...): not ours to clear
  const info = parseLock(text);
  const old = Date.now() - mtimeMs > Math.max(timeoutMs, BREAK_MIN_STALE_MS);
  const stale = old || (info !== null && info.host === os.hostname() && !pidAlive(info.pid));
  if (!stale) return false;
  try {
    if ((await fs.readFile(breakPath, 'utf8')) !== text) return false; // re-acquired meanwhile
    await fs.unlink(breakPath);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT'; // gone already; any other failure: back off
  }
  return true;
}

/**
 * Remove the lock at `lockPath` only when it is provably stale: written by a
 * dead pid on THIS host, or unparseable and older than `timeoutMs`. A live or
 * other-host lock is never touched.
 *
 * Why this is atomic enough. Read-then-unlink is two steps, so two takers could
 * both judge the same dead lock stale and the second unlink could hit a live
 * lock the first taker had just created. The unlink therefore happens only
 * while holding the break lock `<lock>.break` (an `O_EXCL` file, so one holder
 * at a time). While the main lock is held by a dead owner, nothing but a
 * break-lock holder may remove it: the owner never releases (it is dead), a
 * live writer's release only removes its own lock, and acquirers need the file
 * absent. So between the holder's re-read ("still the content judged stale")
 * and its unlink the main lock cannot change, and the unlink cannot hit a live
 * lock. A waiter that does not get the break lock does not touch the main lock;
 * it backs off. The one residual window is a break lock abandoned by a crash and
 * removed by two waiters at once (the stale rule in clearStaleBreakLock).
 * @param {string} lockPath
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}  True when the caller should retry the open at once; false to back off.
 */
async function takeOverIfStale(lockPath, timeoutMs) {
  let text;
  let mtimeMs;
  try { text = await fs.readFile(lockPath, 'utf8'); mtimeMs = (await fs.stat(lockPath)).mtimeMs; }
  catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT'; } // vanished: retry the open; unreadable (EISDIR, EACCES...): back off
  const info = parseLock(text);
  const stale = info ? info.host === os.hostname() && !pidAlive(info.pid) : Date.now() - mtimeMs > timeoutMs;
  if (!stale) return false;

  const breakPath = `${lockPath}.break`;
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
  try {
    const fh = await fs.open(breakPath, 'wx');
    try { await fh.writeFile(mine); } finally { await fh.close(); }
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
    return clearStaleBreakLock(breakPath, timeoutMs); // held by someone else: back off, unless it is abandoned
  }
  try {
    try { if ((await fs.readFile(lockPath, 'utf8')) !== text) return false; }
    catch { return true; } // vanished meanwhile
    try { await fs.unlink(lockPath); } catch { /* already gone */ }
    return true;
  } finally {
    try { if ((await fs.readFile(breakPath, 'utf8')) === mine) await fs.unlink(breakPath); } catch { /* already gone */ }
  }
}

/** Lock-file name of the trail's writer lock, beside the repo. */
const trailLockFile = (/** @type {string} */ name) => `.${name}.lock`;
/** File name of the trail's index (SPEC B5), beside the repo and outside git. A cache: safe to delete. */
const trailIndexFile = (/** @type {string} */ name) => `.${name}.index.sqlite`;
/** Lock-file name of the sync lock (SPEC B4.5), beside the repo. */
const syncLockFile = (/** @type {string} */ name) => `.${name}.sync.lock`;

/** @typedef {{ code: string, failFast: boolean, what: string }} LockKind */
/** @type {LockKind} The trail writer lock: waits up to the timeout. */
const TRAIL_LOCK = Object.freeze({ code: 'ERR_TRAIL_LOCKED', failFast: false, what: 'trail' });
/** @type {LockKind} The sync lock: same mechanism, but a held lock fails at once (a cron run should skip, not queue). */
const SYNC_LOCK = Object.freeze({ code: 'ERR_SYNC_LOCKED', failFast: true, what: 'sync of trail' });

/** Fail-fast locks held by this process (they skip the queueing mutex, so a second holder must be refused here). */
const heldFailFast = new Set();

/**
 * Run `work` while holding a cross-process lock file `<dirname(root)>/<lockFile>` (and, for a waiting lock, the
 * in-process mutex). One implementation serves the trail lock and the sync lock; `kind` picks the error and whether
 * a held lock is waited for (TRAIL_LOCK, default) or refused at once (SYNC_LOCK).
 * @template T
 * @param {string} root  The trail directory.
 * @param {string} lockFile  Lock file name, e.g. `.default.lock` (see trailLockFile, syncLockFile).
 * @param {number} timeoutMs  How long to wait for a held lock (a fail-fast lock never waits). Also the age past which an
 *   unparseable lock counts as stale, except that a fail-fast lock uses DEFAULT_LOCK_TIMEOUT_MS for that.
 * @param {() => Promise<T>} work
 * @param {LockKind} [kind]
 * @returns {Promise<T>}
 * @throws {Error & { code: string }} `kind.code` when the lock is not obtained.
 */
async function withTrailLock(root, lockFile, timeoutMs, work, kind = TRAIL_LOCK) {
  const lockPath = path.join(path.dirname(root), lockFile);
  const run = async () => {
    await fs.mkdir(path.dirname(root), { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
    const staleMs = kind.failFast ? DEFAULT_LOCK_TIMEOUT_MS : timeoutMs;
    const deadline = Date.now() + (kind.failFast ? 0 : timeoutMs);
    let delay = 20;
    let takeovers = 0;
    for (;;) {
      try {
        const fh = await fs.open(lockPath, 'wx');
        try { await fh.writeFile(mine); } finally { await fh.close(); }
        break;
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      }
      // never loops past the deadline; a fail-fast lock has none, so it retries after a takeover a few times instead
      if (await takeOverIfStale(lockPath, staleMs) && (kind.failFast ? ++takeovers <= 3 : Date.now() < deadline)) continue;
      if (kind.failFast || Date.now() >= deadline) {
        throw Object.assign(new Error(`${kind.what} "${path.basename(root)}" is locked by another writer (${lockPath})`), { code: kind.code });
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())) * (0.5 + Math.random() / 2));
      delay = Math.min(delay * 2, 500);
    }
    try { return await work(); }
    finally {
      // Read-then-unlink is safe here: this lock is ours and its pid (ours) is alive,
      // so takeOverIfStale never judges it stale and nobody else removes it.
      try { if ((await fs.readFile(lockPath, 'utf8')) === mine) await fs.unlink(lockPath); } catch { /* already gone */ }
    }
  };
  if (!kind.failFast) return withMutex(lockPath, run);
  if (heldFailFast.has(lockPath)) {
    throw Object.assign(new Error(`${kind.what} "${path.basename(root)}" is locked by another writer in this process (${lockPath})`), { code: kind.code });
  }
  heldFailFast.add(lockPath);
  try { return await run(); } finally { heldFailFast.delete(lockPath); }
}

/**
 * Is `rel` tracked by git (index or HEAD)?
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<boolean>}
 */
async function isTracked(root, rel) {
  try { await git(root, ['ls-files', '--error-unmatch', '--', rel]); return true; }
  catch { return false; }
}

/**
 * Does HEAD exist (at least one commit)?
 * @param {string} root
 * @returns {Promise<boolean>}
 */
async function hasHead(root) {
  try { await git(root, ['rev-parse', '--verify', '-q', 'HEAD']); return true; }
  catch { return false; }
}

/**
 * Is `rel` committed in HEAD? (Not "exists on disk": a crashed writer can leave
 * files that were never committed.)
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<boolean>}
 */
async function inHead(root, rel) {
  try { await git(root, ['cat-file', '-e', `HEAD:${rel}`]); return true; }
  catch { return false; }
}

/**
 * The trail's HEAD commit, or null when there is no repo or no commit. Never throws.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function headOf(root) {
  try { return (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) || null; } catch { return null; }
}

/**
 * Is commit `a` an ancestor of (or equal to) `b`? False on any git failure.
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function isAncestor(root, a, b) {
  try { await git(root, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}

/**
 * Ids of the records added or changed between commit `since` and HEAD (as the index catch-up reads them).
 * @param {string} root
 * @param {string} since
 * @returns {Promise<string[]>}
 */
async function recordIdsSince(root, since) {
  const out = await git(root, ['diff', '--name-only', '--no-renames', '-z', since, 'HEAD', '--', 'records']);
  /** @type {string[]} */
  const ids = [];
  for (const p of out.split('\0')) {
    const m = /^records\/([0-9a-f]{32})\.json$/.exec(p);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * Create the trail's repo on first use. Idempotent and crash-safe: it is done
 * only once the first commit exists, so a repo that was initialised but never
 * committed (or a `trail.json` written but not committed) is finished on the
 * next call. Caller holds the trail lock.
 * @param {string} root
 * @param {string} name
 * @param {string} createdIso
 * @returns {Promise<void>}
 */
async function ensureTrail(root, name, createdIso) {
  if (await exists(path.join(root, '.git')) && await hasHead(root)) return;
  await fs.mkdir(path.join(root, 'records'), { recursive: true });
  if (!(await exists(path.join(root, 'trail.json')))) {
    await fs.writeFile(path.join(root, 'trail.json'), serialise({ v: 2, name, created: createdIso }));
  }
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', GIT_IDENTITY.name]);
  await git(root, ['config', 'user.email', GIT_IDENTITY.email]);
  await git(root, ['add', 'trail.json']);
  await git(root, ['commit', '-m', 'trail created']);
}

/**
 * Is `rel` (a trail-relative, `/`-separated path) a file mailproof itself writes?
 *   records/<32 lowercase hex>.json         the record
 *   records/<32 lowercase hex>.json.ots     its OpenTimestamps proof
 *   replies/<32 lowercase hex>.<slug>.json  a reply-text record (slug: the stripper version, [a-z0-9-]+)
 *   keys/<domain>/<selector>/<16 hex>.json  an archived DKIM key (domain and selector
 *                                           lowercase, the characters fetchDkimKey allows)
 * @param {string} rel
 * @returns {boolean}
 */
function isLibraryFile(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'records' && parts.length === 2) {
    const m = /^(.+)\.json(\.ots)?$/.exec(parts[1]);
    return m !== null && RECORD_ID_RE.test(m[1]);
  }
  if (parts[0] === 'replies' && parts.length === 2) return /^[0-9a-f]{32}\.[a-z0-9-]+\.json$/.test(parts[1]);
  if (parts[0] === 'keys' && parts.length === 4) {
    const label = (/** @type {string} */ l) => DKIM_LABEL_RE.test(l) && l === l.toLowerCase() && !l.startsWith('.') && !l.includes('..');
    return label(parts[1]) && label(parts[2]) && /^[0-9a-f]{16}\.json$/.test(parts[3]);
  }
  return false;
}

/**
 * Clear what a crashed writer left half-done: staged changes, and the untracked
 * files mailproof itself writes under `records/` and `keys/` (see isLibraryFile).
 * Anything else there is left alone. Safe because only the lock holder writes,
 * and tracked files are never touched. Needs a HEAD.
 * @param {string} root
 * @returns {Promise<void>}
 */
async function clearLeftovers(root) {
  await git(root, ['reset', '-q']);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'records', 'keys', 'replies'])).split('\0').filter(Boolean);
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const rel of untracked) {
    if (!isLibraryFile(rel)) continue;
    await fs.rm(path.join(root, rel), { force: true });
    if (rel.startsWith('keys/')) { dirs.add(path.dirname(rel)); dirs.add(path.dirname(path.dirname(rel))); }
  }
  // drop the key directories this pass emptied (deepest first); rmdir refuses a non-empty one
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await fs.rmdir(path.join(root, d)); } catch { /* not empty, or gone */ }
  }
  await fs.mkdir(path.join(root, 'records'), { recursive: true });
}

/**
 * Read a record by id; null when absent, malformed or the id is not 32 hex.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<MpRecord | null>}
 */
async function readRecord(root, id) {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(root, 'records', `${id}.json`), 'utf8')); }
  catch { return null; }
}

/**
 * All record ids in the trail's working tree.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listIds(root) {
  try {
    return (await fs.readdir(path.join(root, 'records')))
      .filter((f) => f.endsWith('.json') && RECORD_ID_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5));
  } catch { return []; }
}

/**
 * Write one file (+ any new key files) and commit them as one commit, under the trail lock. The one write path of
 * records (`commitRecord`) and of reply-text records (B6). A file that is committed in HEAD is a no-op
 * (`duplicate`); the start of every call first clears a crashed writer's leftovers. On any failure only the
 * files this call newly created (and git does not track) are removed, so the tree is never left dirty and no
 * committed file is touched.
 * @param {string} root
 * @param {string} name
 * @param {{ rel: string, json: unknown, requires?: string, keyFiles?: Array<{ rel: string, json: unknown }>, message: string, now: () => Date,
 *           afterWrite?: (fileAbs: string) => Promise<string[]>,
 *           sideFiles?: (duplicate: boolean) => Promise<string[]>,
 *           lockTimeoutMs?: number }} job
 *   `sideFiles` writes files outside git (the content store, SPEC B7), under the same lock: it is called with `true`
 *   when the file is already committed (a backfill) and with `false` just before the git commit. It must not throw
 *   (a side-file problem never loses the proof); it returns the absolute paths it newly created, which are removed
 *   if the commit fails.
 *   `rel` is the trail-relative path of the file and `json` its content. `requires`: a trail-relative path that must
 *   be committed in HEAD (checked under the lock), else `ERR_NOT_RECORDED`. `afterWrite` may add files next to the
 *   file (the OTS proof); it returns their trail-relative paths.
 * @returns {Promise<{ duplicate: boolean, commit: string, extra: string[] }>}
 */
async function commitFiles(root, name, { rel, json, requires, keyFiles = [], message, now, afterWrite, sideFiles, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }) {
  return withTrailLock(root, trailLockFile(name), lockTimeoutMs, async () => {
    await ensureTrail(root, name, now().toISOString());
    await clearLeftovers(root);
    if (requires !== undefined && !(await inHead(root, requires))) {
      throw Object.assign(new Error(`not recorded: ${requires} is not committed in trail "${name}"`), { code: 'ERR_NOT_RECORDED' });
    }
    if (await inHead(root, rel)) {
      if (sideFiles) await sideFiles(true);
      return { duplicate: true, commit: await git(root, ['rev-parse', 'HEAD']), extra: [] };
    }
    /** @type {string[]} */
    const written = []; // only paths that did not exist before this call wrote them
    /** @type {{ duplicate: boolean, commit: string, extra: string[] }} */
    let res;
    /** @type {string[]} */
    let sideCreated = [];
    try {
      for (const k of keyFiles) {
        const abs = path.join(root, k.rel);
        if (await inHead(root, k.rel)) continue; // archived once per domain+selector+key, never rewritten
        await fs.mkdir(path.dirname(abs), { recursive: true });
        written.push(k.rel);
        await fs.writeFile(abs, serialise(k.json));
      }
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      written.push(rel);
      await fs.writeFile(path.join(root, rel), serialise(json));
      const extra = afterWrite ? await afterWrite(path.join(root, rel)) : [];
      written.push(...extra);
      if (sideFiles) sideCreated = await sideFiles(false);
      await git(root, ['add', '--', ...written]);
      await git(root, ['commit', '-m', message]);
      res = { duplicate: false, commit: await git(root, ['rev-parse', 'HEAD']), extra };
    } catch (err) {
      try { await git(root, ['reset', '-q']); } catch { /* nothing staged */ }
      for (const f of sideCreated) await fs.rm(f, { force: true });
      for (const r of written) {
        if (!(await isTracked(root, r))) await fs.rm(path.join(root, r), { force: true });
      }
      throw err;
    }
    return res;
  });
}

/**
 * Write one record (+ any new key files) and commit them as one commit (see commitFiles).
 * @param {string} root
 * @param {string} name
 * @param {{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }>, message: string, now: () => Date,
 *           afterWrite?: (recordAbs: string) => Promise<string[]>,
 *           sideFiles?: (duplicate: boolean) => Promise<string[]>,
 *           lockTimeoutMs?: number }} job
 * @returns {Promise<{ duplicate: boolean, commit: string, extra: string[] }>}
 */
async function commitRecord(root, name, { record, ...rest }) {
  return commitFiles(root, name, { rel: `records/${record.id}.json`, json: record, ...rest });
}

export { TRAIL_NAME_RE, RECORD_ID_RE, DEFAULT_LOCK_TIMEOUT_MS, TRAIL_LOCK, SYNC_LOCK, trailLockFile, trailIndexFile, syncLockFile, withTrailLock, serialise, ensureTrail, readRecord, listIds, commitRecord, commitFiles, headOf, isAncestor, recordIdsSince };
