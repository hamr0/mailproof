
// Unit tests for the event store's PURE surface — no filesystem. The
// disk-touching primitives (loadEvent/createEvent/activateEvent/editEvent/
// record*) are exercised in tests/integration/event-store.test.js, matching
// the unit-vs-integration split established for outbound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore, buildEventRecord, expandFlow } from '../../src/event-store.js';

// A store needs only dataDir to construct; the pure helpers ignore it.
const store = createEventStore({ dataDir: '/nonexistent' });

const EVENT = {
  id: 'demo123',
  steps: [
    { id: 'step1', name: 'Legal review', participant: 'legal@example.com', status: 'pending' },
    { id: 'step2', name: 'CEO sign', participant: 'CEO@example.com', status: 'pending' },
  ],
};

test('createEventStore: requires dataDir', () => {
  assert.throws(() => createEventStore({}), /dataDir required/);
  assert.throws(() => createEventStore(), /dataDir required/);
});

test('findStep: locates step by id', () => {
  assert.equal(store.findStep(EVENT, 'step1').name, 'Legal review');
});

test('findStep: returns null when step missing', () => {
  assert.equal(store.findStep(EVENT, 'stepZZZ'), null);
});

test('findStep: tolerates null event / null stepId', () => {
  assert.equal(store.findStep(null, 'step1'), null);
  assert.equal(store.findStep({ steps: [] }, null), null);
});

test('senderMatchesStep: case-insensitive email match', () => {
  const step = store.findStep(EVENT, 'step2'); // participant CEO@example.com
  assert.equal(store.senderMatchesStep('ceo@example.com', step), true);
  assert.equal(store.senderMatchesStep('CEO@example.com', step), true);
  assert.equal(store.senderMatchesStep('  ceo@example.com  ', step), true);
});

test('senderMatchesStep: mismatch returns false', () => {
  const step = store.findStep(EVENT, 'step1');
  assert.equal(store.senderMatchesStep('attacker@evil.com', step), false);
});

test('senderMatchesStep: tolerates null inputs', () => {
  assert.equal(store.senderMatchesStep(null, null), false);
  assert.equal(store.senderMatchesStep('a@b', { participant: null }), false);
});

test('store: does not expose dropped magic-link policy (confirmActivationLink)', () => {
  assert.equal(store.confirmActivationLink, undefined);
});

// --- expandFlow (flow sugar → canonical dependsOn graph, SPEC §3) ---

test('expandFlow: sequential builds a linear dependsOn chain', () => {
  const steps = expandFlow([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'sequential');
  assert.deepEqual(steps[0].dependsOn, []);
  assert.deepEqual(steps[1].dependsOn, ['a']);
  assert.deepEqual(steps[2].dependsOn, ['b']);
  // per-step lifecycle defaults filled
  assert.equal(steps[0].status, 'pending');
  assert.equal(steps[0].commit_sequence, null);
});

test('expandFlow: parallel gives every step empty deps', () => {
  const steps = expandFlow([{ id: 'a' }, { id: 'b' }], 'parallel');
  assert.deepEqual(steps.map((s) => s.dependsOn), [[], []]);
});

test('expandFlow: custom preserves caller dependsOn verbatim', () => {
  const steps = expandFlow([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a', 'b'] }], 'custom');
  assert.deepEqual(steps[1].dependsOn, ['a']);
  assert.deepEqual(steps[2].dependsOn, ['a', 'b']);
});

// --- buildEventRecord (two-mode normalization + structural validation) ---

test('buildEventRecord: workflow defaults — type/status/flow + expanded steps', () => {
  const ev = buildEventRecord({ id: 'w1', salt: 's', title: 'T', initiator: 'o@x.com',
    steps: [{ id: 'a', participant: 'a@x.com' }, { id: 'b', participant: 'b@x.com' }] });
  assert.equal(ev.type, 'workflow');
  assert.equal(ev.status, 'open');
  assert.equal(ev.flow, 'sequential');
  assert.equal(ev.activated_at, null);
  assert.equal(ev.completed_at, null);
  assert.deepEqual(ev.steps[1].dependsOn, ['a']);
});

test('buildEventRecord: rejects unknown type, missing/duplicate step ids', () => {
  assert.throws(() => buildEventRecord({ id: 'x', salt: 's', type: 'banana' }), /unknown type/);
  assert.throws(() => buildEventRecord({ id: 'x', salt: 's', steps: [{ participant: 'a@x.com' }] }), /needs an id/);
  assert.throws(() => buildEventRecord({ id: 'x', salt: 's', steps: [{ id: 'a' }, { id: 'a' }] }), /unique/);
});

test('buildEventRecord: crypto normalizes signers/threshold and inits signatures', () => {
  const ev = buildEventRecord({ id: 'c1', salt: 's', type: 'crypto', initiator: 'o@x.com',
    signers: ['Alice@X.com', 'BOB@x.com'] });
  assert.equal(ev.type, 'crypto');
  assert.deepEqual(ev.signers, ['alice@x.com', 'bob@x.com'], 'lowercased');
  assert.equal(ev.threshold, 1, 'defaults to 1');
  assert.equal(ev.open, false);
  assert.equal(ev.requiredDocHash, null);
  assert.deepEqual(ev.signatures, []);
});

test('buildEventRecord: crypto rejects threshold < 1 and an uncountable event', () => {
  assert.throws(() => buildEventRecord({ id: 'c', salt: 's', type: 'crypto', signers: ['a@x.com'], threshold: 0 }), /threshold/);
  assert.throws(() => buildEventRecord({ id: 'c', salt: 's', type: 'crypto', signers: [], open: false }), /signers.*or.*open/);
  // open with no signers is valid (anyone may sign)
  const open = buildEventRecord({ id: 'c', salt: 's', type: 'crypto', open: true });
  assert.equal(open.open, true);
});
