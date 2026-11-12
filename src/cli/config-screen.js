// The menu's `config` screen (SPEC B11.4e): where the settings live, whether they are valid, each account's settings (never a password),
// and the three things you can do: edit in $EDITOR (validated when it closes), add an account, show an annotated example.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { printable as p } from './printable.js';
import { tilde } from './paths.js';
import { loadConfig, ConfigError } from './config.js';
import { redactUrl } from './backup.js';
import { STAMP_EVERY_HOURS } from '../proof/limits.js';

/** The editor to open: `$VISUAL`, `$EDITOR`, else `nano`, else `vi`; the first word is the program, the rest its arguments (no shell). @param {Record<string, string | undefined>} env @returns {string[]} */
export function editorCommand(env) {
  const named = (env.VISUAL || env.EDITOR || '').trim();
  if (named) return named.split(/\s+/);
  for (const e of ['nano', 'vi']) {
    for (const d of (env.PATH ?? '').split(path.delimiter)) { if (d && fs.existsSync(path.join(d, e))) return [e]; }
  }
  return ['vi'];
}

/**
 * Open the file in the editor and wait; the editor owns the terminal meanwhile.
 * @param {string} file @param {Record<string, string | undefined>} env @returns {Promise<number>}  The editor's exit code.
 */
export function openEditor(file, env) {
  const [cmd, ...args] = editorCommand(env);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args, file], { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * The settings of every account and whether the file is valid, as lines.
 * @param {string} file @param {import('./session.js').Ctx} ctx @param {import('./style.js').Style} st
 * @returns {Promise<{ lines: string[], valid: boolean }>}
 */
export async function configSummary(file, ctx, st) {
  const t = (/** @type {string} */ x) => p(tilde(x, ctx.env));
  const row = (/** @type {string} */ label, /** @type {string} */ v) => `${st.bold(label.padEnd(13))}${v}`;
  /** @type {string[]} */
  const lines = [row('Config file', t(file))];
  /** @type {import('./config.js').Config} */
  let config;
  try { config = await loadConfig(file, ctx.env, { euid: ctx.euid }); }
  catch (e) {
    const msg = String(/** @type {Error} */ (e).message);
    lines.push(row('Valid', st.red(`${st.sym.bad} not valid`)));
    for (const l of (e instanceof ConfigError ? e.problems : msg.split('\n'))) lines.push(`  ${p(tilde(l, ctx.env), { max: 200 })}`);
    return { lines, valid: false };
  }
  lines.push(row('Valid', st.green(`${st.sym.ok} valid`)));
  for (const a of Object.values(config.accounts)) {
    lines.push('');
    lines.push(`${st.bold(p(a.name))} ${st.dim(st.sym.dot)} ${p(a.user)}`);
    lines.push(row('  server', `${p(a.host)}:${a.port}`));
    lines.push(row('  folders', `${a.folders.map((f) => p(f)).join(', ')}${a.sent === false ? '' : `; sent: ${a.sent === true ? 'automatic' : p(String(a.sent))}`}`));
    lines.push(row('  trail', `${t(a.trailDir)} (${p(a.trail)})`));
    lines.push(row('  password', await secretLine(a, ctx.env, st)));
    lines.push(row('  seal', a.otsBin === null ? st.dim('off') : `every ${a.stamp.everyHours ?? STAMP_EVERY_HOURS} h`));
    lines.push(row('  backup', a.backupRemote ? p(redactUrl(a.backupRemote)) : st.dim('no remote (a file only)')));
  }
  return { lines, valid: true };
}

/** Where the password comes from, never what it is. @param {import('./config.js').Account} a @param {Record<string, string | undefined>} env @param {import('./style.js').Style} st @returns {Promise<string>} */
async function secretLine(a, env, st) {
  if (a.secret.passFile) {
    const f = a.secret.passFile;
    try {
      const mode = (await fsp.stat(f)).mode & 0o777;
      const m = mode.toString(8).padStart(4, '0');
      return `file ${p(tilde(f, env))} ${mode & 0o077 ? st.red(`mode ${m} ${st.sym.bad} must be 0600`) : st.green(`mode ${m} ${st.sym.ok}`)}`;
    } catch { return `file ${p(tilde(f, env))} ${st.red(`${st.sym.bad} cannot be read`)}`; }
  }
  return a.secret.accessTokenCommand ? 'an access-token command (not shown)' : 'a command (not shown)';
}

/**
 * Edit the config in the editor until it is valid or the person stops. The file stays owner-only (an editor that replaces the file leaves
 * the default mode: it is set back to 0600).
 * @param {string} file
 * @param {{ ctx: import('./session.js').Ctx, edit: (file: string) => Promise<number>, suspend: <T>(fn: () => Promise<T>) => Promise<T>, askYes: (q: string, d?: boolean) => Promise<boolean>, out: (s: string) => void, st: import('./style.js').Style }} h
 * @returns {Promise<boolean>}  True when the file is valid at the end.
 */
export async function editUntilValid(file, h) {
  for (;;) {
    const code = await h.suspend(() => h.edit(file));
    if (code !== 0) h.out(`the editor ended with exit ${code}`);
    await fsp.chmod(file, 0o600).catch(() => {});
    try { await loadConfig(file, h.ctx.env, { euid: h.ctx.euid }); h.out(`${h.st.green(h.st.sym.ok)} saved and valid`); return true; }
    catch (e) {
      h.out(h.st.red(`${h.st.sym.bad} the settings are not valid:`));
      for (const l of (e instanceof ConfigError ? e.problems : String(/** @type {Error} */ (e).message).split('\n'))) h.out(`  ${p(tilde(l, h.ctx.env), { max: 200 })}`);
      if (!(await h.askYes('Open it again?', true))) { h.out('left as it is: fix it later with `mailproof config validate`'); return false; }
    }
  }
}
