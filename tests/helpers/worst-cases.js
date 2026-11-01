// TEST-ONLY: for every input limit (src/proof/limits.js), the most expensive message that is still
// ADMITTED, i.e. built just under the limit. check() on each must stay cheap: the gate bounds the size of
// what reaches the parsers, and these are the shapes that cost the most per byte once they get there.
// Each case says which limit it sits under; `admitted()` asserts that the gate really lets it through
// (a case the gate refuses would time the gate, not the code behind it). NEVER imported from src/.
import crypto from 'node:crypto';
import { admit } from '../../src/proof/admit.js';
import {
  MAX_HEADER_BYTES, MAX_HEADER_LINES, MAX_HEADER_FIELDS, MAX_SIGNATURES, MAX_H_NAMES, MAX_SIG_BYTES,
  MAX_MIME_PARTS, MAX_BODY_LINE,
} from '../../src/proof/limits.js';
import { makeKey, signedMail } from './proof.js';

export const CRLF = '\r\n';
const SIG = (extra = '') => `DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA${extra}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
export const msg = (headers, body = 'hello' + CRLF) => Buffer.from([...headers, '', body].join(CRLF));
/** the SIG header with a bh= that matches `body` (relaxed canon of already-canonical lines) */
const sigFor = (body) => SIG().replace(/bh=[^;]*/, `bh=${sha(body)}`);
const MiB = 1 << 20;

/** 10 valid signatures (distinct keys) over a body that is then altered, so every signature goes down the mismatch search. */
async function tampered({ body, hNames = 0, flipFromEnd }) {
  const signers = Array.from({ length: MAX_SIGNATURES }, (_, i) => ({ domain: `s${i}.example`, selector: 'sel', key: makeKey('rsa') }));
  const headerList = hNames ? [...Array(hNames).fill('received'), 'from', 'to', 'subject', 'date', 'message-id'] : undefined;
  const s = await signedMail({ signers: signers.map((x) => ({ ...x, headerList })), body });
  // 900 Received fields on top, added after signing (signing them would list each one in h=)
  const top = Buffer.from(hNames ? Array.from({ length: 900 }, (_, i) => `Received: hop ${i}${CRLF}`).join('') : '');
  const raw = Buffer.concat([top, s.raw]);
  raw[raw.length - flipFromEnd] ^= 1;   // inside the body: every bh= now mismatches
  return { raw, resolver: s.resolver };
}
const lines = (n, width) => Array.from({ length: n }, (_, i) => 'line' + String(i).padStart(6, '0') + 'x'.repeat(width)).join(CRLF) + CRLF;

/** normal-looking message: about `size` bytes, MIME with a base64 attachment (76-column lines), matching bh. */
function normalMessage(size) {
  const line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';
  const body = `--b${CRLF}Content-Type: text/plain${CRLF}${CRLF}hello${CRLF}--b${CRLF}Content-Type: application/pdf${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}`
    + (line + CRLF).repeat(Math.ceil(size / (line.length + 2))) + `--b--${CRLF}`;
  return msg([sigFor(body), 'Subject: hi', 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"',
    ...Array.from({ length: 8 }, (_, i) => `Received: from h${i}.example by m.example; Mon, 1 Jan 2026 00:00:00 +0000`)], body);
}

const rfc822 = (inner) => `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}${inner}`;
const parts = (n, mk) => Array.from({ length: n }, (_, i) => mk(i)).join('');
const mimeHeaders = (...h) => [SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"', ...h];

/** @type {Array<{ name: string, limit: string, build: () => Promise<{ raw: Buffer, resolver?: Function }> | { raw: Buffer, resolver?: Function }, ceilingMs?: number, why?: string }>} */
export const WORST_CASES = [
  // ---- header block ----
  { limit: 'header_bytes', name: 'one unfolded Subject filling the header block', build: () => ({ raw: msg([SIG(), 'From: me@x.example', 'Subject: ' + 'a'.repeat(MAX_HEADER_BYTES - 4096)]) }) },
  { limit: 'header_lines', name: 'one field folded into 3900 lines', build: () => ({ raw: msg([SIG().replace('h=from', 'h=subject'), 'From: me@x.example', 'Subject: s' + Array.from({ length: MAX_HEADER_LINES - 100 }, () => `${CRLF} ${'f'.repeat(60)}`).join('')]) }) },
  { limit: 'header_fields', name: '990 colon-less 64-byte lines, matching bh', build: () => { const body = ('x'.repeat(79) + CRLF).repeat(100); return { raw: msg([sigFor(body), 'From: me@x.example', ...Array.from({ length: MAX_HEADER_FIELDS - 10 }, () => 'A'.repeat(64))], body) }; } },
  { limit: 'header_fields', name: '990 fields of ~250 bytes', build: () => ({ raw: msg([SIG(), 'From: me@x.example', ...Array.from({ length: MAX_HEADER_FIELDS - 10 }, (_, i) => `X-${i}: ${'v'.repeat(240)}`)]) }) },
  { limit: 'header_fields', name: '990 Received lines + a signature with h= of 200 x received', build: () => ({ raw: msg([SIG().replace('h=from', 'h=' + Array(MAX_H_NAMES).fill('received').join(':')), 'From: me@x.example', ...Array.from({ length: MAX_HEADER_FIELDS - 10 }, (_, i) => `Received: hop ${i}`)]) }) },
  { limit: 'header_bytes', name: 'List-Id of "<" filling the header block', build: () => ({ raw: msg([SIG(), 'From: me@x.example', 'List-Id: ' + '<'.repeat(MAX_HEADER_BYTES - 4096)], 'x' + CRLF) }) },
  { limit: 'header_bytes', name: 'signed From of ~256 KiB with no @ (valid signature)', build: async () => { const s = await signedMail({ from: 'a'.repeat(MAX_HEADER_BYTES - 8192), signers: [{ domain: 'signer.example', selector: 'sel1', key: makeKey('rsa') }] }); return { raw: s.raw, resolver: s.resolver }; } },
  { limit: 'sig_bytes', name: 'one signature with padded b= and bh= at the field limit', build: () => ({ raw: msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(MAX_SIG_BYTES / 4 - 100)}`).replace('b=AAAA', `b=${'A '.repeat(MAX_SIG_BYTES / 4 - 100)}`), 'From: me@x.example']) }) },
  // ---- signatures x body search: the shapes the per-message work budget exists for ----
  { limit: 'signatures', name: '10 valid signatures, tampered 128 KiB body (1700 lines)', build: () => tampered({ body: lines(1700, 60), flipFromEnd: 5000 }) },
  { limit: 'signatures', name: '10 valid signatures, tampered 2 MiB body (5000 lines)', build: () => tampered({ body: lines(5000, 400), flipFromEnd: 40 }) },
  { limit: 'signatures', name: '10 valid signatures, tampered 1 MiB body (20000 lines)', build: () => tampered({ body: lines(20000, 40), flipFromEnd: 40 }) },
  { limit: 'signatures', name: '10 valid signatures with 190-name h=, 900 Received, tampered', build: () => tampered({ body: lines(100, 40), hNames: 190, flipFromEnd: 40 }) },
  // ---- body line ----
  { limit: 'body_line', name: 'one line of exactly 256 KiB, matching bh', build: () => { const b = 'a'.repeat(MAX_BODY_LINE) + CRLF; return { raw: msg([sigFor(b), 'From: me@x.example'], b) }; } },
  { limit: 'body_line', name: 'one 256 KiB line of tabs and spaces, wrong bh', build: () => ({ raw: msg([SIG(), 'From: me@x.example'], 'a \t'.repeat(MAX_BODY_LINE / 3 - 1) + CRLF) }) },
  { limit: 'total_bytes', name: '96 lines of 256 KiB (24 MiB), matching bh', ceilingMs: 6000, why: 'linear in size: ~75 ms a MiB through mailparser, mailauth and our own hashing', build: () => { const b = ('a'.repeat(MAX_BODY_LINE) + CRLF).repeat(96); return { raw: msg([sigFor(b), 'From: me@x.example'], b) }; } },
  { limit: 'signatures', name: '10 valid signatures, tampered, a 256 KiB line then 5000 short lines', build: () => tampered({ body: 'a '.repeat(MAX_BODY_LINE / 2 - 2) + CRLF + Array.from({ length: 5000 }, (_, i) => 'l' + i).join(CRLF) + CRLF, flipFromEnd: 40 }) },
  // ---- MIME ----
  { limit: 'mime_parts', name: '190 attachment parts', build: () => ({ raw: msg(mimeHeaders(), parts(MAX_MIME_PARTS - 10, (i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`) + `--bnd--${CRLF}`) }) },
  { limit: 'mime_parts', name: '190 message/rfc822 parts', build: () => ({ raw: msg(mimeHeaders('Subject: Fwd: x'), parts(MAX_MIME_PARTS - 10, () => rfc822(`From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`)) + `--bnd--${CRLF}`) }) },
  { limit: 'mime_parts', name: '190 message/rfc822 parts, each a signed message', build: () => ({ raw: msg(mimeHeaders(), parts(MAX_MIME_PARTS - 10, () => rfc822(`${SIG()}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`)) + `--bnd--${CRLF}`) }) },
  // ---- total size ----
  { limit: 'total_bytes', name: 'ordinary 1 MiB message with a base64 attachment', build: () => ({ raw: normalMessage(MiB) }) },
  { limit: 'total_bytes', name: 'ordinary 24 MiB message with a base64 attachment', ceilingMs: 6000, why: 'linear in size (see above)', build: () => ({ raw: normalMessage(24 * MiB) }) },
  { limit: 'total_bytes', name: '10 valid signatures, tampered 5.5 MiB body of short lines', ceilingMs: 4000, why: 'size x signatures: each signature hashes the body once in our own code (mailauth shares one hash)', build: () => tampered({ body: lines(80000, 60).repeat(1), flipFromEnd: 40 }) },
];

/** Assert the gate lets the case through. */
export function admitted(raw) {
  const g = admit(raw);
  if (!g.ok) throw new Error(`the gate refused a case meant to sit under every limit: ${g.limit}`);
  return g;
}
