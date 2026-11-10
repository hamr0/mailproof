// The reply fact bundle (SPEC B10): one flat object of strings describing ONE recorded reply, built from the stored
// record, the (optional) reply text and the (optional) raw email header block. Pure: no I/O, no clock, no DNS, so the
// same inputs always give the same bundle. mailproof supplies facts; the consumer decides what they mean.

import { verifyRecord } from './recheck.js';
import { participantsOf, linksOf, strongest, signedHeaderValue, signedFromAddresses } from './participants.js';
import { headerText, claimedHeader } from './header-text.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */

/** Separator of the multi-value fields (`to`, `cc`, `toRaw`, `ccRaw`, `attachments`): no address and no `sha256:<hex>` can contain it. */
const SEP = ',';

/** @typedef {'pass' | 'fail' | 'none' | 'other'} Result */
const TRUST = ['verified', 'forwarded', 'authorized', 'unverified'];

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * One verdict result (DMARC, SPF or ARC) mapped to the closed set: `pass`, `fail`, `none` (absent), `other` (anything
 * else mailauth reports: neutral, softfail, temperror, permerror, policy, ...). Anything that is not `pass` is not a pass.
 * @param {unknown} v  The stored verdict object (or null).
 * @returns {Result}
 */
function resultOf(v) {
  const r = v && typeof v === 'object' ? /** @type {any} */ (v).result : null;
  if (typeof r !== 'string' || r === '' || r === 'none') return 'none';
  return r === 'pass' || r === 'fail' ? r : 'other';
}

/**
 * The live DKIM verdict (one entry per signature; an unsigned mail has one entry with result `none`) mapped to `pass`
 * (some signature passed), `none` (no entry, or every entry is `none`: nothing was signed) or `fail` (anything else).
 * @param {unknown} list
 * @returns {'pass' | 'fail' | 'none'}
 */
function dkimOf(list) {
  const l = (Array.isArray(list) ? list : []).filter((d) => d && typeof d === 'object');
  if (l.some((d) => d.result === 'pass')) return 'pass';
  return l.every((d) => d.result === 'none' || d.result === undefined || d.result === null || d.result === '') ? 'none' : 'fail';
}

/** @param {unknown} v @returns {string} A trust level of the closed set; anything else is `unverified`. */
const trustOf = (v) => (typeof v === 'string' && TRUST.includes(v) ? v : 'unverified');

/**
 * Date or Subject: the value a PASSING signature covers (`signed`), else the header of the raw email (`claimed`), else
 * `''` (`none`). Encoded words are decoded.
 * @param {MpRecord} rec @param {number[]} passing @param {Buffer | null} raw @param {string} name  Lower case.
 * @returns {{ value: string, source: 'signed' | 'claimed' | 'none' }}
 */
function headerFact(rec, passing, raw, name) {
  const signed = signedHeaderValue(rec, name, passing);
  if (signed !== null) return { value: headerText(signed), source: 'signed' };
  const claimed = raw ? claimedHeader(raw, name) : null;
  return claimed !== null ? { value: headerText(claimed), source: 'claimed' } : { value: '', source: 'none' };
}

/**
 * The domain of the bundle's `from`: what follows the LAST `@`, with exactly one trailing `.` removed. `from` is already
 * lower-cased, so this is too; no IDN/punycode conversion, no normalisation. `ADDR_RE` (participants.js) admits a trailing
 * `.` in the domain (`bob@company.example.`), so the strip is real. `""` when `from` is empty or has no domain. A claimed
 * value, like `from`: only `fromDkimAligned` = `pass` makes it proven. Subdomains are not folded.
 * @param {string} from  The bundle's `from` value.
 * @returns {string}
 */
function domainOf(from) {
  const d = from.slice(from.lastIndexOf('@') + 1);
  return from.includes('@') ? (d.endsWith('.') ? d.slice(0, -1) : d) : '';
}

/**
 * The first line of the reply text that is non-empty after ECMAScript `trim()`; the line breaks are `\r\n`, `\n`, `\r`.
 * No case folding, no normalisation.
 * @param {string} text
 * @returns {string}
 */
function firstLineOf(text) {
  for (const l of text.split(/\r\n|\n|\r/)) { const t = l.trim(); if (t) return t; }
  return '';
}

/**
 * @typedef {Object} TextFacts
 * @property {'content' | 'none' | 'over-limit'} source  `content`: read from the stored raw email. `none`: no stored raw email (store off, expired, forgotten, corrupt). `over-limit`: the raw email is over an input limit and is not read.
 * @property {string} [text] @property {'found' | 'not-found' | 'inline'} [quote] @property {boolean} [trailing] @property {boolean} [textPlain]  The reply had a text/plain part.
 */

/**
 * Build the bundle of one recorded reply.
 * @param {{ rec: MpRecord, parent: string, commit: string, trail: string, raw: Buffer | null, text: TextFacts }} a
 *   `parent`: the Message-ID the bundle answers (the one asked for); `raw`: the stored raw email, for claimed Date and Subject only.
 * @returns {Record<string, string>}  Every value is a string.
 */
function replyBundle({ rec, parent, commit, trail, raw, text }) {
  const v = verifyRecord(rec);
  const people = participantsOf(rec);
  const role = (/** @type {string} */ r) => people.filter((p) => p.role === r);
  const from = role('from')[0];
  const live = rec.verdicts?.live ?? {};
  const date = headerFact(rec, v.passing, raw, 'date');
  const subject = headerFact(rec, v.passing, raw, 'subject');
  const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
  const aligned = v.passing.length > 0 && signedFromAddresses(rec, v.passing).length > 0;
  const proven = text.source === 'content' && text.textPlain === true && rec.body_status === 'matched';
  const t = text.source === 'content' ? str(text.text) : '';
  return {
    messageId: str(rec.message?.message_id),
    messageKey: str(rec.message_key),
    recordId: str(rec.id),
    commit,
    trail,
    captured: str(rec.captured),
    from: from ? from.address : '',
    fromRaw: from ? from.raw : '',
    fromDomain: domainOf(from ? from.address : ''),
    fromDkimAligned: aligned ? 'pass' : sigs.length ? 'fail' : 'none',
    to: role('to').map((p) => p.address).join(SEP),
    toRaw: role('to').map((p) => p.raw).join(SEP),
    cc: role('cc').map((p) => p.address).join(SEP),
    ccRaw: role('cc').map((p) => p.raw).join(SEP),
    date: date.value,
    dateSource: date.source,
    subject: subject.value,
    subjectSource: subject.source,
    dkim: dkimOf(live.dkim),
    dmarc: resultOf(live.dmarc),
    spf: resultOf(live.spf),
    arc: resultOf(live.arc),
    live: trustOf(live.trust),
    portable: trustOf(rec.verdicts?.portable?.trust),
    link: strongest(linksOf(rec, v.passing), parent),
    text: t,
    firstLine: firstLineOf(t),
    textSource: text.source,
    bodyProven: proven ? 'proven' : 'unproven',
    quote: text.source === 'content' && text.quote ? text.quote : 'not-found',
    trailing: text.source === 'content' && text.trailing === true ? 'yes' : 'no',
    attachments: (Array.isArray(rec.attachments) ? rec.attachments : []).map((a) => str(a?.sha256)).filter(Boolean).join(SEP),
  };
}

export { SEP, replyBundle, domainOf, firstLineOf, resultOf, dkimOf };
