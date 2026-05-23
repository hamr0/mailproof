'use strict';

// Unit tests for the git ledger's PURE surface — no git, no filesystem. The
// repo-touching primitives are exercised in tests/integration/gitrepo.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitrepo } = require('../../src/gitrepo');

// Pure helpers ignore dataDir; a throwaway binding is fine.
const repo = createGitrepo({ dataDir: '/nonexistent' });

test('createGitrepo: requires dataDir', () => {
  assert.throws(() => createGitrepo({}), /dataDir required/);
  assert.throws(() => createGitrepo(), /dataDir required/);
});

test('buildCommitMetadata: same salt + same sender → same hash (dedup works)', () => {
  const event = { salt: 'fixed-salt' };
  const ctx1 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'Alice@Example.com' }, from: null };
  const ctx2 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m1 = repo.buildCommitMetadata(1, ctx1, event);
  const m2 = repo.buildCommitMetadata(1, ctx2, event);
  assert.equal(m1.sender_hash, m2.sender_hash); // lowercased → same
});

test('buildCommitMetadata: different salt → different hash (cross-event isolation)', () => {
  const ctx = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m1 = repo.buildCommitMetadata(1, ctx, { salt: 'salt-A' });
  const m2 = repo.buildCommitMetadata(1, ctx, { salt: 'salt-B' });
  assert.notEqual(m1.sender_hash, m2.sender_hash);
});

test('buildCommitMetadata: no salt falls back to unsalted hash', () => {
  const ctx = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m = repo.buildCommitMetadata(1, ctx, {});
  assert.match(m.sender_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(m.sender_hash, repo.saltedSenderHash('alice@example.com', null));
});

test('buildCommitMetadata: omits plaintext (sender/subject/body/message_id)', () => {
  const ctx = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null,
    messageId: '<abc@example.com>' };
  const m = repo.buildCommitMetadata(1, ctx, { salt: 's' });
  assert.equal(m.sender, undefined);
  assert.equal(m.subject, undefined);
  assert.equal(m.body_preview, undefined);
  assert.equal(m.message_id, undefined);
  assert.equal(m.sender_domain, 'example.com');
  assert.match(m.message_id_hash, /^sha256:[a-f0-9]{64}$/);
});

test('normaliseMessageId: strips brackets and lowercases', () => {
  assert.equal(repo.normaliseMessageId('<ABC@Example.com>'), 'abc@example.com');
  assert.equal(repo.normaliseMessageId(null), null);
});
