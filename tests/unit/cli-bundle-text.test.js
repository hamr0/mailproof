// The verify-bundle text report (final tidy, item 1): plurals, rows as browse rows, one seal phrase, dim wrapped notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleText } from '../../src/cli/bundle.js';
import { makeStyle, stripStyle } from '../../src/cli/style.js';

const seal = { state: 'anchored', via: 'manifest', listed_in: 1, stamped_by: 1, sealed_at: '2026-11-11T21:03:10.000Z', block: 975469 };
const rec = (o = {}) => ({ id: 'ab12cd34ef56'.padEnd(32, '0'), captured: '2026-11-11T19:21:03.173Z', direction: 'in', ok: true, trust: 'verified', at: null, signatures: [{}], key: 'ok', seal, replies: [], notes: [], problems: [], ...o });
const result = (records, o = {}) => ({ ok: true, failed: [], bundle: null, expect: null, files: { listed: 1, found: 1, bytes: 1, problems: [] }, records, chain: { runs: [], problems: [] }, ots: 'used', counts: { records: records.length, verified: records.length, unverified: 0, anchored: records.length, pending: 0, unstamped: 0, unsealed: 0, unchecked: 0, bad: 0 }, problems: [], ...o });
const plain = (r, columns = 60) => stripStyle(bundleText(r, makeStyle({ columns })));

test('one record is "1 record", not "1 records"', () => {
  const t = plain(result([rec()]));
  assert.match(t, /^OK {2}1 record \(1 verified, 0 unverified\)/m);
  assert.doesNotMatch(t, /1 records/);
  assert.match(plain(result([rec(), rec({ id: 'cd'.repeat(16) })])), /^OK {2}2 records /m);
});

test('the record is a two-line browse row: short capture time, the seal phrase once', () => {
  const t = plain(result([rec()]));
  assert.ok(t.includes('11-11 19:21Z'), t);
  assert.ok(!t.includes('2026-11-11T19:21:03.173Z'), 'no ISO timestamp');
  assert.ok(!/seal sealed/.test(t), 'the word seal is not repeated');
  assert.match(t, /^ {4}sealed 11-11 21:03Z . anchored \(Bitcoin block 975469\)$/m);
  assert.match(t, /^ #  when .*verdict .*from$/m, 'the list header');
});

test('the three notes are wrapped to the width, after a blank line, before the verdict', () => {
  const r = result([rec()]);
  const t = plain(r, 40);
  const lines = t.split('\n');
  const first = lines.findIndex((l) => l === '');
  assert.ok(lines.slice(first).every((l) => [...l].length <= 40), lines.filter((l) => [...l].length > 40).join('|'));
  const i = lines.findIndex((l) => /does not prove completeness/.test(l.replace(/\s+/g, ' ')) || /^This bundle does not/.test(l));
  assert.equal(lines[i - 1], '', 'blank line before the notes');
  assert.match(lines.at(-1), /VERIFIED$/);
  assert.equal(lines.at(-2), '', 'blank line before the verdict');
  const styled = bundleText(r, makeStyle({ env: { FORCE_COLOR: '1' }, columns: 40 }));
  assert.ok(styled.includes('\x1b[2mThis bundle'), 'notes are dim');
});

test('a record row reads like list: from (or "to <address>"), the subject, "subject not signed", and "not sealed" when unsealed', () => {
  const t = plain(result([
    rec({ from: 'bob@bob.example', to: 'owner@owner.example', subject: 'Hello there', subject_signed: true }),
    rec({ id: 'cd'.repeat(16), direction: 'out', from: 'owner@owner.example', to: 'bob@bob.example', subject: 'Re: plan', subject_signed: false, seal: { state: 'unsealed' } }),
  ]));
  assert.match(t, /^ 1 .*bob@bob\.example$/m);
  assert.match(t, /^ 2 .*to bob@bob\.example$/m);
  assert.match(t, /^ {4}Hello there$/m);
  assert.match(t, /^ {4}Re: plan {2}. subject not signed$/m);
  assert.match(t, /^ {4}not sealed$/m);
  assert.doesNotMatch(t, /waiting to be sealed/);
  assert.ok(!t.includes('ab12cd34ef56'), 'the id is only the fallback');
});

test('a hostile subject and address are escaped', () => {
  const t = bundleText(result([rec({ from: 'a\x1b[31m@x', subject: 'hi\x1b[2Jthere', subject_signed: true })]), makeStyle({ columns: 60 }));
  assert.ok(!t.includes('\x1b[31m') && !t.includes('\x1b[2J'));
});
