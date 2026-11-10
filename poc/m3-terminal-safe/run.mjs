// POC: terminal-safe printing for CLI text output. node poc/m3-terminal-safe/run.mjs
// Part 1 attack corpus (synthetic, example.*), Part 2 real-mail COUNTS ONLY, Part 3 --json escaping, Part 4 bench.
// Nothing from real mail is printed or written: only counts and code-point classes. Scratch trail under M3_SCRATCH
// (default os.tmpdir()), removed in finally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { printable, dangerousIn, FORBIDDEN_AFTER } from './printable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const q = (s) => JSON.stringify(s);

// ---------- 1. attack corpus ----------
const ESC = '\u001b';
const corpus = {
  'cursor-up + erase overwrites the verdict line': `ok${ESC}[1A${ESC}[2K    link signed  verified/verified  body proven`,
  'OSC title set, BEL terminator (message-id)': `<${ESC}]0;pwned\u0007x@example.com>`,
  'OSC title set, ST terminator': `${ESC}]2;pwned${ESC}\\`,
  'OSC 8 hyperlink': `${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\`,
  'CSI via C1 0x9B': '\u009b2Jcleared',
  'C1 OSC (0x9D) and ST (0x9C)': '\u009d0;t\u009c',
  'bidi override reverses a domain': 'bob@moc.elpmaxe‮',
  'RTL spoof of an address (RLO + isolates)': '‮bob@example.com‬ ⁧x⁩',
  'zero-width chars: two addresses look identical': 'bob​@exa⁠mple.com',
  'ZWJ/ZWNJ next to ASCII (hidden in an address)': 'bob‍@example‌.com',
  'soft hyphen / BOM / filler': 'bo­b@ex﻿ample.comㅤ',
  'tag characters smuggling hidden text': 'hi\u{e0069}\u{e0067}\u{e006e}',
  'NUL, BEL, BS, FF, DEL': 'a\u0000b\u0007c\u0008d\u000ce\u007f',
  'raw newline and CR in a single-line field (forged second line)': 'x@example.com\r\n    link signed verified/verified body proven',
  'U+2028 / U+2029 / U+0085 line breaks': 'a b c\u0085d',
  'lone surrogates': 'a\ud800b\udc00c',
  'literal backslash that mimics an escape': 'a\\x1b[1Ab',
  'very long line (100,000 chars)': 'A'.repeat(100000),
};
console.log('1. ATTACK CORPUS (raw JSON | printable JSON)');
let fail = 0;
for (const [name, raw] of Object.entries(corpus)) {
  const out = printable(raw);
  const long = raw.length > 1000;
  // the output must contain no dangerous code point: ZWJ/ZWNJ are the only members that may survive, and only
  // between two non-ASCII characters (none of the corpus has that), so the full set is asserted
  let ok = !FORBIDDEN_AFTER.test(out);
  // unambiguous: undoing the escapes reproduces the input exactly
  const back = out.replace(/\\(\\|n|r|t|x[0-9a-f]{2}|u[0-9a-f]{4}|u\{[0-9a-f]+\})/g, (m, g) =>
    g === '\\' ? '\\' : g === 'n' ? '\n' : g === 'r' ? '\r' : g === 't' ? '\t' : String.fromCodePoint(parseInt(g.replace(/^u\{?|x|\}$/g, ''), 16)));
  const roundtrip = back === raw;
  // a lone surrogate round-trips as a code unit, so compare by code units
  if (!ok || !roundtrip) fail++;
  console.log(`  [${ok && roundtrip ? 'PASS' : 'FAIL'}] ${name}`);
  if (!long) console.log(`      raw ${q(raw)}\n      out ${q(out)}`);
  else console.log(`      raw ${raw.length} chars, out ${out.length} chars; max option: ${q(printable(raw, { max: 20 }))}`);
}
// the keepNewline mode for multi-line blocks: LF stays, CR and the rest do not
assert.equal(printable('a\nb\rc', { keepNewline: true }), 'a\nb\\rc');
// legit text is untouched
const legit = ['Grüße aus Köln', '日本語のメール', 'Привет, мир', 'שלום עולם', 'مرحبا', 'می‌خواهم', '👨‍👩‍👧 family', '❤️ ok', 'Re: [list] a/b (c) <d@example.org>', 'tab nbsp'];
for (const s of legit) { const o = printable(s); const same = o === s.replace(/\t/g, '\\t'); if (!same) { fail++; console.log('  [FAIL] legit mangled', q(s), q(o)); } }
console.log(`  legit non-ASCII samples kept verbatim: ${legit.length}/${legit.length} (Latin, CJK, Cyrillic, Hebrew, Arabic, Persian ZWNJ, emoji ZWJ, FE0F, NBSP)`);
console.log(`  attack corpus: ${Object.keys(corpus).length} cases, failures: ${fail}`);
assert.equal(fail, 0);

// ---------- 3. --json: what JSON.stringify leaves raw ----------
// (done before the real-mail run so a failure is cheap)
const keptRaw = []; const escaped = [];
const classes = [['C0', 0, 0x1f], ['DEL', 0x7f, 0x7f], ['C1', 0x80, 0x9f], ['bidi 202A-202E', 0x202a, 0x202e], ['bidi 2066-2069', 0x2066, 0x2069],
  ['LRM/RLM/ALM', 0x200e, 0x200f], ['ALM 061C', 0x61c, 0x61c], ['ZW 200B-200D', 0x200b, 0x200d], ['2060-2064', 0x2060, 0x2064], ['FEFF', 0xfeff, 0xfeff], ['2028/2029', 0x2028, 0x2029],
  ['tags E0000-E007F', 0xe0000, 0xe007f], ['lone surrogate', 0xd800, 0xdfff]];
console.log('\n3. --json (JSON.stringify) leaves which classes as raw code points?');
for (const [name, lo, hi] of classes) {
  let raw = 0; let n = 0;
  for (let cp = lo; cp <= hi; cp++) { n++; const j = JSON.stringify(String.fromCodePoint(cp)); if (j.length === 2 + String.fromCodePoint(cp).length && j.slice(1, -1) === String.fromCodePoint(cp)) raw++; }
  console.log(`  ${name.padEnd(18)} ${String(n).padStart(3)} code points, left raw by JSON.stringify: ${raw}`);
  (raw ? keptRaw : escaped).push(name);
}
console.log(`  escaped by JSON: ${escaped.join(', ')}\n  NOT escaped (raw in the output bytes): ${keptRaw.join(', ')}`);
assert.ok(keptRaw.includes('C1') && keptRaw.includes('bidi 202A-202E') && escaped.includes('C0') && escaped.includes('DEL') === false);

// ---------- 2. real mail: counts only ----------
console.log('\n2. REAL MAIL (counts only)');
const home = os.homedir();
const dirs = [...fs.readdirSync(home).filter((n) => n.startsWith('mailproof-m0-samples')).map((n) => path.join(home, n)),
  path.join(home, 'mail-samples/m2-replies'), path.join(home, 'mail-samples/m3-replyfacts')].filter((d) => fs.existsSync(d));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.eml$/i.test(e.name) ? [path.join(d, e.name)] : []);
const seen = new Set(); const files = [];
for (const d of dirs) for (const f of walk(d).sort()) {
  const raw = fs.readFileSync(f); const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (seen.has(sha)) continue; seen.add(sha);
  files.push({ raw, dir: /sent/i.test(d) ? 'out' : 'in' });
}
const { Mailproof } = await import(path.join(root, 'src/index.js'));
const { simpleParser } = await import('mailparser');
const scratch = fs.mkdtempSync(path.join(process.env.M3_SCRATCH || os.tmpdir(), 'm3-termsafe-'));
const stat = { fields: 0, changed: 0, byField: {}, classes: {}, nonAscii: 0 };
const check = (kind, v) => {
  if (v === null || v === undefined || v === '') return;
  stat.fields++;
  stat.byField[kind] ??= { n: 0, changed: 0 };
  stat.byField[kind].n++;
  const s = String(v);
  if (/[^\u0000-\u007f]/.test(s)) stat.nonAscii++;
  if (printable(s) !== s) {
    stat.changed++; stat.byField[kind].changed++;
    const found = dangerousIn(s);
    const key = (c) => `${c} in ${kind}`;
    const per = {};
    for (const c of found) per[c] = (per[c] ?? 0) + 1;
    for (const [c, n] of Object.entries(per)) stat.classes[key(c)] = (stat.classes[key(c)] ?? 0) + n;
  }
};
let recorded = 0;
try {
  const mp = new Mailproof({ trailDir: scratch, worker: { size: 0 } });
  const recs = [];
  for (const x of files) { try { const r = await mp.record(x.raw, { direction: x.dir }); recs.push({ id: r.id, raw: x.raw }); recorded++; } catch { /* counted below */ } }
  const asked = new Set();
  for (const { id, raw } of recs) {
    const rec = await mp.get(id);
    const m = rec.message ?? {};
    check('message_id', m.message_id); check('from(record)', m.from);
    for (const a of rec.addresses ?? []) check(`address(${a.role})`, a.address);
    for (const r of [m.in_reply_to, ...(m.references ?? [])]) check('parent/child message_id', r);
    const parts = await mp.proofParts(rec);
    for (const x of parts?.attachments ?? []) check('attachment filename', x.filename);
    // header fields the CLI does not print today but a future text view might (subject), from the parsed raw email
    const p = await simpleParser(raw);
    check('subject', p.subject);
    // wider legit-text check than the CLI prints: the whole decoded text/plain body (the stress case for the escape set)
    check('decoded text body (extra)', p.text ? p.text.replace(/\r?\n/g, ' ') : '');
    for (const k of ['to', 'cc']) for (const a of p[k]?.value ?? []) { check(k, a.address); check(`${k} display name`, a.name); }
    for (const a of p.from?.value ?? []) check('from display name', a.name);
    if (m.in_reply_to) asked.add(m.in_reply_to);
    for (const r of m.references ?? []) asked.add(r);
  }
  const rids = new Set(); let replyRows = 0;
  for (const mid of asked) {
    let rows = []; try { rows = await mp.replyFacts({ messageId: mid }); } catch { /* none */ }
    for (const r of rows) {
      if (rids.has(r.recordId)) continue; rids.add(r.recordId); replyRows++;
      check('replies from', r.from); check('replies firstLine', r.firstLine); check('replies subject', r.subject); check('replies to', r.to); check('replies cc', r.cc);
    }
  }
  console.log(`  files (distinct bytes) ${files.length}, recorded ${recorded}, distinct replies via replyFacts ${replyRows}`);
  console.log(`  fields checked ${stat.fields}, changed by printable() ${stat.changed}, fields containing any non-ASCII ${stat.nonAscii}`);
  for (const [k, v] of Object.entries(stat.byField).sort()) console.log(`    ${k.padEnd(28)} checked ${String(v.n).padStart(3)}  changed ${v.changed}`);
  const cls = Object.entries(stat.classes).sort();
  console.log(cls.length ? '  triggering classes:\n' + cls.map(([k, n]) => `    ${k} x${n}`).join('\n') : '  triggering classes: none');
  await mp.close();
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

// ---------- 4. bench ----------
console.log('\n4. BENCH: printable() on 10,000 typical fields');
const typical = [];
const rnd = (n) => crypto.randomBytes(n).toString('hex');
for (let i = 0; i < 10000; i++) {
  typical.push(i % 4 === 0 ? `<${rnd(12)}@mail.example.com>` : i % 4 === 1 ? `Person ${i} <p${i}@example.org>` : i % 4 === 2 ? `Re: quarterly numbers ${i} (see attached) - ${rnd(8)}` : `Yes, approved ${rnd(30)}. Please go ahead with the plan as described.${i % 40 === 3 ? ' Grüße 日本' : ''}`);
}
for (let w = 0; w < 5; w++) for (const s of typical) printable(s);
const t0 = process.hrtime.bigint(); let sink = 0; const R = 20;
for (let r = 0; r < R; r++) for (const s of typical) sink += printable(s).length;
const ns = Number(process.hrtime.bigint() - t0) / (R * typical.length);
console.log(`  ${ns.toFixed(0)} ns/op (clean ASCII + 2.5% non-ASCII, mean length ${Math.round(typical.reduce((a, s) => a + s.length, 0) / typical.length)}), checksum ${sink}`);
const dirty = typical.map((s, i) => i % 10 === 0 ? s + '\u001b[1A‮' : s);
const t1 = process.hrtime.bigint(); for (let r = 0; r < R; r++) for (const s of dirty) printable(s);
console.log(`  ${(Number(process.hrtime.bigint() - t1) / (R * dirty.length)).toFixed(0)} ns/op with 10% of fields carrying an escape and a bidi control`);
const big = 'A'.repeat(1 << 20); const t2 = process.hrtime.bigint(); printable(big); console.log(`  1 MiB single field: ${(Number(process.hrtime.bigint() - t2) / 1e6).toFixed(2)} ms`);
