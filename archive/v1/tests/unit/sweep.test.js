
// Unit tests for sweep's PURE predicates — the reference clock and the
// active-cohort gate that drive the overdue/archive decisions. No fs, no
// process; the bound sweep() that walks the store + emits occasions is covered
// in tests/integration/sweep.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceClockMs, isActive } from '../../src/sweep.js';

const ms = (iso) => new Date(iso).getTime();

test('referenceClockMs: null when the event is missing or never activated', () => {
  assert.equal(referenceClockMs(null), null);
  assert.equal(referenceClockMs({}), null);
  assert.equal(referenceClockMs({ activated_at: null }), null);
});

test('referenceClockMs: falls back to activated_at when no pending step has a deadline', () => {
  const e = { activated_at: '2026-01-10T00:00:00Z', type: 'workflow', steps: [{ status: 'pending' }] };
  assert.equal(referenceClockMs(e), ms('2026-01-10T00:00:00Z'));
});

test('referenceClockMs: uses the MAX deadline over pending steps, ignoring complete ones', () => {
  const e = {
    activated_at: '2026-01-01T00:00:00Z',
    type: 'workflow',
    steps: [
      { status: 'pending', deadline: '2026-02-01' },
      { status: 'pending', deadline: '2026-03-01' },
      { status: 'complete', deadline: '2026-12-01' }, // ignored — already done
    ],
  };
  assert.equal(referenceClockMs(e), ms('2026-03-01'));
});

test('referenceClockMs: a crypto event (no steps) clocks from activated_at', () => {
  const e = { activated_at: '2026-04-01T00:00:00Z', type: 'crypto', signers: ['a@x.example'] };
  assert.equal(referenceClockMs(e), ms('2026-04-01T00:00:00Z'));
});

test('referenceClockMs: null when activated_at is unparseable', () => {
  assert.equal(referenceClockMs({ activated_at: 'not-a-date', type: 'crypto' }), null);
});

test('isActive: true only for an activated, un-archived, incomplete event', () => {
  assert.equal(isActive({ activated_at: '2026-01-01T00:00:00Z', status: 'open' }), true);
});

test('isActive: false for null / never-activated / archived / complete', () => {
  assert.equal(isActive(null), false);
  assert.equal(isActive({ activated_at: null }), false);
  assert.equal(isActive({ activated_at: '2026-01-01T00:00:00Z', archived_at: '2026-02-01T00:00:00Z' }), false);
  assert.equal(isActive({ activated_at: '2026-01-01T00:00:00Z', status: 'complete' }), false);
});
