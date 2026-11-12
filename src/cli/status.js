// `status` (SPEC B11.5): what a trail holds and how it is kept. Read-only: never opens IMAP, never takes the trail lock, never builds or catches up the index. The one command that may
// run on every account at once (B11.3).

import path from 'node:path';
import { Mailproof } from '../index.js';
import { EX_OK } from './errors.js';
import { selectAccount, mailproofOptions, loadConfig } from './config.js';
import { print, printJson, loadCtxConfig } from './session.js';
import { printable as p } from './printable.js';
import { styleOf, fileUrl, rel } from './style.js';
import { readState, stateDir } from './state.js';
import { pidAlive, headOf, trailIndexFile } from '../proof/trail.js';
import { sealStatus } from '../proof/stamp.js';
import { STAMP_EVERY_HOURS } from '../proof/limits.js';
import { indexOverview } from '../proof/index-db.js';

/**
 * The facts of one account, as `status` shows them and the MCP `status` tool returns them: the library's `status()` (what the trail
 * holds and how it is kept) plus what only the CLI side knows (the state file: last sync, last backup, a running watch).
 * @param {import('./config.js').Account} account
 * @param {import('../index.js').Mailproof} mp
 * @param {string} state  The state directory.
 * @returns {Promise<{ user: string, trail: string, records: import('../proof/status.js').TrailStatus['records'], lastSync: import('./state.js').AccountState['lastSync'], content: import('../proof/status.js').TrailStatus['content'], index: import('../proof/status.js').TrailStatus['index'], pendingStamps: number | null, seal: import('../proof/status.js').TrailStatus['seal'], lastBackup: import('./state.js').AccountState['lastBackup'], watch: { running: boolean, pid?: number } }>}
 */
export async function accountStatus(account, mp, state) {
  const [lib, st] = await Promise.all([mp.status(), readState(state, account.name)]);
  return {
    user: account.user, trail: lib.trail, records: lib.records, lastSync: st.lastSync, content: lib.content, index: lib.index,
    pendingStamps: lib.pendingStamps, seal: lib.seal, lastBackup: st.lastBackup,
    watch: st.lastWatch && st.lastWatch.state === 'running' && pidAlive(st.lastWatch.pid) ? { running: true, pid: st.lastWatch.pid } : { running: false },
  };
}

/**
 * Does the config file pass `config validate`? (Permissions and every field; no secret is read.) For the MCP `status` tool.
 * @param {string} file
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ path: string, ok: boolean, error?: string }>}
 */
export async function configFacts(file, env) {
  try { await loadConfig(file, env, {}); return { path: file, ok: true }; }
  catch (e) { return { path: file, ok: false, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 500) }; }
}

/**
 * @param {import('./config.js').Account} account
 * @param {import('./session.js').Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
async function statusOf(account, ctx) {
  const mp = ctx.deps.makeMailproof ? ctx.deps.makeMailproof(account) : new Mailproof(mailproofOptions(account));
  try {
    const s = await accountStatus(account, mp, stateDir(ctx.env));
    // the verified/unverified counts are the library's and the menu's; `status` has never printed them
    const r = s.records && !('error' in s.records) ? (({ verified, unverified, ...rest }) => rest)(s.records) : s.records;
    return { ...s, records: r };
  } finally { await mp.close(); }
}

/**
 * The seal line (SPEC B13.1.12): mode, last and next due, manifests and those without a proof, proofs not yet anchored.
 * @param {Record<string, any> | null} z
 * @returns {string}
 */
function sealText(z) {
  if (!z) return 'unknown';
  if (!z.enabled) return 'off (ots: false)';
  if (z.chain !== 'ok') return `chain broken at seq ${z.chain.brokenAt}: ${p(z.chain.why)}`;
  const when = z.last ? `last ${p(z.last.replace(/\.\d+Z$/, 'Z'))}, next due ${p(z.nextDue.replace(/\.\d+Z$/, 'Z'))}` : 'never run (due at the next sync or `mailproof stamp`)';
  const parts = [`${z.mode} every ${z.everyHours}h`, when];
  if (z.mode === 'batch') parts.push(`${z.manifests} manifests (${z.unstamped} without a proof)`);
  parts.push(`${z.pending} proofs not yet anchored`);
  if (z.error) parts.push(`last run: ${p(z.error)}`);
  return parts.join('; ');
}

/**
 * @param {Record<string, any>} s
 * @param {import('./style.js').Style} st
 * @param {Date} now
 * @returns {string}
 */
