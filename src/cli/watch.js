// `watch` (SPEC B11.9): a foreground loop of `sync`. No daemon, no pid file of its own: the user's init system runs it.

import { EX_OK, EX_ERR, EX_NOPERM, exitFor, EX_TEMPFAIL } from './errors.js';
import { parseDuration, MIN_INTERVAL_MS } from './parse.js';
import { openAccount, print, warn, printJson, stamp } from './session.js';
import { syncOnce, folderLines, indexAfterSync } from './sync-op.js';
import { indexProgressLine } from './progress.js';
import { styleOf } from './style.js';
import { printable as p } from './printable.js';
import { updateState, appendWatchLog, truncateWatchLog } from './state.js';

const MAX_BACKOFF_MS = 3_600_000;

/**
 * Sleep that ends early on abort.
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export function sleepUntil(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The wait before the next tick: the interval, doubled for each consecutive failure, at most 1 h (never below the interval).
 * @param {number} intervalMs
 * @param {number} failures  Consecutive failures so far.
 * @returns {number}
 */
export function nextWait(intervalMs, failures) {
  return Math.max(intervalMs, Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS));
}

/** @param {import('./session.js').Args} a @param {import('./session.js').Ctx} ctx @returns {Promise<number>} */
export async function watchCmd(a, ctx) {
  const intervalMs = parseDuration(a.values.interval ?? '5m', '--interval', ctx.deps.minIntervalMs ?? MIN_INTERVAL_MS);
  const json = Boolean(a.values.json);
  const now = ctx.deps.now ?? (() => new Date());
  const sleep = ctx.deps.sleep ?? sleepUntil;
  const s = await openAccount(a, ctx);
  const name = s.account.name;
  try {
    await truncateWatchLog(s.state, name);
    await updateState(s.state, name, { lastWatch: { at: stamp(now()), pid: process.pid, state: 'running' } });
    let failures = 0;
    let code = EX_OK;
    let ticks = 0;
    while (!ctx.signal.aborted) {
      let wait = intervalMs;
      const at = stamp(now());
      /** @type {{ status: 'ok' | 'locked' | 'error', result?: unknown, ots?: unknown, error?: { code: string, message: string } }} */
      let tick;
      let line;
      /** @type {import('./sync-op.js').SyncOnce | null} */
      let synced = null;
      let stop = false;
      try {
        const r = await syncOnce(s, ctx);
        synced = r;
        if (r.folderError) {
          const c = exitFor(r.folderError.code);
          tick = { status: 'error', result: r.result, ots: r.ots, error: { code: r.folderError.code, message: r.folderError.message } };
          if (r.folderError.code === 'ERR_SYNC_LOCKED' || r.folderError.code === 'ERR_TRAIL_LOCKED') { tick.status = 'locked'; line = `${at} skipped (locked)`; }
          else if (c === EX_TEMPFAIL) { failures++; wait = nextWait(intervalMs, failures); line = `${at} error ${p(r.folderError.code)}: ${p(r.folderError.message)}; next in ${Math.round(wait / 1000)}s`; }
          else { stop = true; code = c; line = `${at} error ${p(r.folderError.code)}: ${p(r.folderError.message)}; stopping`; }
        } else {
          failures = 0;
          tick = { status: 'ok', result: r.result, ots: r.ots };
          line = `${at} ok recorded ${r.result.folders.reduce((n, f) => n + f.recorded, 0)}${r.result.complete ? '' : ' (not complete)'}`;
        }
      } catch (e) {
        const ec = /** @type {any} */ (e)?.code;
        const message = String(/** @type {any} */ (e)?.message ?? e);
        tick = { status: 'error', error: { code: ec ?? 'error', message } };
        if (ec === 'ERR_SYNC_LOCKED' || ec === 'ERR_TRAIL_LOCKED') { tick.status = 'locked'; line = `${at} skipped (locked)`; }
        else if (ec === 'ERR_IMAP_AUTH') { stop = true; code = EX_NOPERM; line = `${at} login refused (ERR_IMAP_AUTH); stopping: retrying a refused login can lock the account`; }
        else if (exitFor(ec) === EX_TEMPFAIL) { failures++; wait = nextWait(intervalMs, failures); line = `${at} error ${p(ec)}: ${p(message)}; next in ${Math.round(wait / 1000)}s`; }
        else { stop = true; code = EX_ERR; line = `${at} error ${p(ec ?? 'error')}: ${p(message)}; stopping`; }
      }
      await appendWatchLog(s.state, name, p(line, { keepBackslash: true }));   // the log is a file people `tail`: nothing raw in it either
      if (json) printJson(ctx, { at, ...tick, nextInMs: stop ? null : wait });
      else {
        if (ticks++ > 0) print(ctx, '');   // a blank line between ticks (C9)
        print(ctx, line);   // the log keeps this one line; the screen adds the per-folder counts, as `sync` prints them
        if (synced) for (const l of folderLines(synced, styleOf(ctx))) print(ctx, `  ${l}`);
      }
      if (synced) await indexAfterSync(s, ctx, json ? null : indexProgressLine(ctx));   // the cheap catch-up of this tick's records (a first build shows its progress)
      if (stop) { if (tick.status === 'error') warn(ctx, `mailproof: ${p(tick.error?.code)}: ${p(tick.error?.message)}`); break; }
      if (ctx.signal.aborted) break;   // a signal during the sync: it finished, now stop
      await sleep(wait, ctx.signal);
    }
    return code;
  } finally {
    await updateState(s.state, name, { lastWatch: { at: stamp(now()), pid: process.pid, state: 'stopped' } });
    await s.close();
  }
}
