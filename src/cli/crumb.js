// The menu's where-am-I breadcrumb (SPEC B11.4a): one dim rule line naming the path to the output that follows, e.g.
// `── mailproof › 4 list › bob@beta.example › #3 › v verify ───`. One helper for the menu and the browser; the screen is never cleared, so
// the scrollback keeps every block under its own line. Width-fitted (never wraps): when the path is too long the middle goes first, then the
// last step is cut. ASCII (`-`, `>`, `...`) when the locale is not UTF-8. Every segment may come from an email: it is escaped first.

import { printable as p } from './printable.js';

/**
 * @param {import('./style.js').Style} st
 * @param {string[]} segs  The path after the `mailproof` root (`4 list`, an address, `#1`, `v verify`).
 * @returns {string}  The styled line, no newline.
 */
export function crumbLine(st, segs) {
  const bar = st.utf8 ? '─' : '-';
  const sep = ` ${st.utf8 ? '›' : '>'} `;
  const ell = st.utf8 ? '…' : '...';
  const head = `${bar}${bar} `;
  const parts = ['mailproof', ...segs.map((s) => p(s, { max: 80 }))];
  const room = st.width - head.length;
  const len = (/** @type {string[]} */ a) => [...a.join(sep)].length;
  /** @type {string[]} */
  let shown = parts;
  if (len(parts) > room) {
    shown = [];
    for (let j = parts.length - 2; j >= 1; j--) { const c = [parts[0], ell, ...parts.slice(-j)]; if (len(c) <= room) { shown = c; break; } }
    if (!shown.length) {
      const last = parts[parts.length - 1];
      const left = [parts[0], ell];
      shown = [...left, st.fit(last, Math.max(1, room - len(left) - sep.length))];
    }
  }
  const body = `${head}${shown.join(sep)}`;
  const fill = Math.min(st.width, 64) - [...body].length - 1;
  return st.dim(st.fit(fill >= 1 ? `${body} ${bar.repeat(fill)}` : body, st.width));
}
