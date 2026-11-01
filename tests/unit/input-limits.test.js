// The input limits (SPEC Part B, "Limits"; src/proof/limits.js), each JUST UNDER (admitted: the message is
// verified as before) and JUST OVER (recorded, but unverified with `over limit: <name>`; mailauth and
// mailparser never run on it, no DNS is asked, nothing throws).
//
// "Never parsed" is asserted three ways, because mailauth and mailparser cannot be stubbed from here:
//   - a resolver that counts every DNS question (mailauth is the only thing that asks any): zero;
//   - the record has `message_id: null` although the raw bytes carry a Message-ID header (mailparser
//     would have read it);
//   - a header block over 1 MiB, which mailparser rejects with EMAXLEN, is recorded without error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof, hashDocument, verifyRecord } from '../../src/index.js';
import { admit, overLimitReason } from '../../src/proof/admit.js';
import {
  MAX_TOTAL_BYTES, MAX_HEADER_BYTES, MAX_HEADER_LINES, MAX_HEADER_FIELDS, MAX_SIGNATURES, MAX_H_NAMES,
  MAX_SIG_BYTES, MAX_MIME_PARTS, MAX_BODY_LINE,
} from '../../src/proof/limits.js';
import { splitMessage } from '../../src/proof/signed-headers.js';
import { signedMail, makeKey } from '../helpers/proof.js';

const trailDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lim-'));
const BASE = ['from', 'to', 'subject', 'date', 'message-id'];

/** Wrap a resolver so every DNS question (any type) is logged. */
function counting(inner) {
  const calls = [];
  return { fn: async (name, type) => { calls.push(`${type || 'TXT'} ${name}`); return inner(name, type); }, calls };
}
const nxdomain = async () => { throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); };

/** signedMail options for a signature whose h= lists exactly `n` names, all of them real headers. */
const withNames = (n, extra = {}) => ({
  headerList: [...BASE, ...Array.from({ length: n - BASE.length }, (_, i) => `x-o${i}`)],
  extraHeaders: Array.from({ length: n - BASE.length }, (_, i) => `X-O${i}: v`),
  ...extra,
});

/**
 * One builder per limit: `build(over)` -> a signed message (verifies against its resolver) exactly AT the
 * limit (`over` false) or exactly one unit above it. The size knobs are calibrated against the gate's own
 * measurement of the unpadded message, so "at the limit" means the gate's number equals the limit.
 */
const CASES = {
  header_bytes: async (over) => {
    const m = await signedMail({});
    const pad = MAX_HEADER_BYTES - admit(m.raw).m.headerBytes - 'X-Pad: \r\n'.length + (over ? 1 : 0);
    return signedMail({ extraHeaders: [`X-Pad: ${'a'.repeat(pad)}`] });
  },
  header_lines: async (over) => {
    const m = await signedMail({ extraHeaders: ['X-Pad: a'] });
    const folds = MAX_HEADER_LINES - admit(m.raw).m.headerLines + (over ? 1 : 0);
    return signedMail({ extraHeaders: ['X-Pad: a' + ' \r\n b'.repeat(folds)] });
  },
  header_fields: async (over) => {
    const m = await signedMail({});
    const n = MAX_HEADER_FIELDS - admit(m.raw).m.headerFields + (over ? 1 : 0);
    return signedMail({ extraHeaders: Array.from({ length: n }, (_, i) => `X-F${i}: v`) });
  },
  signatures: (over) => signedMail({ signers: Array.from({ length: MAX_SIGNATURES + (over ? 1 : 0) }, (_, i) => ({ domain: 'signer.example', selector: `s${i}`, key: makeKey('rsa') })) }),
  h_names: (over) => signedMail(withNames(MAX_H_NAMES + (over ? 1 : 0))),
  sig_bytes: async (over) => {
    const m = await signedMail({});
    // whitespace inside b= is folding space to a verifier, so padding there leaves the signature valid
    const grow = (k) => Buffer.from(m.raw.toString('binary').replace(/(\bb=[A-Za-z0-9+/]{4})/, `$1${' '.repeat(k)}`), 'binary');
    const k = MAX_SIG_BYTES - admit(m.raw).m.maxSigBytes + (over ? 1 : 0);
    return { ...m, raw: grow(k) };
  },
  mime_parts: (over) => signedMail({ body: Array.from({ length: MAX_MIME_PARTS + (over ? 1 : 0) }, (_, i) => `--part${i}`).join('\r\n') + '\r\n' }),
  body_line: (over) => signedMail({ body: 'a'.repeat(MAX_BODY_LINE + (over ? 1 : 0)) + '\r\n' }),
};

