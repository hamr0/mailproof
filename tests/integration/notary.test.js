'use strict';

// Document notary — verify half (PRD §4.1). Drives the real ledger: an event
// in the event store + a reply committed to its per-event git repo, then
// verifyDocument re-hashes the file and matches it back. No mocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createEventStore } = require('../../src/event-store');
const { createGitrepo } = require('../../src/gitrepo');
const { createNotary } = require('../../src/notary');

const DOC = Buffer.from('the signed contract, v3 — bytes that get fingerprinted');

// Stand up a tmp store + repo, create an event, and commit one reply that
// carries DOC as an attachment (hashed through the notary's own hashDocument,
// i.e. what m7's parser will do). Returns the wired pieces + event.
async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-notary-'));
  const eventStore = createEventStore({ dataDir: tmp });
  const gitrepo = createGitrepo({ dataDir: tmp });
  const notary = createNotary({ gitrepo, eventStore });

  const event = await eventStore.createEvent({
    id: 'evnot01', type: 'workflow', flow: 'sequential', status: 'open',
    activated_at: '2026-01-01T00:00:00Z',
    steps: [{ id: 'sign', participant: 'alice@example.com', status: 'pending', dependsOn: [], minTrust: 'verified' }],
  });

  await gitrepo.commitReply('evnot01', event, {
    eventId: 'evnot01', stepId: 'sign', receivedAt: '2026-04-19T00:00:00Z',
    messageId: '<m1@example.com>', from: 'alice@example.com',
    trustLevel: 'verified', participantMatch: true,
    attachments: [{ filename: 'contract.pdf', size: DOC.length, sha256: notary.hashDocument(DOC) }],
    rawSha256: 'sha256:feed', rawSize: 1024,
  });

  return { tmp, notary };
}

test('verifyDocument: matches the exact document committed to the ledger', async () => {
  const { tmp, notary } = await fixture();
  try {
    const res = await notary.verifyDocument('evnot01', DOC);
    assert.equal(res.found, true);
    assert.equal(res.matches.length, 1);
    const m = res.matches[0];
    assert.equal(m.sequence, 1);
    assert.equal(m.received_at, '2026-04-19T00:00:00Z');
    assert.equal(m.trust_level, 'verified');
    assert.equal(m.sender_domain, 'example.com');
    assert.equal(m.filename, 'contract.pdf');
    assert.equal(m.sender_match, null);   // no email supplied ⇒ layer-2 not evaluated
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verifyDocument: the email layer matches the committing sender, rejects others', async () => {
  const { tmp, notary } = await fixture();
  try {
    const ok = await notary.verifyDocument('evnot01', DOC, { email: 'alice@example.com' });
    assert.equal(ok.matches[0].sender_match, true);

    const wrong = await notary.verifyDocument('evnot01', DOC, { email: 'mallory@evil.example' });
    assert.equal(wrong.found, true);                 // doc still matches…
    assert.equal(wrong.matches[0].sender_match, false); // …but the sender doesn't
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verifyDocument: a tampered/unknown document does not match', async () => {
  const { tmp, notary } = await fixture();
  try {
    const tampered = await notary.verifyDocument('evnot01', Buffer.from('the signed contract, v4'));
    assert.equal(tampered.found, false);
    assert.deepEqual(tampered.matches, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verifyDocument: unknown event returns not-found, not an error', async () => {
  const { tmp, notary } = await fixture();
  try {
    const res = await notary.verifyDocument('nosuchevt', DOC);
    assert.equal(res.found, false);
    assert.deepEqual(res.matches, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