function statusText(s, st, now) {
  const r = s.records;
  const hint = s.index === 'unreadable' ? 'the index cannot be opened: check permissions on the trail directory; if it is writable, `mailproof list` rebuilds it'
    : s.index === 'unknown' ? 'the SQLite add-on (better-sqlite3) cannot load, so `mailproof list` fails too: reinstall or rebuild it (npm rebuild better-sqlite3)'
      : 'index stale; run `mailproof list` for in/out and dates';
  const rec = r === null ? 'no trail yet' : r.error ? `unavailable (${p(r.error)})`
    : r.totalSource === 'git' ? `${r.total} files at HEAD (${s.index === 'absent' ? 'no index yet; run `mailproof list` for in/out and dates' : hint})`
      : `${r.total} (${r.in} in, ${r.out} out), oldest ${r.oldest?.slice(0, 10) ?? '-'}, newest ${r.newest?.slice(0, 10) ?? '-'}`;
  const c = s.content === 'off' ? 'off' : `${s.content.files} files, ${(s.content.bytes / 1048576).toFixed(1)} MiB`;
  const ls = s.lastSync;
  const sync = !ls ? st.dim('never')
    : `${ls.error ? st.red(st.sym.bad) : ls.complete ? st.green(st.sym.ok) : st.yellow(st.sym.warn)} ${p(ls.at)} ${st.dim(`(${rel(ls.at, now)})`)}${ls.complete ? '' : ' (not complete)'}${ls.error ? ` error ${p(ls.error)}` : ''}`;
  const sealWord = (/** @type {string} */ t) => (/^off|never|unknown/.test(t) ? st.dim(t) : /broken/.test(t) ? st.red(t) : t);
  /** @param {string} label @param {string} v */
  const row = (label, v) => `  ${st.dim(label.padEnd(13))} ${v}`;
  return [
    row('trail', st.link(p(s.trail), fileUrl(s.trail))),
    row('records', rec),
    row('last sync', sync),
    row('content', c),
    row('index', s.index === 'present' ? st.green(s.index) : st.yellow(s.index)),
    row('seal', sealWord(sealText(s.seal))),
    row('last backup', s.lastBackup ? `${p(s.lastBackup.at)}  ${st.link(p(s.lastBackup.path), fileUrl(String(s.lastBackup.path)))}` : st.dim('never')),
    row('watch', s.watch.running ? st.green(`running (pid ${s.watch.pid})`) : st.dim('not running')),
  ].join('\n');
}

/** @param {import('./session.js').Args} a @param {import('./session.js').Ctx} ctx @returns {Promise<number>} */
export async function statusCmd(a, ctx) {
  const { config } = await loadCtxConfig(a, ctx);
  const names = a.values.account === undefined ? Object.keys(config.accounts) : [selectAccount(config, a.values.account).name];
  /** @type {Record<string, Record<string, unknown>>} */
  const all = {};
  for (const n of names) all[n] = await statusOf(config.accounts[n], ctx);
  if (a.values.json) { printJson(ctx, all); return EX_OK; }
  const st = styleOf(ctx);
  const now = (ctx.deps.now ?? (() => new Date()))();
  for (const n of names) print(ctx, `${st.bold(p(n))}\n${statusText(all[n], st, now)}`);
  return EX_OK;
}

/**
 * What the menu header shows (SPEC B11.4): fast and offline. It reads the state file, the HEAD of the trail, the index overview (one
 * aggregate query on a present index; a count of the record files otherwise) and the manifest chain. No IMAP, no DNS, no `ots`, no lock,
 * no content-store walk, no index build.
 * @param {import('./config.js').Account} account
 * @param {import('./session.js').Ctx} ctx
 * @returns {Promise<{ user: string, trailOk: boolean, lastSync: { at: string, complete: boolean, error: string | null } | null, records: { total: number, verified: number | null, unverified: number | null, out: number | null } | null, seal: { state: 'off' | 'never' | 'pending' | 'sealed' | 'broken', nextDue: string | null }, watch: boolean }>}
 */
export async function headerFacts(account, ctx) {
  const mp = ctx.deps.makeMailproof ? ctx.deps.makeMailproof(account) : new Mailproof(mailproofOptions(account));
  try {
    const st = await readState(stateDir(ctx.env), account.name);
    const head = await headOf(mp.root).catch(() => null);
    /** @type {import('../proof/index-db.js').IndexOverview | null} */
    let ov = null;
    if (head !== null) ov = await indexOverview({ root: mp.root, trail: mp.trail, lockTimeoutMs: mp.lockTimeoutMs }, path.join(account.trailDir, trailIndexFile(account.trail))).catch(() => null);
    const z = account.otsBin !== null && head !== null
      ? await sealStatus({ root: mp.root, trail: mp.trail, stamp: { mode: account.stamp.mode ?? 'batch', everyHours: account.stamp.everyHours ?? STAMP_EVERY_HOURS }, enabled: true }).catch(() => null)
      : null;
    const sealState = account.otsBin === null ? 'off' : !z ? 'never' : z.chain !== 'ok' ? 'broken' : z.last === null ? 'never' : z.pending + z.unstamped > 0 ? 'pending' : 'sealed';
    return {
      user: account.user, trailOk: head !== null,
      lastSync: st.lastSync ? { at: st.lastSync.at, complete: st.lastSync.complete, error: st.lastSync.error } : null,
      records: ov ? { total: ov.total, verified: ov.verified, unverified: ov.unverified, out: ov.out } : null,
      seal: { state: sealState, nextDue: z?.nextDue ?? null },
      watch: Boolean(st.lastWatch && st.lastWatch.state === 'running' && pidAlive(st.lastWatch.pid)),
    };
  } finally { await mp.close(); }
}