for (const [limit, build] of Object.entries(CASES)) {
  test(`${limit}: at the limit the message is admitted and verified; one over it is recorded unverified, never parsed`, async () => {
    const at = await build(false);
    assert.deepEqual(admit(at.raw).limit, null, 'admitted at the limit');
    const { fn, calls } = counting(at.resolver);
    const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
    const ok = await mp.check(at.raw);
    assert.equal(ok.portable.trust, 'verified', 'verified as before');
    assert.equal(ok.live.trust, 'verified');
    assert.equal('reason' in ok.portable, false);
    assert.equal(ok.body_status, 'matched');
    assert.ok(ok.signatures >= 1);
    assert.ok(calls.length > 0, 'DNS was asked');

    const over = await build(true);
    assert.equal(admit(over.raw).limit, limit, 'refused one over the limit, for that limit');
    const dns = counting(over.resolver);
    const mp2 = new Mailproof({ trailDir: trailDir(), resolver: dns.fn });
    const c = await mp2.check(over.raw);
    assert.equal(dns.calls.length, 0, `DNS asked: ${dns.calls.join(', ')}`);
    assert.equal(c.live.trust, 'unverified');
    assert.equal(c.portable.trust, 'unverified');
    assert.equal(c.live.reason, `over limit: ${limit}`);
    assert.equal(c.portable.reason, `over limit: ${limit}`);
    assert.equal(c.signatures, 0);
    assert.equal(c.unsigned, false, 'not looked at, so not reported as unsigned');
    assert.equal(c.body_status, 'not-checked');
    assert.deepEqual([c.key_errors, c.body], [[], []]);
    assert.equal('signatures_skipped' in c, false);

    // accept-with-flag: committed, with only what the bytes give without a parser
    const r = await mp2.record(over.raw, { direction: 'in', source: 't' });
    assert.equal(r.duplicate, false);
    assert.equal(dns.calls.length, 0);
    const rec = await mp2.get(r.id);
    assert.equal(rec.id, hashDocument(over.raw).slice('sha256:'.length, 'sha256:'.length + 32));
    assert.deepEqual(rec.message, { message_id: null, in_reply_to: null, references: [], raw_sha256: hashDocument(over.raw), size: over.raw.length });
    assert.match(over.raw.toString('binary').slice(0, MAX_HEADER_BYTES + 2048), /Message-ID: </i, 'the header was there for a parser to read');
    assert.deepEqual([rec.attachments, rec.signatures, rec.message_key, rec.body_status, rec.copy], [[], [], null, 'not-checked', { kind: 'unknown', evidence: {} }]);
    assert.equal('signatures_skipped' in rec, false);
    assert.equal(rec.verdicts.live.reason, overLimitReason(limit));
    assert.equal(rec.verdicts.portable.reason, overLimitReason(limit));
    assert.deepEqual(rec.verdicts.live.dkim, []);
    assert.equal(rec.verdicts.portable.trust, 'unverified');
    const v = await mp2.verify(r.id);
    assert.equal(v.ok, false);
    assert.equal(verifyRecord(rec).ok, false);
    assert.equal((await mp2.record(over.raw, { direction: 'in', source: 't' })).duplicate, true, 'the same bytes are a no-op');
  });
}

test('total size: over 25 MiB nothing is scanned or parsed; at 25 MiB the scan runs', async () => {
  assert.equal(MAX_TOTAL_BYTES, 25 * 1024 * 1024);
  const m = await signedMail({});
  const fill = (n) => Buffer.concat([m.raw, Buffer.alloc(n - m.raw.length, 0x62)]);   // one long body line
  const over = fill(MAX_TOTAL_BYTES + 1);
  const g = admit(over);
  assert.equal(g.limit, 'total_bytes', 'total size is checked first: the 25 MiB line is not even measured');
  assert.equal(g.m.maxBodyLine, 0);
  const dns = counting(nxdomain);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: dns.fn });
  const r = await mp.record(over, { direction: 'in', source: 't' });
  assert.equal(dns.calls.length, 0);
  const rec = await mp.get(r.id);
  assert.equal(rec.verdicts.portable.reason, 'over limit: total_bytes');
  assert.equal(rec.message.size, MAX_TOTAL_BYTES + 1);
  assert.equal(admit(fill(MAX_TOTAL_BYTES)).limit, 'body_line', 'exactly 25 MiB is within the total, and is then measured');
});

test('a header block over 1 MiB is recorded over-limit (it used to reject with EMAXLEN and record nothing); no DNS', async () => {
  const calls = counting(nxdomain);
  const sig = 'DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA';
  const raw = Buffer.from([sig, 'From: a@b.example', `X-Big: ${'a'.repeat(1024 * 1024 + 10)}`, '', 'hi', ''].join('\r\n'));
  const mp = new Mailproof({ trailDir: trailDir(), resolver: calls.fn });
  const r = await mp.record(raw, { direction: 'in', source: 't' });   // does not throw
  assert.equal((await mp.get(r.id)).verdicts.live.reason, 'over limit: header_bytes');
  const c = await mp.check(raw);
  assert.equal(c.portable.reason, 'over limit: header_bytes');
  await new Promise((res) => setTimeout(res, 200));   // anything started in the background would show by now
  assert.deepEqual(calls.calls, [], 'no DNS asked');
  assert.equal((await mp.list()).length, 1);
});

