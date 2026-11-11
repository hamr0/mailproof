// The README.txt of a pair bundle (SPEC B13.2.10): plain text, 80 columns, LF, made from a fixed template and the records, no free
// text of the owner's. Every value that comes from an email (addresses, subjects, ids as written, file names) goes through
// `printable()` (F28: the README is read in a terminal and a subject is attacker-chosen), and a subject or file name is cut to
// 200 code points. The verifier never reads it (it is only hashed, so damage is noticed): nothing in it is trusted.

import { printable } from './printable.js';
import { participantsOf, signedHeaderValue } from './participants.js';
import { verifyRecord } from './recheck.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {{ state: string, via: string | null, listed_in: number | null, stamped_by: number | null }} SealFacts */

const WIDTH = 80;
const FIELD_MAX = 200;
const LIST_MAX = 400;

/**
 * Wrap `text` to 80 columns after `label` (continuation lines indented to the end of the label). A word longer than the
 * line is broken hard. Never produces a line over 80 columns.
 * @param {string} label  Starts the first line, e.g. `    Subject   : `.
 * @param {string} text
 * @returns {string[]}
 */
function wrap(label, text) {
  const pad = ' '.repeat(Math.min(label.length, 24));
  const room = WIDTH - pad.length;
  /** @type {string[]} */
  const lines = [];
  let cur = '';
  /** @param {string} w */
  const add = (w) => {
    while (w.length > room) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, room)); w = w.slice(room); }
    if (!cur) cur = w; else if (cur.length + 1 + w.length <= room) cur += ` ${w}`; else { lines.push(cur); cur = w; }
  };
  for (const w of text.split(' ')) if (w) add(w);
  if (cur || !lines.length) lines.push(cur);
  return lines.map((l, i) => (i === 0 ? label + l : pad + l));
}

/** @param {string} v @param {number} n @returns {string} */
const field = (v, n = FIELD_MAX) => printable(v, { max: n });

/**
 * A header value the signature covers is bytes (Latin-1 in the record); show valid UTF-8 as characters, else as written.
 * @param {string} v
 * @returns {string}
 */
function asText(v) {
  const b = Buffer.from(v, 'binary');
  const u = b.toString('utf8');
  return u.includes('�') ? v : u;
}

/**
 * What the README says about one record, taken from the record alone (never the raw email). Small, so a bundle of thousands keeps
 * only this per record.
 * @param {MpRecord} rec
 * @returns {Record<string, any>}
 */
function factsOf(rec) {
  const parts = participantsOf(rec);
  /** @param {string} role */
  const addrs = (role) => parts.filter((p) => p.role === role).map((p) => ({ address: p.raw, signed: p.signed }));
  const v = verifyRecord(rec);
  const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
  const pass = v.passing.length ? v.passing[0] : -1;
  const used = pass >= 0 ? sigs[pass] : null;
  const h = used && used.tags && typeof used.tags.h === 'string' ? used.tags.h : '';
  const subject = signedHeaderValue(rec, 'subject');
  const date = signedHeaderValue(rec, 'date');
  const body = typeof rec.body_status === 'string' ? rec.body_status : 'not-checked';
  const partial = sigs.find((s) => s && s.partial_body === true);
  const m = rec.message ?? {};
  return {
    id: rec.id, direction: rec.direction, captured: rec.captured,
    from: addrs('from'), to: addrs('to'), cc: addrs('cc'), replyTo: addrs('reply-to'),
    subject: subject === null ? null : asText(subject), date: date === null ? null : asText(date),
    messageId: typeof m.message_id === 'string' ? m.message_id : null,
    inReplyTo: typeof m.in_reply_to === 'string' ? m.in_reply_to : null,
    inReplyToSigned: signedHeaderValue(rec, 'in-reply-to') !== null,
    dkim: sigs.length === 0 ? 'unsigned'
      : used ? `verified by d=${v.signatures[pass].d ?? '?'} s=${v.signatures[pass].s ?? '?'}, ${h ? h.split(':').length : 0} header names signed (${h})`
        : `not verified: ${v.signatures[0]?.why || 'no signature verifies'}`,
    body, partialBytes: partial && partial.tags && partial.tags.l ? String(partial.tags.l) : null,
    raw: typeof m.raw_sha256 === 'string' ? m.raw_sha256.replace(/^sha256:/, '') : '',
  };
}

/** @param {Array<{ address: string, signed: boolean }>} l @returns {string} */
function addrList(l) {
  if (!l.length) return '';
  const all = l.every((x) => x.signed);
  const none = l.every((x) => !x.signed);
  const txt = (/** @type {string} */ s) => printable(s, { max: LIST_MAX });
  if (all || none) return `${txt(l.map((x) => printable(x.address)).join(', '))} (${all ? 'signed' : 'unsigned'})`;
  return txt(l.map((x) => `${printable(x.address)} (${x.signed ? 'signed' : 'unsigned'})`).join(', '));
}

/**
 * @param {SealFacts} s
 * @returns {string}
 */
function sealLine(s) {
  if (s.state === 'anchored') return s.via === 'record' ? 'anchored at export (the record\'s own stamp)' : `anchored at export (manifest ${s.listed_in} listed it, manifest ${s.stamped_by} stamped)`;
  if (s.state === 'pending') return s.via === 'record' ? 'pending at export (the record\'s own stamp)' : `pending at export (manifest ${s.listed_in} listed it, manifest ${s.stamped_by} stamped)`;
  if (s.state === 'unstamped') return 'listed but not stamped at export';
  return 'not sealed at export';
}

/**
 * One email's block.
 * @param {number} n  1-based.
 * @param {Record<string, any>} f  `factsOf`.
 * @param {SealFacts} seal
 * @param {{ raw: { sha256: string, stored: boolean }, attachments: Array<{ filename: string | null, size: number, sha256: string, stored: boolean }> }} content
 * @param {Array<{ slug: string, sha256: string }>} replies
 * @returns {string[]}
 */
