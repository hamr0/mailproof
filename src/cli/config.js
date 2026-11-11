// The config file (SPEC B11.2): human-edited JSON, secrets by reference, strict. Only `config add-account` ever writes it
// (atomically, mode 0600). Loading refuses a file that is not owned by the caller or is readable by group or others,
// because it can name commands that run with the caller's rights.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageError, PermError } from './errors.js';
import { TRAIL_NAME_RE } from '../proof/trail.js';

/**
 * @typedef {Object} Account
 * @property {string} name
 * @property {string} user
 * @property {string} host
 * @property {number} port
 * @property {string[]} folders
 * @property {boolean | string} sent
 * @property {string} trailDir  Absolute.
 * @property {string} trail
 * @property {{ passCommand?: string, passFile?: string, accessTokenCommand?: string }} secret  Exactly one key.
 * @property {{ store?: boolean, attachments?: boolean, days?: number, sweepDays?: number }} content
 * @property {string | null} otsBin
 * @property {string | null} backupRemote
 */
/**
 * The server-wide `mcp` block (SPEC B12.2). Absent from the file: the defaults of `mcpSettings`.
 * @typedef {Object} McpConfig
 * @property {string[]} inputDirs  Absolute folders a tool may read a `path` from; empty refuses every path.
 * @property {string | null} outputDir  The one folder `saveTo` may write into; null refuses `saveTo`.
 * @property {number} maxResponseBytes  Cap on a result's text.
 * @property {number} maxBinaryBytes  Cap on a returned raw email or attachment.
 */
/** @typedef {{ v: 1, accounts: Record<string, Account>, mcp?: McpConfig }} Config */

export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLAINTEXT_KEYS = new Set(['pass', 'password', 'secret']);
const ACCOUNT_KEYS = new Set(['user', 'host', 'port', 'folders', 'sent', 'trailDir', 'trail', 'passCommand', 'passFile', 'accessTokenCommand', 'content', 'ots', 'backupRemote']);
const CONTENT_KEYS = new Set(['store', 'attachments', 'days', 'sweepDays']);
const MCP_KEYS = new Set(['inputDirs', 'outputDir', 'maxResponseBytes', 'maxBinaryBytes']);
export const MCP_DEFAULTS = Object.freeze({ maxResponseBytes: 524288, maxBinaryBytes: 1048576 });
const SECRET_KEYS = ['passCommand', 'passFile', 'accessTokenCommand'];

/** The text `mailproof config template` prints (it validates, see the tests). */
export const TEMPLATE = {
  v: 1,
  accounts: {
    personal: {
      user: 'ana@example.com',
      host: 'imap.example.com',
      port: 993,
      folders: ['INBOX'],
      sent: true,
      trailDir: '/home/ana/mailproof/personal',
      trail: 'default',
      passCommand: 'pass show mailproof/personal',
      content: { store: true, attachments: true, days: 730, sweepDays: 7 },
      ots: true,
      backupRemote: 'git@git.example.org:ana/mailproof-personal.git',
    },
    business: {
      user: 'ana@corp.example.net',
      host: 'imap.corp.example.net',
      trailDir: '/home/ana/mailproof/business',
      accessTokenCommand: 'oauth-token --account business',
    },
  },
};

/** An error that carries every problem found, one per line, each naming the JSON path. */
export class ConfigError extends UsageError {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/**
 * The home directory.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
const homeOf = (env) => env.HOME || os.homedir();

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}  `$XDG_CONFIG_HOME/mailproof` or `~/.config/mailproof`.
 */
export function configDir(env) {
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), '.config'), 'mailproof');
}

/**
 * @param {string | undefined} flag  `--config`.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function configPath(flag, env) {
  return flag ? path.resolve(flag) : path.join(configDir(env), 'config.json');
}

/**
 * `~` and `~/...` expanded; anything else as given.
 * @param {string} p
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function expandHome(p, env) {
  if (p === '~') return homeOf(env);
  return p.startsWith('~/') ? path.join(homeOf(env), p.slice(2)) : p;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Find a key named pass, password or secret anywhere in a value.
 * @param {unknown} v
 * @param {string} at
 * @param {string[]} out
 */
function findPlaintext(v, at, out) {
  if (Array.isArray(v)) { v.forEach((x, i) => findPlaintext(x, `${at}[${i}]`, out)); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (PLAINTEXT_KEYS.has(k.toLowerCase())) out.push(`${at}.${k}: put the password in your password manager and use passCommand, passFile or accessTokenCommand`);
    else findPlaintext(x, `${at}.${k}`, out);
  }
}

