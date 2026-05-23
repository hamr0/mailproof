'use strict';

// Integration tests for the event store's filesystem-backed primitives,
// lifted from gitdone's event-store.test.js and adapted to the injected-config
// factory (createEventStore({ dataDir }) — no env var, no config-singleton
// cache busting). Each touches a real tmp dataDir.
//
// Two gitdone tests exercise the *activated* edit path, which writes an audit
// commit via gitrepo (module 5b): the audit-commit assertion is skipped here
// with a pointer to 5b. The activateEvent and last_send_error-clearing
// behaviors don't depend on that commit and are covered now (gitrepo sync in
// activateEvent is best-effort and no-ops until 5b lands).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createEventStore } = require('../../src/event-store');

let tmpDir;
let store;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-test-'));
  store = createEventStore({ dataDir: tmpDir });
  await fs.mkdir(path.join(tmpDir, 'events'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'events', 'demo123.json'),
    JSON.stringify({
      id: 'demo123',
      type: 'event',
      flow: 'sequential',
      title: 'Demo',
      initiator: 'init@example.com',
      steps: [
        { id: 'step1', name: 'Legal review', participant: 'legal@example.com', status: 'pending' },
        { id: 'step2', name: 'CEO sign', participant: 'CEO@example.com', status: 'pending' },
      ],
    })
  );
});

after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- loadEvent ---

test('loadEvent: returns parsed event when file exists', async () => {
  const event = await store.loadEvent('demo123');
  assert.ok(event);
  assert.equal(event.id, 'demo123');
  assert.equal(event.steps.length, 2);
});

test('loadEvent: returns null for unknown event id', async () => {
  assert.equal(await store.loadEvent('nonexistent'), null);
});

test('loadEvent: rejects invalid id (path traversal guard)', async () => {
  assert.equal(await store.loadEvent('../passwd'), null);
  assert.equal(await store.loadEvent(''), null);
  assert.equal(await store.loadEvent(null), null);
  assert.equal(await store.loadEvent('a/b'), null);
});

// --- createEvent (incl. magic-link trim provability) ---

test('createEvent: assigns id/created_at/salt, omits magic-link fields, pending', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'trim', initiator: 'o@ex.com',
    steps: [{ id: 's', name: 'n', participant: 'a@ex.com', status: 'pending' }],
  });
  assert.match(ev.id, /^[a-zA-Z0-9]+$/);
  assert.ok(ev.created_at);
  assert.equal(typeof ev.salt, 'string');
  assert.equal(ev.activated_at, null, 'created pending');
  assert.equal(Object.prototype.hasOwnProperty.call(ev, 'activation_ack_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ev, 'activation_link_clicked_at'), false);
  // ...and the same on disk after a reload.
  const reloaded = await store.loadEvent(ev.id);
  assert.equal(Object.prototype.hasOwnProperty.call(reloaded, 'activation_ack_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reloaded, 'activation_link_clicked_at'), false);
});

test('createEvent: refuses to overwrite an existing id', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'dup', initiator: 'o@ex.com',
    steps: [{ id: 's', name: 'n', participant: 'a@ex.com', status: 'pending' }],
  });
  await assert.rejects(() => store.createEvent({ id: ev.id, title: 'again' }), /already exists/);
});

// --- activateEvent (the pending→active gate; gitrepo sync is best-effort) ---

test('activateEvent: flips pending→active and persists, idempotently', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'act', initiator: 'o@ex.com',
    steps: [{ id: 's', name: 'n', participant: 'a@ex.com', status: 'pending' }],
  });
  assert.equal(ev.activated_at, null);

  const r1 = await store.activateEvent(ev.id);
  assert.equal(r1.alreadyActive, false);
  assert.ok(r1.event.activated_at, 'activated_at set on first activation');
  const reloaded = await store.loadEvent(ev.id);
  assert.equal(reloaded.activated_at, r1.event.activated_at, 'persisted to disk');

  // Re-activating is a no-op that reports alreadyActive and keeps the timestamp.
  const r2 = await store.activateEvent(ev.id);
  assert.equal(r2.alreadyActive, true);
  assert.equal(r2.event.activated_at, r1.event.activated_at);
});

