
// Workflow completion engine (SPEC §4) — transitions are pure, so the whole
// decision tree is covered without I/O. Re-anchored from gitdone's
// completion.test.js: per-step `minTrust`, machine-code `count_reason`s,
// top-level `status`/`completed_at`, camelCase `dependsOn`. Crypto/declaration/
// attestation/dedup/revoke cases are NOT here — they stay in gitdone (PRD §8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCount,
  applyReply,
  isComplete,
  firstPendingStep,
  stepDepsMet,
  eligibleSteps,
  meetsTrust,
  COUNT_REASONS,
} from '../../src/completion.js';

// -- builders (SPEC §3 shapes; gitdone domains → example.com) --

// Default = two-step sequential chain ('two' dependsOn 'one'). Override `flow`
// / `steps` for the parallel and custom-mix cases.
function mkWorkflow(overrides = {}) {
  return {
    id: 'ev1', type: 'workflow', flow: 'sequential', status: 'open',
    salt: 'a'.repeat(64),
    activated_at: '2026-01-01T00:00:00Z', completed_at: null, archived_at: null,
    steps: [
      { id: 'one', name: 'one', participant: 'one@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' },
      { id: 'two', name: 'two', participant: 'two@example.com', status: 'pending', dependsOn: ['one'], minTrust: 'verified' },
    ],
    ...overrides,
  };
}

function mkCommit(overrides = {}) {
  return {
    sequence: 1, trust_level: 'verified', participant_match: true,
    step_id: 'one', sender_hash: 'sha256:h-one', sender_domain: 'example.com',
    received_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

// -- trust comparator (per-step minTrust, classifier ordering) --

test('meetsTrust: strict ordering against step.minTrust', () => {
  const lenient = { minTrust: 'authorized' };
  assert.equal(meetsTrust({ trust_level: 'verified' }, lenient), true);
  assert.equal(meetsTrust({ trust_level: 'authorized' }, lenient), true);
  assert.equal(meetsTrust({ trust_level: 'unverified' }, lenient), false);
  const strict = { minTrust: 'verified' };
  assert.equal(meetsTrust({ trust_level: 'forwarded' }, strict), false);
  // defaults: absent minTrust ⇒ 'verified'; unknown level ⇒ weakest (fails)
  assert.equal(meetsTrust({ trust_level: 'verified' }, {}), true);
  assert.equal(meetsTrust({ trust_level: 'bogus' }, lenient), false);
});

// -- count decision over the dependency graph --

test('sequential: blocked step reads out_of_order', () => {
  const ev = mkWorkflow();   // 'two' dependsOn 'one'; 'one' pending
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one' })).count, true);
  const blocked = shouldCount(ev, mkCommit({ step_id: 'two' }));
  assert.equal(blocked.count, false);
  assert.equal(blocked.reason, COUNT_REASONS.OUT_OF_ORDER);
  assert.equal(blocked.step.id, 'two');
});

test('non-sequential flow: blocked-by-deps reads deps_unmet, not out_of_order', () => {
  // A custom/mixed flow with an explicit dependency that is not yet met.
  const ev = mkWorkflow({ flow: 'custom' });
  const blocked = shouldCount(ev, mkCommit({ step_id: 'two' }));
  assert.equal(blocked.count, false);
  assert.equal(blocked.reason, COUNT_REASONS.DEPS_UNMET);
});

test('parallel: no-dependency steps both count independently', () => {
  const ev = mkWorkflow({
    flow: 'parallel',
    steps: [
      { id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' },
      { id: 'two', participant: 'b@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' },
    ],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'two' })).count, true);
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one' })).count, true);
});

test('requires_attachment: blocks with missing_attachment and returns the step', () => {
  const ev = mkWorkflow({
    steps: [{ id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified', requires_attachment: true }],
  });
  const r = shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: false }));
  assert.equal(r.count, false);
  assert.equal(r.reason, COUNT_REASONS.MISSING_ATTACHMENT);
  assert.equal(r.step.id, 'one');   // caller composes the "please attach" reply
});

