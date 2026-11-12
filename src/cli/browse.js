// The menu's list and its "dig deeper" view (SPEC B11.4a). Menu item 4 asks for a person (or everyone) and shows the latest five emails
// as numbered rows (a row line, the full subject, the why line); a number opens one email: exactly the text `mailproof show <id>` prints,
// then the actions raw, attachment, verify, thread and person. Presentation only: the rows are the library's `list` (ids, the filters) and
// `describe` (the facts, the `why` sentence), the thread is `linked`, the person row is `counterparties`, the open and verify views are the
// `show` and `verify` subcommands run through the same dispatcher. Nothing is re-derived here, no DNS and no network.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Cancel } from './prompt.js';
import { UsageError } from './errors.js';
import { parseChoice, parseDate } from './parse.js';
import { printable as p } from './printable.js';
import { SCREEN_JOBS } from './menu-header.js';
import { expandHome, ensureDefaultDir } from './paths.js';
import { pageLines, partyOf } from './rows.js';

export { pageLines };

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('../proof/describe.js').Facts} Facts */
/** @typedef {{ id: string, tag?: string }} Entry  One email of a screen; `tag` is the thread relation (`parent, link signed`). */
/** @typedef {{ who: string, role: string, direction: string, after: string, before: string, subject: string }} Filters */

/**
 * What the view needs from the menu. Everything is injected, so the view runs the same from a test.
 * @typedef {Object} BrowseEnv
 * @property {import('./style.js').Style} st
 * @property {import('./prompt.js').Prompter} p
 * @property {(spec: import('./prompt.js').ValueSpec) => Promise<string>} ask
 * @property {(label: string, flag: string, example?: string) => Promise<string>} askDate
 * @property {(s: string) => void} out  Text output, through the backstop.
 * @property {(path: string[], job?: string) => void} crumb  Print the top of a screen: a blank line, the where-am-I breadcrumb for this path (after `mailproof`) and, when given, the job line (frame.js).
 * @property {(line: string) => void} foot  Print the bottom of a screen: a blank line, the dim rule, then the options line (frame.js).
 * @property {(argv: string[]) => Promise<number>} go  Run a subcommand on the account (the menu's own path).
 * @property {() => Promise<boolean>} showHeld  Show what a terminal pager holds back; false when the input ended.
 * @property {import('../index.js').Mailproof} mp
 * @property {(f: string) => string} tilde
 * @property {() => Date} now
 * @property {Record<string, string | undefined>} env  The environment (HOME): `~` in a path the person types, the default folder for a saved attachment.
 */

export const PAGE = 5;
const RAW_MAX = 1 << 20;
const DASH = (/** @type {BrowseEnv} */ e) => ` ${e.st.sym.dot} `;

/**
 * The facts of the emails with these ids, in order; an id with no record is left out.
 * @param {BrowseEnv} e @param {string[]} ids @param {Map<string, Facts>} cache
 * @returns {Promise<void>}
 */
async function load(e, ids, cache) {
  const need = ids.filter((i) => !cache.has(i));
  const got = await Promise.all(need.map((i) => e.mp.describe(i)));
  need.forEach((i, k) => { const f = got[k].records[0]; if (f) cache.set(i, f); });
}

/** @param {Filters} f */
const listArgs = (f) => ({
  ...(f.who ? { with: f.who } : {}), ...(f.role ? { role: /** @type {'from' | 'to' | 'cc' | 'reply-to'} */ (f.role) } : {}),
  ...(f.direction ? { direction: /** @type {'in' | 'out'} */ (f.direction) } : {}), ...(f.subject ? { subject: f.subject } : {}),
  ...(f.after ? { after: parseDate(f.after, '--after') } : {}), ...(f.before ? { before: parseDate(f.before, '--before') } : {}),
});

/**
 * One numbered screen: the latest five of `entries`, `m` for the next five, a number to open one email. With `filters` it also takes `f`
 * (role, direction, after, before) and `s` (subject text) and reloads the entries through `reload`.
 * @param {BrowseEnv} e
 * @param {{ path: string[], entries: Entry[], filters?: Filters, reload?: (f: Filters) => Promise<Entry[]>, crumbed?: boolean }} o  `path`: the breadcrumb of this screen (after `mailproof`); `crumbed`: the caller already printed it for the first page.
 * @returns {Promise<void>}
 */
