// One sync of one account (SPEC B11.5 "Sync now"), used by `sync` and by every tick of `watch`: resolve the secret, read
// the mailbox, record, run the content sweep (the library does), then upgrade pending OpenTimestamps stamps.

import { resolveAuth } from './secrets.js';
import { exitFor } from './errors.js';
import { updateState } from './state.js';
import { stamp } from './session.js';
import { printable as p } from './printable.js';
import { makeStyle, rel } from './style.js';
import { clock } from './menu-header.js';
import { count } from './words.js';
import { sealStatus } from '../proof/stamp.js';
import { STAMP_EVERY_HOURS } from '../proof/limits.js';

/**
 * @typedef {Object} SyncOnce
 * @property {import('../proof/sync.js').SyncResult} result
 * @property {import('../proof/stamp.js').StampResult | null} ots  DEPRECATED ALIAS of `result.stamp` (the same object), kept because 3.3.0 documented `ots` in the CLI `--json` and MCP `sync` output; new consumers read `stamp`. The automatic stamp job's result (SPEC B13.1.12; a superset of the 3.3.0 `{ upgraded, pending, error? }`); null: OpenTimestamps is off for this account.
 * @property {{ folder: string, code: string, message: string } | null} folderError  The first folder that carries an error.
 * @property {number} exit  The exit code of the run (B4.1): 0 for a complete or capped run.
 */

/**
 * @param {import('./session.js').Session} s
 * @param {import('./session.js').Ctx} ctx
 * @param {{ folders?: string[], sent?: boolean | string, maxMessages?: number, onProgress?: (p: import('../proof/sync.js').SyncProgress) => void }} [over]  Flags that override the account for this run (`maxMessages`: the MCP server's per-call bound, B12.12; `onProgress`: the library's progress hook, used for the terminal progress line).
 * @returns {Promise<SyncOnce>}  Throws what `sync()` throws (`ERR_IMAP_AUTH`, `ERR_SYNC_LOCKED`, ...), after noting it in state.json.
 */
