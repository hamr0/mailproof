// The `show` view of one record (SPEC B11.5a): every field on its own labelled line, always, in one fixed order, `N/A` when a
// value does not exist, so the layout never shifts. PRESENTATION ONLY: the facts are the library's `describe` result (SPEC B8.5,
// `src/proof/describe.js`), the `why` sentence is the library's `explain`; `render` turns them into lines. The compact form (the
// per-record block of `show <address>`) is the same lines minus the long-tail facts. No DNS and no network.

import { printable as p } from './printable.js';
import { sealPhrase } from './seal.js';
import { makeStyle, rel } from './style.js';

/** @typedef {import('../proof/describe.js').Facts} LibFacts */
/** @typedef {import('./session.js').Session} Session */
/** @typedef {LibFacts & { account: { user: string | null, name: string } }} Facts  The library's facts plus the account line (the config's `user` and the account name). */

export const NA = 'N/A';
const LABEL = 12;

/**
 * The facts `render` takes: the library facts of one record plus which account they came from.
 * @param {LibFacts} f
 * @param {Session['account']} account
 * @returns {Facts}
 */
export const accountFacts = (f, account) => ({ ...f, account: { user: account.user ?? null, name: account.name } });

/**
 * The facts as `--json` carries them: the body text only when the caller asked for the whole thing (`--full`).
 * @param {Facts} f @param {boolean} full @returns {Facts | Omit<Facts, 'body'> & { body: Omit<Facts['body'], 'text' | 'more_lines'> }}
 */
export function jsonFacts(f, full) {
  if (full) return f;
  const { text: _t, more_lines: _m, ...body } = f.body;
  return { ...f, body };
}

/** One rule for every header line: `signed` only when a verifying signature covers it. */
const COVER = { signed: 'signed', failing: 'signed, failing', none: 'not signed' };
/** @param {string | null} s @returns {string} */
const link = (s) => (s ? `, link ${s}` : ', link not recorded');
/** The DNS names of a DKIM key (`selector._domainkey.domain`) in already-escaped text. */
const DKIM_NAME = /[A-Za-z0-9_.-]+\._domainkey\.[A-Za-z0-9.-]*[A-Za-z0-9]/g;

/**
 * The `why` text of a record: escaped (printable), the DNS name of a missing or unreadable DKIM key made a link (to a DNS lookup page: the
 * user clicks, mailproof never does), in yellow. The name is cut from already-escaped text, so it holds only name characters.
 * @param {import('./style.js').Style} st @param {string} why @returns {string}
 */
export function whyText(st, why) {
  return st.yellow(p(why, { max: 500 }).replace(DKIM_NAME, (name) => st.link(name, `https://dnschecker.org/#TXT/${encodeURIComponent(name)}`)));
}

/**
 * The labelled lines of one record, grouped under section headers (Message, People, Proof, Content, Seal). Every string from the record
 * goes through printable() BEFORE any style is applied.
 * @param {Facts} f
 * @param {{ compact?: boolean, fullHashes?: boolean, st?: import('./style.js').Style, now?: Date }} [o]  `compact`: the block of a multi-record view (the long-tail facts are left out; the body is as long as the facts carry it, the library cuts it to 10 lines unless asked for `full`); `fullHashes`: do not shorten hashes to 12 characters; `st`: the style (default none); `now`: for the relative times.
 * @returns {string[]}
 */
