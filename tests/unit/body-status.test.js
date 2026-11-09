// Body status: per-signature `body` + record-level `body_status`, detectors that
// must fire on the synthetic cases below and must NOT fire on clean mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dkimBody } from 'mailauth/lib/dkim/body';
import { analyseBody, summariseBody, canonLines, newBudget } from '../../src/proof/body-status.js';
import { MAX_LINES, MAX_WORK } from '../../src/proof/limits.js';
import { splitMessage, parseTags } from '../../src/proof/signed-headers.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, makeKey } from '../helpers/proof.js';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from '../helpers/tmp.js';
import { recordPath } from '../../src/proof/layout.js';
// Sign at the instant the instance clock is pinned to, so t= equals captured whatever the real date.
const T0 = new Date('2026-11-01T10:00:00Z');

const SPLIT = Buffer.from('\r\n\r\n');
/** Replace the body of a signed raw message (headers, incl. the signature, untouched). */
function withBody(raw, fn) {
  const i = raw.indexOf(SPLIT) + 4;
  return Buffer.concat([raw.subarray(0, i), Buffer.from(fn(raw.subarray(i).toString('binary')), 'binary')]);
}
const addHeaders = (raw, ...h) => Buffer.concat([Buffer.from(h.join('\r\n') + '\r\n'), raw]);
function analyse(raw, ctx = {}) {
  const { rows, body } = splitMessage(raw);
  const sr = rows.find((r) => r.name === 'dkim-signature');
  return analyseBody(parseTags(sr.raw), body, { rows, ...ctx });
}
const kinds = (r) => r.explain.map((e) => e.kind);
const BODY = 'Hello there.\r\nSecond line.\r\n';

for (const canon of ['relaxed/relaxed', 'simple/simple']) {
  test(`clean mail (${canon}): matched, empty explain`, async () => {
    const m = await signedMail({ signTime: T0, body: BODY, canon });
    assert.deepEqual(analyse(m.raw), { status: 'matched', explain: [] });
  });

  test(`appended footer (${canon}): mismatch + appended with the canonical byte count`, async () => {
    const m = await signedMail({ signTime: T0, body: BODY, canon });
    const footer = '\r\n-- \r\nSent via the list\r\nUnsubscribe here\r\n';
    const r = analyse(withBody(m.raw, (b) => b + footer));
    assert.equal(r.status, 'mismatch');
    assert.deepEqual(kinds(r), ['appended']);
    const canonFooter = canon.startsWith('relaxed') ? '\r\n--\r\nSent via the list\r\nUnsubscribe here\r\n' : footer;
    assert.equal(r.explain[0].detail.bytes, canonFooter.length);
    assert.equal(r.explain[0].detail.lines, 4);
  });

  test(`prepended banner (${canon}): mismatch + prepended`, async () => {
    const m = await signedMail({ signTime: T0, body: BODY, canon });
    const r = analyse(withBody(m.raw, (b) => 'CAUTION: external sender\r\n\r\n' + b));
    assert.equal(r.status, 'mismatch');
    assert.deepEqual(kinds(r), ['prepended']);
    assert.equal(r.explain[0].detail.lines, 2);
  });
}

test('l= with extra bytes after the signed prefix: partial + l_tag', async () => {
  const m = await signedMail({ signTime: T0, body: BODY, bodyLength: 13 });
  const r = analyse(withBody(m.raw, (b) => b + 'injected tail\r\n'));
  assert.equal(r.status, 'partial');
  assert.deepEqual(kinds(r), ['l_tag']);
  assert.equal(r.explain[0].detail.signed, 13);
  assert.ok(r.explain[0].detail.unsigned > 0);
});

test('l= covering the whole body: matched, not partial; l= with the signed prefix altered: mismatch, no appended/prepended search', async () => {
  const full = await signedMail({ signTime: T0, body: BODY, bodyLength: BODY.length });
  assert.equal(analyse(full.raw).status, 'matched');
  const m = await signedMail({ signTime: T0, body: BODY, bodyLength: 13 });
  const r = analyse(withBody(m.raw, (b) => 'X' + b));
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(kinds(r), ['unknown']);
});