export async function syncOnce(s, ctx, over = {}) {
  const { account, mp } = s;
  const now = ctx.deps.now ?? (() => new Date());
  try {
    const auth = await resolveAuth(account.secret);   // re-resolved every run: a fresh token, the command re-run
    const opts = { host: account.host, port: account.port, user: account.user, auth, folders: over.folders ?? account.folders, sent: over.sent ?? account.sent, ...(over.maxMessages ? { maxMessages: over.maxMessages } : {}), ...(over.onProgress ? { onProgress: over.onProgress } : {}) };
    const result = await (ctx.deps.sync ? ctx.deps.sync(mp, opts) : mp.sync(opts));
    const ots = result.stamp ?? null;   // the library ran the job at the end of the run; the CLI no longer upgrades by itself
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
 * The per-folder lines of a sync result (what `sync` prints, and what every `watch` tick prints under its line).
 * @param {SyncOnce} r
 * @param {import('./style.js').Style} [st]
 * @returns {string[]}
 */
export function folderLines(r, st = makeStyle()) {
  const { sym } = st;
  return r.result.folders.map((f) => {
    const [ch, colour] = f.error ? [sym.bad, st.red] : !f.attempted || !f.complete ? [sym.warn, st.yellow] : [sym.ok, st.green];
    const tail = f.error ? `  ${st.red(`error ${p(f.error.code)}`)}` : !f.attempted ? '  not attempted' : f.complete ? '' : '  partial (run again)';
    return `${colour(ch)}${' '.repeat(Math.max(0, 2 - ch.length))} ${p(f.folder).padEnd(24)} ${f.direction === 'out' ? 'sent' : 'in  '}  seen ${f.seen}  recorded ${f.recorded}  duplicate ${f.duplicate}${f.over_limit ? `  over-limit ${f.over_limit}` : ''}${tail}`;
  });
}

/**
 * The seal line of a sync, in plain words (SPEC B11.5): what was sealed, when the next seal is due, and how many proofs still wait for their Bitcoin anchor.
 * @param {import('../proof/stamp.js').StampResult} z
 * @param {import('./style.js').Style} st
 * @param {{ nextDue?: string | null, now?: Date }} [o]  `nextDue`: the library's seal status (ISO time); left out when unknown.
 * @returns {string}
 */
export function sealLine(z, st, o = {}) {
  if (!z.enabled) return `seal: ${st.dim('off for this account')}`;
  const now = o.now ?? new Date();
  const records = z.manifests.reduce((n, m) => n + m.records, 0);
  /** @type {string[]} */
  const parts = [];
  if (z.error) parts.push(st.yellow(`problem: ${p(z.error)}`));
  else if (z.skipped === 'locked') parts.push('another seal run is in progress');
  else if (z.ran && z.manifests.length) parts.push(`sealed ${count(records, 'new record')}`);
  if (o.nextDue) parts.push(`next due ${clock(o.nextDue, now)} (${rel(o.nextDue, now)})`);
  if (z.upgraded) parts.push(`${count(z.upgraded, 'proof')} anchored in Bitcoin`);
  const waiting = z.pending + z.unstamped;
  if (waiting) parts.push(`${waiting} waiting for ${waiting === 1 ? 'its' : 'their'} Bitcoin anchor`);
  if (!parts.length) parts.push('nothing to seal');
  return `seal: ${parts.join('; ')}`;
}

/**
 * The text of a sync result.
 * @param {SyncOnce} r
 * @param {import('./style.js').Style} [st]
 * @param {{ nextDue?: string | null, now?: Date }} [o]  See `sealLine`.
 * @returns {string}
 */
export function syncText(r, st = makeStyle(), o = {}) {
  const lines = folderLines(r, st);
  lines.push(r.result.complete ? st.green('complete') : st.yellow('not complete: the next run continues from the saved cursor'));
  if (r.ots) lines.push(sealLine(r.ots, st, o));
  return lines.join('\n');
}

/**
 * When the next seal is due, from the library's seal status: cheap and offline (a read of the manifest chain), null when the seal is off or unreadable.
 * @param {import('./session.js').Session} s
 * @returns {Promise<string | null>}
 */
export async function nextSealDue(s) {
  if (s.account.otsBin === null) return null;
  const z = await sealStatus({ root: s.mp.root, trail: s.mp.trail, stamp: { mode: s.account.stamp.mode ?? 'batch', everyHours: s.account.stamp.everyHours ?? STAMP_EVERY_HOURS }, enabled: true }).catch(() => null);
  return z?.nextDue ?? null;
}

/**
 * The next seal time for a `show`, only when one of these records still waits for a seal (otherwise null, and no lookup).
 * @param {Array<{ seal: { state: string } | null }>} facts
 * @param {import('./session.js').Session} s
 * @returns {Promise<string | null>}
 */
export async function dueFor(facts, s) {
  return facts.some((f) => f.seal && (f.seal.state === 'unsealed' || f.seal.state === 'not-stamped')) ? nextSealDue(s) : null;
}

/**
 * The text of a stamp result, in plain words (SPEC B11.5).
 * @param {import('../proof/stamp.js').StampResult} r
 * @param {import('./style.js').Style} [st]
 * @returns {string}
 */
export function stampText(r, st = makeStyle()) {
  if (!r.enabled) return `${st.dim('ots is off for this account')}`;
  if (!r.manifests.length && r.stamped === null && !r.upgraded && !r.pending && !r.unstamped && !r.unsealed && !r.skipped && !r.error) return 'nothing new to seal';
  /** @type {string[]} */
  const lines = [];
  const records = r.manifests.reduce((n, m) => n + m.records, 0);
  const replies = r.manifests.reduce((n, m) => n + m.replies, 0);
  if (r.manifests.length) lines.push(`${st.green(st.sym.ok)} sealed ${count(records, 'new record')}${replies ? ` and ${count(replies, 'reply', 'replies')}` : ''}`);
  else lines.push('nothing new to seal');
  if (r.upgraded) lines.push(`${count(r.upgraded, 'proof')} anchored in Bitcoin`);
  if (r.pending + r.unstamped > 0) lines.push('the Bitcoin anchor is pending (usually a few hours); it completes on the next sync or seal');
  if (r.unsealed) lines.push(`${count(r.unsealed, 'file')} not sealed yet: run seal again`);
  if (r.skipped) lines.push(`${st.yellow(st.sym.warn)} skipped (${r.skipped})`);
  if (r.error) lines.push(`${st.red(st.sym.bad)} error: ${p(r.error)}`);
  return lines.join('\n');
}
