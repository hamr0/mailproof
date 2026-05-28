'use strict';

// Unit coverage for the neutral default email surface (src/templates.js).
// renderDefault is pure, so we assert the { subject, defaultBody } shape per
// occasion directly — the integration tests cover that producers spread it
// into deliver() and that composeNotification still overrides it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDefault, statsBody } = require('../../src/templates');

const ev = (over = {}) => ({ id: 'ev1', title: 'My Event', ...over });

test('renderDefault: every kind returns a non-empty subject + defaultBody', () => {
  const kinds = [
    'activation', 'advance', 'reassigned', 'stats', 'bounce',
    'ack', 'completion', 'archived', 'overdue', 'proof_anchored',
  ];
  for (const kind of kinds) {
    const out = renderDefault(kind, { event: ev(), eventId: 'ev1', mode: 'workflow', snapshot: {} });
    assert.equal(typeof out.subject, 'string', `${kind} subject`);
    assert.ok(out.subject.length > 0, `${kind} subject non-empty`);
    assert.equal(typeof out.defaultBody, 'string', `${kind} body`);
    assert.ok(out.defaultBody.length > 0, `${kind} body non-empty`);
  }
});

test('renderDefault: titles fall back to eventId then a generic phrase', () => {
  assert.match(renderDefault('completion', { eventId: 'ev9' }).defaultBody, /"ev9" is now complete/);
  assert.match(renderDefault('completion', {}).subject, /your event/);
});

test('renderDefault: copy is brand-free (no product tag / host / verify CLI)', () => {
  for (const kind of ['activation', 'advance', 'ack', 'completion', 'proof_anchored', 'bounce']) {
    const { subject, defaultBody } = renderDefault(kind, {
      event: ev(), eventId: 'ev1', mode: 'workflow', failed: [], blockHeight: 1,
    });
    const blob = `${subject}\n${defaultBody}`;
    assert.doesNotMatch(blob, /\[gitdone\]|git-done\.com|gitdone-verify/i, `${kind} stays generic`);
  }
});

test('renderDefault: activation/advance distinguish crypto vs workflow and reminder', () => {
  assert.match(renderDefault('activation', { event: ev(), mode: 'crypto' }).subject, /Signature requested/);
  assert.match(renderDefault('activation', { event: ev(), mode: 'crypto', reminder: true }).subject, /^Reminder —/);
  assert.match(renderDefault('activation', { event: ev(), mode: 'workflow' }).subject, /Action needed/);
  assert.match(renderDefault('advance', { event: ev(), reminder: true }).subject, /^Reminder —/);
  // A named step is surfaced in the body clause.
  assert.match(
    renderDefault('advance', { event: ev(), step: { id: 's1', name: 'Sign off' } }).defaultBody,
    /"Sign off"/,
  );
});

test('renderDefault: bounce names failed recipients + diagnostic from ctx.failed', () => {
  const out = renderDefault('bounce', {
    event: ev(), eventId: 'ev1',
    failed: [{ finalRecipient: 'bad@x.example', diagnostic: '550 user unknown' }],
  });
  assert.match(out.subject, /Delivery problem: My Event/);
  assert.match(out.defaultBody, /to bad@x\.example/);
  assert.match(out.defaultBody, /550 user unknown/);
});

test('renderDefault: completion tally pluralises and proof_anchored names the block', () => {
  assert.match(renderDefault('completion', { event: ev(), countedCommits: 1 }).defaultBody, /\(1 recorded reply\)/);
  assert.match(renderDefault('completion', { event: ev(), countedCommits: 3 }).defaultBody, /\(3 recorded replies\)/);
  assert.match(renderDefault('proof_anchored', { event: ev(), blockHeight: 850000 }).defaultBody, /block 850000/);
});

test('statsBody: workflow renders a checkbox step list; crypto a signature tally', () => {
  const wf = statsBody({
    eventId: 'ev1', title: 'Flow', type: 'workflow', status: 'open',
    steps: [{ id: 's1', participant: 'a@x.example', status: 'pending' }],
  });
  assert.match(wf, /Type: workflow/);
  assert.match(wf, /\[ \] s1 → a@x\.example/);

  const cr = statsBody({
    eventId: 'ev2', title: 'Sign', type: 'crypto', status: 'open',
    threshold: 2, signatureCount: 1, signers: ['s@x.example'],
  });
  assert.match(cr, /Signatures: 1 \/ 2/);
  assert.match(cr, /- s@x\.example/);
});

test('renderDefault: an unknown kind degrades to a generic update, never throws', () => {
  const out = renderDefault('nope', { event: ev() });
  assert.match(out.defaultBody, /Update on "My Event"/);
});
