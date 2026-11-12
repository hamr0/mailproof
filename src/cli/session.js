// What every command needs: the output channels, the config, one account, one Mailproof (SPEC B11.3). The dispatcher
// and the menu build a Ctx once; commands receive it and never touch process.* themselves, so they run the same from
// the shell, from the menu and from a test.

import { Mailproof } from '../index.js';
import { loadConfig, configPath, selectAccount, mailproofOptions } from './config.js';
import { stateDir } from './state.js';
import { printable } from './printable.js';
import { styleOf, allowStyle } from './style.js';

/**
 * Seams a test (or an embedding program) can replace.
 * @typedef {Object} Deps
 * @property {(mp: Mailproof, opts: import('../proof/sync.js').SyncOptions) => Promise<import('../proof/sync.js').SyncResult>} [sync]  Default `mp.sync(opts)`. Tests never contact IMAP.
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} [sleep]  Default: a timer that ends early on abort.
 * @property {() => Date} [now]
 * @property {(args: string[], ctx: Ctx) => Promise<number>} [runNpm]  Default: spawn `npm` with the output streaming through.
 * @property {() => { dev: boolean, dir: string }} [installInfo]  Where mailproof is installed and whether it is a development link (default: looked up from the package folder).
 * @property {() => Promise<string | null>} [npmView]  The latest version on npm, null when unreachable (default: `npm view mailproof version`, 10 s). Tests never reach the registry.
 * @property {(account: import('./config.js').Account) => Mailproof} [makeMailproof]
 * @property {(raw: Buffer) => Promise<{ live: Record<string, any>, portable: Record<string, any>, signatures: number, unsigned: boolean, key_errors: string[], body_status: string }>} [check]  The menu's "check a .eml file" (default: the library's `check`, which asks DNS). Tests inject a fake.
 * @property {(o: { host: string, port: number, user: string, auth: { pass: string } | { accessToken: string }, folders: string[], sent: boolean | string }) => Promise<{ ok: true, folders: Array<{ folder: string, count: number }> } | { ok: false, code: string, message: string }>} [testLogin]  The wizard's "test login now" (default: one real IMAP login and a folder status). Tests inject a fake: IMAP is never contacted.
 * @property {number} [minIntervalMs]  Lower bound of `watch --interval` (default 30 s; tests lower it).
 */

/**
 * @typedef {Object} Ctx
 * @property {{ write: (s: string | Uint8Array) => unknown, isTTY?: boolean, columns?: number, rows?: number }} stdout
 * @property {{ write: (s: string) => unknown, isTTY?: boolean, columns?: number }} stderr
 * @property {NodeJS.ReadableStream | null} stdin  Only the menu and `config add-account` read it.
 * @property {boolean} interactive  stdin and stdout are terminals (the menu may start).
 * @property {Record<string, string | undefined>} env
 * @property {number | null | undefined} [euid]  Overrides the effective uid in the config owner check (tests).
 * @property {AbortSignal} signal  Aborted by SIGINT/SIGTERM (watch stops, a running command is cut short).
 * @property {Deps} deps
 * @property {import('./prompt.js').Prompter} [prompter]  Set by the menu: one reader of stdin shared by every prompt.
 * @property {{ dev?: boolean, upToDate?: boolean, newer?: boolean }} [updateOut]  Set by the menu for `update --check`: the command fills it so the menu knows whether to offer the upgrade.
 * @property {boolean} [previewed]  Set by the menu for a destructive command it already showed the preview of: the command does not print it a second time.
 */

/**
 * @typedef {Object} Args
 * @property {string} cmd
 * @property {Record<string, any>} values  Global flags and the command's flags.
 * @property {string[]} positionals
 */

/**
 * The output backstop (SPEC B11, F28): every line of text output passes through here, so a field a sink forgot to wrap
 * still cannot reach the terminal as a control sequence. Fields are wrapped per field where they are built (that escapes
 * the backslash too); this pass keeps backslashes, so an escape a field already made is not escaped a second time.
 * @param {string} s
 * @returns {string}
 */
export const safe = (s) => printable(s, { keepNewline: true, keepBackslash: true });

/** @param {Ctx} ctx @param {string} s */
export const print = (ctx, s) => { const t = styleOf(ctx).on ? allowStyle(s) : safe(s); ctx.stdout.write(t.endsWith('\n') ? t : `${t}\n`); };
/** @param {Ctx} ctx @param {string} s */
export const warn = (ctx, s) => { const t = styleOf(ctx, 'stderr').on ? allowStyle(s) : safe(s); ctx.stderr.write(t.endsWith('\n') ? t : `${t}\n`); };
/** @param {Ctx} ctx @param {unknown} v One JSON document. */
export const printJson = (ctx, v) => { ctx.stdout.write(JSON.stringify(v) + '\n'); };

/**
 * The config of this run: the path (flag, XDG, home), then permission check and validation.
 * @param {Args} a
 * @param {Ctx} ctx
 * @returns {Promise<{ file: string, config: import('./config.js').Config }>}
 */
export async function loadCtxConfig(a, ctx) {
  const file = configPath(a.values.config, ctx.env);
  return { file, config: await loadConfig(file, ctx.env, { euid: ctx.euid }) };
}

/**
 * @typedef {Object} Session
 * @property {import('./config.js').Account} account
 * @property {Mailproof} mp
 * @property {string} state  The state directory.
 * @property {string} configFile
 * @property {() => Promise<void>} close
 */

/**
 * Open the account a command runs on. The caller must `close()` it.
 * @param {Args} a
 * @param {Ctx} ctx
 * @returns {Promise<Session>}
 */
export async function openAccount(a, ctx) {
  const { file, config } = await loadCtxConfig(a, ctx);
  const account = selectAccount(config, a.values.account);
  const mp = ctx.deps.makeMailproof ? ctx.deps.makeMailproof(account) : new Mailproof(mailproofOptions(account));
  return { account, mp, state: stateDir(ctx.env), configFile: file, close: () => mp.close() };
}

/**
 * Run `fn` with the account's session, always closing it.
 * @template T
 * @param {Args} a
 * @param {Ctx} ctx
 * @param {(s: Session) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAccount(a, ctx, fn) {
  const s = await openAccount(a, ctx);
  try { return await fn(s); } finally { await s.close(); }
}

/**
 * Plain ISO time without milliseconds, for lines of text.
 * @param {Date} d
 * @returns {string}
 */
export const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