test('ARC-sealed list message: appended + forwarded + mailing_list, no body text in explain', async () => {
  const m = await signedMail({ signTime: T0, body: BODY });
  const listed = addHeaders(
    withBody(m.raw, (b) => b + '\r\n_______________________________________________\r\nSECRET-FOOTER-TEXT mailing list\r\n'),
    'ARC-Seal: i=1; a=rsa-sha256; t=1; cv=none; d=Relay.Example; s=arc; b=AAAA',
    'ARC-Seal: i=2; a=rsa-sha256; t=2; cv=pass; d=list.example; s=arc; b=BBBB',
    'List-Id: <announce.lists.example.org>',
  );
  const r = analyse(listed, { arc: 'pass' });
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(kinds(r), ['appended', 'forwarded', 'mailing_list']);
  assert.deepEqual(r.explain[1].detail, { sealers: ['relay.example', 'list.example'], arc: 'pass' });
  assert.deepEqual(r.explain[2].detail, { list_id_domain: 'lists.example.org' });
  assert.ok(!JSON.stringify(r).includes('SECRET-FOOTER'));
});

test('hints do not fire without the headers, and clean mail never gets any', async () => {
  const m = await signedMail({ signTime: T0, body: BODY });
  const altered = analyse(withBody(m.raw, (b) => b + 'x\r\n'));
  assert.deepEqual(kinds(altered), ['appended'], 'no ARC-Seal / List-Id, no hints');
  const sealedClean = addHeaders(m.raw, 'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=relay.example; s=arc; b=A', 'List-Id: <l.example.org>');
  assert.deepEqual(analyse(sealedClean), { status: 'matched', explain: [] }, 'matched mail carries no explain even if sealed');
});

test('an edit in the middle is not mistaken for appended/prepended: unknown', async () => {
  const m = await signedMail({ signTime: T0, body: 'one\r\ntwo\r\nthree\r\n' });
  const r = analyse(withBody(m.raw, () => 'one\r\nTWO\r\nthree\r\n'));
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(kinds(r), ['unknown']);
});

test('other canonicalisation and line-ending detectors (bh computed under a different rule)', () => {
  const hashOf = (mode, buf) => { const h = dkimBody(mode, 'sha256', false); h.update(buf); return h.digest('base64'); };
  const body = Buffer.from('a  b \r\nc\r\n');
  const asRelaxed = analyseBody({ a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('relaxed', body) }, body);
  assert.deepEqual(asRelaxed.explain, [{ kind: 'canonicalisation', detail: { signed_as: 'simple', matches_as: 'relaxed' } }]);
  // bh from a CRLF body; the body we hold has lone CRs mailauth would keep as content
  const signedBody = Buffer.from('x\r\ny\r\n');
  const loneCr = Buffer.from('x\ry\r');
  const le = analyseBody({ a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('simple', signedBody) }, loneCr);
  assert.deepEqual(le.explain, [{ kind: 'line_endings', detail: { lone_cr: 2 } }]);
  assert.deepEqual(analyseBody({ a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('simple', body) }, body), { status: 'matched', explain: [] });
});

test('search cap: a footer longer than the cap is not found, search_capped is recorded; a short footer on a huge body still is', async () => {
  const head = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n';
  const m = await signedMail({ signTime: T0, body: head });
  const longFooter = Array.from({ length: MAX_LINES + 50 }, (_, i) => `f${i}`).join('\r\n') + '\r\n';
  const capped = analyse(withBody(m.raw, (b) => b + longFooter));
  assert.equal(capped.status, 'mismatch');
  assert.deepEqual(kinds(capped), ['search_capped', 'unknown']);
  const big = await signedMail({ signTime: T0, body: Array.from({ length: MAX_LINES * 2 }, (_, i) => `row ${i}`).join('\r\n') + '\r\n' });
  const found = analyse(withBody(big.raw, (b) => b + 'footer\r\n'));
  assert.deepEqual(kinds(found), ['appended']);
});

test('summariseBody: best over the signatures that verify, else over all, else not-checked', () => {
  const s = (status) => ({ body: { status, explain: [] } });
  assert.equal(summariseBody([s('matched'), s('mismatch')], [false, true]), 'mismatch');
  assert.equal(summariseBody([s('matched'), s('partial')], [true, true]), 'matched');
  assert.equal(summariseBody([s('partial'), s('mismatch')], [false, false]), 'partial');
  assert.equal(summariseBody([], []), 'not-checked');
});

