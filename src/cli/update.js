// `update` (SPEC B11.10): the installed version, whether it is a development link, what the registry says is latest, and the upgrade itself.
// A development link (`npm link`, a git checkout) is updated with git, never with npm; a real global install is looked up first
// (`npm view`, a short timeout, offline says so) so nothing is installed that already is; npm's own output is shown only when it fails.

import { spawn, execFile } from 'node:child_process';
import { EX_OK, EX_ERR } from './errors.js';
import { print, warn, printJson } from './session.js';
import { printable as p } from './printable.js';
import { styleOf } from './style.js';
import { tilde } from './paths.js';
import { installInfo } from './install.js';
import { version, NPM_ARGS, UPDATE_COMMAND } from './version.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The latest version on npm, or null when it cannot be reached (offline, no npm, slow).
 * @returns {Promise<string | null>}
 */
export function npmLatest() {
  return new Promise((resolve) => {
    execFile('npm', ['view', 'mailproof', 'version'], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (err, out) => {
      const v = String(out ?? '').trim();
      resolve(!err && /^\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

/**
 * Run npm quietly: its output is kept and handed back, to be shown only when it fails.
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
function spawnNpmQuiet(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (/** @type {Buffer} */ d) => { if (output.length < 8192) output += d; };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (e) => resolve({ code: EX_ERR, output: e.message }));
    child.on('close', (code) => resolve({ code: code === 0 ? EX_OK : EX_ERR, output }));
  });
}

/** @param {Ctx} ctx */
const lookup = (ctx) => (ctx.deps.npmView ? ctx.deps.npmView() : npmLatest());

/**
 * `update`: with no flag the installed version and the command (offline); `--check` also asks the registry; `--run` upgrades.
 * @param {Args} a @param {Ctx} ctx @returns {Promise<number>}
 */
export async function updateCmd(a, ctx) {
  const st = styleOf(ctx);
  const info = ctx.deps.installInfo ? ctx.deps.installInfo() : installInfo();
  const installed = version();
  const json = Boolean(a.values.json);
  const dev = `development link to ${p(tilde(info.dir, ctx.env))}; update with git (git pull in that folder)`;
  if (ctx.updateOut) ctx.updateOut.dev = info.dev;
  if (info.dev) {
    if (json) printJson(ctx, { installed, dev: true, dir: info.dir }); else print(ctx, `mailproof ${installed}: ${dev}`);
    return EX_OK;
  }
  if (!a.values.run && !a.values.check) {
    if (json) printJson(ctx, { installed, command: UPDATE_COMMAND }); else print(ctx, `mailproof ${installed} installed. To upgrade: ${UPDATE_COMMAND}`);
    return EX_OK;
  }
  const latest = await lookup(ctx);
  if (latest === null) {
    if (json) printJson(ctx, { installed, latest: null, offline: true }); else print(ctx, `mailproof ${installed} installed; the npm registry could not be reached, so the latest version is unknown`);
    return a.values.run ? EX_ERR : EX_OK;
  }
  const same = latest === installed;
  if (ctx.updateOut) { ctx.updateOut.upToDate = same; ctx.updateOut.newer = !same; }
  if (!a.values.run) {
    if (json) printJson(ctx, { installed, latest, upToDate: same, command: UPDATE_COMMAND });
    else print(ctx, same ? `${st.green(st.sym.ok)} mailproof ${installed} is up to date` : `mailproof ${installed} installed, ${st.key(latest)} is available. To upgrade: ${UPDATE_COMMAND}`);
    return EX_OK;
  }
  if (same) {
    if (json) printJson(ctx, { installed, latest, upToDate: true, exit: 0 }); else print(ctx, `${st.green(st.sym.ok)} mailproof ${installed} is up to date: nothing to install`);
    return EX_OK;
  }
  if (!json) print(ctx, `upgrading ${installed} to ${latest} ...`);
  /** @type {number} */
  let code;
  let output = '';
  if (ctx.deps.runNpm) code = await ctx.deps.runNpm(NPM_ARGS, ctx);
  else ({ code, output } = await spawnNpmQuiet(NPM_ARGS));
  if (json) printJson(ctx, { installed, latest, command: UPDATE_COMMAND, exit: code });
  else if (code === 0) print(ctx, `${st.green(st.sym.ok)} upgraded to ${latest}: restart mailproof to use ${latest}`);
  else { warn(ctx, `mailproof: ${UPDATE_COMMAND} failed${output ? `:\n${p(output.trim(), { keepNewline: true, max: 2000 })}` : ''}`); }
  return code === 0 ? EX_OK : EX_ERR;
}