export function render(f, o = {}) {
  const st = o.st ?? makeStyle();
  const now = o.now ?? new Date();
  /** @type {string[]} */
  const out = [];
  const c = Boolean(o.compact);
  /** @param {string} h @returns {string} A hash, cut to 12 characters (dim) unless --full. */
  const hash = (h) => st.dim(o.fullHashes ? p(h) : p(h.replace(/^(sha256:)?(.*)$/s, (_, pre = '', rest) => `${pre}${rest.slice(0, 12)}`)));
  /** @param {string} v @returns {string} N/A (and its explanation) in dim. */
  const val = (v) => (v === NA || v.startsWith(`${NA} (`) ? st.dim(v) : v);
  let sections = 0;
  /** @param {string} name */
  const section = (name) => { if (sections++) out.push(''); out.push(st.bold(name)); };
  /** @param {string} label @param {string | string[]} value */
  const row = (label, value) => {
    const v = Array.isArray(value) ? value : [value];
    v.forEach((x, i) => out.push(`${st.dim((i === 0 ? label : '').padEnd(LABEL))} ${x}`));
  };
  /** @param {Facts['from']} l @returns {string} */
  const addrText = (l) => (l.length ? l.map((x) => `${x.coverage === 'signed' ? st.bold(p(x.address)) : p(x.address)} (${COVER[x.coverage]})`).join(', ') : st.dim(NA));
  /** @param {{ value: string | null, coverage: string }} h */
  const headText = (h, max = 300) => (h.value === null ? st.dim(NA) : `${h.coverage === 'signed' ? st.bold(p(h.value, { max })) : p(h.value, { max })} (${h.coverage === 'signed' ? COVER.signed : h.coverage === 'failing' ? COVER.failing : COVER.none})`);
  /** @param {string} t @param {string | null} v @returns {string} A trust word: green when verified, yellow otherwise (the word is always there). */
  const trustWord = (t, v) => (v === 'verified' ? st.green(t) : st.yellow(t));

  section('Message');
  row('account', f.account.user ? `${p(f.account.user)} ${st.dim(`(${p(f.account.name)})`)}` : `${st.dim(NA)} (${p(f.account.name)})`);
  row('direction', `${f.direction === 'out' ? 'sent' : 'received'}${f.source ? ` (${p(f.source)})` : ''}`);
  row('date', headText(f.date));
  const ago = rel(f.captured, now);
  row('captured', `${p(f.captured)} (${ago ? `${ago}; ` : ''}this machine's clock)`);
  row('subject', headText(f.subject, 200));
  if (!c) {
    row('in-reply-to', f.in_reply_to ? `${st.dim(p(f.in_reply_to.value))}${link(f.in_reply_to.strength)}` : st.dim(NA));
    row('references', f.references.length ? f.references.map((r) => `${st.dim(p(r.value))}${link(r.strength)}`) : st.dim(NA));
    row('children', f.children.length ? [...f.children.map((x) => `${st.dim(p(x.message_id ?? NA))}  ${p(x.strength)}  ${st.dim(p(x.id.slice(0, 12)))}`), ...(f.children_more ? ['... more'] : [])] : st.dim(NA));
    row('copy', f.copy ? p(f.copy) : st.dim(NA));
  }
  row('message-id', f.message_id ? st.dim(p(f.message_id)) : st.dim(NA));
  if (!c) row('message-key', f.message_key ? hash(f.message_key) : st.dim(NA));
  row('id', st.dim(p(f.id)));

  section('People');
  row('from', addrText(f.from));
  row('to', addrText(f.to));
  row('cc', addrText(f.cc));
  row('reply-to', addrText(f.reply_to));
  row('bcc', f.bcc === null ? st.dim(NA) : `${p(f.bcc, { max: 300 })} (not signed, own copy)`);

  section('Proof');
  row('trust', `live ${trustWord(p(f.trust.live ?? NA), f.trust.live)}, portable ${trustWord(p(f.trust.portable ?? NA), f.trust.portable)}${c ? '' : `; rules ${p(f.trust.rules ?? NA)}`}; re-check ${f.recheck.ok ? st.green('ok') : st.red('not ok')} (${p(f.recheck.trust)})`);
  row('why', f.why === null ? `${st.dim(NA)} (it verifies)` : whyText(st, f.why));
  row('body proof', f.body_proof === 'matched' ? st.green('matched') : f.body_proof === 'partial' ? st.yellow('partial (the signature covers only the first bytes)') : st.yellow(`not proven (${p(f.body_proof ?? NA)})`));
  {   // the same lines in every block (show <address> too): one definition
    row('dkim', f.dkim.length ? f.dkim.map((s) => `d=${p(s.d ?? NA)} s=${p(s.s ?? NA)} a=${p(s.a ?? NA)} result=${s.result === 'pass' ? st.green('pass') : p(s.result ?? NA)} aligned=${s.aligned === null ? NA : s.aligned ? 'yes' : 'no'} re-check=${p(s.recheck === null ? NA : s.recheck.ok ? 'ok' : `fails: ${s.recheck.why}`)} body=${p(s.body ?? NA)} key archived=${s.key_archived ? 'yes' : 'no'}`) : `${st.dim(NA)} (no DKIM signature)`);
    row('dmarc', f.dmarc ? `${p(f.dmarc.result ?? NA)}, policy ${p(f.dmarc.policy ?? NA)}, published ${f.dmarc.published ? 'yes' : 'no'}` : st.dim(NA));
    row('spf', f.spf ? p(f.spf.result) : st.dim(NA));
    row('arc', f.arc ? `${p(f.arc.result)}${f.arc.sealers.length ? `, sealers ${f.arc.sealers.map((x) => p(x)).join(', ')}` : ''}` : st.dim(NA));
  }

  section('Content');
  if (!f.body.stored) row('body', val(`${NA} (not stored: ${goneText(f.content.gone, now)})`));
  else if (f.body.text === null) row('body', val(`${NA} (${f.body.limit ? `over limit: ${p(f.body.limit)}` : 'no text part'})`));
  else {
    row('body', f.body.text === '' ? '(empty)' : `(${f.body.source})`);
    for (const l of f.body.text === '' ? [] : bodyLines(f.body.text)) out.push(`  ${p(l)}`);
    if (f.body.more_lines) out.push(`  ${st.dim(`... ${f.body.more_lines} more lines, use show ${p(f.id.slice(0, 12))} --full`)}`);
  }
  row('attachments', f.attachments.length
    ? f.attachments.map((a) => `${p(a.filename ?? '(no name)', { max: 200 })}  ${a.size === null ? NA : `${a.size} bytes`}  ${a.sha256 ? hash(a.sha256) : NA}  stored ${a.stored ? 'yes' : 'no'}${a.match === null ? '' : a.match ? '  match yes' : `  ${st.red('match NO (differs)')}`}`)
    : val(`${NA} (none)`));
  if (!c) row('content', f.content.raw_stored ? `raw email stored (${f.content.raw_sha256 ? hash(f.content.raw_sha256) : NA})` : val(`${NA} (raw email not stored: ${goneText(f.content.gone, now)})`));

  section('Seal');
  row('seal', f.seal === null ? val(`${NA} (sealing is off for this account)`) : sealPhrase(f.seal, now, st.sym.dot));
  return out;
}

