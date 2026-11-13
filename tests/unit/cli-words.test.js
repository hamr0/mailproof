import test from 'node:test';
import assert from 'node:assert/strict';
import { count, humanSize, wrap } from '../../src/cli/words.js';
import { profileSummary, ruleLines, DEFAULT_PROFILE } from '../../src/cli/profile-text.js';
import { tildeText } from '../../src/cli/paths.js';

test('count: plain plurals, no (s)', () => {
  assert.equal(count(1, 'record'), '1 record');
  assert.equal(count(2, 'record'), '2 records');
  assert.equal(count(0, 'reply', 'replies'), '0 replies');
  assert.equal(count(1, 'reply', 'replies'), '1 reply');
});

test('humanSize: bytes, KiB, MiB', () => {
  assert.deepEqual([1, 1023, 1024, 1536, 5 * 1024 * 1024].map(humanSize), ['1 byte', '1023 bytes', '1.0 KiB', '1.5 KiB', '5.0 MiB']);
});

test('wrap: at spaces, never past the width, a long word is cut', () => {
  const lines = wrap('one two three four five six seven eight nine ten', 12);
  assert.ok(lines.every((l) => [...l].length <= 12), JSON.stringify(lines));
  assert.equal(lines.join(' '), 'one two three four five six seven eight nine ten');
  assert.deepEqual(wrap('x'.repeat(20), 8), ['xxxxxxxx', 'xxxxxxxx', 'xxxx']);
  assert.deepEqual(wrap('', 10), []);
});

test('profileSummary and ruleLines: plain words, one line per rule the profile names', () => {
  assert.equal(profileSummary(DEFAULT_PROFILE), 'DKIM signature verifies and covers the From');
  assert.equal(profileSummary({}), 'accepts any email');
  assert.match(profileSummary({ senders: ['@a.example'], body: 'proven', link: ['signed'] }), /^sender @a\.example; body proven; link signed$/);
  assert.match(profileSummary({ nope: 1 }), /^not a valid profile/);
  const lines = ruleLines({ senders: ['@a.example'], checks: { dmarc: true } }, [{ rule: 'senders', want: ['@a.example'], got: ['x@b.example'] }]);
  assert.deepEqual(lines.map((l) => l.ok), [false, true]);
  assert.match(lines[0].text, /^sender x@b\.example is not @a\.example$/);
  assert.deepEqual(ruleLines({}, [{ rule: 'record', want: 'a version 2 record', got: 'missing' }]).map((l) => l.ok), [false]);
});

test('tildeText: every <home>/ in a message shows as ~/', () => {
  assert.equal(tildeText('cannot read /home/ana/x and /home/ana/y', { HOME: '/home/ana' }), 'cannot read ~/x and ~/y');
  assert.equal(tildeText('/home/anabel/x', { HOME: '/home/ana' }), '/home/anabel/x');
});
