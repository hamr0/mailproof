// sync (the command), update, config, export, mcp: the commands that are mostly text.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, EX_OK, EX_ERR, EX_USAGE } from './errors.js';
import { parseFolders, parseSent } from './parse.js';
import { openAccount, loadCtxConfig, print, warn, printJson } from './session.js';
import { serveMcp } from '../mcp/server.js';
import { syncOnce, syncText } from './sync-op.js';
import { configPath, TEMPLATE, loadConfig, ConfigError } from './config.js';
import { addAccountWizard } from './wizard.js';
import { printable as p } from './printable.js';
import { stampText } from './sync-op.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @returns {string} The installed version. */
export const version = () => JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function syncCmd(a, ctx) {
  const over = {
    ...(a.values.folders !== undefined ? { folders: parseFolders(a.values.folders) } : {}),
    ...(a.values.sent !== undefined ? { sent: parseSent(a.values.sent) } : {}),
  };
  const s = await openAccount(a, ctx);
  try {
    if (ctx.stderr.isTTY) warn(ctx, `syncing ${p(s.account.name)} ...`);
    const r = await syncOnce(s, ctx, over);
    if (a.values.json) printJson(ctx, { ...r.result, ots: r.ots }); else print(ctx, syncText(r));
    if (r.folderError) warn(ctx, `mailproof: ${p(r.folderError.folder)}: ${p(r.folderError.code)}: ${p(r.folderError.message)}`);
    return r.exit;
  } finally { await s.close(); }
}

/**
 * `stamp` (SPEC B13.1.12): run the stamp job now. Exit 0 when the job completed without an `ots` error (also when the seal is off),
 * 1 when `ots` failed (the manifest is still committed), 75 for a held lock (the dispatcher maps ERR_TRAIL_LOCKED / ERR_STAMP_LOCKED).
 * @param {Args} a @param {Ctx} ctx @returns {Promise<number>}
 */
export async function stampCmd(a, ctx) {
  const s = await openAccount(a, ctx);
  try {
    const r = await s.mp.stamp();
    if (a.values.json) printJson(ctx, r); else print(ctx, stampText(r));
    if (r.error) { warn(ctx, `mailproof: ${p(r.error)}`); return EX_ERR; }
    return EX_OK;
  } finally { await s.close(); }
}

const NPM_ARGS = ['install', '-g', 'mailproof@latest'];

/**
 * Run npm with the output streaming through (no shell).
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function spawnNpm(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { stdio: 'inherit' });
    child.on('error', () => resolve(EX_ERR));
    child.on('close', (code) => resolve(code === 0 ? EX_OK : EX_ERR));
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function updateCmd(a, ctx) {
  const cmd = `npm ${NPM_ARGS.join(' ')}`;
  if (!a.values.run) {
    if (a.values.json) printJson(ctx, { installed: version(), command: cmd }); else print(ctx, `mailproof ${version()} installed. To upgrade: ${cmd}`);
    return EX_OK;
  }
  if (!a.values.json) print(ctx, `running: ${cmd}`);
  const code = await (ctx.deps.runNpm ? ctx.deps.runNpm(NPM_ARGS, ctx) : spawnNpm(NPM_ARGS));
  if (a.values.json) printJson(ctx, { installed: version(), command: cmd, exit: code });
  return code === 0 ? EX_OK : EX_ERR;
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function configCmd(a, ctx) {
  const action = a.positionals[0];
  const file = configPath(a.values.config, ctx.env);
  switch (action) {
    case 'path':
      if (a.values.json) printJson(ctx, { path: file }); else print(ctx, p(file));
      return EX_OK;
    case 'template':
      ctx.stdout.write(JSON.stringify(TEMPLATE, null, 2) + '\n');
      return EX_OK;
    case 'validate': {
      try { await loadConfig(file, ctx.env, { euid: ctx.euid }); }
      catch (e) {
        if (a.values.json && e instanceof ConfigError) { warn(ctx, e.message); }
        throw e;
      }
      if (a.values.json) printJson(ctx, { ok: true, path: file }); else print(ctx, 'ok');
      return EX_OK;
    }
    case 'add-account':
      return addAccountWizard(a, ctx, file);
    default:
      throw new UsageError(`config: unknown action "${action}"; use path, validate, template or add-account`);
  }
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function mcpCmd(a, ctx) {
  const stdin = ctx.stdin;
  if (!stdin || /** @type {{ isTTY?: boolean }} */ (stdin).isTTY) {
    warn(ctx, 'mailproof mcp is a stdio server: register it in your MCP client');
    return EX_USAGE;
  }
  const { file, config } = await loadCtxConfig(a, ctx);   // a bad config or an unknown --account ends here (64, 77) before anything is read
  return serveMcp({
    config, accountFlag: a.values.account, env: ctx.env, deps: ctx.deps, configFile: file, version: version(),
    ...(a.values.log !== undefined ? { logFile: path.resolve(a.values.log) } : {}),
    stdin, write: (s) => ctx.stdout.write(s), signal: ctx.signal,
  });
}
