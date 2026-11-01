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
 * Remove the lock at `lockPath` only when it is provably stale: written by a
 * dead pid on THIS host, or unparseable and older than `timeoutMs`. A live or
 * other-host lock is never touched. The content is re-read just before the
 * unlink so a lock re-acquired in between is not removed.
 * @param {string} lockPath
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}  True when the lock is gone or was removed (caller retries the open).
 */
async function takeOverIfStale(lockPath, timeoutMs) {
  let text;
  let mtimeMs;
  try { text = await fs.readFile(lockPath, 'utf8'); mtimeMs = (await fs.stat(lockPath)).mtimeMs; }
  catch { return true; } // vanished: just retry the open
  /** @type {any} */
  let info = null;
  try { info = JSON.parse(text); } catch { /* unparseable */ }
  let stale;
  if (info && typeof info === 'object' && Number.isInteger(info.pid) && typeof info.host === 'string') {
    stale = info.host === os.hostname() && !pidAlive(info.pid);
  } else {
    stale = Date.now() - mtimeMs > timeoutMs;
  }
  if (!stale) return false;
  try {
    if ((await fs.readFile(lockPath, 'utf8')) !== text) return false;
    await fs.unlink(lockPath);
  } catch { /* someone else removed it */ }
  return true;
}

/**
 * Run `work` while holding the trail's cross-process lock (and the in-process mutex).
 * @template T
 * @param {string} root  The trail directory.
 * @param {string} name
 * @param {number} timeoutMs
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 * @throws {Error & { code: 'ERR_TRAIL_LOCKED' }} when the lock is not obtained within `timeoutMs`.
 */
async function withTrailLock(root, name, timeoutMs, work) {
  return withMutex(root, async () => {
    const lockPath = path.join(path.dirname(root), `.${name}.lock`);
    await fs.mkdir(path.dirname(root), { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
    const deadline = Date.now() + timeoutMs;
    let delay = 20;
    for (;;) {
      try {
        const fh = await fs.open(lockPath, 'wx');
        try { await fh.writeFile(mine); } finally { await fh.close(); }
        break;
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      }
      if (await takeOverIfStale(lockPath, timeoutMs)) continue;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`trail "${name}" is locked by another writer (${lockPath})`), { code: 'ERR_TRAIL_LOCKED' });
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())) * (0.5 + Math.random() / 2));
      delay = Math.min(delay * 2, 500);
    }
    try { return await work(); }
    finally {
      try { if ((await fs.readFile(lockPath, 'utf8')) === mine) await fs.unlink(lockPath); } catch { /* already gone */ }
    }
  });
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
 * Clear what a crashed writer left half-done: staged changes, and untracked
 * files under `records/` and `keys/`. Safe because only the lock holder writes,
 * and tracked files and everything else are never touched. Needs a HEAD.
 * @param {string} root
 * @returns {Promise<void>}
 */
async function clearLeftovers(root) {
  await git(root, ['reset', '-q']);
  await git(root, ['clean', '-fdq', '--', 'records', 'keys']);
  await fs.mkdir(path.join(root, 'records'), { recursive: true }); // clean removes the dir while nothing in it is tracked
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
 * Write one record (+ any new key files) and commit them as one commit, under
 * the trail lock. A record whose id is committed is a no-op (`duplicate`); the
 * start of every call first clears a crashed writer's leftovers. On any
 * failure only the files this call newly created (and git does not track) are
 * removed, so the tree is never left dirty and no committed file is touched.
 * @param {string} root
 * @param {string} name
 * @param {{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }>, message: string, now: () => Date,
 *           afterWrite?: (recordAbs: string) => Promise<string[]>, lockTimeoutMs?: number }} job
 *   `afterWrite` may add files next to the record (the OTS proof); it returns their trail-relative paths.
 * @returns {Promise<{ duplicate: boolean, commit: string, extra: string[] }>}
 */
async function commitRecord(root, name, { record, keyFiles, message, now, afterWrite, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }) {
  return withTrailLock(root, name, lockTimeoutMs, async () => {
    await ensureTrail(root, name, now().toISOString());
    await clearLeftovers(root);
    const rel = `records/${record.id}.json`;
    if (await inHead(root, rel)) {
      return { duplicate: true, commit: await git(root, ['rev-parse', 'HEAD']), extra: [] };
    }
    /** @type {string[]} */
    const written = []; // only paths that did not exist before this call wrote them
    try {
      for (const k of keyFiles) {
        const abs = path.join(root, k.rel);
        if (await inHead(root, k.rel)) continue; // archived once per domain+selector+key, never rewritten
        await fs.mkdir(path.dirname(abs), { recursive: true });
        written.push(k.rel);
        await fs.writeFile(abs, serialise(k.json));
      }
      written.push(rel);
      await fs.writeFile(path.join(root, rel), serialise(record));
      const extra = afterWrite ? await afterWrite(path.join(root, rel)) : [];
      written.push(...extra);
      await git(root, ['add', '--', ...written]);
      await git(root, ['commit', '-m', message]);
      return { duplicate: false, commit: await git(root, ['rev-parse', 'HEAD']), extra };
    } catch (err) {
      try { await git(root, ['reset', '-q']); } catch { /* nothing staged */ }
      for (const r of written) {
        if (!(await isTracked(root, r))) await fs.rm(path.join(root, r), { force: true });
      }
      throw err;
    }
  });
}

export { TRAIL_NAME_RE, RECORD_ID_RE, DEFAULT_LOCK_TIMEOUT_MS, serialise, ensureTrail, readRecord, listIds, commitRecord };
