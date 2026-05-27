'use strict';

// Pure unit tests for the verifier's findMatch (the match cascade). reverifyDkim
// + the composed verify() are exercised end-to-end in
// tests/integration/verifier.test.js (they need the real mailauth + ledger).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findMatch, resolveUpgrade, pickSigner } = require('../../src/verifier');
const { hashDocument } = require('../../src/notary');

const RAW = Buffer.from('the original signed email bytes');
const DOC = Buffer.from('an attached document');
const commits = [
  { sequence: 1, raw_sha256: hashDocument(RAW), message_id_hash: 'sha256:mid1', attachments: [] },
  { sequence: 2, raw_sha256: 'sha256:other', message_id_hash: 'sha256:mid2',
    attachments: [{ filename: 'd.pdf', sha256: hashDocument(DOC) }] },
];

test('findMatch: whole-email match wins via raw_sha256', () => {
  const m = findMatch(RAW, commits);
  assert.equal(m.matchType, 'raw_email');
  assert.equal(m.commit.sequence, 1);
  assert.equal(m.hash, hashDocument(RAW));
});

test('findMatch: falls back to Message-ID hash when bytes differ', () => {
  const m = findMatch(Buffer.from('re-encoded forward'), commits, { messageIdHash: 'sha256:mid2' });
  assert.equal(m.matchType, 'message_id');
  assert.equal(m.commit.sequence, 2);
});

test('findMatch: matches a committed attachment by hash', () => {
  const m = findMatch(DOC, commits);
  assert.equal(m.matchType, 'attachment');
  assert.equal(m.commit.sequence, 2);
  assert.equal(m.attachment.filename, 'd.pdf');
});

test('findMatch: no match returns matchType none with the computed hash', () => {
  const m = findMatch(Buffer.from('unknown'), commits, { messageIdHash: 'sha256:nope' });
  assert.equal(m.matchType, 'none');
  assert.equal(m.commit, undefined);
  assert.equal(m.hash, hashDocument(Buffer.from('unknown')));
});

test('findMatch: raw_sha256 takes precedence over a Message-ID hit', () => {
  // A candidate whose bytes match commit 1 AND whose mid hash matches commit 2:
  // whole-email is the stronger match and must win.
  const m = findMatch(RAW, commits, { messageIdHash: 'sha256:mid2' });
  assert.equal(m.matchType, 'raw_email');
  assert.equal(m.commit.sequence, 1);
});

// --- reverify trust-upgrade policy ---

test('resolveUpgrade: below-verified levels upgrade to verified; verified does not', () => {
  for (const lvl of ['unverified', 'authorized', 'forwarded']) {
    assert.deepEqual(resolveUpgrade(lvl), { upgradeTo: 'verified', reason: null });
  }
  assert.deepEqual(resolveUpgrade('verified'), { upgradeTo: null, reason: 'already verified' });
  assert.equal(resolveUpgrade('bogus').upgradeTo, null);
});

test('pickSigner: prefers a pass signature, falls back to any with domain+selector, else null', () => {
  const pass = { result: 'pass', domain: 'a.example', selector: 's1' };
  const fail = { result: 'fail', domain: 'b.example', selector: 's2' };
  assert.equal(pickSigner({ dkim: { signatures: [fail, pass] } }), pass);
  assert.equal(pickSigner({ dkim: { signatures: [fail] } }), fail);     // fallback
  assert.equal(pickSigner({ dkim: { signatures: [{ result: 'none' }] } }), null); // no domain/selector
  assert.equal(pickSigner({}), null);
});
