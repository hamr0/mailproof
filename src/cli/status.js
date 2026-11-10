// `status` (SPEC B11.5): what a trail holds and how it is kept. Read-only, never opens IMAP. The one command that may
// run on every account at once (B11.3).

import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailproof } from '../index.js';
import { EX_OK } from './errors.js';
import { selectAccount, mailproofOptions } from './config.js';
import { print, printJson, loadCtxConfig } from './session.js';
import { readState, stateDir } from './state.js';
import { pidAlive, headOf, trailIndexFile } from '../proof/trail.js';
import { countPendingStamps } from '../proof/ots-upgrade.js';
import { indexState } from '../proof/index-db.js';

/** @param {string} dir @returns {Promise<{ files: number, bytes: number }>} */
async function sizeOf(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = await sizeOf(p); files += s.files; bytes += s.bytes; }
    else if (e.isFile()) { files++; bytes += (await fs.stat(p)).size; }
  }
  return { files, bytes };
}

/**
 * @param {import('./config.js').Account} account
 * @param {import('./session.js').Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
async function statusOf(account, ctx) {
  const mp = ctx.deps.makeMailproof ? ctx.deps.makeMailproof(account) : new Mailproof(mailproofOptions(account));
  try {
    const st = await readState(stateDir(ctx.env), account.name);
    const head = await headOf(mp.root).catch(() => null);
    /** @type {Record<string, unknown>} */
    const out = { user: account.user, trail: path.join(account.trailDir, account.trail) };
    if (head === null) out.records = null;
    else {
      try {
        const rows = await mp.list();
        const times = rows.map((r) => r.captured).sort();
        out.records = { total: rows.length, in: rows.filter((r) => r.direction === 'in').length, out: rows.filter((r) => r.direction === 'out').length, oldest: times[0] ?? null, newest: times[times.length - 1] ?? null };
      } catch (e) { out.records = { error: /** @type {any} */ (e)?.code ?? 'error' }; }
    }
    out.lastSync = st.lastSync;
    if (account.content.store === false) out.content = 'off';
    else {
      try { out.content = await sizeOf(mp.contentDir); } catch { out.content = { files: 0, bytes: 0 }; }
    }
    out.index = head === null ? 'absent' : await indexState({ root: mp.root, trail: mp.trail, lockTimeoutMs: mp.lockTimeoutMs }, path.join(account.trailDir, trailIndexFile(account.trail))).catch(() => 'unknown');
    out.pendingStamps = account.otsBin && head !== null ? await countPendingStamps(mp.root, mp.trail) : null;
    out.lastBackup = st.lastBackup;
    out.watch = st.lastWatch && st.lastWatch.state === 'running' && pidAlive(st.lastWatch.pid) ? { running: true, pid: st.lastWatch.pid } : { running: false };
    return out;
  } finally { await mp.close(); }
}

/** @param {Record<string, any>} s @returns {string} */
function statusText(s) {
  const r = s.records;
  const rec = r === null ? 'no trail yet' : r.error ? `unavailable (${r.error})` : `${r.total} (${r.in} in, ${r.out} out), oldest ${r.oldest?.slice(0, 10) ?? '-'}, newest ${r.newest?.slice(0, 10) ?? '-'}`;
  const c = s.content === 'off' ? 'off' : `${s.content.files} files, ${(s.content.bytes / 1048576).toFixed(1)} MiB`;
  return [
    `  trail         ${s.trail}`,
    `  records       ${rec}`,
    `  last sync     ${s.lastSync ? `${s.lastSync.at}${s.lastSync.complete ? '' : ' (not complete)'}${s.lastSync.error ? ` error ${s.lastSync.error}` : ''}` : 'never'}`,
    `  content       ${c}`,
    `  index         ${s.index}`,
    `  ots pending   ${s.pendingStamps === null ? '-' : s.pendingStamps}`,
    `  last backup   ${s.lastBackup ? `${s.lastBackup.at}  ${s.lastBackup.path}` : 'never'}`,
    `  watch         ${s.watch.running ? `running (pid ${s.watch.pid})` : 'not running'}`,
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
  for (const n of names) print(ctx, `${n}\n${statusText(all[n])}`);
  return EX_OK;
}
