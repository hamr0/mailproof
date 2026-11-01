// Linear-time parsing of sender-controlled text in src/proof. Each helper is checked
// against the regex it replaced (kept here ONLY as the oracle) over generated
// inputs, and each is timed through the public path with a 1 MB adversarial input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimTrailingWs } from '../../src/proof/body-status.js';
import { extractAddresses, verifyRecord } from '../../src/proof/recheck.js';
import { listIdInner } from '../../src/proof/relay.js';
import { Mailproof } from '../../src/index.js';
import { signedMail, recordOf } from '../helpers/proof.js';

// --- oracles: the regexes the linear code replaced ---------------------------
const oracleTrim = (l) => l.replace(/[ \t]+$/, '');
const oracleAddresses = (v) => v.match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g) || [];
const oracleListId = (v) => /<([^>]*)>/.exec(v)?.[1] ?? v;

/** Deterministic generator (mulberry32) so a failure reproduces. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALPHABET = ['a', 'b', 'c', '@', '@', '<', '>', ' ', ' ', '\t', ',', ';', '"', '(', ')', '.', 'x@y', ' ', '\r', '\n', 'é'];
function gen(rand, maxLen) {
  const n = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}
function corpus(seed, count, maxLen, edge) {
  const rand = rng(seed);
  const out = [...edge];
  for (let i = 0; i < count; i++) out.push(gen(rand, maxLen));
  return out;
}

test('trimTrailingWs matches the regex it replaced (generated + edge inputs)', () => {
  const edge = ['', ' ', '\t', ' \t ', 'a', 'a ', 'a \t', ' a', 'a b', 'a  b  ', 'a\r', 'a \r', 'a ', '\t\t\tx\t\t\t'];
  const inputs = corpus(1, 500, 14, edge);
  for (const s of inputs) assert.equal(trimTrailingWs(s), oracleTrim(s), JSON.stringify(s));
  assert.ok(inputs.length >= 500);
});

test('extractAddresses matches the regex it replaced (generated + edge inputs, multiple @)', () => {
  const edge = ['', '@', 'a@', '@a', 'a@b', 'a@b@c', 'a@b@', '@@', '@@@', 'a@@b', '@a@', 'a@b@c@d', 'x <a@b>', 'a@b, c@d', 'A <a@b> ; "q@r" (s@t)', '(a@b)', 'a@b c@d\te@f', 'a @b', 'é@ü', '@a@b', 'a@b@@', ' a@b ', '"a@b"', 'a@b<c@d>e@f'];
  const inputs = corpus(2, 800, 16, edge);
  let withMatch = 0;
  for (const s of inputs) {
    const got = extractAddresses(s);
    assert.deepEqual(got, oracleAddresses(s), JSON.stringify(s));
    if (got.length) withMatch++;
  }
  assert.ok(withMatch > 100, 'the corpus must exercise the matching path, not only the empty one');
});

test('listIdInner matches the regex it replaced (generated + edge inputs)', () => {
  const edge = ['', '<', '>', '<>', '<a>', 'x <a.b> y', '<<a>', '<a<b>', '<a>>', '><', '>a<', '<a', 'a>', '<<<', '<a> <b>', 'name <list.example.org>', 'plain.example.org', '<a>\n<b>'];
  const inputs = corpus(3, 800, 14, edge);
  for (const s of inputs) assert.equal(listIdInner(s), oracleListId(s), JSON.stringify(s));
});

// --- timing: 1 MB adversarial inputs through the public path -----------------
const MB = 1_000_000;   // just under mailsplit's 1 MiB header cap, so a header can be this big
const LIMIT_MS = 500;
const SPLIT = Buffer.from('\r\n\r\n');
const trailDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-linear-'));
async function timed(f) { const t = performance.now(); await f(); return performance.now() - t; }

// record() also runs mailauth and mailsplit over the same bytes, and their parsing sets a
// ~0.4-0.7 s floor for a 1 MB message that is not ours (a benign 1 MB header costs that
// much too). So record() is asserted RELATIVE to a benign control of the same size, run
// first in the same test (it also warms the process): adversarial < 3 x control + 500 ms.
// The pre-fix regexes take minutes at this size, so the ratio still catches a regression.
const slack = (control) => 3 * control + LIMIT_MS;
async function recordMs(m, raw) {
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  let r;
  const ms = await timed(async () => { r = await mp.record(raw, { direction: 'in', source: 't' }); });
  return { ms, r };
}

test('record(): a 1 MB body line with a long space run and a bogus bh costs about what a benign 1 MB line does', async () => {
  const m = await signedMail({ body: 'x\r\n' });
  const i = m.raw.indexOf(SPLIT) + 4;
  const withBody = (b) => Buffer.concat([m.raw.subarray(0, i), Buffer.from(b)]);
  const control = await recordMs(m, withBody('a'.repeat(MB) + '\r\n'));
  // Spaces that do not end the line: the old `[ \t]+$` rescanned the run from every start.
  const adv = await recordMs(m, withBody('a' + ' '.repeat(MB) + 'b\r\n'));
  assert.equal(adv.r.record.body_status, 'mismatch', 'the mismatch path really ran');
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});

test('verifyRecord(): a 1 MB signed From with no @ resolves in < 500 ms; record() costs about what a benign 1 MB From does', async () => {
  const m = await signedMail({ body: 'x\r\n', from: 'a'.repeat(MB) });
  const rec = recordOf(m.raw, m.signers);
  let v;
  const ms = await timed(() => { v = verifyRecord(rec); });
  assert.equal(v.signatures[0].ok, true, 'the signature verified, so From alignment ran');
  assert.equal(v.signatures[0].aligned, false);
  assert.ok(ms < LIMIT_MS, `verifyRecord took ${Math.round(ms)} ms`);
  const benign = await signedMail({ body: 'x\r\n', from: 'a'.repeat(MB - 10) + '@x.example' });
  const control = await recordMs(benign, benign.raw);
  const adv = await recordMs(m, m.raw);
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});

test('record(): a 1 MB List-Id of "<" characters costs about what a benign 1 MB List-Id does', async () => {
  const benign = await signedMail({ body: 'x\r\n', extraHeaders: ['List-Id: ' + 'a'.repeat(MB)] });
  const control = await recordMs(benign, benign.raw);
  const m = await signedMail({ body: 'x\r\n', extraHeaders: ['List-Id: ' + '<'.repeat(MB)] });
  const adv = await recordMs(m, m.raw);
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});
