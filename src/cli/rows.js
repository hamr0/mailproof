// The numbered email rows every screen shares (SPEC B11.4a): the menu's list, a person's emails, `verify <address>`, `replies`, the previews of
// export and forget and the pick list of `check`. One renderer, so a row looks the same wherever it appears. Pure rendering: the facts come from the
// library's `describe` (and `replyFacts`), nothing is derived here. Every mail-derived string is escaped (printable) before any style is applied.

import { printable as p } from './printable.js';
import { rel } from './style.js';
import { otherParty } from './target.js';
import { whyText } from './detail.js';
import { wrap, count } from './words.js';

/** @typedef {import('../proof/describe.js').Facts} Facts */
/** What a row needs of its screen: the style (and so the width) and the clock. @typedef {{ st: import('./style.js').Style, now: () => Date }} RowEnv */

/** @param {string} iso @param {Date} now @returns {string} `11-01 10:06Z`, with the year when it is not this one. */
export const whenText = (iso, now) => `${iso.slice(iso.slice(0, 4) === String(now.getUTCFullYear()) ? 5 : 0, 10)} ${iso.slice(11, 16)}Z`;

/** The other party of an email, lower case (the From of a received one, the first To or Cc of a sent one): the library's `otherParty`. @param {Facts} f @returns {string | null} */
export const partyOf = (f) => otherParty(f.direction, [...f.from.map((a) => ({ role: 'from', address: a.address.toLowerCase() })), ...f.to.map((a) => ({ role: 'to', address: a.address.toLowerCase() })), ...f.cc.map((a) => ({ role: 'cc', address: a.address.toLowerCase() }))]);

/**
 * The lines of a page of emails: a header, then three lines each (row, subject, short reason; or the wrapped `note`). Every mail-derived string is escaped before any
 * style is applied and cut at the terminal width.
 * @param {RowEnv} e
 * @param {Array<{ facts: Facts, tag?: string, verdict?: { ok: boolean, word: string }, note?: string, extra?: string }>} items  `extra`: a dim remark at the end of the last line (`sent copy, not counted`); `verdict`: a re-check's own verdict instead of the one recorded at capture; `note`: a long reason, wrapped and indented under the row instead of the short one.
 * @param {number} first  The number of the first row.
 * @returns {string[]}
 */
export function pageLines(e, items, first) {
  const { st } = e;
  const now = e.now();
  const width = st.width;
  const pre = items.map(({ facts: f, tag, verdict: v, note, extra }) => {
    const ago = rel(f.captured, now).replace(/ ago$/, '');
    const live = v ? v.word : f.trust.live;
    const party = partyOf(f);
    return {
      when: whenText(f.captured, now), ago, ok: v ? v.ok : live === 'verified', verdict: `${(v ? v.ok : live === 'verified') ? st.sym.ok : st.sym.bad} ${p(live ?? '-')}`, note, extra: extra ? p(extra) : '',
      who: p(`${f.direction === 'out' ? 'to ' : ''}${party ?? '-'}`), tag, subject: p(f.subject.value ?? '(no subject)'), noSubject: f.subject.value === null, unsigned: f.subject.value !== null && f.subject.coverage !== 'signed',
      why: p(f.reason, { max: 80 }), att: f.attachments.length,
    };
  });
  const whenW = Math.max(4, ...pre.map((x) => x.when.length));
  const ageW = Math.max(3, ...pre.map((x) => x.ago.length));
  const verW = Math.max(7, ...pre.map((x) => [...x.verdict].length));
  const indent = '    ';
  /** @type {string[]} */
  const out = [];
  out.push(st.dim(` #  ${'when'.padEnd(whenW)}  ${'age'.padEnd(ageW)}  ${'verdict'.padEnd(verW)}  from`));
  for (const [i, x] of pre.entries()) {
    const n = String(first + i).padStart(2);
    const left = `${n}  ${x.when.padEnd(whenW)}  ${x.ago.padEnd(ageW)}  ${x.verdict.padEnd(verW)}  `;
    const tag = x.tag ? `  ${x.tag}` : '';
    const room = Math.max(8, width - [...left].length - [...tag].length);
    const verdict = x.ok ? st.green(x.verdict.padEnd(verW)) : st.yellow(x.verdict.padEnd(verW));
    out.push(`${n}  ${x.when.padEnd(whenW)}  ${st.dim(x.ago.padEnd(ageW))}  ${verdict}  ${st.fit(x.who, room)}${x.tag ? st.dim(tag) : ''}`);
    const mark = x.unsigned ? `  ${st.sym.dot} subject not signed` : '';
    const subject = st.fit(x.subject, Math.max(8, width - indent.length - [...mark].length));
    out.push(`${indent}${x.noSubject ? st.dim(subject) : subject}${x.unsigned ? st.dim(mark) : ''}`);
    if (x.note) {
      for (const l of wrap(x.note.slice(0, 500), width - indent.length)) out.push(`${indent}${whyText(st, l)}`);
      if (x.extra) out.push(`${indent}${st.dim(x.extra)}`);
      continue;
    }
    const att = x.att ? ` ${st.sym.dot} ${count(x.att, 'attachment')}` : '';
    out.push(`${indent}${st.dim(st.fit(`${x.why}${att}${x.extra ? ` ${st.sym.dot} ${x.extra}` : ''}`, width - indent.length))}`);
  }
  return out;
}