/**
 * Validate a parsed config. Strict: unknown keys, wrong types, bad names, two accounts on one trail are refused.
 * @param {unknown} json
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: Config | null, problems: string[] }}  `config` is null when there are problems.
 */
export function validateConfig(json, env) {
  /** @type {string[]} */
  const problems = [];
  if (!isObj(json)) return { config: null, problems: ['config: must be a JSON object'] };
  for (const k of Object.keys(json)) if (k !== 'v' && k !== 'accounts' && k !== 'mcp') problems.push(`${k}: unknown key`);
  const mcp = json.mcp === undefined ? undefined : validateMcp(json.mcp, env, problems);
  if (json.v !== 1) problems.push('v: must be 1');
  if (!isObj(json.accounts)) { problems.push('accounts: must be an object of accounts'); return { config: null, problems }; }
  /** @type {Record<string, Account>} */
  const accounts = {};
  /** @type {Map<string, string>} */
  const trails = new Map();
  for (const [name, raw] of Object.entries(json.accounts)) {
    const at = `accounts.${name}`;
    const before = problems.length;
    if (!ACCOUNT_NAME_RE.test(name)) problems.push(`${at}: the account name must match [a-z0-9][a-z0-9_-]{0,31}`);
    if (!isObj(raw)) { problems.push(`${at}: must be an object`); continue; }
    findPlaintext(raw, at, problems);
    for (const k of Object.keys(raw)) if (!ACCOUNT_KEYS.has(k) && !PLAINTEXT_KEYS.has(k.toLowerCase())) problems.push(`${at}.${k}: unknown key`);
    /** @param {string} k @param {string} type */
    const typed = (k, type) => {
      if (raw[k] === undefined) return false;
      if (typeof raw[k] !== type || (type === 'string' && !(/** @type {string} */ (raw[k])).trim())) { problems.push(`${at}.${k}: must be a ${type === 'string' ? 'non-empty string' : type}`); return false; }
      return true;
    };
    const userOk = raw.user === undefined ? (problems.push(`${at}.user: required`), false) : typed('user', 'string');
    const hostOk = raw.host === undefined || typed('host', 'string');
    let port = 993;
    if (raw.port !== undefined) {
      if (!Number.isInteger(raw.port) || /** @type {number} */ (raw.port) < 1 || /** @type {number} */ (raw.port) > 65535) problems.push(`${at}.port: must be an integer 1-65535`);
      else port = /** @type {number} */ (raw.port);
    }
    /** @type {string[]} */
    let folders = ['INBOX'];
    if (raw.folders !== undefined) {
      if (!Array.isArray(raw.folders) || raw.folders.length === 0 || raw.folders.some((f) => typeof f !== 'string' || !f.trim())) problems.push(`${at}.folders: must be a non-empty array of folder names`);
      else folders = /** @type {string[]} */ (raw.folders);
    }
    /** @type {boolean | string} */
    let sent = true;
    if (raw.sent !== undefined) {
      if (typeof raw.sent === 'boolean' || (typeof raw.sent === 'string' && raw.sent.trim())) sent = /** @type {boolean | string} */ (raw.sent);
      else problems.push(`${at}.sent: must be true, false or a folder path`);
    }
    let trailDir = '';
    if (raw.trailDir === undefined) problems.push(`${at}.trailDir: required`);
    else if (typed('trailDir', 'string')) {
      trailDir = expandHome(/** @type {string} */ (raw.trailDir), env);
      if (!path.isAbsolute(trailDir)) { problems.push(`${at}.trailDir: must be an absolute path (or start with ~/)`); trailDir = ''; }
    }
    let trail = 'default';
    if (raw.trail !== undefined) {
      if (typeof raw.trail !== 'string' || !TRAIL_NAME_RE.test(raw.trail)) problems.push(`${at}.trail: must match [a-z0-9][a-z0-9_-]{0,63}`);
      else trail = raw.trail;
    }
    /** @type {Account['secret']} */
    const secret = {};
    const named = SECRET_KEYS.filter((k) => raw[k] !== undefined);
    if (named.length !== 1) problems.push(`${at}: give exactly one of ${SECRET_KEYS.join(', ')}${named.length ? ` (found ${named.join(', ')})` : ''}`);
    for (const k of named) if (typed(k, 'string')) secret[/** @type {keyof Account['secret']} */ (k)] = /** @type {string} */ (raw[k]);
    /** @type {Account['content']} */
    const content = {};
    if (raw.content !== undefined) {
      if (!isObj(raw.content)) problems.push(`${at}.content: must be an object`);
      else {
        for (const [k, v] of Object.entries(raw.content)) {
          if (!CONTENT_KEYS.has(k)) problems.push(`${at}.content.${k}: unknown key`);
          else if (k === 'store' || k === 'attachments') {
            if (typeof v !== 'boolean') problems.push(`${at}.content.${k}: must be true or false`);
            else content[/** @type {'store' | 'attachments'} */ (k)] = v;
          } else if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) problems.push(`${at}.content.${k}: must be a positive integer`);
          else content[/** @type {'days' | 'sweepDays'} */ (k)] = /** @type {number} */ (v);
        }
      }
    }
    /** @type {string | null} */
    let otsBin = null;
    if (raw.ots !== undefined) {
      if (raw.ots === true) otsBin = 'ots';
      else if (raw.ots === false) otsBin = null;
      else if (typeof raw.ots === 'string' && path.isAbsolute(raw.ots)) otsBin = raw.ots;
      else problems.push(`${at}.ots: must be true, false or an absolute path to the ots binary`);
    }
    /** @type {string | null} */
    let backupRemote = null;
    if (raw.backupRemote !== undefined && typed('backupRemote', 'string')) {
      backupRemote = /** @type {string} */ (raw.backupRemote).trim();
      // secrets by reference only: a token or password in the URL sits in the config and in git's argv; ssh://git@host (a login name) is fine
      const m = /^([a-z][a-z0-9+.-]*):\/\/([^/@\s]*)@/i.exec(backupRemote);
      if (m && (m[2].includes(':') || !/^(git\+)?ssh$/i.test(m[1]))) {
        problems.push(`${at}.backupRemote: must not carry credentials; use a git credential helper or an ssh key (git@host:path, ssh://git@host/path)`);
        backupRemote = null;
      }
    }
    if (trailDir) {
      const key = `${path.resolve(trailDir)}\0${trail}`;
      const other = trails.get(key);
      if (other) problems.push(`${at}: shares trailDir and trail with account "${other}"`);
      else trails.set(key, name);
    }
    if (problems.length === before && userOk && hostOk) {
      accounts[name] = { name, user: /** @type {string} */ (raw.user), host: /** @type {string} */ (raw.host ?? 'imap.gmail.com'), port, folders, sent, trailDir, trail, secret, content, otsBin, backupRemote };
    }
  }
  if (Object.keys(json.accounts).length === 0) problems.push('accounts: at least one account is required');
  return problems.length ? { config: null, problems } : { config: { v: 1, accounts, ...(mcp ? { mcp } : {}) }, problems };
}

