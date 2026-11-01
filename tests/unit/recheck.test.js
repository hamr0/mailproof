import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { authenticate } from 'mailauth';
import { verifyRecord, verifySignature, matchBodyRecord } from '../../src/proof/recheck.js';
import { signedMail, recordOf, makeKey } from '../helpers/proof.js';

const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
const un = (x) => Buffer.from(x, 'base64').toString('binary');
const clone = (r) => structuredClone(r);

async function fixture(opts = {}) {
  const m = await signedMail(opts);
  const rec = recordOf(m.raw, m.signers);
  return { m, rec };
}

test('verifyRecord passes a freshly signed record, from the JSON alone (rsa + ed25519, simple + relaxed)', async () => {
  for (const alg of ['rsa', 'ed25519']) {
    for (const canon of ['relaxed/relaxed', 'simple/simple', 'relaxed/simple']) {
      const { rec } = await fixture({ alg, canon });
      const r = verifyRecord(JSON.parse(JSON.stringify(rec)));
      assert.equal(r.ok, true, `${alg} ${canon}: ${JSON.stringify(r.signatures)}`);
    }
  }
});

test('offline verdict agrees with live mailauth, and canonical bytes are mailauth\'s own', async () => {
  const { m, rec } = await fixture({ signers: [{ domain: 'a.example', selector: 's1' }, { domain: 'b.example', selector: 's2', alg: 'ed25519' }], from: 'me@a.example' });
  const live = await authenticate(m.raw, { trustReceived: false, resolver: m.resolver, disableBimi: true });
  assert.equal(live.dkim.results.length, 2);
  const off = verifyRecord(rec);
  for (const lv of live.dkim.results) {
    const o = off.signatures.find((s) => s.d === lv.signingDomain && s.s === lv.selector);
    assert.equal(o.ok, lv.status.result === 'pass');
    const sig = rec.signatures[o.index];
    const mine = verifySignature(sig, Date.now(), Date.now()).canon;
    assert.ok(Buffer.from(lv.signingHeaders.canonicalizedHeader, 'base64').equals(mine), 'canonical header bytes differ from mailauth');
  }
});

test('F6 a: editing a signed header value fails', async () => {
  const { rec } = await fixture();
  const r = clone(rec);
  const i = r.signatures[0].signed_headers.findIndex((x) => /^subject:/i.test(un(x)));
  r.signatures[0].signed_headers[i] = b64(un(r.signatures[0].signed_headers[i]).replace('please', 'pleaze'));
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 b: swapping in a generated key fails', async () => {
  const { rec } = await fixture();
  const r = clone(rec);
  const k = makeKey('rsa');
  r.signatures[0].key = { k: k.k, p: k.p };
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 c: dropping a signed header fails', async () => {
  const { rec } = await fixture();
  const r = clone(rec);
  r.signatures[0].signed_headers.splice(0, 1);
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 x: editing x= in the signature fails', async () => {
  const exp = new Date(Date.now() + 86400e3);
  const { rec } = await fixture({ expires: exp });
  assert.equal(verifyRecord(rec).ok, true);
  const r = clone(rec);
  const sg = un(r.signatures[0].dkim_signature);
  assert.match(sg, /\bx=\d+/);
  r.signatures[0].dkim_signature = b64(sg.replace(/\bx=(\d+)/, (_, d) => 'x=' + (Number(d) + 1)));
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 d: key replay (a real key of a different domain) fails', async () => {
  const { rec } = await fixture({ domain: 'one.example' });
  const other = await fixture({ domain: 'two.example' });
  const r = clone(rec);
  r.signatures[0].key = other.rec.signatures[0].key;
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 e: flipping one base64 char of b= fails', async () => {
  const { rec } = await fixture();
  const r = clone(rec);
  const sg = un(r.signatures[0].dkim_signature);
  r.signatures[0].dkim_signature = b64(sg.replace(/(\bb=\s*)([A-Za-z0-9+/]{8})/, (m, a, f) => a + (f[0] === 'A' ? 'B' : 'A') + f.slice(1)));
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 f: swapping two signed_headers entries fails', async () => {
  const { rec } = await fixture();
  const r = clone(rec);
  const h = r.signatures[0].signed_headers;
  [h[0], h[h.length - 1]] = [h[h.length - 1], h[0]];
  assert.notEqual(h[0], h[h.length - 1]);
  assert.equal(verifyRecord(r).ok, false);
});

test('F6 h: at after x= is expired; at before t= minus 300s fails; at captured passes', async () => {
  const signTime = new Date('2026-05-01T00:00:00Z');
  const expires = new Date('2026-05-08T00:00:00Z');
  const { m, rec } = await fixture({ signTime, expires });
  const r0 = clone(rec); r0.captured = '2026-05-02T00:00:00Z';
  assert.equal(verifyRecord(r0).ok, true);
  const late = verifyRecord(r0, { at: '2026-05-09T00:00:00Z' });
  assert.equal(late.ok, false);
  assert.equal(late.signatures[0].why, 'expired');
  const early = verifyRecord(r0, { at: new Date(signTime.getTime() - 301e3) });
  assert.equal(early.ok, false);
  assert.equal(early.signatures[0].why, 'timestamp in future');
  // expired "now" is informational only: passes at capture time, flagged expired_now
  const now = verifyRecord(r0, { now: Date.parse('2027-01-01') });
  assert.equal(now.ok, true);
  assert.equal(now.signatures[0].expired_now, true);
  assert.ok(m);
});

