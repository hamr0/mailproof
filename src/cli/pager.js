// The menu's output pager (SPEC B11.4): on a terminal, what an action writes is held back until the action ends (or until the next prompt, which
// flushes it), then shown at once when it fits the screen, else one screen at a time with `Enter more · q menu`. No screen clear, no "Press Enter":
// the compact action line follows the output. On a pipe there is no pager (the menu keeps its "Press Enter" step).

import { stripStyle } from './style.js';
import { SECTIONS } from './detail.js';

/** A block header of `show <address>`. */
const BLOCK = /^#\d+ of \d+$/;

/** @typedef {{ write: (s: string | Uint8Array) => unknown, isTTY?: boolean, columns?: number, rows?: number }} Out */

/**
 * @param {Out} real  The real stdout.
 * @param {import('./prompt.js').Prompter} p
 * @param {import('./style.js').Style} st
 */
export function makePager(real, p, st) {
  let buf = '';
  let live = false;
  /** Write what is held back, unpaged (before a prompt, which must come after the text that explains it). */
  const flush = () => { if (buf) { const t = buf; buf = ''; real.write(t); } };
  /** @type {Out} */
  const stream = { write: (s) => { if (live) return real.write(s); buf += typeof s === 'string' ? s : Buffer.from(s).toString(); return true; }, ...(real.isTTY !== undefined ? { isTTY: real.isTTY } : {}), ...(real.columns ? { columns: real.columns } : {}), ...(real.rows ? { rows: real.rows } : {}) };
  /** @type {import('./prompt.js').Prompter} */
  const prompter = { ...p, ask: (l) => { flush(); return p.ask(l); }, askSecret: (l) => { flush(); return p.askSecret(l); }, suspend: (fn) => { flush(); return p.suspend(fn); } };
  const footer = `${st.key('Enter')} ${st.dim('more')} ${st.dim(st.sym.dot)} ${st.key('q')} ${st.dim('menu')}`;

  /** Screen lines of a text line: a long one wraps. @param {string} l */
  const height = (l) => Math.max(1, Math.ceil([...stripStyle(l)].length / (real.columns || 80)));

  /**
   * Where a page that would end at `end` (exclusive) should end instead (SPEC B11.4): before the last `#N of M` block that starts on this page,
   * else before the last section heading, so a block is not cut right after its header; the blank line that separates them goes with the cut
   * (the next page starts at the header). Unchanged when the text ends here, when nothing on the page is such a start, or at the page's own first line.
   * @param {string[]} lines @param {number} start @param {number} end @returns {number}
   */
  function cut(lines, start, end) {
    if (end >= lines.length) return end;
    /** @param {(t: string) => boolean} is */
    const last = (is) => {
      for (let j = end; j > start; j--) {
        const at = lines[j] === undefined ? '' : stripStyle(lines[j]);
        const b = at === '' && j + 1 < lines.length && is(stripStyle(lines[j + 1])) ? j : is(at) && lines[j - 1] !== '' ? j : -1;   // the boundary: the blank before a start, else the start itself
        if (b > start) return b;
      }
      return -1;
    };
    const b = last((t) => BLOCK.test(t));
    if (b > start) return b;
    const c = last((t) => SECTIONS.includes(t));
    return c > start ? c : end;
  }

  /**
   * Show the held-back output: all of it when it fits (rows, default 24, minus the action line and the prompt), else page by page.
   * @returns {Promise<boolean>}  False when the input ended.
   */
  async function show() {
    if (!buf) return true;
    const lines = buf.replace(/\n$/, '').split('\n');
    buf = '';
    const avail = Math.max(3, (real.rows || 24) - 2);
    let i = 0;
    while (i < lines.length) {
      let used = 0;
      const start = i;
      while (i < lines.length && (used + height(lines[i]) <= avail || i === start)) used += height(lines[i++]);
      i = cut(lines, start, i);
      real.write(`${lines.slice(start, i).join('\n')}\n`);
      while (i < lines.length && lines[i] === '' && i > start) i++;   // a blank line never leads a page
      if (i >= lines.length) break;
      real.write(`${footer}\n`);
      /** @type {string | null} */
      let a;
      try { a = await p.ask(''); } catch { a = 'q'; }   // Ctrl-C at `Enter more` is q
      if (a === null) return false;
      if (a.trim().toLowerCase() === 'q' || a.includes('\x1b')) break;
    }
    return true;
  }
  /** Pass output straight through (a long-running action such as `watch` must show its lines as they come). @param {boolean} on */
  const setLive = (on) => { if (on) flush(); live = on; };
  return { stream, prompter, flush, show, setLive };
}
