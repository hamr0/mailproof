'use strict';

// Crypto sign-off engine (SPEC §4 crypto-event shape) — transitions are pure,
// so the whole decision tree is covered without I/O. Re-anchored from gitdone's
// completion.test.js declaration/attestation cases, collapsed onto ONE
// parameterized engine: threshold:1 IS the old "declaration"; distinct-count to
// N IS the old "attestation unique". The dropped policy tail — latest/
// accumulating dedup, strict multi-doc manifests, revoke, attestor-PII — has NO
// cases here by design (it stays in gitdone, PRD §8). Domains → example.com.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldCount,
  applyReply,
  isComplete,
  signatures,
  CRYPTO_REASONS,
} = require('../../src/crypto');

// -- builders (SPEC §3 crypto shape) --

function mkEvent(overrides = {}) {
  return {
    id: 'c1', type: 'crypto', status: 'open',
    initiator: 'organiser@example.com',
    salt: 'a'.repeat(64),
    activated_at: '2026-01-01T00:00:00Z', completed_at: null, archived_at: null,
    signers: ['a@example.com', 'b@example.com', 'c@example.com'],
    open: false,
    threshold: 3,
    requiredDocHash: null,
    signatures: [],
    ...overrides,
  };
}

// A counting commit: DKIM-verified, a matched non-initiator signer. The engine
// reads precomputed signer_match / is_initiator (orchestrator's job), so tests
// set them directly — exactly as completion.test.js sets participant_match.
function mkCommit(overrides = {}) {
  return {
    sequence: 1, trust_level: 'verified',
    signer_match: true, is_initiator: false,
    sender_hash: 'sha256:s1', sender_domain: 'example.com',
    received_at: '2026-04-19T00:00:00Z',
    attachments: [],
    ...overrides,
  };
}

// -- threshold:1 == declaration --

test('declaration (threshold 1): a matching signer counts and completes', () => {
  const ev = mkEvent({ threshold: 1 });
  const r = applyReply(ev, mkCommit({ sequence: 4 }), { now: '2026-05-01T00:00:00Z' });
  assert.equal(r.applied, true);
  assert.equal(r.completedEvent, true);
  assert.equal(r.signatureCount, 1);
  assert.equal(isComplete(r.event), true);
  assert.equal(r.event.completed_at, '2026-05-01T00:00:00Z');
  assert.equal(signatures(r.event)[0].sender_hash, 'sha256:s1');
});

test('declaration: a non-signer does not count', () => {
  const ev = mkEvent({ threshold: 1 });
  const r = applyReply(ev, mkCommit({ signer_match: false }));
  assert.equal(r.applied, false);
  assert.equal(r.decision.reason, CRYPTO_REASONS.NOT_A_SIGNER);
  assert.equal(isComplete(r.event), false);
});

test('declaration: second reply after completion does not re-count', () => {
  const ev = mkEvent({ threshold: 1 });
  const r1 = applyReply(ev, mkCommit({ sequence: 4 }));
  const r2 = applyReply(r1.event, mkCommit({ sequence: 5, sender_hash: 'sha256:s2' }));
  assert.equal(r2.applied, false);
  assert.equal(r2.decision.reason, CRYPTO_REASONS.ALREADY_COMPLETE);
  assert.equal(signatures(r2.event).length, 1);
});

// -- distinct-count to N == attestation (unique only) --

test('distinct signers count toward threshold and lock at N', () => {
  let ev = mkEvent({ threshold: 3 });
  for (let i = 0; i < 3; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: `sha256:s${i}`, sequence: i + 1 }));
    assert.equal(r.applied, true);
    ev = r.event;
  }
  assert.equal(signatures(ev).length, 3);
  assert.equal(isComplete(ev), true);
});

test('a duplicate sender does not advance the distinct count', () => {
  let ev = mkEvent({ threshold: 2 });
  const r1 = applyReply(ev, mkCommit({ sender_hash: 'sha256:same', sequence: 1 }));
  assert.equal(r1.applied, true);
  ev = r1.event;
  const r2 = applyReply(ev, mkCommit({ sender_hash: 'sha256:same', sequence: 2 }));
  assert.equal(r2.applied, false);
  assert.equal(r2.decision.reason, CRYPTO_REASONS.ALREADY_SIGNED);
  assert.equal(signatures(r2.event).length, 1);
  assert.equal(isComplete(r2.event), false, 'threshold not met via one distinct sender');
});

test('post-threshold reply from a new signer is rejected as already_complete', () => {
  let ev = mkEvent({ threshold: 1 });
  ev = applyReply(ev, mkCommit({ sender_hash: 'sha256:s1', sequence: 1 })).event;
  const r = applyReply(ev, mkCommit({ sender_hash: 'sha256:s2', sequence: 2 }));
  assert.equal(r.applied, false);
  assert.equal(r.decision.reason, CRYPTO_REASONS.ALREADY_COMPLETE);
});

// -- initiator self-reply (anti-self-dealing; user decision 2026-05-24) --

