// `shortReason` (SPEC B8.5): the ONE short plain reason of a record, next to `explain`; the CLI list rows print it and `describe` returns it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortReason, explain } from '../../src/proof/explain.js';

const sig = (extra = {}) => ({ tags: { d: 'a.example', s: 'k' }, ...extra });
const okSig = { index: 0, d: 'a.example', s: 'k', ok: true, aligned: true, why: '' };
const badSig = (why) => ({ index: 0, d: 'a.example', s: 'k', ok: false, aligned: false, why });
const ver = (signatures) => ({ ok: signatures.some((s) => s.ok), signatures });
const rec = (o = {}) => ({ signatures: [sig()], verdicts: { live: { trust: 'unverified', dkim: [{ d: 'a.example', s: 'k', result: 'pass', aligned: true }] } }, ...o });
const live = (l, signatures = [sig()]) => ({ signatures, verdicts: { live: { trust: 'unverified', ...l } } });

const CASES = [
  ['verifies', { signatures: [sig()], verdicts: { live: { trust: 'verified' } } }, ver([okSig])],
  ['no DKIM signature', live({}, []), ver([])],
  ['no DKIM key in DNS', live({ dkim: [{ d: 'a.example', s: 'k', result: 'neutral' }] }, [sig({ key_error: 'queryTxt ENODATA k._domainkey.a.example' })]), ver([badSig('no archived key')])],
  ['no DKIM key in DNS', live({ dkim: [{ d: 'a.example', s: 'k', result: 'neutral' }] }), ver([badSig('no archived key')])],
  ['DKIM key not fetched', live({ dkim: [{ d: 'a.example', s: 'k', result: 'temperror' }] }, [sig({ key_error: 'queryTxt ETIMEOUT x' })]), ver([badSig('no archived key')])],
  ['signature fails', live({ dkim: [{ d: 'a.example', s: 'k', result: 'fail' }] }), ver([badSig('bad signature')])],
  ['body changed after signing', live({ dkim: [{ d: 'a.example', s: 'k', result: 'fail' }] }, [sig({ body: { status: 'mismatch' } })]), ver([{ ...okSig, aligned: true }])],
  ['key expired (x=)', live({ dkim: [{ d: 'a.example', s: 'k', result: 'fail' }] }), ver([badSig('expired')])],
  ['signature dated in the future', live({ dkim: [{ d: 'a.example', s: 'k', result: 'fail' }] }), ver([badSig('timestamp in future')])],
  ['signed headers too long', live({}), ver([badSig('h= too long')])],
  ['unsupported algorithm', live({}), ver([badSig('unsupported a=rsa-sha1')])],
  ['no usable capture time', live({}), ver([badSig('no usable capture time')])],
  ['malformed signature', live({}), ver([badSig('malformed signature entry')])],
  ['signature check error', live({}), ver([badSig('error: boom')])],
  ['DKIM not aligned with From', live({ dkim: [{ d: 'a.example', s: 'k', result: 'pass', aligned: false }] }), ver([okSig])],
  ['DMARC fails', live({ dkim: [{ d: 'a.example', s: 'k', result: 'pass', aligned: true }], dmarc: { published: true, result: 'fail', policy: 'reject' } }), ver([okSig])],
  ['ARC fails', live({ dkim: [{ d: 'a.example', s: 'k', result: 'pass', aligned: true }], arc: { result: 'fail' } }), ver([okSig])],
  ['over limit: size', { signatures: [], verdicts: { live: { trust: 'unverified', reason: 'over limit: size' } } }, ver([])],
  ['over limit: time', { signatures: [], verdicts: { live: { trust: 'unverified', reason: 'over limit: time' } } }, ver([])],
];

for (const [want, r, v] of CASES) test(`shortReason: ${want} (${JSON.stringify(v.signatures[0]?.why ?? 'no sig')})`, () => assert.equal(shortReason(r, v), want));

test('shortReason: an unknown cause falls back to the first clause of the long why, cut at a word, at most 40 characters', () => {
  const r = live({ trust: 'unverified' });
  const v = { ok: true, signatures: [okSig] };
  const got = shortReason(r, v);
  assert.equal(got, 'live verdict unverified, portable N/A', 'the first clause of the long why');
  assert.ok(got.length <= 40);
  assert.match(explain(r, v), /^live verdict unverified/);
  const long = live({ dkim: [{ d: 'a.example', s: 'k', result: 'pass', aligned: true }], dmarc: { published: true, result: 'fail', policy: 'reject' } }, [sig()]);
  const cut = shortReason(long, { ok: false, signatures: [{ ...badSig('some brand new reason that is long'), ok: false }] });
  assert.ok(cut.length <= 40, cut);
  assert.ok(!/\s$/.test(cut));
});

test('shortReason: every reason is plain, one line, at most 40 characters', () => {
  for (const [, r, v] of CASES) { const s = shortReason(r, v); assert.ok(s.length <= 40 && !/[\n;]/.test(s), s); }
});
