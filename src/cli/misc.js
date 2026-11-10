// sync (the command), update, config, export, mcp: the commands that are mostly text.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { UsageError, EX_OK, EX_ERR, EX_USAGE } from './errors.js';
import { parseFolders, parseSent } from './parse.js';
import { openAccount, print, warn, printJson } from './session.js';
import { syncOnce, syncText } from './sync-op.js';
import { configPath, TEMPLATE, loadConfig, ConfigError } from './config.js';

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
    if (ctx.stderr.isTTY) warn(ctx, `syncing ${s.account.name} ...`);
    const r = await syncOnce(s, ctx, over);
    if (a.values.json) printJson(ctx, { ...r.result, ots: r.ots }); else print(ctx, syncText(r));
    if (r.folderError) warn(ctx, `mailproof: ${r.folderError.folder}: ${r.folderError.code}: ${r.folderError.message}`);
    return r.exit;
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
      if (a.values.json) printJson(ctx, { path: file }); else print(ctx, file);
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
      throw new UsageError('config add-account: not available yet');
    default:
      throw new UsageError(`config: unknown action "${action}"; use path, validate, template or add-account`);
  }
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function exportCmd(a, ctx) {
  void a;
  warn(ctx, 'mailproof: export needs M6 (the proof bundle); not available in this version');
  return EX_USAGE;
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function mcpCmd(a, ctx) {
  void a;
  warn(ctx, 'mailproof: not built yet (M3 step 6)');
  return EX_USAGE;
}
