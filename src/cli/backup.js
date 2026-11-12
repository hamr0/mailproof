// `backup` (SPEC B11.6): renders `Mailproof#backup`, which makes the git bundle (through the `git` binary), the optional content archive
// (through `tar`) and the optional push that NEVER forces. This file only chooses the default path, asks for the push confirmation,
// updates the state file and prints.

import path from 'node:path';
import { UsageError, EX_OK, EX_ERR, EX_USAGE, EX_TEMPFAIL } from './errors.js';
import { withAccount, print, warn, printJson, stamp } from './session.js';
import { updateState } from './state.js';
import { tilde, userDir, ensureDefaultDir } from './paths.js';
import { printable as p } from './printable.js';
import { styleOf, fileUrl } from './style.js';
import { count, humanSize } from './words.js';
import { PUSH_WARNING, redactUrl, classifyPush } from '../proof/backup.js';

export { PUSH_WARNING, redactUrl, classifyPush };

/**
 * @param {Date} d
 * @returns {string}  `20261110T101500Z`
 */
const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * The name of a default backup: `<account>-<UTC timestamp>.bundle`.
 * @param {string} account @param {Date} now @returns {string}
 */
export const backupName = (account, now) => `${account}-${compact(now)}.bundle`;

/**
 * The default bundle path (SPEC B11.2a): `~/mailproof/backups/<account>-<UTC timestamp>.bundle`, absolute under $HOME.
 * @param {Record<string, string | undefined>} env
 * @param {string} account
 * @param {Date} now
 * @returns {string}
 */
export function defaultBundlePath(env, account, now) {
  return path.join(userDir(env, 'backups'), backupName(account, now));
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
    const out = v.out ? path.resolve(v.out) : defaultBundlePath(ctx.env, account.name, now);
    await ensureDefaultDir(out, ctx.env, 'backups');
    const opts = { out, mkdir: false, withContent: v['with-content'] === true, ...(v.push ? { push: true, remote: /** @type {string} */ (account.backupRemote) } : {}) };
    /** @type {import('../proof/backup.js').BackupResult} */
    let r;
    try {
      if (v.push && !v.yes) {
        const plan = await mp.backup({ ...opts, dryRun: true });
        warn(ctx, `backup --push to ${p(plan.pushed?.remote ?? '')}: ${count(plan.commits, 'commit')} would be pushed.\n${PUSH_WARNING}\nadd --yes to proceed`);
        return EX_USAGE;
      }
      r = await mp.backup(opts);
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === 'ERR_BACKUP_EMPTY') { warn(ctx, `mailproof: the trail ${p(account.name)} has no records yet: nothing to back up`); return EX_ERR; }
      if (code === 'ERR_BACKUP_NO_DIR') throw new UsageError(`--out: the directory ${p(path.dirname(out))} does not exist`);
      if (code === 'ERR_BACKUP_EXISTS') throw new UsageError(`${/** @type {any} */ (e).path === out ? '--out: ' : ''}${p(/** @type {any} */ (e).path ?? out)} already exists; a backup is never overwritten`);
      if (code === 'ERR_BACKUP_VERIFY') { warn(ctx, `mailproof: ${p(/** @type {Error} */ (e).message, { keepNewline: true })}`); return EX_ERR; }
      throw e;
    }
    await updateState(state, account.name, { lastBackup: { at: stamp(now), path: r.bundle } });
    if (r.contentError) {
      warn(ctx, /^tar not found/.test(r.contentError) ? `mailproof: tar not found: install tar or run backup without --with-content (the bundle ${p(r.bundle)} was kept)` : `mailproof: ${p(r.contentError, { keepNewline: true })} (the bundle ${p(r.bundle)} was kept)`);
      return EX_ERR;
    }
    /** @type {number} */
    let code = EX_OK;
    if (v.push) {
      if (!v.json) print(ctx, PUSH_WARNING);
      if (r.pushError) {
        warn(ctx, p(r.pushError.message, { keepNewline: true }));
        if (r.pushError.kind === 'rejected') {
          warn(ctx, `mailproof: the remote refused the push (it holds history this trail no longer has, for example from before a prune). mailproof never forces a push. The remote keeps its history as an archive; push to a new remote, or force it yourself outside mailproof if you mean to replace it. The bundle ${p(r.bundle)} was written.`);
          code = EX_ERR;
        } else { code = r.pushError.kind === 'network' ? EX_TEMPFAIL : EX_ERR; warn(ctx, `mailproof: the push failed; the bundle ${p(r.bundle)} was written.`); }
      }
    }
    if (code !== EX_OK) { /* a failure: the message above is the output, stdout stays empty */ }
    else if (v.json) printJson(ctx, { bundle: r.bundle, bytes: r.bytes, commits: r.commits, content: r.content, pushed: r.pushed ? { remote: r.pushed.remote, refs: r.pushed.refs } : null });
    else {
      const st = styleOf(ctx);
      const file = p(tilde(r.bundle, ctx.env));
      print(ctx, `${st.green(st.sym.ok)} saved to ${st.link(file, fileUrl(path.resolve(r.bundle)))}`);
      print(ctx, `  ${humanSize(r.bytes ?? 0)}, ${count(r.commits ?? 0, 'commit')}`);
      if (r.content) print(ctx, `  content archive ${p(tilde(r.content.path, ctx.env))}  (${humanSize(r.content.bytes ?? 0)}; not encrypted: it holds other people's mail)`);
      if (r.contentNote) print(ctx, `  ${r.contentNote}`);
      if (r.pushed) print(ctx, `  pushed to ${p(r.pushed.remote)}  (${count(r.pushed.refs.length, 'ref')})`);
      print(ctx, '');
      print(ctx, st.dim('restore with:'));
      print(ctx, `  git clone ${file} <dir>`);
    }
    return code;
  });
}