/**
 * Validate the `mcp` block (SPEC B12.2): strict, every problem names its JSON path.
 * @param {unknown} raw
 * @param {Record<string, string | undefined>} env
 * @param {string[]} problems
 * @returns {McpConfig | undefined}
 */
function validateMcp(raw, env, problems) {
  if (!isObj(raw)) { problems.push('mcp: must be an object'); return undefined; }
  const before = problems.length;
  for (const k of Object.keys(raw)) if (!MCP_KEYS.has(k)) problems.push(`mcp.${k}: unknown key`);
  /** @type {string[]} */
  const inputDirs = [];
  if (raw.inputDirs !== undefined) {
    if (!Array.isArray(raw.inputDirs)) problems.push('mcp.inputDirs: must be an array of absolute directories');
    else raw.inputDirs.forEach((d, i) => {
      const dir = typeof d === 'string' ? expandHome(d, env) : '';
      if (!dir || !path.isAbsolute(dir)) problems.push(`mcp.inputDirs[${i}]: must be an absolute path (or start with ~/)`);
      else inputDirs.push(path.resolve(dir));
    });
  }
  /** @type {string | null} */
  let outputDir = null;
  if (raw.outputDir !== undefined) {
    const dir = typeof raw.outputDir === 'string' ? expandHome(raw.outputDir, env) : '';
    if (!dir || !path.isAbsolute(dir)) problems.push('mcp.outputDir: must be an absolute path (or start with ~/)');
    else outputDir = path.resolve(dir);
  }
  /** @type {{ maxResponseBytes: number, maxBinaryBytes: number }} */
  const sizes = { maxResponseBytes: MCP_DEFAULTS.maxResponseBytes, maxBinaryBytes: MCP_DEFAULTS.maxBinaryBytes };
  for (const k of /** @type {const} */ (['maxResponseBytes', 'maxBinaryBytes'])) {
    if (raw[k] === undefined) continue;
    const v = raw[k];
    if (!Number.isInteger(v) || /** @type {number} */ (v) < 1024) problems.push(`mcp.${k}: must be an integer of at least 1024`);
    else sizes[k] = /** @type {number} */ (v);
  }
  return problems.length === before ? { inputDirs, outputDir, ...sizes } : undefined;
}

