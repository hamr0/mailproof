// Sequencing pillar — the workflow completion engine (SPEC §4).
//
// Given an event and an incoming reply commit, decides whether the reply
// COUNTS toward progress (the accept-with-flag `counted` flag), applies the
// state transition, and reports whether the event is now complete.
//
// Pure: no I/O. `applyReply` returns a NEW event and never mutates its input.
// Persistence (atomic write + repo sync) and the completion ledger commit are
// the caller's job (wired in `create()/ingest()` — see DESIGN), exactly as
// gitdone's receive.js orchestrates them. The cascade (notifying steps that
// became eligible) is also orchestration: read `eligibleSteps(next)` after a
// transition.
//
// Workflow rule — ONE model (no sequential/parallel branching in the engine):
//   a reply counts for its step iff, in order:
//     · the event is activated and not archived/complete
//     · the sender is the step's participant (participant_match)
//     · the reply names a known, not-yet-complete step
//     · trust_level meets the step's minTrust (§1 ordering, from classifier)
//     · every id in the step's dependsOn is complete
//     · if the step requires_attachment, the reply carried one
//   the event completes when every step is complete.
// `flow` ("sequential" | "parallel" | "custom") is stored for audit and only
// affects ONE thing: a blocked-by-deps reply reads `out_of_order` under
// sequential flow, `deps_unmet` otherwise. Eligibility itself is always the
// single dependsOn rule — `createEvent` expands `flow:'sequential'` into a
// linear dependsOn chain, so the engine never needs a second code path.
//
// LIFTED FROM gitdone's completion.js, trimmed to the workflow subset per the
// PRD §8 NO-GO table (DROPPED, they stay in gitdone as policy on the hooks):
// crypto declaration/attestation (§8.2), strict signing + reference_docs
// (§8.3), revoke/threshold/dedup (§8.4). Re-anchored to SPEC: machine-code
// `count_reason`s (not prose), per-step `minTrust` (not a per-event
// `min_trust_level`), top-level `status`/`completed_at` (not a nested
// `completion` object), camelCase `dependsOn`/`minTrust`. Document-hash
// verification is the notary (PRD §4.1), not part of this engine.

'use strict';

const { TRUST_LEVELS } = require('./classifier');

// The accept-with-flag taxonomy (SPEC §4). Exported so consumers and tests
// share one source of truth for "why didn't this reply count?".
const COUNT_REASONS = Object.freeze({
  EVENT_NOT_ACTIVATED: 'event_not_activated',
  EVENT_ARCHIVED: 'event_archived',
  ALREADY_COMPLETE: 'already_complete',
  WRONG_PARTICIPANT: 'wrong_participant',
  NO_STEP: 'no_step',
  UNKNOWN_STEP: 'unknown_step',
  UNVERIFIED_TRUST: 'unverified_trust',
  DEPS_UNMET: 'deps_unmet',
  OUT_OF_ORDER: 'out_of_order',
  MISSING_ATTACHMENT: 'missing_attachment',
});

// --- trust comparator (one source of truth: classifier's TRUST_LEVELS) ---
// TRUST_LEVELS is strongest-first, so a SMALLER index is stronger. An unknown
// level ranks weakest (Infinity) — an unrecognised commit trust never meets a
// real gate, and a malformed minTrust never lets a weak reply through.
function trustRank(level) {
  const i = TRUST_LEVELS.indexOf(level);
  return i < 0 ? Infinity : i;
}

function meetsTrust(commit, step) {
  const min = (step && step.minTrust) || 'verified';
  return trustRank(commit && commit.trust_level) <= trustRank(min);
}

// --- step-graph predicates (pure) ---

// Re-exported from event-store (the schema-level canonical predicate, lifted
// in spirit from gitdone's 2026-05-28 closed_by canonicalisation — one
// definition for "is this event complete?", not one per engine).
const { isComplete } = require('./event-store');