test('canonLines reproduces mailauth canonicalisation (hash over many shapes)', () => {
  const bodies = ['', '\r\n', 'a', 'a\r\n', 'a\r\n\r\n\r\n', '  a \t b  \r\n \r\nc\t\r\n\r\n', 'x\r\n\r\ny', '\r\n\r\nz\r\n'];
  bodies.push('a\nb\n'); // bare LF: relaxed only (simple keeps it as content)
  for (const mode of ['simple', 'relaxed']) for (const b of bodies) {
    if (mode === 'simple' && b === 'a\nb\n') continue;
    const buf = Buffer.from(b);
    const h = dkimBody(mode, 'sha256', false); h.update(buf);
    const lines = canonLines(buf, mode);
    const bytes = Buffer.from(lines.length ? lines.map((l) => l + '\r\n').join('') : (mode === 'simple' ? '\r\n' : ''), 'binary');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('base64'), h.digest('base64'), `${mode} ${JSON.stringify(b)}`);
  }
});

test('record()/check(): body_status stored per record, trust verdicts untouched, no body text on disk', async () => {
  const dir = makeTmpDir('mp-body-');
  const m = await signedMail({ signTime: T0, body: BODY });
  const altered = withBody(m.raw, (b) => b + 'LEAKY-FOOTER-TEXT\r\n');
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, now: () => new Date('2026-11-01T10:00:00Z') });
  const chk = await mp.check(altered);
  assert.equal(chk.body_status, 'mismatch');
  assert.deepEqual(chk.body[0].explain.map((e) => e.kind), ['appended']);
  assert.equal(chk.portable.trust, 'verified', 'headers are valid: the trust verdict does not move');
  const clean = await mp.record(m.raw, { direction: 'in' });
  assert.equal(clean.record.body_status, 'matched');
  assert.deepEqual(clean.record.signatures[0].body, { status: 'matched', explain: [] });
  const bad = await new Mailproof({ trailDir: dir, trail: 'alt', resolver: m.resolver, now: () => new Date('2026-11-01T10:00:00Z') }).record(altered, { direction: 'in' });
  assert.equal(bad.record.body_status, 'mismatch');
  assert.equal(bad.record.verdicts.portable.trust, 'verified');
  const onDisk = fs.readFileSync(path.join(dir, 'alt', recordPath(bad.id)), 'utf8');
  assert.ok(!onDisk.includes('LEAKY-FOOTER'));
  const unsigned = await mp.check(Buffer.from('From: a@x.example\r\n\r\nhi\r\n'));
  assert.equal(unsigned.body_status, 'not-checked');
});

// ---- one work budget per message --------------------------------------------------------------------
// The mismatch search used to get MAX_WORK per SIGNATURE, so 10 signatures on one tampered body cost 10x
// one search. Now the signatures of a message draw on one budget (`ctx.budget`).
test('work budget: a search the budget cannot cover is skipped and reported as search_capped; the status is the same', async () => {
  const m = await signedMail({ signTime: T0, body: BODY });
  const banner = withBody(m.raw, (b) => 'EXTERNAL BANNER\r\nLine two\r\n' + b);
  const full = analyse(banner);
  assert.deepEqual(kinds(full), ['prepended']);
  const starved = analyse(banner, { budget: { left: 10 } });
  assert.equal(starved.status, full.status, 'the budget never changes the status');
  assert.deepEqual(kinds(starved), ['search_capped', 'unknown']);
  assert.deepEqual(starved.explain[0].detail, { max_lines: MAX_LINES, max_bytes: 2 * 1024 * 1024, max_work_bytes: MAX_WORK });
});

test('work budget: the signatures of one message share it; a budget of exactly one search leaves none for the next', async () => {
  const m = await signedMail({ signTime: T0, body: BODY });
  const banner = withBody(m.raw, (b) => 'EXTERNAL BANNER\r\nLine two\r\n' + b);
  const probe = newBudget();
  analyse(banner, { budget: probe });
  const used = MAX_WORK - probe.left;
  assert.ok(used > 0 && used < MAX_WORK, `one search takes ${used} bytes of work`);
  const shared = { left: used };
  assert.deepEqual(kinds(analyse(banner, { budget: shared })), ['prepended'], 'the first signature gets its search');
  assert.equal(shared.left, 0);
  assert.deepEqual(kinds(analyse(banner, { budget: shared })), ['search_capped', 'unknown'], 'the second gets none');
  // with no budget given each analysis gets a fresh one (a signature analysed on its own)
  assert.deepEqual(kinds(analyse(banner)), ['prepended']);
  assert.deepEqual(kinds(analyse(banner)), ['prepended']);
});