async function screen(e, o) {
  const { st } = e;
  let { entries } = o;
  /** @type {Map<string, Facts>} */
  const cache = new Map();
  let shown = 0;
  let from = 0;
  let crumbed = Boolean(o.crumbed);
  /** @param {number} at @param {string} [step] @param {string} [job] */
  const page = async (at, step, job) => {
    const slice = entries.slice(at, at + PAGE);
    await load(e, slice.map((x) => x.id), cache);
    const items = slice.flatMap((x) => { const facts = cache.get(x.id); return facts ? [{ facts, ...(x.tag ? { tag: x.tag } : {}) }] : []; });
    from = at;
    shown = at + slice.length;
    if (!crumbed) e.crumb(step ? [...o.path, step] : o.path, job);
    crumbed = false;
    if (!slice.length) e.out(entries.length ? 'that is all' : 'no emails match');
    else for (const l of pageLines(e, items, at + 1)) e.out(l);
    footer();
  };
  const footer = () => {
    const k = (/** @type {string} */ s) => st.key(s);
    const parts = [...(shown > 0 ? [`${shown} of ${entries.length}`, `open: ${k('a number')}`] : []), ...(shown < entries.length ? [`${k('m')} more`] : []), ...(o.filters ? [`${k('f')} filter`, `${k('s')} subject search`] : []), `${k('Enter')} back`];
    e.foot(parts.join(DASH(e)));
  };
  await page(0);
  for (;;) {
    const a = await line(e.p);
    if (a === null) throw new Cancel('eof');
    const c = a.trim().toLowerCase();
    if (c === '') return;
    if (/^\d+$/.test(c)) {
      const n = Number(c);
      if (n < 1 || n > shown) { e.out(`choose 1 to ${shown}`); continue; }
      await openEmail(e, entries[n - 1].id, [...o.path, `#${n}`]);
      await page(from);
    } else if (c === 'm') {
      if (shown >= entries.length) { e.out('that is all'); continue; }
      await page(shown, 'm more', SCREEN_JOBS.more);
    } else if ((c === 'f' || c === 's') && o.filters && o.reload) {
      const f = o.filters;
      e.crumb([...o.path, c === 'f' ? 'f filter' : 's subject'], c === 'f' ? SCREEN_JOBS.filter : SCREEN_JOBS.subject);   // before its questions
      const next = { ...f };
      try {
        if (c === 'f') {
          next.role = f.who ? await e.ask({ label: 'Role', example: 'from, to, cc, reply-to, empty = any', optional: true, validate: (s) => parseChoice(s, 'Role', 'from', 'to', 'cc', 'reply-to') }) : '';
          next.direction = await e.ask({ label: 'Direction', example: 'in, out, empty = both', optional: true, validate: (s) => parseChoice(s, 'Direction', 'in', 'out') });
          next.after = await e.askDate('After', '--after', 'date, e.g. {2026-01-01}, empty = no limit');
          next.before = await e.askDate('Before', '--before', 'date, e.g. {2026-08-19}, empty = no limit');
        } else next.subject = await e.ask({ label: 'Subject contains', example: 'text, empty = any', optional: true });
      } catch (x) {
        if (x instanceof Cancel && x.reason === 'back') { footer(); continue; }   // back to this screen, the filters as they were
        throw x;
      }
      Object.assign(f, next);
      entries = await o.reload(f);
      crumbed = c === 'f';   // the filter's crumb is already on screen; a subject search adds its answer to the path
      await page(0, c === 'f' ? undefined : f.subject ? `s "${f.subject}"` : 's clear');
    } else e.out(`not a choice: ${p(c, { max: 40 })}`);
  }
}

/** One `> ` line of a browse level: Ctrl-C reads as an empty answer, one level back. @param {import('./prompt.js').Prompter} p @returns {Promise<string | null>} */
async function line(p) {
  try { return await p.ask('> '); } catch (x) { if (x instanceof Cancel && x.reason === 'back') return ''; throw x; }
}

