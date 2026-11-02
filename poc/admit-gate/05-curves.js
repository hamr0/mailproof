// Proof 4b: cost CURVES of the dimensions that were slow at their cap, so each limit gets a reason.
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { SIG, msg, CRLF } from './gen.js';
import { makeKey, signedMail } from '../../tests/helpers/proof.js';
import { cpu, nxdomain } from './cpu.js';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-'));
const only = process.env.ONLY;
async function curve(title, xs, mk, unit) {
  if (only && !title.includes(only)) return;
  console.log(title);
  let prev = null;
  for (const x of xs) {
    const { raw, resolver } = await mk(x); const mp = new Mailproof({ trailDir: dir(), resolver: resolver || nxdomain });
    const run = async () => { try { await mp.check(raw); } catch {} };
    await run(); const t = []; for (let i = 0; i < 2; i++) t.push((await cpu(run)).ms); const m = Math.min(...t);
    console.log(`   ${String(x).padStart(8)} ${unit}  (${(raw.length / 1024).toFixed(0)} KiB)  ${m.toFixed(0).padStart(6)} ms${prev ? '  x' + (m / prev).toFixed(2) : ''}`); prev = m;
  }
}
await curve('MIME attachment parts', [100, 200, 400, 800], (n) => {
  const parts = Array.from({ length: n }, (_, i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`).join('');
  return { raw: msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], parts + `--bnd--${CRLF}`) };
}, 'parts');
await curve('MIME message/rfc822 parts', [100, 200, 400, 800], (n) => {
  const part = `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`;
  return { raw: msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], part.repeat(n) + `--bnd--${CRLF}`) };
}, 'parts');
await curve('MIME text parts (no headers, tiny)', [100, 200, 400, 800], (n) => ({ raw: msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], `--bnd${CRLF}${CRLF}x${CRLF}`.repeat(n) + `--bnd--${CRLF}`) }), 'parts');
await curve('DKIM-Signature field size (b= and bh= padded with "A ")', [4096, 16384, 65536, 262144, 1000000], (n) => ({ raw: msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(n / 4)}`).replace('b=AAAA', `b=${'A '.repeat(n / 4)}`), 'From: me@x.example']) }), 'B');
await curve('DKIM-Signature field size (one long unspaced b=)', [4096, 16384, 65536, 262144, 1000000], (n) => ({ raw: msg([SIG().replace('b=AAAA', `b=${'A'.repeat(n)}`), 'From: me@x.example']) }), 'B');
await curve('body line with tabs/space runs "a \\t", wrong bh, one line', [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024], (n) => ({ raw: msg([SIG(), 'From: me@x.example'], 'a \t'.repeat(n / 3) + CRLF) }), 'B');
await curve('header block bytes: one unfolded field', [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1000 * 1024], (n) => ({ raw: msg([SIG(), 'From: me@x.example', 'Subject: ' + 'a'.repeat(n)]) }), 'B');
await curve('header block bytes: signed From (valid sig) no-@', [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1000 * 1024], async (n) => { const key = makeKey('rsa'); const s = await signedMail({ from: 'a'.repeat(n), signers: [{ domain: 'signer.example', selector: 'sel1', key }] }); return { raw: s.raw, resolver: s.resolver }; }, 'B');
const tamp = async (nsig, lines, len) => {
  const signers = Array.from({ length: nsig }, (_, i) => ({ domain: `s${i}.example`, selector: 'sel', key: makeKey('rsa') }));
  const body = Array.from({ length: lines }, (_, i) => 'line' + String(i).padStart(6, '0') + 'x'.repeat(len)).join(CRLF) + CRLF;
  const s = await signedMail({ signers, body }); const raw = Buffer.from(s.raw); raw[raw.length - Math.floor(body.length / 2)] ^= 1; return { raw, resolver: s.resolver };
};
await curve('tampered 1 MiB body (20000 lines): number of valid signatures', [1, 2, 4, 10], (k) => tamp(k, 20000, 40), 'sigs');
await curve('tampered body, 3 sigs: body lines (x 50 B)', [2500, 5000, 10000, 20000, 40000], (n) => tamp(3, n, 40), 'lines');
await curve('tampered body, 1 sig: body KiB (2000 lines)', [64, 256, 1024, 2048], (k) => tamp(1, 2000, k * 512 - 10), 'KB-ish');
