// The menu's where-am-I breadcrumb (SPEC B11.4a): one dim rule line naming the path to the output that follows, e.g.
// `── mailproof › 4 list › bob@beta.example › #3 › v verify ───`. One helper for the menu and the browser; the screen is never cleared, so
// the scrollback keeps every block under its own line. Width-fitted (never wraps) and the command name (`10 verify-bundle`, the first step) is never cut: a long
// value is shortened first (a path to its file name, anything long to a middle ellipsis), then middle steps go, then the `mailproof` root, and only
// at an absurd width is the line cut. ASCII (`-`, `>`, `...`) when the locale is not UTF-8. Every segment may come from an email: it is escaped first.

import { printable as p } from './printable.js';

/** A value that is a path (`/x/y`, `~/x`, `./x`): shown as its file name. @param {string} s */
const isPath = (s) => /^(~|\.{1,2})?\/./.test(s);

/** Cut to `n` code points with the ellipsis in the middle, the tail longer (an address keeps its domain). @param {string} s @param {number} n @param {string} ell @returns {string} */
function middle(s, n, ell) {
  const cps = [...s];
  if (cps.length <= n) return s;
  const h = Math.max(1, Math.floor((n - ell.length) / 3));
  const t = Math.max(1, n - ell.length - h);
  return cps.slice(0, h).join('') + ell + cps.slice(cps.length - t).join('');
}

/** How long a value may be once the line does not fit. */
const VALUE_MAX = 24;

/**
 * @param {import('./style.js').Style} st
 * @param {string[]} segs  The path after the `mailproof` root: the command first (`4 list`), then values and steps (an address, `#1`, `v verify`).
 * @returns {string}  The styled line, no newline.
 */
export function crumbLine(st, segs) {
  const bar = st.utf8 ? '─' : '-';
  const sep = ` ${st.utf8 ? '›' : '>'} `;
  const ell = st.utf8 ? '…' : '...';
  const head = `${bar}${bar} `;
  const room = st.width - head.length;
  const len = (/** @type {string[]} */ a) => [...a.join(sep)].length;
  const fits = (/** @type {string[]} */ a) => len(a) <= room;
  // the command is segs[0]; a value is anything after it. A path shows as its file name, always.
  const cmd = p(segs[0] ?? '', { max: 80 });
  let values = segs.slice(1).map((s) => { const t = p(s, { max: 80 }); return isPath(t) ? t.replace(/\/+$/, '').split('/').pop() || t : t; });
  /** @type {string[]} */
  let shown = [];
  const lead = segs.length ? [cmd] : [];
  const all = () => ['mailproof', ...lead, ...values];
  if (fits(all())) shown = all();
  else {
    values = values.map((v) => middle(v, VALUE_MAX, ell));
    if (fits(all())) shown = all();
    else {
      // middle values go, the root and the command stay; then the root goes; the command goes last
      for (let j = values.length - 1; j >= 1 && !shown.length; j--) { const c = ['mailproof', ...lead, ell, ...values.slice(-j)]; if (fits(c)) shown = c; }
      for (let j = values.length - 1; j >= 1 && !shown.length; j--) { const c = [...lead, ell, ...values.slice(-j)]; if (fits(c)) shown = c; }
      if (!shown.length && values.length && fits([...lead, ell])) shown = [...lead, ell];
      if (!shown.length && fits(lead)) shown = lead;
      if (!shown.length) shown = all();   // too narrow for the command itself: the final cut below
    }
  }
  const body = `${head}${shown.join(sep)}`;
  const fill = Math.min(st.width, 64) - [...body].length - 1;
  return st.dim(st.fit(fill >= 1 ? `${body} ${bar.repeat(fill)}` : body, st.width));
}