/** The short `11-12` of when content went (the year only when it is not this one). @param {string} iso @param {Date} now @returns {string} */
const shortDay = (iso, now) => iso.slice(iso.slice(0, 4) === String(now.getUTCFullYear()) ? 5 : 0, 10);

/**
 * Why the raw email is not stored, in plain words, when mailproof knows (it noted the forget or the expiry, or the store is off); the generic
 * sentence only when the reason is truly unknown. One definition for `show` and the browser's raw screen.
 * @param {LibFacts['content']['gone']} gone @param {Date} now @returns {string}
 */
export function goneText(gone, now) {
  if (!gone) return 'expired, forgotten or never stored';
  if (gone.reason === 'never-stored') return 'never stored (content store off)';
  const day = gone.at ? ` ${shortDay(gone.at, now)}` : '';
  return gone.reason === 'forgotten' ? `forgotten${day} (mailproof forget)` : `expired${day} (retention)`;
}

/**
 * The lines of a shown body: tabs become spaces up to the next 4-column stop (a literal `\t` in a mail reads badly), and a run of three or
 * more blank lines at the very start becomes one. Display only: `--raw` and `--json` are untouched; every other control character is still
 * escaped by printable().
 * @param {string} text @returns {string[]}
 */
export function bodyLines(text) {
  const lines = text.split('\n').map((l) => { let col = 0; let o = ''; for (const ch of l) { if (ch === '\t') { const n = 4 - (col % 4); o += ' '.repeat(n); col += n; } else { o += ch; col++; } } return o; });
  let lead = 0;
  while (lead < lines.length && lines[lead].trim() === '') lead++;
  return lead >= 3 ? [lines[0], ...lines.slice(lead)] : lines;
}

/** The label column, for a test (the order of the labelled lines). */
export const LABELS = ['account', 'direction', 'date', 'captured', 'subject', 'in-reply-to', 'references', 'children', 'copy', 'message-id', 'message-key', 'id', 'from', 'to', 'cc', 'reply-to', 'bcc', 'trust', 'why', 'body proof', 'dkim', 'dmarc', 'spf', 'arc', 'body', 'attachments', 'content', 'seal'];
/** The section headers, in order. */
export const SECTIONS = ['Message', 'People', 'Proof', 'Content', 'Seal'];