/**
 * Escaped text that fits `room` code points, cut BEFORE escaping (by code points of the original, so an escape is never split) with the count of what was cut.
 * @param {string} raw @param {number} room @returns {string}
 */
export function fitEscaped(raw, room) {
  let m = Math.min([...raw].length, 400);
  let t = p(raw, { max: m });
  while (m > 1 && [...t].length > room) { m = Math.max(1, Math.min(m - 1, Math.floor(m * (room / [...t].length)))); t = p(raw, { max: m }); }
  return t;
}

/**
 * The rows of `replies` (SPEC B10, B11.5): a header, then three lines each: when, age, verdict and sender; the new text of the reply (its first
 * line, indented); the link and the short reason in plain words. The library's field names (`dkim-aligned none`, `unverified/unverified`) never
 * show: the verdict is the live one, the reason is the library's short reason (the one the list rows use).
 * @param {RowEnv} e
 * @param {Array<{ row: Record<string, any>, reason: string }>} items
 * @param {number} [first]  The number of the first row.
 * @returns {string[]}
 */
export function replyLines(e, items, first = 1) {
  const { st } = e;
  const now = e.now();
  const width = st.width;
  const indent = '    ';
  const pre = items.map(({ row: r, reason }) => {
    const live = String(r.live ?? '-');
    const link = r.link === 'signed' ? 'link signed' : r.link === 'none' ? 'no link' : 'link not signed';
    return {
      when: whenText(String(r.captured), now), ago: rel(String(r.captured), now).replace(/ ago$/, ''), ok: live === 'verified',
      verdict: `${live === 'verified' ? st.sym.ok : st.sym.bad} ${p(live)}`, from: p(String(r.from ?? '-')),
      text: r.firstLine ? String(r.firstLine) : '', detail: `${link} ${st.sym.dot} ${p(reason, { max: 60 })}${r.bodyProven === 'proven' ? '' : `${' '}${st.sym.dot} text not proven`}`,
    };
  });
  const whenW = Math.max(4, ...pre.map((x) => x.when.length));
  const ageW = Math.max(3, ...pre.map((x) => x.ago.length));
  const verW = Math.max(7, ...pre.map((x) => [...x.verdict].length));
  /** @type {string[]} */
  const out = [st.dim(` #  ${'when'.padEnd(whenW)}  ${'age'.padEnd(ageW)}  ${'verdict'.padEnd(verW)}  from`)];
  for (const [i, x] of pre.entries()) {
    const n = String(first + i).padStart(2);
    const room = Math.max(8, width - (2 + 2 + whenW + 2 + ageW + 2 + verW + 2));
    const verdict = x.ok ? st.green(x.verdict.padEnd(verW)) : st.yellow(x.verdict.padEnd(verW));
    out.push(`${n}  ${x.when.padEnd(whenW)}  ${st.dim(x.ago.padEnd(ageW))}  ${verdict}  ${st.fit(x.from, room)}`);
    out.push(`${indent}${x.text ? fitEscaped(x.text, Math.max(8, width - indent.length)) : st.dim('(no text stored)')}`);
    out.push(`${indent}${st.dim(st.fit(x.detail, width - indent.length))}`);
  }
  return out;
}
