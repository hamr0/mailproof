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
  assert.equal(sealPhrase({ state: 'unsealed' }, NOW), 'unsealed');
  assert.equal(sealPhrase({ state: 'not-stamped' }, NOW), 'waiting to be sealed');
  assert.equal(sealPhrase({ state: 'unchecked', sealed_at: '2026-11-11T21:03:10.000Z' }, NOW), 'sealed 11-11 21:03Z · anchor not checked');
});
