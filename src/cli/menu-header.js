// The menu header and the first-run screen (SPEC B11.4): pure rendering of facts the caller already read (see `headerFacts` in status.js).
// No IO here. Everything that came from a file or a mail goes through printable() before it is styled.

import { printable as p } from './printable.js';
import { rel } from './style.js';

import { summaryOf } from './help.js';

/**
 * The menu table, the one place that names every menu item: key, the dispatch name (a handler in menu.js), the label
 * shown (and accepted as a name), and the help line. A help of `null` is the command's own summary from the command
 * table (commands.js); a text here is a menu-only wording. Groups are in screen order.
 * @type {ReadonlyArray<{ title: string, items: ReadonlyArray<{ key: string, cmd: string, label: string, help: string | null }> }>}
 */
export const MENU_GROUPS = [
  { title: 'Mail', items: [
    { key: '1', cmd: 'sync', label: 'sync', help: 'fetch new mail, record proofs' },
    { key: '2', cmd: 'watch', label: 'watch', help: null },
  ] },
  { title: 'Look', items: [
    { key: '3', cmd: 'people', label: 'people', help: 'who is in this trail' },
    { key: '4', cmd: 'list', label: 'list', help: 'newest first; filter by person/date' },
    { key: '5', cmd: 'show', label: 'show', help: 'an address\'s emails and their proof' },
    { key: '6', cmd: 'replies', label: 'replies', help: 'what people answered' },
  ] },
  { title: 'Check', items: [
    { key: '7', cmd: 'verify', label: 'verify', help: 're-check an address\'s emails offline' },
    { key: '8', cmd: 'check', label: 'check', help: null },
    { key: '9', cmd: 'check-file', label: 'check .eml', help: 'check a saved email file' },
    { key: '10', cmd: 'verify-bundle', label: 'verify-bundle', help: null },
  ] },
  { title: 'Share and keep', items: [
    { key: '11', cmd: 'export', label: 'export', help: null },
    { key: '12', cmd: 'stamp', label: 'seal', help: null },
    { key: '13', cmd: 'backup', label: 'backup', help: null },
  ] },
  { title: 'Clean up', items: [
    { key: '14', cmd: 'forget', label: 'forget', help: 'delete stored mail content' },
    { key: '15', cmd: 'prune', label: 'prune', help: 'drop old history from the trail' },
  ] },
  { title: 'Setup', items: [
    { key: '16', cmd: 'status', label: 'status', help: null },
    { key: '17', cmd: 'config', label: 'config', help: null },
    { key: '18', cmd: 'update', label: 'update', help: null },
    { key: '19', cmd: 'mcp', label: 'mcp', help: null },
  ] },
];

/** Every menu item, flat. */
export const MENU_ITEMS = MENU_GROUPS.flatMap((g) => g.items);

/** The keys of the short line shown after an action (every item is still accepted at the prompt). */
export const SHORT_KEYS = ['1', '3', '5', '7', '11', '16'];

/** Other names a menu item answers to, beside its label and command. */
export const MENU_ALIASES = /** @type {const} */ ([['eml', 'check-file'], ['check-eml', 'check-file'], ['checkfile', 'check-file']]);

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
 * The header of the main menu: a rule, the identity line, the counts line, a rule.
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

  return [st.rule(), id, parts.join(sep), st.rule()];
}

/**
 * The full menu: every command on its own line with its help, in groups; shown at the start and on `?`.
 * @param {import('./style.js').Style} st
 * @param {boolean} manyAccounts
 * @returns {string[]}
 */
export function fullMenu(st, manyAccounts) {
  const w = Math.max(...MENU_ITEMS.map((i) => i.label.length));
  /** @type {string[]} */
  const lines = [];
  for (const g of MENU_GROUPS) {
    lines.push(` ${st.bold(g.title)}`);
    if (g.title === 'Setup') {
      const cells = g.items.map((i) => `${st.key(i.key)} ${i.label}`);
      if (manyAccounts) cells.push(`${st.key('a')} account`);
      lines.push(`  ${cells.join('   ')}`);
    } else for (const i of g.items) lines.push(`${' '.repeat(Math.max(0, 4 - i.key.length))}${st.key(i.key)} ${i.label.padEnd(w)}  ${st.dim(p(i.help ?? summaryOf(i.cmd)))}`);
  }
  lines.push('', `  ${st.key('q')} quit`);
  return lines;
}

/**
 * The short line printed after an action: a few numbers, then `? all` and `q quit`.
 * @param {import('./style.js').Style} st
 * @param {boolean} manyAccounts
 * @returns {string}
 */
export function shortLine(st, manyAccounts) {
  const items = SHORT_KEYS.map((k) => MENU_ITEMS.find((i) => i.key === k)).filter((i) => i !== undefined).map((i) => `${st.key(i.key)} ${i.label}`);
  const tail = [...(manyAccounts ? [`${st.key('a')} account`] : []), `${st.key('?')} all`, `${st.key('q')} quit`];
  return `  ${items.join('  ')}  ${st.sym.dot} ${tail.join(` ${st.sym.dot} `)}`;
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
