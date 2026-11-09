// Trust profile validation and the pure rules (SPEC B8), over hand-built records. The end-to-end cases on real
// captured mail are in tests/integration/trust-profile.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProfile, checkProfile } from '../../src/proof/profile.js';
import { RULES_VERSION } from '../../src/proof/verdict.js';

test('normaliseProfile accepts the empty profile and normalises senders', () => {
  assert.deepEqual(normaliseProfile({}), { checks: {} });
  assert.deepEqual(normaliseProfile({ senders: ['Bob@Beta.Example', '@Gmail.com'], checks: { dmarc: true, spf: false }, body: 'partial', link: ['signed', 'signed'] }),
    { senders: ['bob@beta.example', '@gmail.com'], checks: { dmarc: true, spf: false }, body: 'partial', link: ['signed'] });
});

test('normaliseProfile is strict: every bad shape throws ERR_BAD_PROFILE', () => {
  const bad = [null, 'x', [], 5, { nope: 1 }, { senders: [] }, { senders: 'a@b.example' }, { senders: [5] }, { senders: ['nodomain'] },
    { senders: ['@'] }, { senders: ['a@b@c'] }, { senders: ['gmail.com'] }, { checks: 'x' }, { checks: { dmarc: 'yes' } }, { checks: { dkim: true } },
    { body: 'strong' }, { body: 1 }, { link: [] }, { link: ['strong'] }, { link: 'signed' }, { link: [1] }];
  for (const p of bad) assert.throws(() => normaliseProfile(p), (e) => e.code === 'ERR_BAD_PROFILE', JSON.stringify(p));
  assert.throws(() => checkProfile({}, { typo: true }), (e) => e.code === 'ERR_BAD_PROFILE');
});

test('checkProfile on a missing or junk record fails the record rule, never throws', () => {
  for (const r of [null, undefined, 'not json', '{}', { v: 1 }, { v: 2 }, 5]) {
    const out = checkProfile(r, {});
    assert.equal(out.ok, false);
    assert.equal(out.record, null);
    assert.equal(out.rules, RULES_VERSION);
    assert.equal(out.failed[0].rule, 'record');
  }
});

test('checkProfile with an empty profile passes any readable v2 record', () => {
  assert.deepEqual(checkProfile({ v: 2, id: 'a'.repeat(32), signatures: [], captured: '2026-11-01T00:00:00Z' }, {}), { ok: true, failed: [], record: 'a'.repeat(32), rules: RULES_VERSION });
});

test('live checks read the recorded verdicts: missing facts are "none", never a pass', () => {
  const rec = { v: 2, id: 'b'.repeat(32), signatures: [], captured: '2026-11-01T00:00:00Z', body_status: 'not-checked', verdicts: { live: { dmarc: { result: 'pass' }, spf: null, arc: { result: 'fail' } } } };
  const out = checkProfile(rec, { checks: { dmarc: true, spf: true, arc: true, dkimAligned: true } });
  assert.deepEqual(out.failed, [
    { rule: 'checks.dkimAligned', want: 'pass', got: 'fail' },
    { rule: 'checks.spf', want: 'pass', got: 'none' },
    { rule: 'checks.arc', want: 'pass', got: 'fail' },
  ]);
  assert.equal(checkProfile({ ...rec, verdicts: {} }, { checks: { dmarc: true } }).failed[0].got, 'none');
});

test('body levels', () => {
  const at = (s) => ({ v: 2, id: 'c'.repeat(32), signatures: [], captured: '2026-11-01T00:00:00Z', body_status: s });
  const ok = (s, level) => checkProfile(at(s), { body: level }).ok;
  assert.deepEqual(['matched', 'partial', 'mismatch', 'not-checked'].map((s) => ok(s, 'proven')), [true, false, false, false]);
  assert.deepEqual(['matched', 'partial', 'mismatch', 'not-checked'].map((s) => ok(s, 'partial')), [true, true, false, false]);
  assert.deepEqual(['matched', 'partial', 'mismatch', 'not-checked'].map((s) => ok(s, 'any')), [true, true, true, true]);
  assert.deepEqual(checkProfile(at('mismatch'), { body: 'proven' }).failed, [{ rule: 'body', want: 'proven', got: 'mismatch' }]);
});
