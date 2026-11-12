// The one seal phrase (C11): when it was sealed (the stamping manifest's own time, no network) and where the anchor stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealPhrase } from '../../src/cli/seal.js';

const NOW = new Date('2026-11-12T10:00:00Z');
test('sealed time and anchor state, in one phrase', () => {
  assert.equal(sealPhrase({ state: 'anchored', sealed_at: '2026-11-11T21:03:10.000Z', block: 975469 }, NOW), 'sealed 11-11 21:03Z · anchored (Bitcoin block 975469)');
  assert.equal(sealPhrase({ state: 'pending', sealed_at: '2026-11-11T21:03:10.000Z' }, NOW), 'sealed 11-11 21:03Z · anchor pending');
  assert.equal(sealPhrase({ state: 'anchored', sealed_at: '2025-01-02T03:04:05.000Z', block: null }, NOW, '-'), 'sealed 2025-01-02 03:04Z - anchored', 'another year shows the year');
  assert.equal(sealPhrase({ state: 'pending', sealed_at: null }, NOW), 'sealed · anchor pending');
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW), 'waiting to be sealed');
  assert.equal(sealPhrase({ state: 'not-stamped' }, NOW), 'waiting to be sealed');
  assert.equal(sealPhrase({ state: 'unchecked', sealed_at: '2026-11-11T21:03:10.000Z' }, NOW), 'sealed 11-11 21:03Z · anchor not checked');
});

test('a record waiting for a seal says when the next seal is due (the date only when it is not today)', () => {
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW, '·', '2026-11-12T14:03:00.000Z'), 'waiting to be sealed (next 14:03Z)');
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW, '·', '2026-11-13T02:00:00.000Z'), 'waiting to be sealed (next 11-13 02:00Z)');
  assert.equal(sealPhrase({ state: 'not-stamped' }, NOW, '·', '2026-11-12T14:03:00.000Z'), 'waiting to be sealed (next 14:03Z)');
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW), 'waiting to be sealed', 'no next-due time known');
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW, '·', '2026-11-12T09:00:00.000Z'), 'waiting to be sealed', 'a time already past is left out');
  assert.equal(sealPhrase({ state: 'anchored', sealed_at: '2026-11-11T21:03:10.000Z' }, NOW, '·', '2026-11-12T14:03:00.000Z'), 'sealed 11-11 21:03Z · anchored', 'a sealed record is unaffected');
});
