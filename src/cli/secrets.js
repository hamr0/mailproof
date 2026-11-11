// Where a secret comes from, shared by `mailproof` (the config names the source) and `mailproof-sync` (flags and env).
// Same semantics in both: a command split into argv and run without a shell (first stdout line), a file (first line),
// an OAuth2 token command. The secret is never logged, never echoed, never stored.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { UsageError, PermError } from './errors.js';

const GOOGLE_APP_PASSWORD_SHAPE = /^[a-z]{4}( [a-z]{4}){3}$/;

/**
 * Split a command line into argv: whitespace separated, with '...' and "..." quoting and backslash escapes. No shell.
 * @param {string} s
 * @returns {string[]}
 */
export function splitCommand(s) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let has = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) throw new UsageError('unterminated quote in command');
  if (has) out.push(cur);
  return out;
}

/**
 * Run a secret command and return the first line of its stdout.
 * @param {string} cmd
 * @param {string} what  Names the source in errors ("pass command").
 * @returns {Promise<string>}
 */
export function runSecretCommand(cmd, what) {
  const argv = splitCommand(cmd);
  if (!argv.length) throw new UsageError(`${what} is empty`);
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
      // never echo the command's stderr or stdout: either could hold the secret
      if (err) return reject(Object.assign(new Error(`${what} failed (${/** @type {any} */ (err).code ?? err.name})`), { code: 'EX_SECRET_COMMAND' }));
      resolve(String(stdout).split('\n')[0]);
    });
    // execFile has no stdio option: close the child's stdin so a command that waits for EOF cannot hang
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

/**
 * First line of a file. Same rule as the config: owned by the effective uid, no group or other bits.
 * @param {string} file
 * @param {string} flag  Names the source in errors.
 * @returns {Promise<string>}
 */
export async function readSecretFile(file, flag) {
  /** @type {import('node:fs/promises').FileHandle | null} */
  let fh = null;
  try { fh = await fs.open(file, 'r'); }
  catch (e) { throw new UsageError(`cannot read ${flag}: ${/** @type {any} */ (e).code ?? 'error'}`); }
  try {
    const st = await fh.stat();   // check and read the same open file
    const me = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if ((me !== null && st.uid !== me) || (st.mode & 0o077) !== 0) {
      throw new PermError(`${flag} ${file} must be owned by you and mode 0600 (chmod 600 ${file})`);
    }
    return (await fh.readFile('utf8')).split('\n')[0];
  } catch (e) {
    if (e instanceof PermError) throw e;
    throw new UsageError(`cannot read ${flag}: ${/** @type {any} */ (e).code ?? 'error'}`);
  } finally { await fh.close(); }
}

/**
 * Turn a raw password line into the `auth` of `sync()`. Google shows an app password as four groups of four lowercase
 * letters; the spaces are not part of it. Any other value is a real password: only the surrounding whitespace goes.
 * @param {string} raw
 * @returns {{ pass: string }}
 */
export function passwordAuth(raw) {
  const trimmed = raw.trim();
  const pass = GOOGLE_APP_PASSWORD_SHAPE.test(trimmed) ? trimmed.replace(/ /g, '') : trimmed;
  if (!pass) throw new UsageError('the password source gave an empty password');
  return { pass };
}

/**
 * @param {string} cmd  The access-token command.
 * @returns {Promise<{ accessToken: string }>}
 */
export async function tokenAuth(cmd) {
  const accessToken = (await runSecretCommand(cmd, 'access-token command')).trim();
  if (!accessToken) throw new UsageError('the access-token command printed nothing');
  return { accessToken };
}

/**
 * Resolve one account's secret source (the config names exactly one) into `auth`. Called per sync, so a fresh OAuth
 * token is fetched and a `passCommand` re-run every time.
 * @param {{ passCommand?: string, passFile?: string, accessTokenCommand?: string }} src
 * @returns {Promise<{ pass: string } | { accessToken: string }>}
 */
export async function resolveAuth(src) {
  if (src.accessTokenCommand) return tokenAuth(src.accessTokenCommand);
  if (src.passCommand) return passwordAuth(await runSecretCommand(src.passCommand, 'pass command'));
  if (src.passFile) return passwordAuth(await readSecretFile(src.passFile, 'passFile'));
  throw new UsageError('the account names no secret source (passCommand, passFile or accessTokenCommand)');
}
