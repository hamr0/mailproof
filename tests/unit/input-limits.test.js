// The four input limits (SPEC Part B, "Limits"), each at the limit and at limit+1:
//   signatures per message  MAX_SIGNATURES   = 10    (tests/unit/signature-cap.test.js)
//   names in one h=         MAX_H_NAMES      = 200   -> signature not evaluated, key_error 'h= too long'
//   header fields           MAX_HEADER_FIELDS = 1000 -> recorded, not verified, reason on both verdicts
//   header block            1 MiB                    -> rejected by mailsplit (EMAXLEN), not recorded
// The rejected paths must do no DNS at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof, verifyRecord } from '../../src/index.js';
import { splitMessage, MAX_H_NAMES, MAX_HEADER_FIELDS, dropExtraSignatures } from '../../src/proof/signed-headers.js';
import { signedMail } from '../helpers/proof.js';

const trailDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lim-'));
const BASE = ['from', 'to', 'subject', 'date', 'message-id'];
/** signedMail options for a signature whose h= lists exactly `n` names, all of them real headers. */
const withNames = (n, extra = {}) => ({
  headerList: [...BASE, ...Array.from({ length: n - BASE.length }, (_, i) => `x-o${i}`)],
  extraHeaders: Array.from({ length: n - BASE.length }, (_, i) => `X-O${i}: v`),
  ...extra,
});

/** Wrap a resolver so every DNS question (any type) is logged. */
function counting(inner) {
  const calls = [];
  return { fn: async (name, type) => { calls.push(`${type || 'TXT'} ${name}`); return inner(name, type); }, calls };
}
const nxdomain = async () => { throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); };

test('limits are 200 and 1000', () => {
  assert.equal(MAX_H_NAMES, 200);
  assert.equal(MAX_HEADER_FIELDS, 1000);
});

