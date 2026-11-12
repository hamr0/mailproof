// The menu header and the first-run screen (SPEC B11.4): pure rendering of facts the caller already read (see `headerFacts` in status.js).
// No IO here. Everything that came from a file or a mail goes through printable() before it is styled.

import { printable as p } from './printable.js';
import { rel } from './style.js';

/** The menu's numbered action line: key, command, label. */
export const MAIN_ITEMS = /** @type {const} */ ([['1', 'sync', 'sync'], ['2', 'people', 'people'], ['3', 'show', 'show'], ['4', 'verify', 'verify'], ['5', 'export', 'export'], ['6', 'stamp', 'seal'], ['7', 'status', 'status']]);

/** `?` lists these; they are chosen by number or by name. */
export const MORE_ITEMS = /** @type {const} */ ([['8', 'watch'], ['9', 'list'], ['10', 'replies'], ['11', 'check'], ['12', 'backup'], ['13', 'forget'], ['14', 'prune'], ['15', 'config'], ['16', 'update'], ['17', 'mcp']]);

/**
 * A time for a header: `19:21Z` within a day of now, `11-09 19:21Z` otherwise.
 * @param {string} iso @param {Date} now @returns {string}
 */
export function clock(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return p(iso);
  return Math.abs(t - now.getTime()) < 86_400_000 ? `${iso.slice(11, 16)}Z` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * An action line: each key in bold green (st.key), then its label, two spaces apart.
 * @param {import('./style.js').Style} st
 * @param {Array<readonly [string, string]>} items  key, label
 * @returns {string}
 */
export function actionLine(st, items) {
  return items.map(([k, label]) => `${st.key(k)} ${label}`).join('  ');
}

/**
 * @typedef {Object} HeaderFacts
 * @property {string} version
 * @property {string} user
 * @property {string} account
 * @property {boolean} trailOk
 * @property {{ at: string, complete: boolean, error: string | null } | null} lastSync
 * @property {{ total: number, verified: number | null, unverified: number | null, out: number | null } | null} records
 * @property {{ state: 'off' | 'never' | 'pending' | 'sealed' | 'broken', nextDue: string | null }} seal
 * @property {boolean} watch
 * @property {boolean} manyAccounts
 */

/**
 * The header of the main menu: a rule, the identity line, the counts line, a rule, the action line.
 * @param {import('./style.js').Style} st
 * @param {HeaderFacts} h
 * @param {Date} now
 * @returns {string[]}
 */
export function mainHeader(st, h, now) {
  const { sym } = st;
  const sep = ` ${sym.dot} `;
  const ls = h.lastSync;
  const sync = !ls ? st.dim('never')
    : `${ls.error ? st.red(`${sym.bad} failed (${p(ls.error)}), last try `) : ls.complete ? '' : st.yellow(`${sym.warn} not complete, `)}${clock(ls.at, now)} ${st.dim(`(${rel(ls.at, now)})`)}`;
  const trail = h.trailOk ? st.green(sym.ok) : st.yellow(`${sym.warn} none yet`);
  const id = `${st.bold('mailproof')} ${p(h.version)}${sep}${p(h.user)} ${st.dim(`(${p(h.account)})`)}${sep}trail ${trail}${sep}last sync ${sync}`;

  /** @type {string[]} */
  const parts = [];
  const r = h.records;
  if (!r) parts.push('records: none yet');
  else {
    parts.push(`records: ${r.total}`);
    if (r.verified === null || r.unverified === null) parts.push(st.dim('(verified count after the next list)'));
    else {
      parts.push(st.green(`${r.verified} verified`), r.unverified ? st.yellow(`${r.unverified} unverified`) : `${r.unverified} unverified`);
      if (r.out !== null) parts.push(`${r.out} sent cop${r.out === 1 ? 'y' : 'ies'}`);
    }
  }
  const z = h.seal;
  const next = z.nextDue ? ` ${st.dim(`(next ${clock(z.nextDue, now)}, ${rel(z.nextDue, now)})`)}` : '';
  const sealWord = z.state === 'off' ? st.dim('off') : z.state === 'never' ? st.yellow('never run') : z.state === 'pending' ? st.yellow('pending') : z.state === 'broken' ? st.red(`${sym.bad} chain broken`) : st.green(`${sym.ok} sealed`);
  parts.push(`seal ${sealWord}${z.state === 'off' ? '' : next}`);
  parts.push(`watch ${h.watch ? st.green('on') : st.dim('off')}`);

  return [st.rule(), id, parts.join(sep), st.rule(), mainActionLine(st, h.manyAccounts)];
}

/**
 * The compact action line of the main menu (`1 sync  2 people ... q quit`), keys green.
 * @param {import('./style.js').Style} st
 * @param {boolean} manyAccounts
 * @returns {string}
 */
export function mainActionLine(st, manyAccounts) {
  /** @type {Array<readonly [string, string]>} */
  const keys = MAIN_ITEMS.map(([k, , label]) => /** @type {const} */ ([k, label]));
  if (manyAccounts) keys.push(['a', 'account']);
  keys.push(['?', 'more'], ['q', 'quit']);
  return actionLine(st, keys);
}

/**
 * The first-run screen: no config yet.
 * @param {import('./style.js').Style} st
 * @param {{ version: string, configFile: string }} f
 * @returns {string[]}
 */
export function firstRun(st, f) {
  return [
    st.rule(),
    `${st.bold('mailproof')} ${p(f.version)} ${st.sym.dot} ${st.yellow('no account yet')} ${st.sym.dot} config ${p(f.configFile)} ${st.dim('(not found)')}`,
    st.dim('mailproof records a re-checkable proof of every email you send and receive.'),
    st.rule(),
    actionLine(st, [['1', 'set up an account'], ['2', 'check a .eml file'], ['3', 'verify a bundle'], ['?', 'help'], ['q', 'quit']]),
  ];
}
