// One sync of one account (SPEC B11.5 "Sync now"), used by `sync` and by every tick of `watch`: resolve the secret, read
// the mailbox, record, run the content sweep (the library does), then upgrade pending OpenTimestamps stamps.

import { resolveAuth } from './secrets.js';
import { exitFor } from './errors.js';
import { updateState } from './state.js';
import { stamp } from './session.js';
import { printable as p } from './printable.js';

/**
 * @typedef {Object} SyncOnce
 * @property {import('../proof/sync.js').SyncResult} result
 * @property {{ upgraded: number, pending: number, error?: string } | null} ots  null: OpenTimestamps is off for this account.
 * @property {{ folder: string, code: string, message: string } | null} folderError  The first folder that carries an error.
 * @property {number} exit  The exit code of the run (B4.1): 0 for a complete or capped run.
 */

/**
 * @param {import('./session.js').Session} s
 * @param {import('./session.js').Ctx} ctx
 * @param {{ folders?: string[], sent?: boolean | string, maxMessages?: number }} [over]  Flags that override the account for this run (`maxMessages`: the MCP server's per-call bound, B12.12).
 * @returns {Promise<SyncOnce>}  Throws what `sync()` throws (`ERR_IMAP_AUTH`, `ERR_SYNC_LOCKED`, ...), after noting it in state.json.
 */
export async function syncOnce(s, ctx, over = {}) {
  const { account, mp } = s;
  const now = ctx.deps.now ?? (() => new Date());
  try {
    const auth = await resolveAuth(account.secret);   // re-resolved every run: a fresh token, the command re-run
    const opts = { host: account.host, port: account.port, user: account.user, auth, folders: over.folders ?? account.folders, sent: over.sent ?? account.sent, ...(over.maxMessages ? { maxMessages: over.maxMessages } : {}) };
    const result = await (ctx.deps.sync ? ctx.deps.sync(mp, opts) : mp.sync(opts));
    /** @type {SyncOnce['ots']} */
    let ots = null;
    if (account.otsBin) {
      const u = await mp.upgradeStamps().catch((e) => ({ enabled: true, upgraded: 0, pending: 0, error: String(e?.message ?? e).slice(0, 200) }));
      ots = { upgraded: u.upgraded, pending: u.pending, ...(u.error ? { error: u.error } : {}) };
    }
    const bad = result.folders.find((f) => f.error);
    await updateState(s.state, account.name, {
      lastSync: { at: stamp(now()), complete: result.complete, recorded: result.folders.reduce((n, f) => n + f.recorded, 0), error: bad?.error?.code ?? null },
    });
    return {
      result, ots, folderError: bad?.error ? { folder: bad.folder, code: bad.error.code, message: bad.error.message } : null, exit: bad ? exitFor(bad.error?.code) : 0,
    };
  } catch (e) {
    await updateState(s.state, account.name, { lastSync: { at: stamp(now()), complete: false, recorded: 0, error: /** @type {any} */ (e)?.code ?? 'error' } });
    throw e;
  }
}

/**
 * The text of a sync result.
 * @param {SyncOnce} r
 * @returns {string}
 */
export function syncText(r) {
  const lines = r.result.folders.map((f) => {
    const tail = f.error ? `  error ${p(f.error.code)}` : !f.attempted ? '  not attempted' : f.complete ? '' : '  partial (run again)';
    return `${p(f.folder).padEnd(24)} ${f.direction === 'out' ? 'sent' : 'in  '}  seen ${f.seen}  recorded ${f.recorded}  duplicate ${f.duplicate}${f.over_limit ? `  over-limit ${f.over_limit}` : ''}${tail}`;
  });
  lines.push(r.result.complete ? 'complete' : 'not complete: the next run continues from the saved cursor');
  if (r.ots) lines.push(`ots: ${r.ots.upgraded} upgraded, ${r.ots.pending} pending${r.ots.error ? ` (${p(r.ots.error)})` : ''}`);
  return lines.join('\n');
}
