// Sequencing pillar — the crypto sign-off engine (SPEC §4, crypto-event shape).
//
// mailproof's SECOND generic coordination mode (the first is the workflow
// events engine in completion.js). ONE parameterized engine, not gitdone's
// three modes (the same discipline that collapsed events to one `dependsOn`
// rule):
//   · signers       — an explicit email allow-list, OR `open` (any sender)
//   · threshold      — distinct signatures to complete; 1 = single-signer
//                      "declaration", N = count-toward-goal
//   · requiredDocHash — optional single hash; the "email + doc" two-layer
//
// A reply COUNTS as a signature iff, in order:
//   · the event is activated and not archived/complete
//   · it is DKIM-verified (trust_level === 'verified' — see note below)
//   · the sender is NOT the initiator (anti-self-dealing: the initiator
//     orchestrates and may reply, but their reply can never stand as a
//     verification — it is committed for audit, never counted)
//   · the sender is a signer (or any sender, if the event is open)
//   · the sender is distinct from those already counted
//   · if requiredDocHash is set, the reply carries an attachment whose sha256
//     matches it
//   the event completes (locks) when the distinct signature count ≥ threshold.
//
// Trust is hardcoded to `verified` and NOT per-event configurable: crypto is
// the high-assurance mode, and letting a forwarded/authorized reply stand as a
// cryptographic signature is a footgun. (Workflow's per-step `minTrust` is the
// place for graded trust; sign-off is all-or-nothing.)
//
// Pure: no I/O, no crypto. Like completion.js, sender-identity resolution is
// the orchestrator's job — the engine reads precomputed `signer_match` and
// `is_initiator` booleans off the commit (parallel to workflow's
// `participant_match`); the orchestrator compares the plaintext sender against
// `signers`/`open`/`initiator` at ingest (plaintext never reaches the ledger,
// SPEC §6). Distinct-dedup keys off the commit's salted `sender_hash`.
// Persistence + the completion ledger commit are the caller's job.
//
// LIFTED FROM gitdone's completion.js — `shouldCountDeclaration`,
// `shouldCountAttestation`, and the `applyReply` crypto branches — collapsed to
// this one lean engine per the two-mode pivot (decisions-log 2026-05-24).
// DROPPED, they stay gitdone policy (PRD §8.2-8.4): `revoke`,
// `latest`/`accumulating` dedup (distinct-only here), multi-doc strict
// manifests + `reference_docs` registration, per-attestor progress buckets,
// attestor-PII redaction, magic-link/web flow. Re-anchored to SPEC like m6:
// machine-code `count_reason`s, camelCase fields, top-level `status`/
// `completed_at` (not gitdone's nested `completion` object).

'use strict';

// The accept-with-flag taxonomy for sign-off (SPEC §4). Frozen and exported so
// consumers and tests share one source of truth for "why didn't this count?".
// Self-contained, mirroring completion.js's COUNT_REASONS — a few string values
// coincide with the workflow taxonomy, but the two engines stay independent.
const CRYPTO_REASONS = Object.freeze({
  EVENT_NOT_ACTIVATED: 'event_not_activated',
  EVENT_ARCHIVED: 'event_archived',
  ALREADY_COMPLETE: 'already_complete',
  UNVERIFIED_TRUST: 'unverified_trust',
  INITIATOR_SELF_REPLY: 'initiator_self_reply',
  NOT_A_SIGNER: 'not_a_signer',
  ALREADY_SIGNED: 'already_signed',
  DOC_HASH_MISMATCH: 'doc_hash_mismatch',
});

// --- pure predicates ---

function isComplete(event) {
  return !!(event && event.status === 'complete');
}

// The distinct signatures already counted — one source of truth for "who
// counted" and the count-to-threshold record.
function signatures(event) {
  return event && Array.isArray(event.signatures) ? event.signatures : [];
}

function alreadySigned(event, commit) {
  const h = commit && commit.sender_hash;
  if (!h) return false;
  return signatures(event).some((s) => s && s.sender_hash === h);
}

// requiredDocHash gate: when set, some attachment's sha256 must match it.
// Hashes are the notary's `sha256:`-prefixed format (one source of truth —
// notary.hashDocument). Absent requirement ⇒ satisfied.
function docHashMatches(event, commit) {
  const req = event && event.requiredDocHash;
  if (!req) return true;
  const atts = commit && Array.isArray(commit.attachments) ? commit.attachments : [];
  return atts.some((a) => a && a.sha256 === req);
}

// --- count decision ---

function deny(reason) {
  return { count: false, reason };
}

function shouldCount(event, commit) {
  if (!event.activated_at) return deny(CRYPTO_REASONS.EVENT_NOT_ACTIVATED);
  if (event.archived_at) return deny(CRYPTO_REASONS.EVENT_ARCHIVED);
  if (isComplete(event)) return deny(CRYPTO_REASONS.ALREADY_COMPLETE);
  if (!commit || commit.trust_level !== 'verified') return deny(CRYPTO_REASONS.UNVERIFIED_TRUST);
  if (commit.is_initiator) return deny(CRYPTO_REASONS.INITIATOR_SELF_REPLY);
  if (!commit.signer_match) return deny(CRYPTO_REASONS.NOT_A_SIGNER);
  if (alreadySigned(event, commit)) return deny(CRYPTO_REASONS.ALREADY_SIGNED);
  if (!docHashMatches(event, commit)) return deny(CRYPTO_REASONS.DOC_HASH_MISMATCH);
  return { count: true };
}

// --- state transition (pure) ---

// Returns a NEW event; only transitions when shouldCount(...).count === true.
// Appends the distinct signature, then locks the event (status:'complete' +
// completed_at) once the count reaches threshold (default 1). The signature
// stores only non-PII (salted `sender_hash`, plaintext `sender_domain`) per
// SPEC §6; the triggering commit's `received_at` is the timestamp.
function applyReply(event, commit, { now = new Date().toISOString() } = {}) {
  const decision = shouldCount(event, commit);
  if (!decision.count) return { event, applied: false, decision };

  const signature = {
    sender_hash: commit.sender_hash,
    sender_domain: commit.sender_domain || null,
    commit_sequence: commit.sequence,
    received_at: commit.received_at,
    trust_level: commit.trust_level,
  };
  const sigs = [...signatures(event), signature];
  const threshold = event.threshold || 1;
  const reached = sigs.length >= threshold;
  const updated = {
    ...event,
    signatures: sigs,
    status: reached ? 'complete' : (event.status || 'open'),
    completed_at: reached ? now : (event.completed_at || null),
  };
  return {
    event: updated,
    applied: true,
    decision,
    signatureCount: sigs.length,
    completedEvent: reached,
  };
}

module.exports = {
  shouldCount,
  applyReply,
  isComplete,
  signatures,
  CRYPTO_REASONS,
};