test('work budget: 10 valid signatures on one tampered body: the later ones are capped, every verdict is unchanged', async () => {
  const signers = Array.from({ length: 10 }, (_, i) => ({ domain: 'signer.example', selector: `s${i}`, key: makeKey('rsa') }));
  const body = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(150)}`).join('\r\n') + '\r\n';
  const m = await signedMail({ signTime: T0, body, signers });
  const raw = Buffer.from(m.raw);
  raw[raw.length - 5000] ^= 1;                                  // alter the body: every bh= now mismatches
  const mp = new Mailproof({ trailDir: makeTmpDir('mp-wb-'), resolver: m.resolver, now: () => T0 });
  const c = await mp.check(raw);
  assert.equal(c.body_status, 'mismatch');
  assert.deepEqual(c.body.map((b) => b.status), Array(10).fill('mismatch'));
  const capped = c.body.map((b) => b.explain.some((e) => e.kind === 'search_capped'));
  assert.equal(capped.filter(Boolean).length >= 8, true, `the budget runs out early: ${capped.map(Number).join('')}`);
  assert.equal(capped[9], true);
  assert.equal(c.portable.trust, 'verified', 'the signed headers are fine: the body search cannot move a verdict');
  assert.equal(c.live.trust, 'unverified', 'mailauth fails the altered body on its own, whatever the search did');
});

// The budget governs only the super-linear appended/prepended searches. The canonicalisation and
// line-ending detectors are one linear pass each and must still run on a message whose budget is gone,
// and on a body big enough that its own prepended search used the whole budget.
test('work budget: the linear detectors (canonicalisation, line_endings) are never starved by it', () => {
  const hashOf = (mode, buf) => { const h = dkimBody(mode, 'sha256', false); h.update(buf); return h.digest('base64'); };
  const line = 'The quick brown fox jumps over the lazy dog and keeps going for a while longer';
  // ~200 KB of ~80-byte lines, signed simple/simple, then a trailing space added to every line: only relaxed matches
  const signed = Buffer.from(Array(2500).fill(line).join('\r\n') + '\r\n');
  const spaced = Buffer.from(Array(2500).fill(line + ' ').join('\r\n') + '\r\n');
  assert.ok(spaced.length >= 200_000);
  const tags = { a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('relaxed', spaced) };
  const canon = [{ kind: 'canonicalisation', detail: { signed_as: 'simple', matches_as: 'relaxed' } }];
  assert.deepEqual(analyseBody(tags, spaced).explain, canon, 'fresh budget: its own prepended search must not use it all up');
  assert.deepEqual(analyseBody(tags, spaced, { budget: { left: 0 } }).explain, canon, 'budget already gone');
  // lone CRs for the line breaks; bh from the CRLF original
  const loneCr = Buffer.from(signed.toString('binary').replace(/\r\n/g, '\r'), 'binary');
  const le = [{ kind: 'line_endings', detail: { lone_cr: 2500 } }];
  const crTags = { a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('simple', signed) };
  assert.deepEqual(analyseBody(crTags, loneCr).explain, le);
  assert.deepEqual(analyseBody(crTags, loneCr, { budget: { left: 0 } }).explain, le, 'budget already gone');
  // the searches themselves are still capped by an empty budget (nothing found by them, so the cap is reported)
  const none = analyseBody({ a: 'rsa-sha256', c: 'simple/simple', bh: hashOf('simple', Buffer.from('other\r\n')) }, spaced, { budget: { left: 0 } });
  assert.deepEqual(kinds(none), ['search_capped', 'unknown']);
});

// ---- findAppended: the two spots no other test pins ---------------------------------------------------
test('appended: a signed body that was empty and had everything appended is explained as appended (the empty-prefix case)', async () => {
  const m = await signedMail({ signTime: T0, body: '' });
  assert.deepEqual(analyse(m.raw), { status: 'matched', explain: [] });
  const r = analyse(withBody(m.raw, () => 'Added by a relay\r\nSecond line\r\n'));
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(kinds(r), ['appended']);
  assert.deepEqual(r.explain[0].detail, { bytes: 'Added by a relay\r\nSecond line\r\n'.length, lines: 2 });
});

test('work budget: the appended search is charged its own bytes: a budget that covers only the line split leaves it capped', async () => {
  const m = await signedMail({ signTime: T0, body: BODY });
  const tampered = withBody(m.raw, (b) => b + 'Footer one\r\nFooter two\r\n');
  assert.deepEqual(kinds(analyse(tampered)), ['appended'], 'with its full budget the footer is found');
  const bodyLen = splitMessage(tampered).body.length;
  const starved = analyse(tampered, { budget: { left: bodyLen } });   // enough for the line split, none left for hashing the lines
  assert.deepEqual(kinds(starved), ['search_capped', 'unknown']);
});