test('initiator self-reply is never counted, even when verified and a signer', () => {
  const ev = mkEvent({ threshold: 1 });
  const r = applyReply(ev, mkCommit({ is_initiator: true }));
  assert.equal(r.applied, false);
  assert.equal(r.decision.reason, CRYPTO_REASONS.INITIATOR_SELF_REPLY);
  assert.equal(isComplete(r.event), false);
});

// -- trust gate is hardcoded to verified --

test('a non-verified reply never counts (forwarded/authorized/unverified)', () => {
  const ev = mkEvent({ threshold: 1 });
  for (const level of ['forwarded', 'authorized', 'unverified', 'bogus']) {
    const r = applyReply(ev, mkCommit({ trust_level: level }));
    assert.equal(r.applied, false, `${level} must not count`);
    assert.equal(r.decision.reason, CRYPTO_REASONS.UNVERIFIED_TRUST);
  }
});

// -- open mode (orchestrator sets signer_match=true for any sender) --

test('open: any verified non-initiator sender counts', () => {
  const ev = mkEvent({ threshold: 2, signers: [], open: true });
  const r1 = applyReply(ev, mkCommit({ sender_hash: 'sha256:x', signer_match: true }));
  const r2 = applyReply(r1.event, mkCommit({ sender_hash: 'sha256:y', signer_match: true, sequence: 2 }));
  assert.equal(r2.applied, true);
  assert.equal(isComplete(r2.event), true);
});

// -- requiredDocHash: the "email + doc" two-layer gate --

test('requiredDocHash: counts only when an attachment hash matches', () => {
  const docHash = 'sha256:' + 'f'.repeat(64);
  const ev = mkEvent({ threshold: 1, requiredDocHash: docHash });

  const noAtt = applyReply(ev, mkCommit({ attachments: [] }));
  assert.equal(noAtt.applied, false);
  assert.equal(noAtt.decision.reason, CRYPTO_REASONS.DOC_HASH_MISMATCH);

  const wrong = applyReply(ev, mkCommit({ attachments: [{ filename: 'x.pdf', sha256: 'sha256:' + '0'.repeat(64) }] }));
  assert.equal(wrong.applied, false);
  assert.equal(wrong.decision.reason, CRYPTO_REASONS.DOC_HASH_MISMATCH);

  const right = applyReply(ev, mkCommit({
    attachments: [{ filename: 'a.pdf', sha256: 'sha256:0bad' }, { filename: 'b.pdf', sha256: docHash }],
  }));
  assert.equal(right.applied, true);
  assert.equal(isComplete(right.event), true);
});

// -- lifecycle gates --

test('lifecycle gates: not activated / archived', () => {
  const pending = applyReply(mkEvent({ activated_at: null }), mkCommit());
  assert.equal(pending.decision.reason, CRYPTO_REASONS.EVENT_NOT_ACTIVATED);
  const archived = applyReply(mkEvent({ archived_at: '2026-02-01T00:00:00Z' }), mkCommit());
  assert.equal(archived.decision.reason, CRYPTO_REASONS.EVENT_ARCHIVED);
});

// -- purity: applyReply returns a NEW event, never mutates its input --

test('applyReply does not mutate the input event', () => {
  const ev = mkEvent({ threshold: 2 });
  const before = JSON.stringify(ev);
  applyReply(ev, mkCommit());
  assert.equal(JSON.stringify(ev), before);
  assert.equal(ev.signatures.length, 0);
});

// -- provable trims: gitdone's dropped policy fields are inert, not honored --

test('gitdone policy fields are ignored: dedup/revoke/reference_docs/mode have no effect', () => {
  // A gitdone-shaped crypto event carrying the dropped tail. The lean engine
  // must apply ONLY distinct-count-to-threshold: `dedup:'accumulating'` must
  // NOT keep the event open past threshold, a `revoked_senders` entry must NOT
  // un-count, and `reference_docs`/`mode` must be inert.
  let ev = mkEvent({
    threshold: 2,
    mode: 'attestation',
    dedup: 'accumulating',
    revoked_senders: [{ sender_hash: 'sha256:s0' }],
    reference_docs: [{ filename: 'm.pdf', sha256: 'sha256:dead' }],
  });
  ev = applyReply(ev, mkCommit({ sender_hash: 'sha256:s0', sequence: 1 })).event;
  const r = applyReply(ev, mkCommit({ sender_hash: 'sha256:s1', sequence: 2 }));
  assert.equal(r.applied, true);
  assert.equal(isComplete(r.event), true, 'accumulating did NOT keep it open; locks at threshold');
  assert.equal(signatures(r.event).length, 2, 'revoked_senders did NOT un-count s0');
});

// -- reason-order: trust is the foundational gate, checked before identity --

test('an unverified non-signer reads unverified_trust (trust gate is first)', () => {
  const ev = mkEvent({ threshold: 1 });
  const r = shouldCount(ev, mkCommit({ trust_level: 'unverified', signer_match: false }));
  assert.equal(r.reason, CRYPTO_REASONS.UNVERIFIED_TRUST);
});
