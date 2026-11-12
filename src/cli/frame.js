// The frame every menu screen shares (SPEC B11.4b), one definition for the menu and the browser:
//
//   (blank)
//   ── mailproof › 8 check ─────────────────      the crumb: where am I (crumb.js), printed the moment the item is chosen
//   Test one email against a trust profile.       the job line: one sentence from the menu table (menu-header.js: MENU_ITEMS, SCREEN_JOBS)
//   (blank)
//   <questions>
//   <result>
//   (blank)
//   ────────────────────────────────────────      a dim rule between the result and what you can do next
//   <options: the short line, the action line, the list footer>
//
// Pure rendering through the `out` the caller passes (the menu's output backstop), so nothing here writes to a stream itself.

import { crumbLine } from './crumb.js';

/**
 * @param {(s: string) => void} out  Text output, through the backstop.
 * @param {import('./style.js').Style} st
 */
export function makeFrame(out, st) {
  return {
    /**
     * The top of a screen: a blank line, the crumb, and (when given) the job line and a blank line after it. Print it BEFORE the screen's questions.
     * @param {string[]} segs  The path after `mailproof` (`8 check`, an address, `#3`).
     * @param {string} [job]  The one-sentence job line; leave it out for a second crumb that only refines the path (an answer such as an address).
     */
    open(segs, job) {
      out('');
      out(crumbLine(st, segs));
      if (job) { out(job); out(''); }
    },
    /**
     * The bottom of a screen: a blank line, the dim rule, then the options that follow the result.
     * @param {string} line
     */
    foot(line) {
      out('');
      out(st.rule());
      out(line);
    },
  };
}