function findStep(event, stepId) {
  if (!event || !Array.isArray(event.steps) || !stepId) return null;
  return event.steps.find((s) => s && s.id === stepId) || null;
}

function firstPendingStep(event) {
  if (!event || !Array.isArray(event.steps)) return null;
  return event.steps.find((s) => s && s.status !== 'complete') || null;
}

// A step is eligible iff every id in its dependsOn is complete. Empty/absent
// dependsOn ⇒ always eligible (the parallel case falls out for free).
function stepDepsMet(event, step) {
  const deps = (step && step.dependsOn) || [];
  if (deps.length === 0) return true;
  const steps = (event && event.steps) || [];
  for (const depId of deps) {
    const dep = steps.find((s) => s && s.id === depId);
    if (!dep || dep.status !== 'complete') return false;
  }
  return true;
}

function eligibleSteps(event) {
  return ((event && event.steps) || []).filter(
    (s) => s && s.status !== 'complete' && stepDepsMet(event, s)
  );
}

// --- count decision ---

function deny(reason, step) {
  return step ? { count: false, reason, step } : { count: false, reason };
}

function shouldCount(event, commit) {
  if (!event.activated_at) return deny(COUNT_REASONS.EVENT_NOT_ACTIVATED);
  if (event.archived_at) return deny(COUNT_REASONS.EVENT_ARCHIVED);
  if (isComplete(event)) return deny(COUNT_REASONS.ALREADY_COMPLETE);
  if (!commit.participant_match) return deny(COUNT_REASONS.WRONG_PARTICIPANT);
  if (!commit.step_id) return deny(COUNT_REASONS.NO_STEP);

  const step = findStep(event, commit.step_id);
  if (!step) return deny(COUNT_REASONS.UNKNOWN_STEP);
  if (step.status === 'complete') return deny(COUNT_REASONS.ALREADY_COMPLETE, step);
  if (!meetsTrust(commit, step)) return deny(COUNT_REASONS.UNVERIFIED_TRUST, step);
  if (!stepDepsMet(event, step)) {
    const reason = event.flow === 'sequential'
      ? COUNT_REASONS.OUT_OF_ORDER
      : COUNT_REASONS.DEPS_UNMET;
    return deny(reason, step);
  }
  // requires_attachment is the generic kernel doc gate (PRD §4.1, Q2): the
  // reply must carry SOME attachment. Matching a specific document hash is the
  // notary's `verifyDocument`, not a completion gate.
  if (step.requires_attachment && !commit.has_attachment) {
    return deny(COUNT_REASONS.MISSING_ATTACHMENT, step);
  }
  return { count: true, step };
}

// --- state transition (pure) ---

// Returns a NEW event; only transitions when shouldCount(...).count === true.
// On a counting reply: marks the step complete with the triggering
// `commit_sequence` (the commit's `received_at` is the timestamp — SPEC §3
// keeps no separate step.completed_at), and flips the event to complete with
// `completed_at` once every step is done.
function applyReply(event, commit, { now = new Date().toISOString() } = {}) {
  const decision = shouldCount(event, commit);
  if (!decision.count) return { event, applied: false, decision };

  const steps = event.steps.map((s) =>
    s.id === commit.step_id
      ? { ...s, status: 'complete', commit_sequence: commit.sequence }
      : s
  );
  const allDone = steps.every((s) => s.status === 'complete');
  const updated = {
    ...event,
    steps,
    status: allDone ? 'complete' : (event.status || 'open'),
    completed_at: allDone ? now : (event.completed_at || null),
  };
  return {
    event: updated,
    applied: true,
    decision,
    completedStep: commit.step_id,
    completedEvent: allDone,
  };
}

module.exports = {
  shouldCount,
  applyReply,
  isComplete,
  firstPendingStep,
  stepDepsMet,
  eligibleSteps,
  meetsTrust,
  COUNT_REASONS,
};
