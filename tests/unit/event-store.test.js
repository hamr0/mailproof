'use strict';

// Unit tests for the event store's PURE surface — no filesystem. The
// disk-touching primitives (loadEvent/createEvent/activateEvent/editEvent/
// record*) are exercised in tests/integration/event-store.test.js, matching
// the unit-vs-integration split established for outbound.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventStore } = require('../../src/event-store');

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