test('the limits are the documented numbers', () => {
  assert.deepEqual([MAX_TOTAL_BYTES, MAX_HEADER_BYTES, MAX_HEADER_LINES, MAX_HEADER_FIELDS, MAX_SIGNATURES, MAX_H_NAMES, MAX_SIG_BYTES, MAX_MIME_PARTS, MAX_BODY_LINE],
    [25 * 1024 * 1024, 256 * 1024, 4000, 1000, 10, 200, 16 * 1024, 200, 256 * 1024]);
});

test('an h= over the limit never reaches a record, but a stored record carrying one still cannot verify offline', async () => {
  const m = await signedMail(withNames(250));
  assert.equal(admit(m.raw).limit, 'h_names');
  // a hand-made record: the re-check must not canonicalise it
  const good = await signedMail({});
  const mp = new Mailproof({ trailDir: trailDir(), resolver: good.resolver });
  const r = await mp.record(good.raw, { direction: 'in', source: 't' });
  const rec = structuredClone(await mp.get(r.id));
  const sig = splitMessage(m.raw).rows.find((x) => x.name === 'dkim-signature').raw;
  rec.signatures[0].dkim_signature = Buffer.from(sig, 'binary').toString('base64');
  assert.equal(verifyRecord(rec).signatures[0].why, 'h= too long');
});

test('10 signatures are evaluated, 11 are refused whole (not trimmed to the first 10)', async () => {
  const over = await CASES.signatures(true);
  assert.equal(admit(over.raw).limit, 'signatures');
  const dns = counting(over.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: dns.fn });
  const c = await mp.check(over.raw);
  assert.equal(dns.calls.length, 0, 'not one of the 11 signatures was looked up');
  assert.equal(c.portable.trust, 'unverified', 'even though every one of them is valid');
  assert.equal(c.signatures, 0);
});

test('matchBody on a message over a limit matches nothing, even a record whose signed body was empty', async () => {
  const m = await signedMail({ body: '' });
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  const r = await mp.record(m.raw, { direction: 'in', source: 't' });
  assert.equal((await mp.matchBody(r.id, m.raw)).match, true, 'sanity: the real message matches');
  // a body line over the limit: a gate that dropped the body instead of refusing the message would be
  // hashing an empty body here, and an empty body is exactly what this record signed
  const hugeLine = Buffer.concat([m.raw, Buffer.from('\r\n'), Buffer.alloc(MAX_BODY_LINE + 1, 0x61)]);
  assert.equal(admit(hugeLine).limit, 'body_line');
  const res = await mp.matchBody(r.id, hugeLine);
  assert.deepEqual([res.match, res.full], [false, false]);
});

test('an attached original (message/rfc822) goes through the same gate: over a limit it is not examined', async () => {
  const inner = await signedMail({ body: 'a'.repeat(MAX_BODY_LINE + 1) + '\r\n' });
  const small = await signedMail({ body: 'hello\r\n' });
  const outer = (innerRaw) => Buffer.from([
    'From: fwd@other.example', 'To: me@signer.example', 'Subject: Fwd: x', 'Message-ID: <outer@other.example>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bnd"', '', '--bnd', 'Content-Type: text/plain', '', 'see attached', '--bnd',
    'Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="o.eml"', '',
    innerRaw.toString('base64').replace(/(.{76})/g, '$1\r\n'), '--bnd--', '',   // base64: the outer's own lines stay short, the decoded inner's do not
  ].join('\r\n'), 'binary');
  const dns = counting(small.resolver);
  const mp = new Mailproof({ trailDir: trailDir(), resolver: dns.fn });
  const big = await mp.record(outer(inner.raw), { direction: 'in', source: 't' });
  const ent = (await mp.get(big.id)).copy.evidence.attached_original;
  assert.deepEqual(ent, [{ message_key: null, dkim: 'none', d: null, body_status: 'not-checked', over_limit: 'body_line' }]);
  assert.equal(dns.calls.filter((x) => x.includes('signer.example') && x.includes('_domainkey')).length, 0, 'the inner signature was not looked up');
  const ok = await mp.record(outer(small.raw), { direction: 'in', source: 't' });
  const ent2 = (await mp.get(ok.id)).copy.evidence.attached_original;
  assert.equal(ent2.length, 1);
  assert.equal(ent2[0].dkim, 'pass');
  assert.equal('over_limit' in ent2[0], false);
});
