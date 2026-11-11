// The single overwriting progress line of `sync` (SPEC B11.7a): `INBOX 312 read · 31% · 14 s`, on stderr, only when stderr is a terminal.
// Fed by the library's `onProgress` hook (B4.1). It writes a carriage return and "erase line" itself, so it bypasses the text backstop;
// the only untrusted part (the folder name, which the server supplies) is escaped with printable() first. Nothing is written when stderr
// is not a terminal, and the line is cleared before the normal summary is printed.

import { printable as p } from './printable.js';
import { styleOf } from './style.js';

const MIN_GAP_MS = 150;

/**
 * @param {import('./session.js').Ctx} ctx
 * @returns {{ update: (e: import('../proof/sync.js').SyncProgress) => void, clear: () => void } | null}  null: no progress line (stderr is not a terminal, or TERM is dumb).
 */
export function progressLine(ctx) {
  if (ctx.stderr.isTTY !== true || ctx.env.TERM === 'dumb') return null;
  const now = ctx.deps.now ?? (() => new Date());
  const st = styleOf(ctx, 'stderr');
  const t0 = now().getTime();
  let last = 0;
  let shown = false;
  return {
    update(e) {
      const t = now().getTime();
      if (shown && t - last < MIN_GAP_MS) return;
      last = t;
      shown = true;
      const d = st.sym.dot;
      const pct = e.uidMax > 0 ? ` ${d} ${Math.min(100, Math.floor((e.uid / e.uidMax) * 100))}%` : '';
      ctx.stderr.write(`\r\x1b[K${st.dim(`${p(e.folder, { max: 40 })} ${e.done} read${pct} ${d} ${Math.round((t - t0) / 1000)} s`)}`);
    },
    clear() { if (shown) { shown = false; ctx.stderr.write('\r\x1b[K'); } },
  };
}