test('F6 i: missing, null, empty or garbled captured fails closed', async () => {
  const { rec } = await fixture();
  for (const v of [undefined, null, '', 'not-a-date', 'garbage', 12345n]) {
    const r = clone({ ...rec, captured: typeof v === 'bigint' ? 'x' : v });
    if (v === undefined) delete r.captured;
    const out = verifyRecord(r);
    assert.equal(out.ok, false, String(v));
    assert.equal(out.signatures[0].why, 'no usable capture time');
  }
});

test('record with an unsupported version, junk, or no key fails closed without throwing', async () => {
  const { rec } = await fixture();
  assert.equal(verifyRecord({ ...rec, v: 1 }).ok, false);
  assert.equal(verifyRecord('{not json').ok, false);
  assert.equal(verifyRecord(null).ok, false);
  const r = clone(rec); r.signatures[0].key = null;
  assert.equal(verifyRecord(r).signatures[0].why, 'no archived key');
});

test('F6 g: matchBody passes with its own raw, fails with another email\'s', async () => {
  const a = await fixture({ body: 'first body\r\n' });
  const b = await fixture({ body: 'second body\r\n' });
  const own = matchBodyRecord(a.rec, a.m.raw);
  assert.equal(own.match, true);
  assert.equal(own.full, true);
  assert.equal(matchBodyRecord(a.rec, b.m.raw).match, false);
  assert.equal(matchBodyRecord(a.rec, Buffer.from('garbage')).match, false);
});

test('F4: an altered body fails matchBody while the headers still verify', async () => {
  const { m, rec } = await fixture({ body: 'hello world\r\n' });
  const altered = Buffer.from(m.raw.toString('binary').replace('hello world', 'hello w0rld'), 'binary');
  assert.equal(matchBodyRecord(rec, altered).match, false);
  assert.equal(verifyRecord(rec).ok, true);
});

test('matchBody honours l=: bytes appended after the signed length still match', async () => {
  const { m, rec } = await fixture({ body: 'signed part\r\n', bodyLength: 13, canon: 'simple/simple' });
  const appended = Buffer.concat([m.raw, Buffer.from('unsigned tail\r\n')]);
  assert.equal(matchBodyRecord(rec, appended).match, true);
  assert.equal(rec.signatures[0].partial_body, false);
});

test('partial_body flags an l= shorter than the canonical body', async () => {
  const { rec } = await fixture({ body: 'signed part and an unsigned tail\r\n', bodyLength: 5, canon: 'simple/simple' });
  assert.equal(rec.signatures[0].partial_body, true);
  assert.equal(crypto.createHash('sha256').update('x').digest().length, 32);
});

test('verifyRecord fails closed on junk and never throws', async () => {
  const MALFORMED = 'malformed signature entry';
  for (const junk of [null, undefined, 'x', '', '{', 'null', '[]', [], 5, true, {}, { v: 1 }, { v: 2 }]) {
    const r = verifyRecord(junk);
    assert.equal(r.ok, false, String(junk));
    assert.equal(r.trust, 'unverified');
    assert.deepEqual(r.signatures, []);
  }
  for (const signatures of [undefined, null, 'x', 5, {}, { length: 1 }]) {
    assert.equal(verifyRecord({ v: 2, captured: new Date().toISOString(), signatures }).ok, false);
  }
  const bad = [null, 1, 'x', [], {}, undefined, true];
  const r = verifyRecord({ v: 2, captured: new Date().toISOString(), signatures: bad });
  assert.equal(r.ok, false);
  assert.equal(r.signatures.length, bad.length, 'no entry is skipped');
  r.signatures.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.equal(s.ok, false);
    assert.equal(s.aligned, false);
    assert.equal(s.d, null);
    assert.equal(s.s, null);
    if (i !== 4) assert.equal(s.why, MALFORMED, `entry ${i}`);
    assert.equal(typeof s.partial_body, 'boolean');
  });
  const sparse = verifyRecord({ v: 2, captured: new Date().toISOString(), signatures: new Array(2) });
  assert.equal(sparse.signatures.length, 2);
  assert.equal(sparse.signatures[0].why, MALFORMED);
  // junk opts
  const { rec } = await fixture();
  assert.equal(verifyRecord(rec, null).ok, true);
  assert.equal(verifyRecord(rec, { at: {} }).ok, false);
  // a hostile getter cannot escape the contract
  const hostile = { v: 2, get signatures() { throw new Error('boom'); } };
  assert.equal(verifyRecord(hostile).ok, false);
});

test('one valid signature next to a null entry: the valid one still reports, the null is ok:false', async () => {
  const { rec } = await fixture();
  const mixed = clone(rec);
  mixed.signatures.push(null);
  const r = verifyRecord(mixed);
  assert.equal(r.ok, true);
  assert.equal(r.signatures[0].ok, true);
  assert.equal(r.signatures[1].ok, false);
  assert.equal(r.signatures[1].why, 'malformed signature entry');
  assert.deepEqual(r.passing, [0]);
  const first = clone(rec);
  first.signatures.unshift(null);
  const r2 = verifyRecord(first);
  assert.equal(r2.signatures[0].ok, false);
  assert.equal(r2.signatures[1].ok, true);
  assert.deepEqual(r2.passing, [1]);
});

test('mp.verify never throws on junk input or junk opts', async () => {
  const { Mailproof } = await import('../../src/proof/mailproof.js');
  const mp = new Mailproof({ trailDir: '/nonexistent-mailproof-dir' });
  for (const junk of [null, undefined, 'x', 5, [], {}, { v: 2, signatures: [null] }, '{"v":2,"signatures":[null]}', 'a'.repeat(32)]) {
    for (const opts of [undefined, null, 'x', { at: 'garbage' }]) {
      const r = await mp.verify(junk, opts);
      assert.equal(r.ok, false, String(junk));
    }
  }
});