test('activateEvent: throws on unknown event', async () => {
  await assert.rejects(() => store.activateEvent('nope'), /not found/);
});

// --- editEvent ---

test('editEvent: rejects edit on completed step', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'editfreeze', initiator: 'org@ex.com',
    steps: [
      { id: 'a', name: 'one', participant: 'a@ex.com', status: 'complete' },
      { id: 'b', name: 'two', participant: 'b@ex.com', status: 'pending' },
    ],
  });
  await assert.rejects(
    () => store.editEvent(ev.id, { steps: [{ id: 'a', participant: 'changed@ex.com' }] }),
    (err) => err.code === 'EVENT_STEP_FROZEN'
  );
});

test('editEvent: pending event — no audit commit, plain mutation', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'pending edit', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'old@ex.com', status: 'pending' }],
  });
  const result = await store.editEvent(ev.id, {
    title: 'new title',
    steps: [{ id: 's', participant: 'new@ex.com', deadline: '2026-06-01', requires_attachment: true }],
  });
  assert.equal(result.commitSequence, null, 'no audit commit for pending event');
  assert.equal(result.changes.length, 4, 'four field changes');
  const reloaded = await store.loadEvent(ev.id);
  assert.equal(reloaded.title, 'new title');
  assert.equal(reloaded.steps[0].participant, 'new@ex.com');
  assert.equal(reloaded.steps[0].deadline, '2026-06-01');
  assert.equal(reloaded.steps[0].requires_attachment, true);
});

test('editEvent: participant change clears last_send_error on that step', async () => {
  // Pending event: the clearing happens in the pure patch step, independent of
  // activation. The activated variant (which also writes an audit commit) is
  // covered by the skipped 5b test below.
  const ev = await store.createEvent({
    type: 'event', title: 'reset', initiator: 'org@ex.com',
    steps: [
      { id: 'a', name: 'audio', participant: 'old@ex.com', status: 'pending',
        last_send_error: { reason: 'bounced', code: '5.1.1', at: '2026-01-02T00:00:00Z' } },
      { id: 'b', name: 'video', participant: 'b@ex.com', status: 'pending',
        last_send_error: { reason: 'timeout', at: '2026-01-02T00:00:00Z' } },
    ],
  });
  await store.editEvent(ev.id, { steps: [{ id: 'a', participant: 'new@ex.com' }, { id: 'b', participant: 'b@ex.com' }] });
  const reloaded = await store.loadEvent(ev.id);
  const sa = reloaded.steps.find((s) => s.id === 'a');
  const sb = reloaded.steps.find((s) => s.id === 'b');
  assert.equal(sa.last_send_error, undefined, 'changed-participant step has its error cleared');
  assert.ok(sb.last_send_error, 'untouched step keeps its error');
  assert.equal(sb.last_send_error.reason, 'timeout');
});

test('editEvent: no-op when patch matches current state', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'noop', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'pending' }],
  });
  const result = await store.editEvent(ev.id, { steps: [{ id: 's', participant: 'a@ex.com' }] });
  assert.equal(result.changes.length, 0);
  assert.equal(result.commitSequence, null);
});

test('editEvent: rejects invalid email', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 't', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'pending' }],
  });
  await assert.rejects(
    () => store.editEvent(ev.id, { steps: [{ id: 's', participant: 'not-an-email' }] }),
    (err) => err.code === 'BAD_EMAIL'
  );
});

test('editEvent: rejects edit on completed event', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'done', initiator: 'org@ex.com',
    completion: { status: 'complete', completed_at: '2026-01-01T00:00:00Z' },
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'complete' }],
  });
  await assert.rejects(
    () => store.editEvent(ev.id, { title: 'new' }),
    (err) => err.code === 'EVENT_COMPLETE'
  );
});

