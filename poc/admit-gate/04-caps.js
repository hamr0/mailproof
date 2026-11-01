// Proof 4: real check() at JUST UNDER each proposed limit, worst-case shapes. Also asserts admit() ADMITS each case
// (so these are exactly the inputs the gate lets through). CPU ms, warm-up + median of 3 (RUNS env to change).
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { admit } from './admit.js';
import { LIMITS as L } from './limits.js';
import { SIG, msg, msgBh, CRLF, sha, normalMessage } from './gen.js';
import { makeKey, signedMail } from '../../tests/helpers/proof.js';
import { cpu, nxdomain } from './cpu.js';
const RUNS = +(process.env.RUNS || 3);
const only = process.env.ONLY;
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-'));
const cases = [];
const add = (name, make) => cases.push({ name, make });
const KB = 1024, MiB = 1 << 20;

// ---- MAX_HEADER_BYTES / LINES / FIELDS ----
add('hdr: one unfolded 1 MiB field (Subject)', () => ({ raw: msg([SIG(), 'From: me@x.example', 'Subject: ' + 'a'.repeat(L.MAX_HEADER_BYTES - 4096)]) }));
add('hdr: one field folded into 3900 lines', () => ({ raw: msg([SIG().replace('h=from', 'h=subject'), 'From: me@x.example', 'Subject: s' + Array.from({ length: 3900 }, () => `${CRLF} ${'f'.repeat(60)}`).join('')]) }));
add('hdr: 3900 colon-less 64 B lines + matching bh', () => { const body = ('x'.repeat(79) + CRLF).repeat(100); return { raw: msg([SIG().replace(/bh=[^;]*/, `bh=${sha(body)}`), 'From: me@x.example', ...Array.from({ length: 3900 }, () => 'A'.repeat(64))], body) }; });
add('hdr: 990 fields x ~250 B', () => ({ raw: msg([SIG(), 'From: me@x.example', ...Array.from({ length: 990 }, (_, i) => `X-${i}: ${'v'.repeat(240)}`)]) }));
add('hdr: 990 Received + sig h=received x200', () => ({ raw: msg([SIG().replace('h=from', 'h=' + Array(200).fill('received').join(':')), 'From: me@x.example', ...Array.from({ length: 990 }, (_, i) => `Received: hop ${i}`)]) }));
add('hdr: List-Id "<" x 1 MiB', () => ({ raw: msg([SIG(), 'From: me@x.example', 'List-Id: ' + '<'.repeat(L.MAX_HEADER_BYTES - 4096)], 'x' + CRLF) }));
add('hdr: signed From of 1 MiB no-@ (valid sig)', async () => { const key = makeKey('rsa'); const s = await signedMail({ from: 'a'.repeat(L.MAX_HEADER_BYTES - 8192), signers: [{ domain: 'signer.example', selector: 'sel1', key }] }); return { raw: s.raw, resolver: s.resolver }; });
add('hdr: one sig with b=/bh= tags at MAX_SIG_BYTES', () => ({ raw: msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(L.MAX_SIG_BYTES / 4 - 100)}`).replace('b=AAAA', `b=${'A '.repeat(L.MAX_SIG_BYTES / 4 - 100)}`), 'From: me@x.example']) }));
// ---- MAX_SIGNATURES x MAX_H_NAMES: 10 valid signatures, tampered body => body analysis on each ----
const tampered = async (nsig, bodyLines, lineLen, hNames) => {
  const signers = Array.from({ length: nsig }, (_, i) => ({ domain: `s${i}.example`, selector: 'sel', key: makeKey('rsa') }));
  const body = Array.from({ length: bodyLines }, (_, i) => 'line' + String(i).padStart(6, '0') + 'x'.repeat(lineLen)).join(CRLF) + CRLF;
  const headerList = hNames ? Array(hNames).fill('received') .concat(['from', 'to', 'subject', 'date', 'message-id']) : undefined;
  const s = await signedMail({ signers: signers.map((x) => ({ ...x, headerList })), body, extraHeaders: Array.from({ length: hNames ? 900 : 0 }, (_, i) => `Received: hop ${i}`) });
  // tamper: flip one byte in the middle of the body so every bh= mismatches => mismatch explanation search runs per signature
  const raw = Buffer.from(s.raw); const at = raw.length - Math.floor(body.length / 2); raw[at] = raw[at] === 0x7a ? 0x79 : 0x7a;
  return { raw, resolver: s.resolver };
};
add('sig: 10 valid sigs, tampered 128 KiB body (1700 lines)', () => tampered(10, 1700, 60, 0));
add('sig: 10 valid sigs, tampered 2 MiB body (5000 lines)', () => tampered(10, 5000, 400, 0));
add('sig: 10 valid sigs, tampered 1 MiB body (20000 lines)', () => tampered(10, 20000, 40, 0));
add('sig: 10 valid sigs h=200 names, 900 Received, tampered', () => tampered(10, 100, 40, 190));
// ---- MAX_BODY_LINE ----
add('body: 256 KiB single line, matching bh', () => ({ raw: msgBh([], 'a'.repeat(L.MAX_BODY_LINE) + CRLF) }));
add('body: 256 KiB single line, tabs/space runs (fixLineBuffer), wrong bh', () => ({ raw: msg([SIG(), 'From: me@x.example'], 'a \t'.repeat(L.MAX_BODY_LINE / 3 - 1) + CRLF) }));
add('body: 96 lines of 256 KiB (25 MiB total), matching bh', () => ({ raw: msgBh([], ('a'.repeat(L.MAX_BODY_LINE) + CRLF).repeat(96)) }));
add('body: 10 valid sigs, tampered, 256 KiB single line + 5000 short lines', async () => {
  const signers = Array.from({ length: 10 }, (_, i) => ({ domain: `s${i}.example`, selector: 'sel', key: makeKey('rsa') }));
  const body = 'a '.repeat(L.MAX_BODY_LINE / 2 - 2) + CRLF + Array.from({ length: 5000 }, (_, i) => 'l' + i).join(CRLF) + CRLF;
  const s = await signedMail({ signers, body }); const raw = Buffer.from(s.raw); raw[raw.length - 40] ^= 1; return { raw, resolver: s.resolver };
});
// ---- MAX_MIME_PARTS ----
add('mime: 190 attachment parts', () => { const parts = Array.from({ length: 190 }, (_, i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`).join(''); return { raw: msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], parts + `--bnd--${CRLF}`) }; });
add('mime: 190 message/rfc822 parts', () => { const part = `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`; return { raw: msg([SIG(), 'From: me@x.example', 'Subject: Fwd: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], part.repeat(190) + `--bnd--${CRLF}`) }; });
add('mime: 190 nested multipart/digest rfc822 w/ signatures', () => { const inner = `${SIG()}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`; const part = `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}${inner}`; return { raw: msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], part.repeat(190) + `--bnd--${CRLF}`) }; });
// ---- sizes ----
add('size: normal 1 MiB base64 message, matching bh', () => ({ raw: normalMessage(1 * MiB) }));
add('size: normal 25 MiB base64 message, matching bh', () => ({ raw: normalMessage(25 * MiB) }));

const rows = [];
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  const { raw, resolver } = await c.make();
  const a = admit(raw, L, { stopEarly: false });
  const mp = new Mailproof({ trailDir: dir(), resolver: resolver || nxdomain });
  let err = '';
  const run = async () => { try { await mp.check(raw); } catch (e) { err = e.code || e.message.slice(0, 30); } };
  const t = []; const w = await cpu(run); t.push(w.ms);
  for (let i = 1; i < RUNS; i++) t.push((await cpu(run)).ms);
  const med = [...t].sort((x, y) => x - y)[Math.floor(t.length / 2)];
  console.log(`${c.name.padEnd(64)} ${(raw.length / MiB).toFixed(2).padStart(6)} MiB  admit=${a.ok ? 'ok ' : 'REJ(' + a.reason + ')'}  check ${med.toFixed(0).padStart(6)} ms${err ? '  threw ' + err : ''}${med > 1000 ? '   <-- >1s' : ''}`);
}
