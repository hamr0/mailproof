// Hostile generators. First block = copied from tests/integration/complexity.test.js (same shapes, same N);
// second block = new ones for this POC.
import crypto from 'node:crypto';
import { makeKey, signedMail } from '../../tests/helpers/proof.js';

export const CRLF = '\r\n';
export const SIG = (extra = '') => `DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA${extra}`;
export const msg = (headers, body = 'hello' + CRLF) => Buffer.from([...headers, '', body].join(CRLF));
export const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
/** a message with a signature whose bh= matches `body` (relaxed canon of already-canonical lines) */
export const msgBh = (headers, body) => msg([SIG().replace(/bh=[^;]*/, `bh=${sha(body)}`), 'From: me@x.example', ...headers], body);

export const GENERATORS = {
  'whitespace runs in the body': { N: 20000, build: (n) => msg([SIG(), 'From: me@x.example'], 'a' + ' '.repeat(n) + 'b' + CRLF) },
  'no-@ From (signed)': { N: 10000, init: async () => {
    const key = makeKey('rsa');
    const mk = (n) => signedMail({ from: 'a'.repeat(n), signers: [{ domain: 'signer.example', selector: 'sel1', key }] });
    const first = await mk(1);
    return { resolver: first.resolver, build: async (n) => (await mk(n)).raw };
  } },
  '< runs in List-Id': { N: 15000, build: (n) => msg([SIG(), 'From: me@x.example', `List-Id: ${'<'.repeat(n)}`], 'x' + CRLF) },
  'colon-less header lines': { N: 7500, build: (n) => {
    const body = ('x'.repeat(79) + CRLF).repeat(Math.ceil(n * 150 / 81));
    return msg([SIG().replace(/bh=[^;]*/, `bh=${sha(body)}`), 'From: me@x.example', ...Array.from({ length: n }, () => 'A'.repeat(64))], body);
  } },
  'colon-less header lines (rejected size)': { N: 60000, rejected: true, build: (n) => msg([SIG(), 'From: me@x.example', ...Array.from({ length: n }, () => 'A')]) },
  'huge h=': { N: 50000, build: (n) => msg([SIG().replace('h=from', `h=${Array.from({ length: n }, () => 'a').join(':')}`), 'From: me@x.example', ...Array.from({ length: 900 }, () => 'A: v')]) },
  'many repeated header names': { N: 7500, build: (n) => msg([SIG().replace('h=from', 'h=received:received:received'), 'From: me@x.example', ...Array.from({ length: n }, (_, i) => `Received: hop ${i}`)]) },
  'many DKIM-Signatures': { N: 4000, build: (n) => msg([...Array.from({ length: n }, (_, i) => `DKIM-Signature: v=1; d=d${i}.x; s=s; h=from; bh=AA; b=AA`), 'From: me@x.example']) },
  'deep folding': { N: 7500, build: (n) => msg([SIG().replace('h=from', 'h=subject'), 'From: me@x.example', 'Subject: s' + Array.from({ length: n }, () => `${CRLF} folded`).join('')]) },
  'long bh=/b= tag values': { N: 30000, build: (n) => msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(n)}`).replace('b=AAAA', `b=${'A '.repeat(n)}`), 'From: me@x.example']) },
  'many MIME parts / attachments': { N: 150, build: (n) => {
    const parts = Array.from({ length: n }, (_, i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`).join('');
    return msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], parts + `--bnd--${CRLF}`);
  } },
  'many message/rfc822 parts': { N: 150, build: (n) => {
    const part = `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`;
    return msg([SIG(), 'From: me@x.example', 'Subject: Fwd: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], part.repeat(n) + `--bnd--${CRLF}`);
  } },
};

// --- new for this POC ---
export const EXTRA = {
  'one-line body (matching bh)': { N: 1 << 20, build: (n) => { const b = 'a'.repeat(n) + CRLF; return msgBh([], b); } },
  'one-line body, bare LF end': { N: 1 << 20, build: (n) => { const b = 'a'.repeat(n) + '\n'; return msg([SIG(), 'From: me@x.example'], b); } },
  'one-line body, no final EOL': { N: 1 << 20, build: (n) => msg([SIG(), 'From: me@x.example'], 'a'.repeat(n)) },
};
export const ALL = { ...GENERATORS, ...EXTRA };

/** normal-ish message: ~size bytes, MIME with base64 attachment (76-col lines) */
export function normalMessage(size) {
  const line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';
  const lines = Math.ceil(size / (line.length + 2));
  const body = `--b${CRLF}Content-Type: text/plain${CRLF}${CRLF}hello${CRLF}--b${CRLF}Content-Type: application/pdf${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` + (line + CRLF).repeat(lines) + `--b--${CRLF}`;
  return msgBh(['Subject: hi', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', ...Array.from({ length: 8 }, (_, i) => `Received: from h${i}.example by m.example; Mon, 1 Jan 2026 00:00:00 +0000`)], body);
}
