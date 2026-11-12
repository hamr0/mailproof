// The single overwriting progress line of `sync` (SPEC B11.7a): `INBOX 312 read · 31% · 14 s`, and of the trail index work of `status` and
// `sync` (B11.5): `trail index 4,500 of 20,000 records · 22% · 3 s`, on stderr, only when stderr is a terminal.
// Fed by the library's `onProgress` hooks (B4.1 for sync, B5.4 for the index). It writes a carriage return and "erase line" itself, so it
// bypasses the text backstop; the only untrusted part (the folder name, which the server supplies) is escaped with printable() first.
// Nothing is written when stderr is not a terminal, and the line is cleared before the normal output is printed.

import { printable as p } from './printable.js';
import { styleOf } from './style.js';

const MIN_GAP_MS = 150;

/**
 * The one overwriting line both progress lines share: the terminal check, the throttle and the clear.
 * @param {import('./session.js').Ctx} ctx
 * @returns {{ put: (text: (secs: number) => string, force?: boolean) => void, clear: () => void } | null}  null: stderr is not a terminal, or TERM is dumb.
 */
function overwriting(ctx) {
  if (ctx.stderr.isTTY !== true || ctx.env.TERM === 'dumb') return null;
  const now = ctx.deps.now ?? (() => new Date());
  const st = styleOf(ctx, 'stderr');
  const t0 = now().getTime();
  let last = 0;
  let shown = false;
  return {
    put(text, force = false) {
      const t = now().getTime();
      if (shown && !force && t - last < MIN_GAP_MS) return;
      last = t;
      shown = true;
      ctx.stderr.write(`\r\x1b[K${st.dim(text(Math.round((t - t0) / 1000)))}`);
    },
    clear() { if (shown) { shown = false; ctx.stderr.write('\r\x1b[K'); } },
  };
}

/**
 * @param {import('./session.js').Ctx} ctx
 * @returns {{ update: (e: import('../proof/sync.js').SyncProgress) => void, clear: () => void } | null}  null: no progress line (stderr is not a terminal, or TERM is dumb).
 */
export function progressLine(ctx) {
  const line = overwriting(ctx);
  if (!line) return null;
  const d = styleOf(ctx, 'stderr').sym.dot;
  return {
    update(e) {
      const pct = e.uidMax > 0 ? ` ${d} ${Math.min(100, Math.floor((e.uid / e.uidMax) * 100))}%` : '';
      line.put((secs) => `${p(e.folder, { max: 40 })} ${e.done} read${pct} ${d} ${secs} s`);
    },
    clear: line.clear,
  };
}

/**
 * The progress of the trail index work (a rebuild, or a catch-up over many records): one start line saying what is going on, then the
 * overwriting count. Fed by the library's `IndexProgress` hook.
 * @param {import('./session.js').Ctx} ctx
 * @returns {{ update: (e: import('../proof/index-db.js').IndexProgress) => void, clear: () => void } | null}  null: nothing is shown (stderr is not a terminal, or TERM is dumb).
 */
export function indexProgressLine(ctx) {
  const line = overwriting(ctx);
  if (!line) return null;
  const st = styleOf(ctx, 'stderr');
  const num = (/** @type {number} */ n) => n.toLocaleString('en-US');
  let started = false;
  return {
    update(e) {
      if (!started) {
        started = true;
        ctx.stderr.write(`${e.phase === 'rebuild' ? 'updating the trail index (first time, or after an upgrade) …' : 'updating the trail index …'}\n`);
      }
      const pct = e.total > 0 ? ` ${st.sym.dot} ${Math.min(100, Math.floor((e.done / e.total) * 100))}%` : '';
      line.put((secs) => `trail index ${num(e.done)} of ${num(e.total)} records${pct} ${st.sym.dot} ${secs} s`, e.done >= e.total);   // the last count is never throttled away
    },
    clear: line.clear,
  };
}
