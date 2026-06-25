
// Pins the PUBLIC contract — the exact surface a consumer gets from
// `require('mailproof')`. Every other test imports `src/<module>.js`
// directly, so a dropped or renamed re-export in index.js would ship
// silently and break consumers at import time (gitdone, P2). This is the
// one test that exercises the barrel itself.
//
// EXPECTED is the frozen contract: name -> typeof. Adding or removing an
// export, or changing its kind (function <-> constant), must be a conscious
// edit here. Keep this list in sync with docs/02-design/DESIGN.md's surface.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as mailproof from '../../src/index.js';

const EXPECTED = {
  // Composition root
  create: 'function',
  // Verify — trust classifier
  classifyTrust: 'function',
  TRUST_LEVELS: 'object',
  // Sequence — address routing
  parseAddress: 'function',
  parseEventTag: 'function',
  parseVerifyTag: 'function',
  parseReverifyTag: 'function',
  parseAttestTag: 'function',
  parseInitiatorCommand: 'function',
  // Inbound — preprocessing
  preFilter: 'function',
  extractHeaderBlock: 'function',
  rawHeader: 'function',
  parseEnvelope: 'function',
  // Inbound — decoding
  authenticateMessage: 'function',
  parseMessage: 'function',
  summariseAuth: 'function',
  // Verify — durable DKIM-key archive
  fetchDkimKey: 'function',
  pickSignatureToArchive: 'function',
  extractPublicKey: 'function',
  toPem: 'function',
  // Email triggers — outbound
  sendmail: 'function',
  buildRawMessage: 'function',
  sanitizeSubject: 'function',
  newMessageId: 'function',
  rfc5322Date: 'function',
  withSignature: 'function',
  // Git ledger — storage
  createEventStore: 'function',
  withEventMutex: 'function',
  createGitrepo: 'function',
  saltedSenderHash: 'function',
  // Git ledger — optional OTS anchoring
  createOts: 'function',
  parseOtsBlockHeight: 'function',
  // Sequence — workflow completion engine
  shouldCount: 'function',
  applyReply: 'function',
  isComplete: 'function',
  firstPendingStep: 'function',
  stepDepsMet: 'function',
  eligibleSteps: 'function',
  meetsTrust: 'function',
  COUNT_REASONS: 'object',
  // Sequence — crypto sign-off engine
  shouldCountSignoff: 'function',
  applySignoff: 'function',
  signatures: 'function',
  CRYPTO_REASONS: 'object',
  // Verify — document notary
  createNotary: 'function',
  hashDocument: 'function',
  // Verify — offline durable verification + reverify
  createVerifier: 'function',
  findMatch: 'function',
  reverifyDkim: 'function',
  resolveUpgrade: 'function',
  pickSigner: 'function',
  // Email triggers — notification seam
  createNotifier: 'function',
  // Email triggers — time-driven occasions
  createSweep: 'function',
  referenceClockMs: 'function',
  isActive: 'function',
  // Email triggers — proof anchoring
  createProofAnchor: 'function',
  // Email triggers — inbound bounce (DSN)
  isDeliveryStatusReport: 'function',
  extractDsn: 'function',
  permanentFailures: 'function',
  parseDeliveryStatusBody: 'function',
};

test('public barrel exposes exactly the documented surface', () => {
  const actual = Object.keys(mailproof).sort();
  const expected = Object.keys(EXPECTED).sort();

  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));

  assert.deepEqual(missing, [], `index.js is missing exports: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `index.js exports undocumented names: ${extra.join(', ')}`);
});

test('every export is the expected kind (function vs constant)', () => {
  for (const [name, kind] of Object.entries(EXPECTED)) {
    assert.equal(
      typeof mailproof[name],
      kind,
      `export "${name}" should be a ${kind}, got ${typeof mailproof[name]}`,
    );
  }
});

test('no export is null or undefined', () => {
  for (const name of Object.keys(EXPECTED)) {
    assert.ok(mailproof[name] != null, `export "${name}" is null/undefined`);
  }
});
