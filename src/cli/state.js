// The state directory (SPEC B11.2): everything mailproof rewrites by itself lives here, never in the config. It is
// advisory: losing it loses nothing. Mode 0700, created on first write.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {Object} AccountState
 * @property {number} v
 * @property {{ at: string, complete: boolean, recorded: number, error: string | null } | null} lastSync
 * @property {{ at: string, pid: number, state: 'running' | 'stopped' } | null} lastWatch
 * @property {{ at: string, path: string } | null} lastBackup
 */

const LOG_KEEP_BYTES = 1024 * 1024;

/** @returns {AccountState} */
const emptyState = () => ({ v: 1, lastSync: null, lastWatch: null, lastBackup: null });

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function stateDir(env) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(base, 'mailproof');
}

/** @param {string} dir @param {string} account @returns {string} */
const accountDir = (dir, account) => path.join(dir, account);

/**
 * @param {string} dir
 * @param {string} account
 * @returns {Promise<AccountState>}
 */
export async function readState(dir, account) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(accountDir(dir, account), 'state.json'), 'utf8'));
    return j && typeof j === 'object' ? { ...emptyState(), ...j } : emptyState();
  } catch { return emptyState(); }
}

/**
 * Merge `patch` into the account's state.json (atomic: temp file, then rename). Best effort: it never fails a command.
 * @param {string} dir
 * @param {string} account
 * @param {Partial<AccountState>} patch
 * @returns {Promise<void>}
 */
export async function updateState(dir, account, patch) {
  try {
    const d = accountDir(dir, account);
    await fs.mkdir(d, { recursive: true, mode: 0o700 });
    const next = { ...(await readState(dir, account)), ...patch, v: 1 };
    const file = path.join(d, 'state.json');
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch { /* advisory */ }
}

/**
 * Append one line to watch.log.
 * @param {string} dir
 * @param {string} account
 * @param {string} line
 * @returns {Promise<void>}
 */
export async function appendWatchLog(dir, account, line) {
  try {
    const d = accountDir(dir, account);
    await fs.mkdir(d, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(d, 'watch.log'), line + '\n', { mode: 0o600 });
  } catch { /* advisory */ }
}

/**
 * Keep only the last 1 MiB of watch.log (done once at watch start).
 * @param {string} dir
 * @param {string} account
 * @returns {Promise<void>}
 */
export async function truncateWatchLog(dir, account) {
  const file = path.join(accountDir(dir, account), 'watch.log');
  try {
    const st = await fs.stat(file);
    if (st.size <= LOG_KEEP_BYTES) return;
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(LOG_KEEP_BYTES);
      await fh.read(buf, 0, LOG_KEEP_BYTES, st.size - LOG_KEEP_BYTES);
      const nl = buf.indexOf(10);   // start at a line boundary
      await fs.writeFile(file, nl >= 0 ? buf.subarray(nl + 1) : buf, { mode: 0o600 });
    } finally { await fh.close(); }
  } catch { /* no log yet */ }
}