test('editEvent: activated event writes a hashed audit commit', async () => {
  const repo = require('../../src/gitrepo').createGitrepo({ dataDir: tmpDir });
  const ev = await store.createEvent({
    type: 'event', title: 'audit', initiator: 'org@ex.com',
    salt: store.generateEventSalt(),
    steps: [{ id: 's', name: 'do', participant: 'old@ex.com', status: 'pending' }],
  });
  const { event: activated } = await store.activateEvent(ev.id);
  await repo.initRepoIfNeeded(ev.id, activated);

  const result = await store.editEvent(ev.id, {
    steps: [{ id: 's', participant: 'new@ex.com', deadline: '2026-07-01' }],
  }, { organiserHandle: 'h_test' });

  assert.equal(typeof result.commitSequence, 'number');
  assert.ok(result.commitSequence >= 1);
  const commits = await repo.listCommits(ev.id);
  const editCommit = commits.find((c) => c.kind === 'event_edit');
  assert.ok(editCommit, 'audit commit written');
  const partChange = editCommit.changes.find((c) => c.field === 'participant');
  assert.ok(partChange.from_hash.startsWith('sha256:'));
  assert.ok(partChange.to_hash.startsWith('sha256:'));
  assert.equal(partChange.from, undefined);
  assert.equal(partChange.to, undefined);
  const dlChange = editCommit.changes.find((c) => c.field === 'deadline');
  assert.equal(dlChange.to, '2026-07-01');
});

// --- recordStepSendErrors ---

test('recordStepSendErrors: persists per-step error and clears on null', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'send-err', initiator: 'org@ex.com',
    steps: [
      { id: 'a', name: 'one', participant: 'a@ex.com', status: 'pending' },
      { id: 'b', name: 'two', participant: 'b@ex.com', status: 'pending' },
    ],
  });
  await store.recordStepSendErrors(ev.id, {
    a: { reason: 'no such address', code: 67, at: '2026-05-03T10:00:00Z' },
  });
  const after1 = await store.loadEvent(ev.id);
  assert.deepEqual(after1.steps[0].last_send_error, {
    reason: 'no such address', code: 67, at: '2026-05-03T10:00:00Z',
  });
  assert.equal(after1.steps[1].last_send_error, undefined);

  await store.recordStepSendErrors(ev.id, { a: null });
  const after2 = await store.loadEvent(ev.id);
  assert.equal(after2.steps[0].last_send_error, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(after2.steps[0], 'last_send_error'), false);
});

test('recordStepSendErrors: leaves untouched steps alone, ignores unknown step ids', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'send-err-2', initiator: 'org@ex.com',
    steps: [
      { id: 'a', name: 'one', participant: 'a@ex.com', status: 'pending' },
      { id: 'b', name: 'two', participant: 'b@ex.com', status: 'pending', last_send_error: { reason: 'old', code: null, at: 'x' } },
    ],
  });
  await store.recordStepSendErrors(ev.id, {
    a: { reason: 'fresh fail', code: null, at: '2026-05-03T11:00:00Z' },
    bogus: { reason: 'should be ignored', code: null, at: 'y' },
  });
  const after = await store.loadEvent(ev.id);
  assert.equal(after.steps[0].last_send_error.reason, 'fresh fail');
  assert.equal(after.steps[1].last_send_error.reason, 'old');
});

// --- recordProofEmailMessageId (kept; idempotent thread-root capture) ---

test('recordProofEmailMessageId: stores once, then is idempotent', async () => {
  const ev = await store.createEvent({
    type: 'event', title: 'proof-thread', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'pending' }],
  });
  assert.equal(await store.recordProofEmailMessageId(ev.id, '<first@ex.com>'), '<first@ex.com>');
  // Second call must NOT overwrite the canonical thread root.
  assert.equal(await store.recordProofEmailMessageId(ev.id, '<second@ex.com>'), '<first@ex.com>');
  const reloaded = await store.loadEvent(ev.id);
  assert.equal(reloaded.proof_email_message_id, '<first@ex.com>');
});
