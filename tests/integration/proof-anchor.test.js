
// Proof-anchor pass (m7d-4). Drives the per-event lift of the Bitcoin
// attestation across an event's .ots proofs, records anchored state into the
// ledger, and emits the `proof_anchored` occasion on a fresh full-anchor
// transition. Exercised via createProofAnchor directly with the real eventStore
// + gitrepo + a STUB ots (injecting the boundary, not internals — the real
// `ots upgrade` is the m7c-4 primitive, already tested in tests/integration/
// ots.test.js) and a stub deliver that captures calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEventStore } from '../../src/event-store.js';
import { createGitrepo } from '../../src/gitrepo.js';
import { createProofAnchor } from '../../src/proof-anchor.js';

const OPERATOR = 'app.example';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-pa-'));
}

// A stub ots that returns the supplied per-call upgrade results in order. When
// the configured result has `changed: true`, the proof file is mutated in place
// to simulate the calendar attestation being folded in (so git sees a real diff
// in the next commit). Subsequent calls past the array recycle the last entry.
function stubOts(seq) {
  let i = 0;
  return {
    upgradeProof: async (abs) => {
      const r = seq[Math.min(i, seq.length - 1)];
      i += 1;
      if (r && r.changed) await fs.appendFile(abs, '\nupgraded\n');
      return r;
    },
  };
}

function captureDeliver() {
  const calls = [];
  const deliver = async (msg) => {
    calls.push(msg);
    return { kind: msg.kind, to: msg.to, ok: true, reason: null };
  };
  return { deliver, calls };
}

// Seed an event repo with N pending proofs + sibling commit JSONs (untracked).
// The first call to commitProofUpgrade will stage and commit them.
async function seed(dataDir, event, proofBaseNames) {
  const eventStore = createEventStore({ dataDir });
  const gitrepo = createGitrepo({ dataDir });
  await eventStore.createEvent(event);
  // Persist the full event JSON (including the test-only status:'complete' /
  // initiator that createEvent's buildEventRecord keeps; createEvent already
  // wrote it).
  const stored = await eventStore.loadEvent(event.id);
  // Init the per-event repo (mkdirs, .gitkeep, baseline commit).
  await gitrepo.initRepoIfNeeded(event.id, stored);
  const root = path.join(dataDir, 'repos', event.id);
  // Drop one (proof, sibling JSON) pair per base name into the repo.
  for (const base of proofBaseNames) {
    await fs.writeFile(path.join(root, 'ots_proofs', `${base}.ots`), Buffer.from(`pending-proof-${base}`));
    await fs.writeFile(
      path.join(root, 'commits', `${base}.json`),
      JSON.stringify({ schema_version: 1, sequence: 1, kind: 'reply', sender_domain: 'corp.example' }, null, 2) + '\n',
    );
  }
  return { eventStore, gitrepo };
}

const ANCHORED_OK = { ok: true, changed: true, anchored: true, pending: false, exit: 0, block_height: 850000 };
const ALREADY_OK  = { ok: true, changed: false, anchored: true, pending: false, exit: 0, block_height: 850000 };
const PENDING     = { ok: true, changed: false, anchored: false, pending: true, exit: 1 };

