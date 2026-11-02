// Proof 6: classes a raw-byte pre-scan cannot bound. Every case here is ADMITTED by admit(); we measure check() and,
// for fan-out, count resolver calls. For each class we double the size to see growth where applicable.
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { admit } from './admit.js';
import { SIG, msg, CRLF } from './gen.js';
import { cpu, nxdomain } from './cpu.js';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-'));
const only = process.env.ONLY;
const mbPart = (ct, enc, body) => msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', `Content-Type: ${ct}`, ...(enc ? [`Content-Transfer-Encoding: ${enc}`] : [])], body);
const wrap = (s, n = 76) => s.match(new RegExp(`.{1,${n}}`, 'g')).join(CRLF) + CRLF;
const CASES = {
  'encoded-word Subject (1 MiB of =?utf-8?Q?a?= words, folded)': (n) => msg([SIG(), 'From: me@x.example', 'Subject: ' + Array.from({ length: n / 16 }, () => '=?utf-8?Q?a?=').join(`${CRLF} `)]),
  'encoded-word, 1 field long unfolded (n bytes)': (n) => msg([SIG(), 'From: me@x.example', 'Subject: ' + '=?utf-8?Q?a?= '.repeat(n / 14)]),
  'HTML body: <a> x n (unclosed, 76-col lines)': (n) => mbPart('text/html', null, wrap('<a>'.repeat(n / 3))),
  'HTML body: <div> nesting depth n': (n) => mbPart('text/html', null, wrap('<div>'.repeat(n / 5))),
  'HTML body: "<" runs': (n) => mbPart('text/html', null, wrap('<'.repeat(n))),
  'HTML body: &amp; entities': (n) => mbPart('text/html', null, wrap('&amp;'.repeat(n / 5))),
  'HTML body: <table><tr><td> nesting': (n) => mbPart('text/html', null, wrap('<table><tr><td>'.repeat(n / 15))),
  'QP body: soft-wrapped => ONE decoded line of n bytes': (n) => mbPart('text/plain', 'quoted-printable', Array.from({ length: n / 76 }, () => 'a'.repeat(75) + '=').join(CRLF) + CRLF + 'z' + CRLF),
  'base64 text/plain body n bytes': (n) => mbPart('text/plain', 'base64', wrap(Buffer.alloc(n * 3 / 4, 97).toString('base64'))),
  'nested multipart depth (1 "--" line per level + hdr)': (n) => { const d = Math.min(n / 1000, 450); let b = ''; for (let i = 0; i < d; i++) b += `--b${i}${CRLF}Content-Type: multipart/mixed; boundary="b${i + 1}"${CRLF}${CRLF}`; b += `--b${d}${CRLF}Content-Type: text/plain${CRLF}${CRLF}x${CRLF}`; for (let i = d; i >= 0; i--) b += `--b${i}--${CRLF}`; return msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b0"'], b); },
  'many Content-Type params / boundaries (1000 fields)': (n) => msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', ...Array.from({ length: 980 }, (_, i) => `Content-Type: multipart/mixed; boundary="${'b'.repeat(n / 1000)}${i}"`)], 'x' + CRLF),
  'To: 1 MiB of addresses': (n) => msg([SIG(), 'From: me@x.example', 'To: ' + Array.from({ length: n / 14 }, (_, i) => `a${i}@x.example`).join(`,${CRLF} `)], 'x' + CRLF),
  'To: nested group/comment parens': (n) => msg([SIG(), 'From: me@x.example', 'To: ' + '('.repeat(n / 2) + ')'.repeat(n / 2)], 'x' + CRLF),
  'From: quoted-string/escape runs': (n) => msg([SIG(), 'From: "' + '\\"'.repeat(n / 2) + '" <a@x.example>'], 'x' + CRLF),
};
const sizes = [128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024 - 8192];
for (const [name, mk] of Object.entries(CASES)) {
  if (only && !name.includes(only)) continue;
  const out = []; let allOk = true;
  for (const n of sizes) {
    const raw = mk(n); const a = admit(raw, undefined, { stopEarly: false }); allOk &&= a.ok;
    const mp = new Mailproof({ trailDir: dir(), resolver: nxdomain });
    let e = ''; const run = async () => { try { await mp.check(raw); } catch (x) { e = x.code || 'ERR'; } };
    await run(); const t = []; for (let i = 0; i < 2; i++) t.push((await cpu(run)).ms);
    out.push(`${(Math.min(...t)).toFixed(0).padStart(6)}${e ? '(' + e + ')' : ''}`);
  }
  console.log(`${name.padEnd(60)} admitted=${allOk ? 'all' : 'NOT ALL'}  ms @128K/256K/512K/1M: ${out.join(' ')}`);
}
// ---- DNS / network fan-out: count resolver calls (the gate bounds count of signatures, not other lookups) ----
if (!only || only === 'dns') {
  const calls = []; const counting = async (name, type) => { calls.push(`${type || 'TXT'} ${name}`); throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
  const run = async (label, raw) => {
    calls.length = 0; const a = admit(raw);
    const mp = new Mailproof({ trailDir: dir(), resolver: counting });
    const t0 = Date.now(); try { await mp.check(raw); } catch {} 
    console.log(`  ${label.padEnd(58)} admit=${a.ok ? 'ok' : 'REJ ' + a.reason}  resolver calls=${calls.length} (${new Set(calls).size} distinct)`);
  };
  console.log('DNS fan-out (counting resolver, everything NXDOMAIN):');
  await run('10 sigs, distinct d=/s=', msg([...Array.from({ length: 10 }, (_, i) => `DKIM-Signature: v=1; a=rsa-sha256; d=d${i}.example; s=s${i}; c=relaxed/relaxed; h=from; bh=AAAA; b=AAAA`), 'From: me@x.example']));
  await run('1 sig + 50 ARC sets (AMS+AS+AAR each)', msg([...Array.from({ length: 50 }, (_, i) => [`ARC-Seal: i=${i + 1}; a=rsa-sha256; d=a${i}.example; s=k; cv=none; b=AAAA`, `ARC-Message-Signature: i=${i + 1}; a=rsa-sha256; d=a${i}.example; s=k; c=relaxed/relaxed; h=from; bh=AAAA; b=AAAA`, `ARC-Authentication-Results: i=${i + 1}; a${i}.example; spf=pass`]).flat().reverse(), SIG(), 'From: me@x.example']));
  await run('Received-SPF / Authentication-Results x900', msg([SIG(), 'From: me@x.example', ...Array.from({ length: 450 }, (_, i) => `Authentication-Results: h${i}.example; spf=pass smtp.mailfrom=a@h${i}.example`), ...Array.from({ length: 450 }, (_, i) => `Received-SPF: pass (h${i}.example) client-ip=1.2.3.${i % 255}`)]));
}
