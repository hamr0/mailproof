// `Mailproof#backup` (SPEC B11.6): a git bundle of the trail through the `git` binary, optionally the content store through the `tar`
// binary, optionally a push that NEVER forces. mailproof keeps no copy logic of its own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTrailLock, trailLockFile, headOf } from './trail.js';

const run = promisify(execFile);

/** fs.link errors that mean "this filesystem has no hard links" (or no more of them): fall back to a copy. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EMLINK']);

export const PUSH_WARNING = 'Proof records contain the signed headers of your mail: sender and recipient addresses, subjects, dates, and Message-IDs (never message bodies). Push only to a remote you trust to hold that.';

/**
 * A URL with any credentials in it hidden, for messages and JSON.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
}

/**
 * The host a remote names (`https://h/x`, `ssh://git@h/x`, `git@h:x`), or null for a local path.
 * @param {string} remote
 * @returns {string | null}
 */
export function remoteHost(remote) {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?(\[[^\]]+\]|[^/:\s]+)/i.exec(remote);
  if (url) return url[1];
  const scp = /^(?:[^/@\s]+@)?([^/:\s]+):(?!\/\/)/.exec(remote);
  return scp ? scp[1] : null;
}

/**
 * Classify a failed push from git's stderr: a refused update, or the network/login.
 * @param {string} stderr
 * @returns {'rejected' | 'network' | 'other'}
 */
export function classifyPush(stderr) {
  if (/rejected|non-fast-forward|fetch first|\[remote rejected\]|failed to push some refs/i.test(stderr) && !/could not read from remote|unable to access|resolve host|permission denied|authentication failed/i.test(stderr)) return 'rejected';
  if (/could not resolve host|could not read from remote|unable to access|connection (refused|timed out|reset)|permission denied|authentication failed|network is unreachable|early eof|operation timed out/i.test(stderr)) return 'network';
  return 'other';
}

/**
 * @param {Date} d
 * @returns {string}  `20261110T101500Z`
 */
export const compactUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * The file name of a default backup bundle: `<name>-<UTC timestamp>.bundle` (the one definition; the CLI builds its default path with it too).
 * @param {string} name  The trail name (library) or the account name (CLI).
 * @param {Date} now
 * @returns {string}
 */
export const bundleFileName = (name, now) => `${name}-${compactUtc(now)}.bundle`;

/**
 * The default bundle path when `out` is not given: `<trailDir>/.<trail>.backups/<trail>-<UTC timestamp>.bundle`.
 * @param {string} root  The trail directory.
 * @param {string} trail
 * @param {Date} now
 * @returns {string}
 */
export const defaultBundleFile = (root, trail, now) => path.join(path.dirname(root), `.${trail}.backups`, bundleFileName(trail, now));

/** @param {string} p @returns {Promise<boolean>} */
const exists = (p) => fs.access(p).then(() => true, () => false);

