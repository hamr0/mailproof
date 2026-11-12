// The menu header and the first-run screen (SPEC B11.4): pure rendering of facts the caller already read (see `headerFacts` in status.js).
// No IO here. Everything that came from a file or a mail goes through printable() before it is styled.

import { printable as p } from './printable.js';
import { rel } from './style.js';

import { summaryOf } from './help.js';

/**
 * The menu table, the one place that names every menu item: key, the dispatch name (a handler in menu.js), the label
 * shown (and accepted as a name), the help line and the job line. A help of `null` is the command's own summary from the command
 * table (commands.js); a text here is a menu-only wording. The `job` is the one sentence under the breadcrumb of the item's screen (SPEC B11.4b):
 * what the screen is for, in plain words. Groups are in screen order.
 * @type {ReadonlyArray<{ title: string, items: ReadonlyArray<{ key: string, cmd: string, label: string, help: string | null, job: string }> }>}
 */
export const MENU_GROUPS = [
  { title: 'Mail', items: [
    { key: '1', cmd: 'sync', label: 'sync', help: 'fetch new mail, record proofs', job: 'Fetch new mail from your mailbox and record a proof of each email.' },
    { key: '2', cmd: 'watch', label: 'watch', help: null, job: 'Keep syncing on a timer until you stop it with Ctrl-C.' },
  ] },
  { title: 'Look', items: [
    { key: '3', cmd: 'people', label: 'people', help: 'who is in this trail', job: 'Everyone in this trail: how many emails, how many verified.' },
    { key: '4', cmd: 'list', label: 'list', help: 'newest first; filter by person/date', job: 'Browse emails newest first; open one to see its proof.' },
    { key: '5', cmd: 'show', label: 'show', help: 'an address\'s emails and their proof', job: 'Every email with one address, and what its signature proves.' },
    { key: '6', cmd: 'replies', label: 'replies', help: 'what people answered', job: 'What people answered: the new text of each signed reply.' },
  ] },
  { title: 'Check', items: [
    { key: '7', cmd: 'verify', label: 'verify', help: 're-check an address\'s emails offline', job: 'Re-check an address\'s emails offline, from the saved records alone.' },
    { key: '8', cmd: 'check', label: 'check', help: null, job: 'Test one email against a trust profile: each rule passes or fails.' },
    { key: '9', cmd: 'check-file', label: 'check .eml', help: 'check a saved email file', job: 'Check a saved .eml file for a DKIM signature; nothing is recorded.' },
    { key: '10', cmd: 'verify-bundle', label: 'verify-bundle', help: null, job: 'Check a proof bundle someone sent you; no account needed.' },
  ] },
  { title: 'Share and keep', items: [
    { key: '11', cmd: 'export', label: 'export', help: null, job: 'Write a proof bundle of your emails with one person, to send them.' },
    { key: '12', cmd: 'stamp', label: 'seal', help: null, job: 'Seal new records now with OpenTimestamps (a Bitcoin time anchor).' },
    { key: '13', cmd: 'backup', label: 'backup', help: null, job: 'Save a copy of the trail as one file you can keep or restore.' },
  ] },
  { title: 'Clean up', items: [
    { key: '14', cmd: 'forget', label: 'forget', help: 'delete stored mail content', job: 'Delete stored mail content for a person or dates; the proofs stay.' },
    { key: '15', cmd: 'prune', label: 'prune', help: 'drop old history from the trail', job: 'Permanently remove proofs captured before a date (forget only removes content).' },
  ] },
  { title: 'Setup', items: [
    { key: '16', cmd: 'status', label: 'status', help: null, job: 'What this trail holds and how it is kept.' },
    { key: '17', cmd: 'config', label: 'config', help: null, job: 'Your settings: where they live, whether they\'re valid, and how to change them.' },
    { key: '18', cmd: 'update', label: 'update', help: null, job: 'Check for a newer mailproof and upgrade it.' },
    { key: '19', cmd: 'mcp', label: 'mcp', help: null, job: 'Let an AI assistant read and prove your mail through mailproof.' },
  ] },
];

/**
 * The job line of the screens inside a command (SPEC B11.4b): an opened email and what its actions open, and the list's own steps.
 * @type {Readonly<Record<'open' | 'raw' | 'attachment' | 'verify' | 'thread' | 'person' | 'more' | 'filter' | 'subject' | 'setup' | 'help', string>>}
 */
export const SCREEN_JOBS = {
  open: 'One email: what was signed and what that proves.',
  raw: 'The raw email exactly as it was stored.',
  attachment: 'Save an attachment of this email to a file.',
  verify: "Re-check this email's signature again, offline.",
  thread: 'The email this one answers and the replies to it.',
  person: 'Everything with the other party of this email.',
  more: 'The next five emails.',
  filter: 'Narrow the list by role, direction or date.',
  subject: 'Narrow the list to subjects containing some text.',
  setup: 'Add your mailbox: where it lives, how to log in, which folders.',
  help: 'Every command, and what it does.',
};

/** The job line of a menu command. @param {string} cmd @returns {string} */
export const jobOf = (cmd) => MENU_GROUPS.flatMap((g) => g.items).find((i) => i.cmd === cmd)?.job ?? '';

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
  // the first line is the status bar: bold (each plain stretch; the coloured parts keep their own colour)
  const b = st.bold;
  const id = `${b('mailproof')} ${b(p(h.version))}${b(sep)}${b(p(h.user))} ${st.dim(`(${p(h.account)})`)}${b(sep)}${b('trail')} ${trail}${b(sep)}${b('last sync')} ${sync}`;

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
