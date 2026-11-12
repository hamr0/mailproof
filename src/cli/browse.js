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
import { rel } from './style.js';
import { otherParty } from './target.js';

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
 * @property {(argv: string[]) => Promise<number>} go  Run a subcommand on the account (the menu's own path).
 * @property {() => Promise<boolean>} showHeld  Show what a terminal pager holds back; false when the input ended.
 * @property {import('../index.js').Mailproof} mp
 * @property {(f: string) => string} tilde
 * @property {() => Date} now
 * @property {string | undefined} home
 */

export const PAGE = 5;
const RAW_MAX = 1 << 20;
const DASH = (/** @type {BrowseEnv} */ e) => ` ${e.st.sym.dot} `;

/** @param {string} iso @param {Date} now @returns {string} `11-01 10:06Z`, with the year when it is not this one. */
const whenText = (iso, now) => `${iso.slice(iso.slice(0, 4) === String(now.getUTCFullYear()) ? 5 : 0, 10)} ${iso.slice(11, 16)}Z`;

/** The other party of an email, lower case (the From of a received one, the first To or Cc of a sent one): the library's `otherParty`. @param {Facts} f @returns {string | null} */
const partyOf = (f) => otherParty(f.direction, [...f.from.map((a) => ({ role: 'from', address: a.address.toLowerCase() })), ...f.to.map((a) => ({ role: 'to', address: a.address.toLowerCase() })), ...f.cc.map((a) => ({ role: 'cc', address: a.address.toLowerCase() }))]);

/**
 * The lines of a page of emails: a header, then three lines each (row, full subject, why). Every mail-derived string is escaped before any
 * style is applied and cut at the terminal width.
 * @param {BrowseEnv} e
 * @param {Array<{ facts: Facts, tag?: string }>} items
 * @param {number} first  The number of the first row.
 * @returns {string[]}
 */
export function pageLines(e, items, first) {
  const { st } = e;
  const now = e.now();
  const width = st.width;
  const pre = items.map(({ facts: f, tag }) => {
    const ago = rel(f.captured, now).replace(/ ago$/, '');
    const live = f.trust.live;
    const party = partyOf(f);
    const subject = f.subject.value === null ? '(no subject)' : `${f.subject.coverage === 'signed' ? '' : '~ '}${f.subject.value}`;
    const why = f.why === null ? 'verifies' : f.why;
    return {
      when: whenText(f.captured, now), ago, dir: f.direction === 'out' ? 'out' : 'in', ok: live === 'verified', verdict: `${live === 'verified' ? st.sym.ok : st.sym.bad} ${live ?? '-'}`,
      who: p(`${f.direction === 'out' ? 'to ' : ''}${party ?? '-'}`), tag, subject: p(subject), noSubject: f.subject.value === null,
      why: p(why, { max: 500 }), att: f.attachments.length,
    };
  });
  const whenW = Math.max(4, ...pre.map((x) => x.when.length));
  const ageW = Math.max(0, ...pre.map((x) => x.ago.length));
  const verW = Math.max(7, ...pre.map((x) => [...x.verdict].length));
  const indent = '    ';
  /** @type {string[]} */
  const out = [];
  out.push(st.dim(` #  ${'when'.padEnd(whenW + 2 + ageW)}  dir  ${'verdict'.padEnd(verW)}  from`));
  pre.forEach((x, i) => {
    const n = String(first + i).padStart(2);
    const left = `${n}  ${x.when.padEnd(whenW)}  ${x.ago.padEnd(ageW)}  ${x.dir.padEnd(3)}  ${x.verdict.padEnd(verW)}  `;
    const tag = x.tag ? `  ${x.tag}` : '';
    const room = Math.max(8, width - [...left].length - [...tag].length);
    const verdict = x.ok ? st.green(x.verdict.padEnd(verW)) : st.yellow(x.verdict.padEnd(verW));
    out.push(`${n}  ${x.when.padEnd(whenW)}  ${st.dim(x.ago.padEnd(ageW))}  ${x.dir.padEnd(3)}  ${verdict}  ${st.fit(x.who, room)}${x.tag ? st.dim(tag) : ''}`);
    const subject = st.fit(x.subject, width - indent.length);
    out.push(`${indent}${x.noSubject ? st.dim(subject) : subject}`);
    const att = x.att ? `${DASH(e)}${x.att} attachment${x.att === 1 ? '' : 's'}` : '';
    out.push(`${indent}${st.dim(st.fit(`why: ${x.why}${att}`, width - indent.length))}`);
  });
  return out;
}

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
 * @param {{ entries: Entry[], filters?: Filters, reload?: (f: Filters) => Promise<Entry[]> }} o
 * @returns {Promise<void>}
 */
async function screen(e, o) {
  const { st } = e;
  let { entries } = o;
  /** @type {Map<string, Facts>} */
  const cache = new Map();
  let shown = 0;
  let from = 0;
  /** @param {number} at */
  const page = async (at) => {
    const slice = entries.slice(at, at + PAGE);
    await load(e, slice.map((x) => x.id), cache);
    const items = slice.flatMap((x) => { const facts = cache.get(x.id); return facts ? [{ facts, ...(x.tag ? { tag: x.tag } : {}) }] : []; });
    from = at;
    shown = at + slice.length;
    if (!slice.length) e.out(entries.length ? 'that is all' : 'no emails match');
    else for (const l of pageLines(e, items, at + 1)) e.out(l);
    const k = (/** @type {string} */ s) => st.key(s);
    const parts = [...(shown > 0 ? [`${shown} of ${entries.length}`, `open: ${k('a number')}`] : []), ...(shown < entries.length ? [`${k('m')} more`] : []), ...(o.filters ? [`${k('f')} filter`, `${k('s')} subject search`] : []), `${k('Enter')} back`];
    e.out(parts.join(DASH(e)));
  };
  await page(0);
  for (;;) {
    const a = await e.p.ask('> ');
    if (a === null) throw new Cancel('eof');
    const c = a.trim().toLowerCase();
    if (c === '') return;
    if (/^\d+$/.test(c)) {
      const n = Number(c);
      if (n < 1 || n > shown) { e.out(`choose 1 to ${shown}`); continue; }
      await openEmail(e, entries[n - 1].id);
      await page(from);
    } else if (c === 'm') {
      if (shown >= entries.length) { e.out('that is all'); continue; }
      await page(shown);
    } else if ((c === 'f' || c === 's') && o.filters && o.reload) {
      const f = o.filters;
      if (c === 'f') {
        f.role = f.who ? await e.ask({ label: 'Role', example: 'from, to, cc, reply-to, empty = any', optional: true, validate: (s) => parseChoice(s, 'Role', 'from', 'to', 'cc', 'reply-to') }) : '';
        f.direction = await e.ask({ label: 'Direction', example: 'in, out, empty = both', optional: true, validate: (s) => parseChoice(s, 'Direction', 'in', 'out') });
        f.after = await e.askDate('After', '--after', 'date, e.g. {2026-01-01}, empty = no limit');
        f.before = await e.askDate('Before', '--before', 'date, e.g. {2026-08-19}, empty = no limit');
      } else f.subject = await e.ask({ label: 'Subject contains', example: 'text, empty = any', optional: true });
      entries = await o.reload(f);
      await page(0);
    } else e.out(`not a choice: ${p(c, { max: 40 })}`);
  }
}

/**
 * The menu's list: ask nothing here (the caller asked Who), show the latest five for that person, or for everyone.
 * @param {BrowseEnv} e
 * @param {string} who  An exact address, or '' for everyone.
 * @returns {Promise<void>}
 */
export async function browseList(e, who) {
  /** @type {Filters} */
  const filters = { who, role: '', direction: '', after: '', before: '', subject: '' };
  /** @param {Filters} f @returns {Promise<Entry[]>} */
  const reload = async (f) => (await e.mp.list(listArgs(f))).map((r) => ({ id: r.id }));
  await screen(e, { entries: await reload(filters), filters, reload });
}

/**
 * One email, opened: the `show` text, then the actions. Enter goes back to where it was opened from.
 * @param {BrowseEnv} e @param {string} id
 * @returns {Promise<void>}
 */
async function openEmail(e, id) {
  const { st } = e;
  const k = (/** @type {string} */ s) => st.key(s);
  const action = `  ${k('r')} raw email${DASH(e)}${k('a')} save attachment${DASH(e)}${k('v')} verify again${DASH(e)}${k('t')} thread${DASH(e)}${k('p')} this person${DASH(e)}${k('Enter')} back to list`;
  await e.go(['show', id]);
  if (!(await e.showHeld())) throw new Cancel('eof');
  const facts = (await e.mp.describe(id)).records[0];
  if (!facts) return;
  for (;;) {
    e.out(action);
    const a = await e.p.ask('> ');
    if (a === null) throw new Cancel('eof');
    const c = a.trim().toLowerCase();
    if (c === '') return;
    if (c === 'r') await rawEmail(e, id);
    else if (c === 'a') await saveAttachment(e, facts);
    else if (c === 'v') await e.go(['verify', id]);
    else if (c === 't') await thread(e, id);
    else if (c === 'p') await person(e, facts);
    else { e.out(`not a choice: ${p(c, { max: 40 })}`); continue; }
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
  const dflt = `~/Downloads/${safeName(att.filename, att.sha256 ?? '')}`;
  for (let tries = 0; tries < 3; tries++) {
    const want = await e.ask({ label: 'Save to', example: 'path', def: dflt });
    const dest = path.resolve(want === '~' || want.startsWith('~/') ? `${e.home ?? ''}${want.slice(1)}` : want);
    try {
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

/** The parent and the direct replies of one email, graded by link, as a numbered screen. @param {BrowseEnv} e @param {string} id */
async function thread(e, id) {
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
  if (!entries.length && !lost.length) { e.out('no linked emails'); return; }
  const n = (/** @type {number} */ c, /** @type {string} */ one, /** @type {string} */ many) => `${c} ${c === 1 ? one : many}`;
  e.out(`thread: ${n(nParents, 'parent', 'parents')}, ${n(nReplies, 'reply', 'replies')} ${e.st.dim('(signed: a verifying DKIM signature covers the reference; unsigned: the sender\'s word)')}`);
  for (const x of lost) e.out(e.st.dim(`  ${p(x.message_id, { max: 120 })} is named as a parent but is not in this trail (link ${x.strength})`));
  if (entries.length) await screen(e, { entries });
}

/** The counterparty row for the other party of this email (as the people list shows it), then the latest five with them. @param {BrowseEnv} e @param {Facts} facts */
async function person(e, facts) {
  const addr = partyOf(facts);
  if (!addr) { e.out('no other party is recorded for this email'); return; }
  const who = addr;
  const row = (await e.mp.counterparties()).find((r) => r.address === who);
  if (row) e.out(`${p(who)}  ${row.records} email${row.records === 1 ? '' : 's'}, ${row.verified} received verified, first ${row.first.slice(0, 10)}, last ${row.last.slice(0, 10)}`);
  e.out(`${e.st.dim('to send them what you hold:')} ${e.st.key('11')} export`);
  await browseList(e, who);
}