function emailBlock(n, f, seal, content, replies) {
  /** @type {string[]} */
  const out = [`[${n}] ${printable(f.id)}`];
  /** @param {string} label @param {string} text */
  const row = (label, text) => out.push(...wrap(`  ${label.padEnd(11)}: `, text));
  row('direction', f.direction === 'out' ? 'sent' : 'received');
  row('captured', `${printable(f.captured)} (the owner's clock)`);
  row('From', addrList(f.from) || 'not recorded');
  if (f.to.length) row('To', addrList(f.to));
  if (f.cc.length) row('Cc', addrList(f.cc));
  if (f.replyTo.length) row('Reply-To', addrList(f.replyTo));
  row('Subject', f.subject === null ? 'not recorded (not signed)' : `${field(f.subject)} (signed)`);
  row('Date', f.date === null ? 'not recorded' : `${field(f.date)} (signed)`);
  row('Message-ID', f.messageId === null ? 'none' : field(f.messageId));
  row('In-Reply-To', f.inReplyTo === null ? 'none' : `${field(f.inReplyTo)} (${f.inReplyToSigned ? 'signed' : 'unsigned'})`);
  row('DKIM', field(f.dkim, 300));
  row('Body', f.body === 'matched' ? 'matched' : f.body === 'partial' ? `partial (the signature covers only the first ${f.partialBytes ?? '?'} bytes)` : f.body === 'mismatch' ? 'mismatch' : 'not checked');
  row('Seal', sealLine(seal));
  row('Owner has', `raw email sha256 ${content.raw.sha256} (${content.raw.stored ? 'stored' : 'not stored'})`);
  for (const a of content.attachments) row('Owner has', `attachment ${field(a.filename ?? '(no name)')}, ${a.size} bytes, sha256 ${a.sha256} (${a.stored ? 'stored' : 'not stored'})`);
  for (const r of replies) row('Reply text', `${field(r.slug)} recorded (sha256 ${r.sha256})`);
  return out;
}

/**
 * The whole README.
 * @param {{ created: string, version: string, trail: string, head: string, with: string[], after: string | null, before: string | null, records: number, blocks: string[][] }} a
 * @returns {string}
 */
function readmeText(a) {
  const head = [
    'MAILPROOF PAIR BUNDLE',
    '=====================',
    ...wrap('', `Made ${printable(a.created)} by mailproof ${printable(a.version)} from the trail "${printable(a.trail)}" (commit ${printable(a.head.slice(0, 12))}).`),
    ...wrap('', `Selection: emails that name ${a.with.map((x) => printable(x)).join(', ')} on From, To, Cc or Reply-To, captured ${a.after ? `from ${printable(a.after)}` : 'from the beginning'} to ${a.before ? printable(a.before) : 'now'}.`),
    `${a.records} emails. The sha256 of bundle.json is printed by the owner's export, not here.`,
  ];
  const fixed = `
WHAT THIS IS
Proof records of emails, not the emails. For each email the record holds the
header lines the sender's mail server signed (DKIM), the signatures, and the
sender's public key as fetched when the mail arrived. An OpenTimestamps seal
fixes a latest date for each record. The emails themselves (bodies and
attachments) are NOT in this bundle.

CHECK IT, with no account, no trail and no network:
    npx mailproof verify-bundle <this directory>
(Install opentimestamps-client first if you want the seals checked as well:
without it verify-bundle says "seals not checked".) To check that this is the
bundle its owner made, ask for its sha256 by another channel and add
--expect <sha256>.

WHAT IS PROVEN (each line below says it per email; verify-bundle recomputes it)
- A signed email: the signing domain's key signed exactly the header lines
  listed as "signed". Those headers were not altered after signing. A signed
  From that aligns with the signing domain says that domain vouched for the
  sender.
- The record's file existed no later than the date of its seal (the Bitcoin
  block), through the manifest chain in manifests/. "Pending" means the seal
  is not in a Bitcoin block yet. "Anchored" means the proof is for these bytes
  and carries a Bitcoin block attestation; verify-bundle does not check that
  block against the Bitcoin chain (run \`ots verify\` on the manifest for that).
- The key shown is the key the record carries.

WHAT IS BEST EFFORT, NOT PROVEN
- Headers the signature does not cover: To, Cc, Reply-To, In-Reply-To and
  References are shown as recorded and marked "unsigned". "Replied to" is
  what the headers say, nothing a signature backs.
- The body and attachments: not in the bundle. "body: matched" says that at
  capture the body hashed to the signed value; only the owner's copy of the
  email can show it again. If you are given an email, its sha256 must equal the
  sha256 listed below (sha256sum), and its first 32 hex are the id.
- "captured" is the owner's clock. Only the seal bounds it ("no later than").
- An unsigned email (for example a sent copy at some providers) proves nothing
  about the sender; only that the owner recorded these bytes by the seal date.
- COMPLETENESS: not proven. The owner chose which emails to include. Nothing
  here shows that no other email between you exists. One weak check: the
  manifests list other records by hash. If you hold an email that is not here,
  take the first 32 hex of its sha256: if a manifest lists that id, the owner
  recorded it and left it out.

PRIVACY
This bundle names the people the owner wrote to and heard from, and the
subjects of these emails. Its manifests also show that other records existed
(how many, and when each batch was sealed), never what they were. Share it
only with whom you mean to.

THE EMAILS`;
  const lines = [...head, ...fixed.split('\n'), ...a.blocks.flatMap((b) => ['', ...b])];
  return `${lines.join('\n')}\n`;
}

export { factsOf, emailBlock, readmeText, wrap };