/**
 * The menu's list: ask nothing here (the caller asked Who), show the latest five for that person, or for everyone.
 * @param {BrowseEnv} e
 * @param {string} who  An exact address, or '' for everyone.
 * @param {string[]} [path]  The breadcrumb to start from (after `mailproof`); the person view of an opened email continues its path.
 * @param {boolean} [crumbed]  The caller already printed `path`.
 * @returns {Promise<void>}
 */
export async function browseList(e, who, path = ['4 list', who || 'everyone'], crumbed = false) {
  /** @type {Filters} */
  const filters = { who, role: '', direction: '', after: '', before: '', subject: '' };
  /** @param {Filters} f @returns {Promise<Entry[]>} */
  const reload = async (f) => (await e.mp.list(listArgs(f))).map((r) => ({ id: r.id }));
  await screen(e, { path, entries: await reload(filters), filters, reload, crumbed });
}

/**
 * One email, opened: the `show` text, then the actions. Enter goes back to where it was opened from.
 * @param {BrowseEnv} e @param {string} id @param {string[]} path  The breadcrumb of the open email (after `mailproof`).
 * @returns {Promise<void>}
 */
async function openEmail(e, id, path) {
  const { st } = e;
  const k = (/** @type {string} */ s) => st.key(s);
  const action = `  ${k('r')} raw email${DASH(e)}${k('a')} save attachment${DASH(e)}${k('v')} verify again${DASH(e)}${k('t')} thread${DASH(e)}${k('p')} this person${DASH(e)}${k('Enter')} back to list`;
  e.crumb(path, SCREEN_JOBS.open);
  await e.go(['show', id]);
  if (!(await e.showHeld())) throw new Cancel('eof');
  const facts = (await e.mp.describe(id)).records[0];
  if (!facts) return;
  for (;;) {
    e.foot(action);
    const a = await line(e.p);
    if (a === null) throw new Cancel('eof');
    const c = a.trim().toLowerCase();
    if (c === '') return;
    try {
      if (c === 'r') { e.crumb([...path, 'r raw'], SCREEN_JOBS.raw); await rawEmail(e, id); }
      else if (c === 'a') { e.crumb([...path, 'a attachment'], SCREEN_JOBS.attachment); await saveAttachment(e, facts); }
      else if (c === 'v') { e.crumb([...path, 'v verify'], SCREEN_JOBS.verify); await e.go(['verify', id]); }
      else if (c === 't') await thread(e, id, [...path, 't thread']);
      else if (c === 'p') await person(e, facts, [...path, 'p this person']);
      else { e.out(`not a choice: ${p(c, { max: 40 })}`); continue; }
    } catch (x) {
      if (x instanceof Cancel && x.reason === 'back') continue;   // back out of a question: this email's actions again
      throw x;
    }
    if (!(await e.showHeld())) throw new Cancel('eof');
  }
}

/** The stored raw email, as text, through the pager (the library's `rawEmail`: re-hashed on read). @param {BrowseEnv} e @param {string} id */
async function rawEmail(e, id) {
  const raw = await e.mp.rawEmail(id);
  if (!raw) { e.out('the raw email is no longer stored (expired, forgotten or never stored)'); return; }
  const cut = raw.length > RAW_MAX;
  e.out(raw.subarray(0, RAW_MAX).toString('utf8').replace(/\r\n/g, '\n').replace(/\t/g, '    ').replace(/\n$/, ''));
  if (cut) e.out(e.st.dim(`... cut at 1 MiB; the whole email is in the content store (${raw.length} bytes)`));
}

/** A file name from an email, reduced to one safe path segment. @param {string | null} name @param {string} sha @returns {string} */
function safeName(name, sha) {
  const base = path.basename((name ?? '').replace(/[\\/\0-\x1f\x7f]/g, '_')).slice(0, 100).trim();
  return base === '' || base === '.' || base === '..' ? `attachment-${sha.replace(/^sha256:/, '').slice(0, 12)}` : base;
}