/** @param {string} dir @returns {Promise<number>} The number of regular files under dir. */
async function countFiles(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

/** @param {string} code @param {string} msg @param {string} [file]  The path an `ERR_BACKUP_EXISTS` is about. @returns {Error & { code: string, path?: string }} */
const err = (code, msg, file) => Object.assign(new Error(msg), { code, ...(file !== undefined ? { path: file } : {}) });

/**
 * @typedef {Object} BackupResult
 * @property {boolean} [dryRun]  Present (true) only for a dry run: nothing was written, pushed or changed.
 * @property {string} bundle  The bundle file (the path it would be written to, for a dry run).
 * @property {number | null} bytes  Null for a dry run.
 * @property {number} commits  Commits in the trail (all of them are in the bundle and would be pushed).
 * @property {{ path: string, bytes: number | null } | null} content  The content archive (`bytes` null for a dry run); null when not asked for, nothing is stored, or tar failed.
 * @property {string | null} [contentNote]  Why no content archive was made (the store is off or empty).
 * @property {string | null} [contentError]  `tar` failed (or is missing): the bundle was kept, `content` is null.
 * @property {{ remote: string, host: string | null, refs: string[] } | null} pushed  The remote with credentials hidden. For a dry run: where it WOULD push (`refs` empty).
 * @property {{ kind: 'rejected' | 'network' | 'other', message: string } | null} [pushError]  The push failed (the bundle was written).
 */

/**
 * @param {{ root: string, trail: string, contentDir: string, lockTimeoutMs: number, now: () => Date }} c
 * @param {unknown} rawOpts
 * @returns {Promise<BackupResult>}
 */
export async function runBackup(c, rawOpts) {
  if (rawOpts !== undefined && (!rawOpts || typeof rawOpts !== 'object' || Array.isArray(rawOpts))) throw new TypeError('backup: options must be an object');
  const o = /** @type {Record<string, unknown>} */ (rawOpts ?? {});
  for (const k of Object.keys(o)) if (!['out', 'withContent', 'push', 'remote', 'dryRun', 'mkdir'].includes(k)) throw new TypeError(`backup: unknown option "${k}"`);
  for (const k of ['withContent', 'push', 'dryRun', 'mkdir']) if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new TypeError(`backup: ${k} must be a boolean`);
  if (o.out !== undefined && (typeof o.out !== 'string' || !o.out)) throw new TypeError('backup: out must be a path');
  if (o.remote !== undefined && (typeof o.remote !== 'string' || !o.remote)) throw new TypeError('backup: remote must be a non-empty string');
  const dryRun = o.dryRun === true;
  const withContent = o.withContent === true;
  const remote = /** @type {string | undefined} */ (o.remote);
  if (o.push === true && !remote) throw new TypeError('backup: push needs remote (the git remote to push to)');
  const explicit = typeof o.out === 'string';
  const out = explicit ? path.resolve(/** @type {string} */ (o.out)) : defaultBundleFile(c.root, c.trail, c.now());
  const mkdir = o.mkdir === true || !explicit;

  if ((await headOf(c.root).catch(() => null)) === null) throw err('ERR_BACKUP_EMPTY', `the trail ${c.trail} has no records yet: nothing to back up`);
  const commits = Number(String((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: c.root })).stdout).trim());
  const tarPath = out.replace(/\.bundle$/, '') + '.content.tar';
  /** @type {BackupResult['pushed']} */
  const planned = o.push === true && remote ? { remote: redactUrl(remote), host: remoteHost(remote), refs: [] } : null;

  if (!mkdir && !(await exists(path.dirname(out)))) throw err('ERR_BACKUP_NO_DIR', `the directory ${path.dirname(out)} does not exist`);
  if (await exists(out)) throw err('ERR_BACKUP_EXISTS', `${out} already exists; a backup is never overwritten`, out);
  if (withContent && (await exists(tarPath))) throw err('ERR_BACKUP_EXISTS', `${tarPath} already exists; a backup is never overwritten`, tarPath);

  if (dryRun) {
    const has = withContent && (await exists(c.contentDir)) && (await countFiles(c.contentDir)) > 0;
    return {
      dryRun: true, bundle: out, bytes: null, commits,
      content: has ? { path: tarPath, bytes: null } : null,
      ...(withContent && !has ? { contentNote: 'the content store is off or empty: no content archive written' } : {}),
      pushed: planned,
    };
  }

  if (mkdir) await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });

  // written and verified in a private 0700 directory next to `out`, then linked into place without overwriting:
  // other people's mail-derived data is never readable by others while the bundle is made
  const tmpDir = await fs.mkdtemp(path.join(path.dirname(out), '.mailproof-bundle-'));
  let bundleBytes = 0;
  try {
    await fs.chmod(tmpDir, 0o700);
    const tmpFile = path.join(tmpDir, path.basename(out));
    // under the trail lock, so it cannot run during a prune swap
    await withTrailLock(c.root, trailLockFile(c.trail), c.lockTimeoutMs, async () => {
      try { await run('git', ['bundle', 'create', tmpFile, '--all'], { cwd: c.root }); }
      catch (e) { throw err('ERR_BACKUP_BUNDLE', `git bundle failed: ${String(/** @type {any} */ (e).stderr ?? e).trim().slice(0, 300)}`); }
    });
    try { await run('git', ['bundle', 'verify', tmpFile], { cwd: c.root }); }
    catch (e) { throw err('ERR_BACKUP_VERIFY', `the bundle did not verify and was removed: ${String(/** @type {any} */ (e).stderr ?? e).trim().slice(0, 300)}`); }
    await fs.chmod(tmpFile, 0o600);
    try { await fs.link(tmpFile, out); }
    catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === 'EEXIST') throw err('ERR_BACKUP_EXISTS', `${out} already exists; a backup is never overwritten`, out);
      if (!NO_HARD_LINKS.has(code)) throw e;
      // FAT/exFAT and some network mounts have no hard links: copy instead, still never overwriting
      try { await fs.copyFile(tmpFile, out, fs.constants.COPYFILE_EXCL); }
      catch (e2) {
        if (/** @type {any} */ (e2)?.code === 'EEXIST') throw err('ERR_BACKUP_EXISTS', `${out} already exists; a backup is never overwritten`, out);
        throw e2;
      }
      await fs.chmod(out, 0o600).catch(() => {});   // FAT has no modes
    }
    bundleBytes = (await fs.stat(out)).size;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  /** @type {BackupResult} */
  const result = { bundle: out, bytes: bundleBytes, commits, content: null, pushed: null };
  if (withContent) {
    if (!(await exists(c.contentDir)) || (await countFiles(c.contentDir)) === 0) result.contentNote = 'the content store is off or empty: no content archive written';
    else {
      // created 0600 and exclusive before tar writes to it: other people's mail is never readable while it grows
      try { await (await fs.open(tarPath, 'wx', 0o600)).close(); }
      catch (e) {
        if (/** @type {any} */ (e)?.code === 'EEXIST') throw err('ERR_BACKUP_EXISTS', `${tarPath} already exists; a backup is never overwritten`, tarPath);
        throw e;
      }
      try {
        await run('tar', ['-C', c.contentDir, '-cf', tarPath, '.']);
        result.content = { path: tarPath, bytes: (await fs.stat(tarPath)).size };
      } catch (e) {
        await fs.rm(tarPath, { force: true }).catch(() => {});
        result.contentError = /** @type {any} */ (e)?.code === 'ENOENT' ? 'tar not found: install tar or run backup without content' : `tar failed: ${String(/** @type {any} */ (e)?.stderr ?? e).trim().slice(0, 300)}`;
      }
    }
  }

  if (o.push === true && !result.contentError && remote) {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      const all = await run('git', ['push', '--porcelain', '--all', '--', remote], { cwd: c.root, env });
      const tags = await run('git', ['push', '--porcelain', '--tags', '--', remote], { cwd: c.root, env });
      const refs = `${all.stdout}\n${tags.stdout}`.split('\n').filter((l) => /^[ +\-*=!]\t/.test(l)).map((l) => l.split('\t')[1]);
      result.pushed = { remote: redactUrl(remote), host: remoteHost(remote), refs };
    } catch (e) {
      const raw = String(/** @type {any} */ (e).stderr ?? /** @type {any} */ (e).message ?? e).trim();
      result.pushError = { kind: classifyPush(raw), message: raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@') };
    }
  }
  return result;
}