test('upgradeProofs: pending proof on complete event → no ledger commit, no notify', async () => {
  const tmp = await tmpDir();
  try {
    const { eventStore, gitrepo } = await seed(tmp, {
      id: 'pa1', type: 'workflow', flow: 'sequential', title: 'Done', initiator: 'boss@corp.example',
      status: 'complete', completed_at: '2026-01-02T00:00:00Z', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example', status: 'complete' }],
    }, ['commit-001']);
    const { deliver, calls } = captureDeliver();
    const { upgradeProofs } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([PENDING]), deliver, domain: OPERATOR,
    });
    const r = await upgradeProofs({ now: '2026-05-28T10:00:00Z' });
    assert.equal(r.events[0].checked, 1);
    assert.equal(r.events[0].newlyAnchored, 0);
    assert.equal(r.events[0].pendingAfter, 1);
    assert.equal(r.events[0].committed, false);
    assert.equal(r.events[0].notified, false);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('upgradeProofs: a newly-anchored proof on a complete event patches the ledger AND emits proof_anchored (once)', async () => {
  const tmp = await tmpDir();
  try {
    const { eventStore, gitrepo } = await seed(tmp, {
      id: 'pa2', type: 'workflow', flow: 'sequential', title: 'Board sign-off', initiator: 'boss@corp.example',
      status: 'complete', completed_at: '2026-01-02T00:00:00Z', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example', status: 'complete' }],
    }, ['commit-001']);
    const { deliver, calls } = captureDeliver();
    const { upgradeProofs } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([ANCHORED_OK]), deliver, domain: OPERATOR,
    });
    const r1 = await upgradeProofs({ now: '2026-05-28T10:00:00Z' });
    assert.equal(r1.events[0].newlyAnchored, 1);
    assert.equal(r1.events[0].pendingAfter, 0);
    assert.equal(r1.events[0].committed, true);
    assert.equal(r1.events[0].patched, 1);
    assert.equal(r1.events[0].notified, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'proof_anchored');
    assert.equal(calls[0].to, 'boss@corp.example');
    assert.equal(calls[0].replyAddress, `event+pa2@${OPERATOR}`);
    assert.match(calls[0].defaultBody, /block 850000/);

    // The commit JSON is patched with the anchored fields.
    const commitJson = JSON.parse(await fs.readFile(path.join(tmp, 'repos', 'pa2', 'commits', 'commit-001.json'), 'utf8'));
    assert.equal(commitJson.ots_anchored, true);
    assert.equal(commitJson.ots_anchored_at, '2026-05-28T10:00:00Z');
    assert.equal(commitJson.ots_block, 850000);

    // The event JSON now records the notified flag.
    const ev = await eventStore.loadEvent('pa2');
    assert.equal(ev.ots_proof_anchored_notified_at, '2026-05-28T10:00:00Z');

    // Second run: stub returns "already anchored, not changed" (backfill).
    // Nothing new to anchor, flag already set → no second notify, no second commit.
    const { upgradeProofs: again } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([ALREADY_OK]), deliver, domain: OPERATOR,
    });
    const r2 = await again({ now: '2026-05-28T11:00:00Z' });
    assert.equal(r2.events[0].newlyAnchored, 0);
    assert.equal(r2.events[0].notified, false);
    assert.equal(r2.events[0].committed, false, 'no change → no second ledger commit');
    assert.equal(calls.length, 1, 'no second proof_anchored email');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('upgradeProofs: a complete event with mixed proofs (one anchored, one still pending) holds the notify', async () => {
  const tmp = await tmpDir();
  try {
    const { eventStore, gitrepo } = await seed(tmp, {
      id: 'pa3', type: 'workflow', flow: 'sequential', title: 'Done partly', initiator: 'boss@corp.example',
      status: 'complete', completed_at: '2026-01-02T00:00:00Z', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example', status: 'complete' }],
    }, ['commit-001', 'commit-002']);
    const { deliver, calls } = captureDeliver();
    const { upgradeProofs } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([ANCHORED_OK, PENDING]), deliver, domain: OPERATOR,
    });
    const r = await upgradeProofs({ now: '2026-05-28T10:00:00Z' });
    assert.equal(r.events[0].newlyAnchored, 1);
    assert.equal(r.events[0].pendingAfter, 1);
    assert.equal(r.events[0].committed, true, 'the one anchored proof IS recorded into the ledger');
    assert.equal(r.events[0].notified, false, 'proof_anchored fires only when ALL proofs are anchored');
    assert.equal(calls.length, 0);
    const ev = await eventStore.loadEvent('pa3');
    assert.ok(!ev.ots_proof_anchored_notified_at);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('upgradeProofs: an INCOMPLETE event records anchored state but does NOT emit proof_anchored', async () => {
  const tmp = await tmpDir();
  try {
    const { eventStore, gitrepo } = await seed(tmp, {
      id: 'pa4', type: 'workflow', flow: 'sequential', title: 'In flight', initiator: 'boss@corp.example',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    }, ['commit-001']);
    const { deliver, calls } = captureDeliver();
    const { upgradeProofs } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([ANCHORED_OK]), deliver, domain: OPERATOR,
    });
    const r = await upgradeProofs({ now: '2026-05-28T10:00:00Z' });
    assert.equal(r.events[0].committed, true);
    assert.equal(r.events[0].notified, false);
    assert.equal(calls.length, 0, 'proof_anchored is gated on status:complete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('upgradeProofs: events with no repo / no proofs are skipped cleanly', async () => {
  const tmp = await tmpDir();
  try {
    const eventStore = createEventStore({ dataDir: tmp });
    const gitrepo = createGitrepo({ dataDir: tmp });
    await eventStore.createEvent({
      id: 'pa5', type: 'workflow', title: 'Bare', initiator: 'boss@corp.example',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });
    const { deliver, calls } = captureDeliver();
    const { upgradeProofs } = createProofAnchor({
      eventStore, gitrepo, ots: stubOts([ANCHORED_OK]), deliver, domain: OPERATOR,
    });
    const r = await upgradeProofs({ now: '2026-05-28T10:00:00Z' });
    assert.equal(r.events[0].checked, 0);
    assert.equal(r.events[0].newlyAnchored, 0);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createProofAnchor: refuses to compose without ots / eventStore / gitrepo', () => {
  const eventStore = createEventStore({ dataDir: '/tmp' });
  const gitrepo = createGitrepo({ dataDir: '/tmp' });
  assert.throws(() => createProofAnchor({ eventStore, gitrepo }), /ots required/);
  assert.throws(() => createProofAnchor({ ots: stubOts([]) }), /eventStore \+ gitrepo required/);
});
