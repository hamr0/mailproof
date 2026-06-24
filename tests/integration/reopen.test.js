
// reopenEvent — the neutral lifecycle primitive (added to unblock consumer-policy
// revoke/close-reversal; see mailproof-probe C1). Flips a completed event
// complete→open, optionally retracts counted signatures so the engine's count
// drops, and appends a tamper-evident `event_reopen` commit. The kernel holds no
// policy opinion; these tests cover the mechanism only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';
import { verifiedSigner } from '../helpers/dkim.js';

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-reopen-'));

function fakeSendmail() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'mailproof-reopen-cap-'));
  const script = path.join(dir, 'sendmail.sh');
  fss.writeFileSync(script, `#!/bin/sh\nf=$(mktemp "${dir}/msg.XXXXXX")\ncat > "$f"\nexit 0\n`, { mode: 0o755 });
  return { script, cleanup: () => fss.rmSync(dir, { recursive: true, force: true }) };
}

test('reopenEvent: retracts a signature, flips complete→open, appends an event_reopen commit', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });

    await core.createEvent({
      id: 'rep1', type: 'crypto', title: 'Resolution', initiator: 'boss@signer.example',
      open: true, threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });
    const sign = async (from) => core.ingest(
      await signer.sign({ from, to: `attest+rep1@${OPERATOR}` }),
      envOf(`attest+rep1@${OPERATOR}`, from),
    );

    const a = await sign('alice@signer.example');
    assert.equal(a.eventComplete, true);
    const before = await core.loadEvent('rep1');
    assert.equal(before.status, 'complete');
    const aliceHash = before.signatures[0].sender_hash;

    // Retract alice → count drops to 0 → event reopens.
    const r = await core.reopenEvent('rep1', { reason: 'attestor retracted', retractSignatures: [aliceHash] });
    assert.equal(r.reopened, true);
    assert.deepEqual(r.retracted, [aliceHash]);
    assert.equal(r.event.status, 'open');
    assert.equal(r.event.completed_at, null);
    assert.equal(r.event.signatures.length, 0);

    // Persisted: master JSON reflects the reopen.
    const after = await core.loadEvent('rep1');
    assert.equal(after.status, 'open');
    assert.equal(after.reopened_reason, 'attestor retracted');

    // Ledger: an event_reopen commit was appended, recording the salted hash only.
    const commits = await core.listCommits('rep1');
    const reopen = commits.find((c) => c.kind === 'event_reopen');
    assert.ok(reopen, 'event_reopen commit present');
    assert.deepEqual(reopen.retracted_hashes, [aliceHash]);
    assert.ok(!JSON.stringify(commits).includes('alice@signer.example'), 'no plaintext on the ledger');

    // The engine now counts correctly: a fresh distinct signer re-completes.
    const b = await sign('bob@signer.example');
    assert.equal(b.signatureCount, 1);
    assert.equal(b.eventComplete, true);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('completeEvent: consumer-driven completion flips open→complete + writes the completion record', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    // High threshold so the engine never auto-completes — the consumer owns it.
    await core.createEvent({
      id: 'cmp1', type: 'crypto', title: 'Consumer-owned', initiator: 'boss@signer.example',
      open: true, threshold: 999, activated_at: '2026-01-01T00:00:00Z',
    });
    assert.equal((await core.loadEvent('cmp1')).status, 'open');

    const r = await core.completeEvent('cmp1', { reason: 'all attestors complete', completedAt: '2026-02-01T00:00:00Z' });
    assert.equal(r.completed, true);
    assert.equal(r.event.status, 'complete');
    assert.equal(r.event.completed_at, '2026-02-01T00:00:00Z');

    const after = await core.loadEvent('cmp1');
    assert.equal(after.status, 'complete');
    assert.equal(after.completed_at, '2026-02-01T00:00:00Z');

    // Idempotent: a second call is a no-op.
    const again = await core.completeEvent('cmp1', { reason: 'again' });
    assert.equal(again.completed, false);
    assert.equal(again.reason, 'already_complete');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('reopenEvent: no-op on a non-complete event; refuses an archived event', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'rep2', type: 'crypto', title: 'Open', initiator: 'boss@signer.example',
      open: true, threshold: 2, activated_at: '2026-01-01T00:00:00Z',
    });

    // Not complete → no-op (no reopen commit, status unchanged).
    const r = await core.reopenEvent('rep2', { reason: 'nope' });
    assert.equal(r.reopened, false);
    assert.equal(r.reason, 'not_complete');
    assert.equal((await core.loadEvent('rep2')).status, 'open');

    // Archived (complete + archived_at) → refused with EVENT_ARCHIVED.
    await core.createEvent({
      id: 'rep3', type: 'crypto', title: 'Archived', initiator: 'boss@signer.example',
      open: true, threshold: 1, status: 'complete', completed_at: '2026-01-02T00:00:00Z',
      archived_at: '2026-01-03T00:00:00Z', activated_at: '2026-01-01T00:00:00Z',
    });
    await assert.rejects(
      () => core.reopenEvent('rep3'),
      (err) => err && err.code === 'EVENT_ARCHIVED',
    );
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
