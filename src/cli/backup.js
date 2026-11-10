// `backup` (SPEC B11.6): a git bundle of the trail through the `git` binary, optionally the content store through the
// `tar` binary, optionally a push that NEVER forces. mailproof keeps no copy logic of its own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageError, EX_OK, EX_ERR, EX_USAGE, EX_TEMPFAIL } from './errors.js';
import { withAccount, print, warn, printJson, stamp } from './session.js';
import { updateState } from './state.js';
import { printable as p } from './printable.js';
import { withTrailLock, trailLockFile, headOf } from '../proof/trail.js';

const run = promisify(execFile);

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
 * @param {Date} d
 * @returns {string}  `20261110T101500Z`
 */
const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * The default bundle path: `<state>/backups/<account>/<account>-<UTC timestamp>.bundle`.
 * @param {string} state
 * @param {string} account
 * @param {Date} now
 * @returns {string}
 */
export function defaultBundlePath(state, account, now) {
  return path.join(state, 'backups', account, `${account}-${compact(now)}.bundle`);
}

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
 * @param {import('./session.js').Args} a
 * @param {import('./session.js').Ctx} ctx
 * @returns {Promise<number>}
 */
export async function backupCmd(a, ctx) {
  const v = a.values;
  return withAccount(a, ctx, async ({ mp, account, state }) => {
    const now = (ctx.deps.now ?? (() => new Date()))();
    if (v.push) {
      if (!account.backupRemote) throw new UsageError(`account ${p(account.name)} has no backupRemote in the config; --push needs one`);
    }
    if ((await headOf(mp.root).catch(() => null)) === null) { warn(ctx, `mailproof: the trail ${p(account.name)} has no records yet: nothing to back up`); return EX_ERR; }
    const commits = Number(String((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: mp.root })).stdout).trim());
    if (v.push && !v.yes) {
      warn(ctx, `backup --push to ${p(redactUrl(/** @type {string} */ (account.backupRemote)))}: ${commits} commit(s) would be pushed.\n${PUSH_WARNING}\nadd --yes to proceed`);
      return EX_USAGE;
    }
    const out = v.out ? path.resolve(v.out) : defaultBundlePath(state, account.name, now);
    if (v.out) {
      if (!(await exists(path.dirname(out)))) throw new UsageError(`--out: the directory ${p(path.dirname(out))} does not exist`);
    } else await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    if (await exists(out)) throw new UsageError(`--out: ${p(out)} already exists; a backup is never overwritten`);

    // under the trail lock, so it cannot run during a prune swap
    await withTrailLock(mp.root, trailLockFile(mp.trail), mp.lockTimeoutMs, async () => {
      try { await run('git', ['bundle', 'create', out, '--all'], { cwd: mp.root }); }
      catch (e) { throw Object.assign(new Error(`git bundle failed: ${String(/** @type {any} */ (e).stderr ?? e).trim().slice(0, 300)}`), { code: 'EX_BACKUP' }); }
    });
    try { await run('git', ['bundle', 'verify', out], { cwd: mp.root }); }
    catch (e) {
      await fs.rm(out, { force: true });
      warn(ctx, `mailproof: the bundle did not verify and was removed: ${p(String(/** @type {any} */ (e).stderr ?? e).trim().slice(0, 300), { keepNewline: true })}`);
      return EX_ERR;
    }
    const bundleBytes = (await fs.stat(out)).size;
    await fs.chmod(out, 0o600).catch(() => {});

    /** @type {{ path: string, bytes: number } | null} */
    let content = null;
    /** @type {string | null} */
    let contentNote = null;
    /** @type {number} */
    let code = EX_OK;
    if (v['with-content']) {
      if (!(await exists(mp.contentDir)) || (await countFiles(mp.contentDir)) === 0) contentNote = 'the content store is off or empty: no content archive written';
      else {
        const tarPath = out.replace(/\.bundle$/, '') + '.content.tar';
        try {
          await run('tar', ['-C', mp.contentDir, '-cf', tarPath, '.']);
          await fs.chmod(tarPath, 0o600).catch(() => {});
          content = { path: tarPath, bytes: (await fs.stat(tarPath)).size };
        } catch (e) {
          await fs.rm(tarPath, { force: true }).catch(() => {});
          warn(ctx, /** @type {any} */ (e)?.code === 'ENOENT' ? `mailproof: tar not found: install tar or run backup without --with-content (the bundle ${p(out)} was kept)` : `mailproof: tar failed: ${p(String(/** @type {any} */ (e)?.stderr ?? e).trim().slice(0, 300), { keepNewline: true })} (the bundle ${p(out)} was kept)`);
          code = EX_ERR;
        }
      }
    }
    await updateState(state, account.name, { lastBackup: { at: stamp(now), path: out } });

    /** @type {{ remote: string, refs: string[] } | null} */
    let pushed = null;
    if (v.push && code === EX_OK) {
      if (!v.json) print(ctx, PUSH_WARNING);
      const remote = /** @type {string} */ (account.backupRemote);
      try {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        const all = await run('git', ['push', '--porcelain', '--all', remote], { cwd: mp.root, env });
        const tags = await run('git', ['push', '--porcelain', '--tags', remote], { cwd: mp.root, env });
        const refs = `${all.stdout}\n${tags.stdout}`.split('\n').filter((l) => /^[ +\-*=!]\t/.test(l)).map((l) => l.split('\t')[1]);
        pushed = { remote: redactUrl(remote), refs };
      } catch (e) {
        const err = String(/** @type {any} */ (e).stderr ?? /** @type {any} */ (e).message ?? e).trim();
        const kind = classifyPush(err);
        warn(ctx, p(err.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@'), { keepNewline: true }));
        if (kind === 'rejected') {
          warn(ctx, `mailproof: the remote refused the push (it holds history this trail no longer has, for example from before a prune). mailproof never forces a push. The remote keeps its history as an archive; push to a new remote, or force it yourself outside mailproof if you mean to replace it. The bundle ${p(out)} was written.`);
          code = EX_ERR;
        } else { code = kind === 'network' ? EX_TEMPFAIL : EX_ERR; warn(ctx, `mailproof: the push failed; the bundle ${p(out)} was written.`); }
      }
    }

    if (code !== EX_OK) { /* a failure: the message above is the output, stdout stays empty */ }
    else if (v.json) printJson(ctx, { bundle: out, bytes: bundleBytes, commits, content, pushed });
    else {
      print(ctx, `bundle   ${p(out)}  (${bundleBytes} bytes, ${commits} commits)`);
      if (content) print(ctx, `content  ${p(content.path)}  (${content.bytes} bytes; not encrypted: it holds other people's mail)`);
      if (contentNote) print(ctx, contentNote);
      if (pushed) print(ctx, `pushed   ${p(pushed.remote)}  (${pushed.refs.length} ref(s))`);
      print(ctx, `restore: git clone ${p(out)} <dir>`);
    }
    return code;
  });
}