test('h= with exactly 200 names is evaluated and verifies', async () => {
  const m = await signedMail(withNames(200));
  const { fn, calls } = counting(m.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const c = await mp.check(m.raw);
  assert.equal(c.signatures, 1);
  assert.deepEqual(c.key_errors, []);
  assert.equal(c.portable.trust, 'verified');
  assert.ok(calls.some((x) => x.includes('._domainkey.')), 'the key was fetched');
});

test('h= with 201 names is not evaluated: no key fetch, a failing entry, never verified', async () => {
  const m = await signedMail(withNames(201));
  const { fn, calls } = counting(m.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const c = await mp.check(m.raw);
  assert.deepEqual(calls.filter((x) => x.includes('._domainkey.')), [], 'no key fetch');
  assert.equal(c.signatures, 1);
  assert.deepEqual(c.key_errors, ['h= too long']);
  assert.equal(c.portable.trust, 'unverified');
  assert.notEqual(c.live.trust, 'verified', 'mailauth never saw the signature');
  assert.equal(c.body_status, 'not-checked');
  assert.deepEqual(c.body, [{ status: 'not-checked', explain: [] }]);

  const r = await mp.record(m.raw, { direction: 'in', source: 't' });
  const rec = await mp.get(r.id);
  const s = rec.signatures[0];
  assert.deepEqual([s.key, s.key_file, s.signed_headers, s.tags.h], [null, null, [], null]);
  assert.equal(s.key_error, 'h= too long');
  const v = await mp.verify(r.id);
  assert.equal(v.ok, false);
  assert.equal(v.signatures[0].why, 'h= too long');
  assert.equal(verifyRecord(rec).signatures[0].why, 'h= too long');
});

test('an h=-too-long signature cannot upgrade a verdict: it never verifies, and does not disturb a good signature beside it', async () => {
  const bad = await signedMail(withNames(250, { selector: 'bad' }));
  const good = await signedMail({ selector: 'good' });
  const badSig = splitMessage(bad.raw).rows.find((r) => r.name === 'dkim-signature').raw;
  const mixed = Buffer.concat([Buffer.from(badSig + '\r\n', 'binary'), good.raw]);
  const resolver = async (n, t) => (n.startsWith('bad.') ? bad.resolver(n, t) : good.resolver(n, t));
  const { fn, calls } = counting(resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const c = await mp.check(mixed);
  assert.equal(c.signatures, 2);
  assert.deepEqual(c.key_errors, ['h= too long']);
  assert.equal(c.portable.trust, 'verified', 'decided by the good signature alone');
  assert.deepEqual(calls.filter((x) => x.includes('bad._domainkey')), []);
  const alone = await mp.check(bad.raw);
  assert.equal(alone.portable.trust, 'unverified');
  assert.notEqual(alone.live.trust, 'verified');
});

test('dropExtraSignatures removes a signature whose h= is over the limit, keeps one at the limit', async () => {
  const at = await signedMail(withNames(200));
  const over = await signedMail(withNames(201));
  assert.equal(dropExtraSignatures(at.raw), at.raw, 'at the limit: same buffer');
  const out = dropExtraSignatures(over.raw);
  assert.notEqual(out, over.raw);
  assert.equal(splitMessage(out).rows.filter((r) => r.name === 'dkim-signature').length, 0);
  assert.equal(splitMessage(out).rows.length, splitMessage(over.raw).rows.length - 1, 'only the signature is gone');
});

/** A signed mail padded with extra headers (not in h=, so the signature still holds) to exactly `n` header fields. */
async function withFields(n) {
  const m = await signedMail({});
  const have = splitMessage(m.raw).rows.length;
  const pad = Array.from({ length: n - have }, (_, i) => `X-Pad-${i}: v`).join('\r\n') + '\r\n';
  const raw = Buffer.concat([Buffer.from(pad), m.raw]);
  assert.equal(splitMessage(raw).rows.length, n);
  return { raw, resolver: m.resolver };
}

test('exactly 1000 header fields: evaluated and verified', async () => {
  const m = await withFields(MAX_HEADER_FIELDS);
  const { fn, calls } = counting(m.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const c = await mp.check(m.raw);
  assert.equal(c.portable.trust, 'verified');
  assert.equal(c.live.trust, 'verified');
  assert.equal('reason' in c.portable, false);
  assert.ok(calls.length > 0);
});

test('1001 header fields: recorded, unverifiable, reason on both verdicts, no DNS, never throws', async () => {
  const m = await withFields(MAX_HEADER_FIELDS + 1);
  const { fn, calls } = counting(m.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const c = await mp.check(m.raw);
  assert.equal(calls.length, 0, `DNS asked: ${calls.join(', ')}`);
  assert.equal(c.live.trust, 'unverified');
  assert.equal(c.portable.trust, 'unverified');
  assert.equal(c.live.reason, 'too many header fields');
  assert.equal(c.portable.reason, 'too many header fields');
  assert.equal(c.body_status, 'not-checked');
  assert.equal(c.signatures, 0);
  assert.equal(c.signatures_skipped, 1, 'the signature is counted, not evaluated');
  assert.equal(c.unsigned, false, 'a signed message is not reported as unsigned');

  const r = await mp.record(m.raw, { direction: 'in', source: 't' });   // accept-and-flag: committed
  assert.equal(r.duplicate, false);
  assert.equal(calls.length, 0);
  const rec = await mp.get(r.id);
  assert.equal(rec.body_status, 'not-checked');
  assert.deepEqual(rec.signatures, []);
  assert.equal(rec.signatures_skipped, 1);
  assert.equal(rec.verdicts.live.reason, 'too many header fields');
  assert.equal((await mp.verify(r.id)).ok, false);
});

test('a message of 1001 header fields with no signature is recorded the same way', async () => {
  const calls = counting(nxdomain);
  const raw = Buffer.from([...Array.from({ length: MAX_HEADER_FIELDS }, (_, i) => `X-${i}: v`), 'From: a@b.example', '', 'hi', ''].join('\r\n'));
  const mp = new Mailproof({ trailDir: trailDir(), resolver: calls.fn });
  const c = await mp.check(raw);
  assert.equal(c.portable.reason, 'too many header fields');
  assert.equal(calls.calls.length, 0);
  assert.equal('signatures_skipped' in c, false);
});

test('header block over 1 MiB (mailsplit EMAXLEN) is rejected, not recorded; no DNS', async () => {
  const calls = counting(nxdomain);
  const sig = 'DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA';
  const raw = Buffer.from([sig, 'From: a@b.example', `X-Big: ${'a'.repeat(1024 * 1024 + 10)}`, '', 'hi', ''].join('\r\n'));
  const mp = new Mailproof({ trailDir: trailDir(), resolver: calls.fn });
  await assert.rejects(mp.record(raw, { direction: 'in', source: 't' }), (e) => e.code === 'EMAXLEN');
  await assert.rejects(mp.check(raw), (e) => e.code === 'EMAXLEN');
  await new Promise((r) => setTimeout(r, 200));   // anything started in the background would show by now
  assert.deepEqual(calls.calls, [], 'no DNS asked');
  assert.equal((await mp.list()).length, 0);
});
