// The menu's `mcp` screen (SPEC B11.4d): is mailproof registered in Claude Code, where everything lives, and install / uninstall / "other clients".
// Claude Code is driven through its own CLI (`claude mcp ...`), never by editing its files. Every other client gets the same ready-to-copy
// JSON, printed and written to `~/mailproof/mcp/mcp.json`: mailproof never writes another program's config.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { printable as p } from './printable.js';
import { tilde, ensureUserDir, userDir } from './paths.js';
import { mcpSettings } from './config.js';
import { stateDir, mcpLogFile } from './state.js';

/** The block every MCP client that reads an `mcpServers` map takes. */
export const MCP_JSON = { mcpServers: { mailproof: { command: 'mailproof', args: ['mcp'] } } };
const ADD = ['mcp', 'add', '--scope', 'user', 'mailproof', '--', 'mailproof', 'mcp'];
const REMOVE = ['mcp', 'remove', '--scope', 'user', 'mailproof'];

/**
 * Run `claude` with these arguments; null when there is no `claude` on PATH.
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string } | null>}
 */
export function runClaude(args) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && /** @type {any} */ (err).code === 'ENOENT') return resolve(null);
      const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The first executable named `mailproof` on PATH, or null. @param {Record<string, string | undefined>} env @returns {string | null} */
function onPath(env) {
  for (const d of (env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, 'mailproof');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/**
 * The MCP facts of this machine.
 * @param {import('./session.js').Ctx} ctx
 * @param {import('./config.js').Config} config
 */
export async function mcpFacts(ctx, config) {
  const run = ctx.deps.claude ?? runClaude;
  const got = await run(['mcp', 'get', 'mailproof']);
  const text = got ? `${got.stdout}\n${got.stderr}` : '';
  const grab = (/** @type {string} */ key) => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi').exec(text)?.[1]?.trim() ?? null;
  const mcp = mcpSettings(config);
  return {
    claude: got === null ? /** @type {const} */ ('missing') : got.code === 0 ? /** @type {const} */ ('registered') : /** @type {const} */ ('not registered'),
    scope: got?.code === 0 ? grab('Scope') : null,
    command: got?.code === 0 ? [grab('Command'), grab('Args')].filter(Boolean).join(' ') || null : null,
    onPath: onPath(ctx.env),
    thisInstall: fs.realpathSync(path.resolve(import.meta.dirname, '..', '..', 'bin', 'mailproof.js')),
    logFile: mcpLogFile(stateDir(ctx.env)),
    inputDirs: mcp.inputDirs,
    outputDir: mcp.outputDir,
  };
}

/**
 * The scope `claude mcp get` names, in plain words (`User config (available in all your projects)` becomes `for all your projects (user scope)`).
 * @param {string} scope @returns {string}
 */
export function scopeWords(scope) {
  const k = scope.trim().toLowerCase();
  if (k.startsWith('user')) return 'for all your projects (user scope)';
  if (k.startsWith('project')) return 'for this project (project scope)';
  if (k.startsWith('local')) return 'for you in one project (local scope)';
  return p(scope, { max: 60 });
}

/**
 * The status block, one labelled line each.
 * @param {Awaited<ReturnType<typeof mcpFacts>>} f
 * @param {import('./style.js').Style} st
 * @param {Record<string, string | undefined>} env
 * @param {string} configFile
 * @returns {string[]}
 */
export function mcpStatusLines(f, st, env, configFile) {
  const t = (/** @type {string} */ x) => p(tilde(x, env));
  const row = (/** @type {string} */ label, /** @type {string} */ v) => `${st.bold(label.padEnd(13))}${v}`;
  const claude = f.claude === 'missing' ? st.dim('the `claude` command was not found')
    : f.claude === 'registered' ? `${st.green(st.sym.ok)} registered${f.scope ? ` ${scopeWords(f.scope)}` : ''}${f.command ? `: ${p(f.command, { max: 80 })}` : ''}`
      : 'not registered';
  return [
    row('Claude Code', claude),
    row('Command', f.onPath ? `${t(f.onPath)} ${st.dim('(on your PATH)')}` : st.yellow(`mailproof is not on your PATH; this install is ${t(f.thisInstall)}`)),
    row('Config', t(configFile)),
    row('Log', t(f.logFile)),
    row('Input dirs', f.inputDirs.length ? f.inputDirs.map(t).join(', ') : st.dim('none (a tool cannot read a file by path)')),
    row('Output dir', f.outputDir ? t(f.outputDir) : st.dim('none (a tool cannot save a file)')),
  ];
}

/**
 * Print the JSON for other clients and write the same text to `~/mailproof/mcp/mcp.json` (dir 0700, file 0600).
 * @param {{ env: Record<string, string | undefined> }} ctx
 * @param {(s: string) => void} out
 * @param {import('./style.js').Style} st
 * @returns {Promise<string>}  The file written.
 */
export async function writeOtherClients(ctx, out, st) {
  const text = `${JSON.stringify(MCP_JSON, null, 2)}\n`;
  const dir = await ensureUserDir(ctx.env, 'mcp');
  const file = path.join(dir, 'mcp.json');
  await fsp.writeFile(file, text, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
  for (const l of text.trimEnd().split('\n')) out(`  ${st.key(l)}`);
  out('');
  out(`${st.green(st.sym.ok)} saved to ${p(tilde(file, ctx.env))}`);
  out("copy this into your MCP client's config (most clients use an mcpServers block)");
  return file;
}

export { ADD as CLAUDE_ADD, REMOVE as CLAUDE_REMOVE, userDir };
