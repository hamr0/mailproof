// Linear-time parsing of sender-controlled text in src/proof. Each helper is checked
// against the regex it replaced (kept here ONLY as the oracle) over generated
// inputs, and each is timed through the public path with an adversarial input as large as the
// admission gate lets through (1 MB for the entry points that have no gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trimTrailingWs } from '../../src/proof/body-status.js';
import { extractAddresses, verifyRecord } from '../../src/proof/recheck.js';
import { listIdInner } from '../../src/proof/relay.js';
import { parseOtsBlockHeight, createOts } from '../../src/proof/ots.js';
import { Mailproof } from '../../src/index.js';
import { signedMail, recordOf } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

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

// parseOtsBlockHeight: the whole function as it was (three regexes), as the oracle.
function oracleOtsHeight(stdout) {
  if (!stdout) return null;
  const patterns = [
    /Bitcoin\s+block\s+(?:height\s+)?(\d+)/i,
    /Block\s+height[:\s]+(\d+)/i,
    /BitcoinBlockHeaderAttestation[^]*?\b(\d{6,})\b/i,
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

test('parseOtsBlockHeight matches the three-regex original (generated + edge inputs)', () => {
  const NODE = 'BitcoinBlockHeaderAttestation';
  const toks = [NODE, NODE.toLowerCase(), '123456', '12345', '1234567', '000000', '0', 'a', '_', ' ', '\n', '(', ')', ':', 'Bitcoin block ', 'Bitcoin  block  height ', 'Block height: ', 'Block height', '850123', 'x9', '9x'];
  const edge = ['', NODE, NODE + '123456', NODE + ' 123456', NODE + '(862500)', 'a' + NODE + '1', NODE + '12345 ' + NODE + ' 999999', NODE + ' 000000 123456', NODE + ' 123456a 654321', 'Bitcoin block 850123 ' + NODE + ' 111111', NODE + '_123456 7654321'];
  const rand = rng(4);
  const inputs = [...edge];
  for (let i = 0; i < 800; i++) {
    let v = '';
    for (let j = Math.floor(rand() * 9); j > 0; j--) v += toks[Math.floor(rand() * toks.length)];
    inputs.push(v);
  }
  let hits = 0;
  for (const v of inputs) {
    const got = parseOtsBlockHeight(v);
    assert.equal(got, oracleOtsHeight(v), JSON.stringify(v));
    if (got !== null) hits++;
  }
  assert.ok(hits > 100, 'the corpus must reach the attestation branch');
});

// --- timing: 1 MB adversarial inputs through the public path -----------------
const MB = 1_000_000;   // the offline entry points (verifyRecord, readBlockHeight) have no admission gate: 1 MB is fair game there
const FIT = 250_000;    // just under the gate's 256 KiB header block and body line: the biggest a record() input can be
const LIMIT_MS = 500;
const SPLIT = Buffer.from('\r\n\r\n');
const trailDir = () => makeTmpDir('mp-linear-');
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

test('record(): a body line at the 256 KiB limit with a long space run and a bogus bh costs about what a benign one does', async () => {
  const m = await signedMail({ body: 'x\r\n' });
  const i = m.raw.indexOf(SPLIT) + 4;
  const withBody = (b) => Buffer.concat([m.raw.subarray(0, i), Buffer.from(b)]);
  const control = await recordMs(m, withBody('a'.repeat(FIT) + '\r\n'));
  // Spaces that do not end the line: the old `[ \t]+$` rescanned the run from every start.
  const adv = await recordMs(m, withBody('a' + ' '.repeat(FIT) + 'b\r\n'));
  assert.equal(adv.r.record.body_status, 'mismatch', 'the mismatch path really ran (the gate admitted the line)');
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});

test('verifyRecord(): a 1 MB signed From with no @ resolves in < 500 ms; record() at the header limit costs about what a benign From does', async () => {
  const m = await signedMail({ body: 'x\r\n', from: 'a'.repeat(MB) });
  const rec = recordOf(m.raw, m.signers);
  let v;
  const ms = await timed(() => { v = verifyRecord(rec); });
  assert.equal(v.signatures[0].ok, true, 'the signature verified, so From alignment ran');
  assert.equal(v.signatures[0].aligned, false);
  assert.ok(ms < LIMIT_MS, `verifyRecord took ${Math.round(ms)} ms`);
  const benign = await signedMail({ body: 'x\r\n', from: 'a'.repeat(FIT - 10) + '@x.example' });
  const control = await recordMs(benign, benign.raw);
  const fit = await signedMail({ body: 'x\r\n', from: 'a'.repeat(FIT) });
  const adv = await recordMs(fit, fit.raw);
  assert.equal('reason' in adv.r.record.verdicts.portable, false, 'admitted, so the From was really read');
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});

test('record(): a List-Id of "<" characters at the 256 KiB header limit costs about what a benign one does', async () => {
  const benign = await signedMail({ body: 'x\r\n', extraHeaders: ['List-Id: ' + 'a'.repeat(FIT)] });
  const control = await recordMs(benign, benign.raw);
  const m = await signedMail({ body: 'x\r\n', extraHeaders: ['List-Id: ' + '<'.repeat(FIT)] });
  const adv = await recordMs(m, m.raw);
  assert.equal('reason' in adv.r.record.verdicts.portable, false, 'admitted, so the List-Id was really read');
  assert.ok(adv.ms < slack(control.ms), `adversarial ${Math.round(adv.ms)} ms vs control ${Math.round(control.ms)} ms`);
});

test('readBlockHeight(): 1 MB of attestation nodes with no 6-digit run is parsed in < 500 ms (the old regex rescanned per node)', async () => {
  const dir = makeTmpDir('mp-ots-');
  const bin = path.join(dir, 'ots');
  fs.writeFileSync(bin, `#!/bin/sh\nyes 'BitcoinBlockHeaderAttestation 12345 ' | head -c ${MB}\n`, { mode: 0o755 });
  const ots = createOts({ otsBin: bin, timeoutMs: 20000 });
  let h;
  const control = await timed(async () => { await ots.readBlockHeight(bin); });   // also warms spawn
  const ms = await timed(async () => { h = await ots.readBlockHeight(bin); });
  assert.equal(h, null);
  assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms (first run ${Math.round(control)} ms)`);
});