test('requires_attachment: counts when has_attachment=true', () => {
  const ev = mkWorkflow({
    steps: [{ id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified', requires_attachment: true }],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: true })).count, true);
});

test('step without requires_attachment ignores has_attachment', () => {
  const ev = mkWorkflow({
    steps: [{ id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' }],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: false })).count, true);
});

test('low trust → unverified_trust', () => {
  const r = shouldCount(mkWorkflow(), mkCommit({ trust_level: 'unverified' }));
  assert.equal(r.count, false);
  assert.equal(r.reason, COUNT_REASONS.UNVERIFIED_TRUST);
});

test('participant_match=false → wrong_participant', () => {
  const r = shouldCount(mkWorkflow(), mkCommit({ participant_match: false }));
  assert.equal(r.count, false);
  assert.equal(r.reason, COUNT_REASONS.WRONG_PARTICIPANT);
});

test('no step id → no_step; unknown step id → unknown_step', () => {
  assert.equal(shouldCount(mkWorkflow(), mkCommit({ step_id: null })).reason, COUNT_REASONS.NO_STEP);
  assert.equal(shouldCount(mkWorkflow(), mkCommit({ step_id: 'nope' })).reason, COUNT_REASONS.UNKNOWN_STEP);
});

test('event gates: not activated / archived / already complete', () => {
  assert.equal(shouldCount(mkWorkflow({ activated_at: null }), mkCommit()).reason, COUNT_REASONS.EVENT_NOT_ACTIVATED);
  assert.equal(shouldCount(mkWorkflow({ archived_at: '2026-02-01T00:00:00Z' }), mkCommit()).reason, COUNT_REASONS.EVENT_ARCHIVED);
  assert.equal(shouldCount(mkWorkflow({ status: 'complete' }), mkCommit()).reason, COUNT_REASONS.ALREADY_COMPLETE);
});

test('step already complete → already_complete', () => {
  const ev = mkWorkflow();
  const r1 = applyReply(ev, mkCommit());
  const r2 = shouldCount(r1.event, mkCommit({ sequence: 2 }));
  assert.equal(r2.count, false);
  assert.equal(r2.reason, COUNT_REASONS.ALREADY_COMPLETE);
});

// -- state transition --

test('applyReply: completing both steps flips event to complete', () => {
  const ev = mkWorkflow();
  const r1 = applyReply(ev, mkCommit({ sequence: 1, step_id: 'one' }));
  assert.equal(r1.applied, true);
  assert.equal(r1.event.steps[0].status, 'complete');
  assert.equal(r1.completedStep, 'one');
  assert.equal(r1.completedEvent, false);
  assert.equal(isComplete(r1.event), false);
  assert.equal(r1.event.status, 'open');

  const r2 = applyReply(r1.event, mkCommit({ sequence: 2, step_id: 'two', sender_hash: 'sha256:h-two' }));
  assert.equal(r2.applied, true);
  assert.equal(r2.completedEvent, true);
  assert.equal(isComplete(r2.event), true);
  assert.equal(r2.event.status, 'complete');
});

test('applyReply: step records commit_sequence; event stamps completed_at on the final step', () => {
  const ev = mkWorkflow({
    steps: [{ id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' }],
  });
  const r = applyReply(ev, mkCommit({ sequence: 7 }), { now: '2026-05-01T00:00:00Z' });
  assert.equal(r.event.steps[0].commit_sequence, 7);
  assert.equal(r.event.completed_at, '2026-05-01T00:00:00Z');
  assert.equal(r.event.status, 'complete');
});

test('applyReply: non-counting reply returns applied:false with the decision', () => {
  const r = applyReply(mkWorkflow(), mkCommit({ participant_match: false }));
  assert.equal(r.applied, false);
  assert.equal(r.decision.reason, COUNT_REASONS.WRONG_PARTICIPANT);
});

test('applyReply: does not mutate its input event', () => {
  const ev = mkWorkflow({
    steps: [{ id: 'one', participant: 'a@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' }],
  });
  const snapshot = JSON.stringify(ev);
  applyReply(ev, mkCommit());
  assert.equal(JSON.stringify(ev), snapshot);
});

// -- predicates --

test('firstPendingStep: first non-complete, or null when all done', () => {
  assert.equal(firstPendingStep(mkWorkflow()).id, 'one');
  const done = mkWorkflow({ steps: [{ id: 'one', status: 'complete' }, { id: 'two', status: 'complete' }] });
  assert.equal(firstPendingStep(done), null);
});

test('eligibleSteps / stepDepsMet: only non-complete steps whose deps are met', () => {
  const ev = mkWorkflow();   // 'two' dependsOn 'one' (pending)
  assert.deepEqual(eligibleSteps(ev).map((s) => s.id), ['one']);
  assert.equal(stepDepsMet(ev, ev.steps[1]), false);

  const afterOne = applyReply(ev, mkCommit({ step_id: 'one' })).event;
  assert.deepEqual(eligibleSteps(afterOne).map((s) => s.id), ['two']);
  assert.equal(stepDepsMet(afterOne, afterOne.steps[1]), true);
});