/**
 * The `mcp` settings with the defaults filled in.
 * @param {Config} config
 * @returns {McpConfig}
 */
export function mcpSettings(config) {
  return config.mcp ?? { inputDirs: [], outputDir: null, ...MCP_DEFAULTS };
}

/**
 * Read the file, with the permission check first: owned by the effective uid, no group or other bits. Resolves symlinks.
 * @param {string} file
 * @param {{ euid?: number | null }} [opts]  `euid` overrides the effective uid (tests); null skips the owner check (no uid on this platform).
 * @returns {Promise<string>}  The file's text.
 */
export async function readTrustedFile(file, { euid } = {}) {
  let real;
  try { real = await fs.realpath(file); }
  catch { throw new UsageError(`no config file at ${file}; create one with "mailproof config add-account" or see "mailproof config template"`); }
  const fh = await fs.open(real, 'r');   // check and read the same open file: a swap between the two cannot slip past
  try {
    const st = await fh.stat();
    const me = euid === undefined ? (typeof process.geteuid === 'function' ? process.geteuid() : null) : euid;
    if ((me !== null && st.uid !== me) || (st.mode & 0o077) !== 0) {
      throw new PermError(`config ${file} must be owned by you and mode 0600 (chmod 600 ${file})`);
    }
    return await fh.readFile('utf8');
  } finally { await fh.close(); }
}

/**
 * Parse JSON text and validate it.
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 * @param {string} file  For messages.
 * @returns {Config}
 */
export function parseConfig(text, env, file) {
  /** @type {unknown} */
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new UsageError(`config ${file} is not valid JSON: ${/** @type {Error} */ (e).message}`); }
  const { config, problems } = validateConfig(json, env);
  if (!config) throw new ConfigError(problems.map((p) => `${file}: ${p}`));
  return config;
}

/**
 * Load, check the permissions of, and validate the config.
 * @param {string} file
 * @param {Record<string, string | undefined>} env
 * @param {{ euid?: number | null }} [opts]
 * @returns {Promise<Config>}
 */
export async function loadConfig(file, env, opts) {
  return parseConfig(await readTrustedFile(file, opts), env, file);
}

/**
 * The account a command runs on (SPEC B11.3).
 * @param {Config} config
 * @param {string | undefined} flag  `--account`.
 * @returns {Account}
 */
export function selectAccount(config, flag) {
  const names = Object.keys(config.accounts);
  if (flag === undefined) {
    if (names.length === 1) return config.accounts[names[0]];
    throw new UsageError(`more than one account is configured; name one with --account (${names.join(', ')})`);
  }
  if (!Object.hasOwn(config.accounts, flag)) throw new UsageError(`unknown account "${flag}"; configured: ${names.join(', ')}`);
  return config.accounts[flag];
}

/**
 * The `Mailproof` constructor options of an account.
 * @param {Account} a
 * @returns {{ trailDir: string, trail: string, otsBin?: string, content?: Account['content'] }}
 */
export function mailproofOptions(a) {
  return { trailDir: a.trailDir, trail: a.trail, ...(a.otsBin ? { otsBin: a.otsBin } : {}), ...(Object.keys(a.content).length ? { content: a.content } : {}) };
}

/**
 * A profile: a path as given, else `<configDir>/profiles/<name>.json`. Profiles hold no secrets, so no mode check.
 * @param {string} spec
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<unknown>}  The parsed JSON.
 */
export async function loadProfile(spec, env) {
  const isName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(spec);
  const file = isName ? path.join(configDir(env), 'profiles', `${spec}.json`) : path.resolve(spec);
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { throw new UsageError(`--profile: cannot read ${file} (${/** @type {any} */ (e).code ?? 'error'})${isName ? '; a bare name is looked up in the profiles directory, use a path for another place' : ''}`); }
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`--profile: ${file} is not valid JSON: ${/** @type {Error} */ (e).message}`); }
}

/**
 * Write the config atomically with mode 0600 (directory 0700 when created): temp file in the same directory, fsync, rename.
 * @param {string} file
 * @param {unknown} json
 * @returns {Promise<void>}
 */
export async function writeConfigAtomic(file, json) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(json, null, 2) + '\n');
    await fh.sync();
  } catch (e) { await fh.close(); await fs.rm(tmp, { force: true }); throw e; }
  await fh.close();
  try { await fs.rename(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}