/** List the attachments, ask which and where, write it 0600 and never over a file that exists. @param {BrowseEnv} e @param {Facts} facts */
async function saveAttachment(e, facts) {
  const atts = facts.attachments;
  if (!atts.length) { e.out('this email has no attachments'); return; }
  atts.forEach((a, i) => e.out(`  ${e.st.key(String(i + 1))}  ${p(a.filename ?? '(no name)', { max: 100 })}  ${a.size === null ? 'N/A' : `${a.size} bytes`}  stored ${a.stored ? 'yes' : 'no'}`));
  const which = await e.ask({ label: 'Save which', example: `a number, 1 to ${atts.length}, empty = none`, optional: true, validate: (s) => { if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > atts.length) throw new UsageError(`choose 1 to ${atts.length}`); return s; } });
  if (!which) return;
  const att = atts[Number(which) - 1];
  const bytes = att.sha256 ? await e.mp.attachment(att.sha256) : null;
  if (!bytes) { e.out('the attachment is no longer stored (expired, forgotten or never stored)'); return; }
  const dflt = `~/mailproof/saved/${safeName(att.filename, att.sha256 ?? '')}`;
  for (let tries = 0; tries < 3; tries++) {
    const want = await e.ask({ label: 'Save to', example: 'path', def: dflt });
    const dest = path.resolve(expandHome(want, e.env));
    try {
      await ensureDefaultDir(dest, e.env, 'saved');   // the default folder is made on first use (0700); a folder the person chose must exist
      await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
      e.out(`saved ${bytes.length} bytes to ${p(e.tilde(dest))}`);
      return;
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
      e.out(code === 'EEXIST' ? `${p(e.tilde(dest))} already exists: nothing is overwritten; choose another path` : `cannot write ${p(e.tilde(dest))}: ${p(code ?? /** @type {Error} */ (err).message)}`);
    }
  }
  e.out('cancelled');
}

/** The parent and the direct replies of one email, graded by link, as a numbered screen. @param {BrowseEnv} e @param {string} id @param {string[]} path */
async function thread(e, id, path) {
  e.crumb(path, SCREEN_JOBS.thread);
  const t = await e.mp.linked(id);
  const parents = (t?.parents ?? []);
  /** @type {Entry[]} */
  const entries = [];
  const seen = new Set();
  for (const x of parents) if (x.id && !seen.has(x.id)) { seen.add(x.id); entries.push({ id: x.id, tag: `parent, ${x.strength}` }); }
  const lost = parents.filter((x) => !x.id);
  const nParents = entries.length;
  for (const x of t?.children ?? []) if (!seen.has(x.id)) { seen.add(x.id); entries.push({ id: x.id, tag: `reply, ${x.strength}` }); }
  const nReplies = entries.length - nParents;
  if (!entries.length && !lost.length) { e.out('no thread: no parent or replies recorded for this email'); return; }
  const n = (/** @type {number} */ c, /** @type {string} */ one, /** @type {string} */ many) => `${c} ${c === 1 ? one : many}`;
  e.out(`thread: ${n(nParents, 'parent', 'parents')}, ${n(nReplies, 'reply', 'replies')} ${e.st.dim('(signed: a verifying DKIM signature covers the reference; unsigned: the sender\'s word)')}`);
  for (const x of lost) e.out(e.st.dim(`  ${p(x.message_id, { max: 120 })} is named as a parent but is not in this trail (link ${x.strength})`));
  if (entries.length) await screen(e, { path, entries, crumbed: true });
}

/** The counterparty row for the other party of this email (as the people list shows it), then the latest five with them. @param {BrowseEnv} e @param {Facts} facts @param {string[]} path */
async function person(e, facts, path) {
  e.crumb(path, SCREEN_JOBS.person);
  const addr = partyOf(facts);
  if (!addr) { e.out('no other party is recorded for this email'); return; }
  const who = addr;
  const row = (await e.mp.counterparties()).find((r) => r.address === who);
  if (row) e.out(`${p(who)}  ${row.records} email${row.records === 1 ? '' : 's'}, ${row.verified} received verified, first ${row.first.slice(0, 10)}, last ${row.last.slice(0, 10)}`);
  e.out(`${e.st.dim('to send them what you hold:')} ${e.st.key('11')} export`);
  await browseList(e, who, path, true);
}
