
// Unit tests for the PURE OTS output parser. parseOtsBlockHeight reads the
// Bitcoin block height out of `ots info` stdout, across the output shapes the
// opentimestamps-client has used over its lifetime. No process, no fs — the
// subprocess wrappers (upgradeProof/readBlockHeight) are covered in
// tests/integration/ots.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOtsBlockHeight } from '../../src/ots.js';

test('parseOtsBlockHeight: "Bitcoin block <n>" shape', () => {
  assert.equal(parseOtsBlockHeight('Success! Bitcoin block 850123 attests existence'), 850123);
});

test('parseOtsBlockHeight: "Bitcoin block height <n>" shape', () => {
  assert.equal(parseOtsBlockHeight('verified: Bitcoin block height 723456'), 723456);
});

test('parseOtsBlockHeight: "Block height: <n>" shape', () => {
  assert.equal(parseOtsBlockHeight('Block height: 1000000\nattested'), 1000000);
});

test('parseOtsBlockHeight: BitcoinBlockHeaderAttestation node + 6+ digit run', () => {
  const info = [
    'msg: ...',
    'BitcoinBlockHeaderAttestation:',
    '  # Bitcoin block merkle root',
    '  verify BitcoinBlockHeaderAttestation(862500)',
  ].join('\n');
  assert.equal(parseOtsBlockHeight(info), 862500);
});

test('parseOtsBlockHeight: returns null for a calendar-only / pending proof', () => {
  const pending = [
    'PendingAttestation: https://alice.btc.calendar.opentimestamps.org',
    'PendingAttestation: https://bob.btc.calendar.opentimestamps.org',
  ].join('\n');
  assert.equal(parseOtsBlockHeight(pending), null);
});

test('parseOtsBlockHeight: returns null on empty / missing input', () => {
  assert.equal(parseOtsBlockHeight(''), null);
  assert.equal(parseOtsBlockHeight(null), null);
  assert.equal(parseOtsBlockHeight(undefined), null);
});

test('parseOtsBlockHeight: ignores zero / non-positive block numbers', () => {
  // A short attestation node digit-run below 6 digits won't match the third
  // pattern; an explicit "block 0" is not a real height.
  assert.equal(parseOtsBlockHeight('Bitcoin block 0'), null);
});

test('parseOtsBlockHeight: first recognised match wins', () => {
  const both = 'Bitcoin block 500000\nBlock height: 999999';
  assert.equal(parseOtsBlockHeight(both), 500000);
});
