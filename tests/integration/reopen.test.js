
// reopenEvent — the neutral lifecycle primitive (added to unblock consumer-policy
// revoke/close-reversal; see mailproof-probe C1). Flips a completed event
// complete→open, optionally retracts counted signatures so the engine's count
// drops, and appends a tamper-evident `event_reopen` commit. The kernel holds no
// policy opinion; these tests cover the mechanism only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test('completeEvent after reopenEvent refreshes the ledger record (no stale completion.json)', async () => {
  // Regression: reopenEvent made completion repeatable, but commitCompletion was
  // idempotent on the singleton completion.json — so a re-completion left the
  // ledger recording the FIRST completion while the master event showed the
  // second (the revoke / strict-signing re-completion flow m7e is built for).
  // completeEvent now supersedes: completion.json tracks the CURRENT completion,
  // and the prior record stays in the git chain (the tamper-evidence).
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'rc1', type: 'crypto', title: 'Recompletion', initiator: 'boss@signer.example',
      open: true, threshold: 999, activated_at: '2026-01-01T00:00:00Z',
    });
    const completionPath = path.join(tmp, 'repos', 'rc1', 'commits', 'completion.json');
    const repoRoot = path.join(tmp, 'repos', 'rc1');
    const gitLog = () => execFileSync('git', ['log', '--oneline'], { cwd: repoRoot }).toString();

    // First completion → record written, not a supersede.
    const c1 = await core.completeEvent('rc1', { reason: 'first', completedAt: '2026-02-01T00:00:00Z' });
    assert.equal(c1.completed, true);
    assert.equal(c1.completionRecord.superseded, false);
    let rec = JSON.parse(await fs.readFile(completionPath, 'utf8'));
    assert.equal(rec.completed_at, '2026-02-01T00:00:00Z');
    assert.equal(rec.summary, 'first');

    // Reopen, then re-complete with new data.
    await core.reopenEvent('rc1', { reason: 'mistake' });
    assert.equal((await core.loadEvent('rc1')).status, 'open');
    const c2 = await core.completeEvent('rc1', { reason: 'second', completedAt: '2026-03-01T00:00:00Z' });
    assert.equal(c2.completed, true);
    assert.equal(c2.completionRecord.superseded, true);

    // The ledger record now matches the master event (the bug: it used to be stale).
    rec = JSON.parse(await fs.readFile(completionPath, 'utf8'));
    assert.equal(rec.completed_at, '2026-03-01T00:00:00Z');
    assert.equal(rec.summary, 'second');
    assert.equal((await core.loadEvent('rc1')).completed_at, '2026-03-01T00:00:00Z');

    // Tamper-evidence preserved: the first completion is still in the git chain.
    const log = gitLog();
    assert.match(log, /completion: rc1 complete/, 'first completion still in history');
    assert.match(log, /completion: rc1 re-completed/, 'supersede commit recorded');
    assert.match(log, /reopen: rc1/, 'reopen recorded between them');

    // A byte-identical re-completion writes no completion commit (no empty-diff
    // churn): the record is unchanged, so commitCompletion short-circuits.
    const reCompletions = () => (gitLog().match(/completion: rc1 re-completed/g) || []).length;
    const before = reCompletions();
    await core.reopenEvent('rc1', { reason: 'again' });
    const c3 = await core.completeEvent('rc1', { reason: 'second', completedAt: '2026-03-01T00:00:00Z' });
    assert.equal(c3.completed, true);
    assert.equal(c3.completionRecord.alreadyWritten, true, 'byte-identical completion is a no-op');
    assert.equal(reCompletions(), before, 'no new completion commit for an identical record');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('engine-driven re-completion after reopen refreshes the ledger record (ingest path)', async () => {
  // Regression sibling of the completeEvent supersede fix: the SAME stale-ledger
  // bug, but on the ingest engine path. A crypto event auto-completes via a
  // counted reply; reopenEvent retracts a signature; a NEW counted reply tips it
  // over the threshold again. commitCompletion was called with the default
  // supersede:false, so the singleton completion.json kept the FIRST completion's
  // triggering sequence while the master JSON showed the second — the ledger went
  // stale. ingest now supersedes when the event was reopened.
  const tmp = await tmpDir();
  const signer = verifiedSigner({ domain: 'corp.example' });
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver });
    await core.createEvent({
      id: 'rc2', type: 'crypto', title: 'Two-of-two sign-off',
      activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@corp.example', 'bob@corp.example'], threshold: 2,
    });
    const to = `attest+rc2@${OPERATOR}`;
    const completionPath = path.join(tmp, 'repos', 'rc2', 'commits', 'completion.json');

    // alice (seq 1) → 1/2, not complete. bob (seq 2) → 2/2, completes.
    const a1 = await core.ingest(await signer.sign({ from: 'alice@corp.example', to }), envOf(to, 'alice@corp.example'));
    assert.equal(a1.eventComplete, false);
    const b1 = await core.ingest(await signer.sign({ from: 'bob@corp.example', to }), envOf(to, 'bob@corp.example'));
    assert.equal(b1.eventComplete, true);
    assert.equal(b1.committedSeq, 2);
    let rec = JSON.parse(await fs.readFile(completionPath, 'utf8'));
    assert.equal(rec.triggering_commit_sequence, 2, 'first completion tipped by bob (seq 2)');

    // Reopen, retracting bob — the count drops to 1/2 and the event opens.
    const bobHash = (await core.loadEvent('rc2')).signatures.find((s) => s.commit_sequence === 2).sender_hash;
    const re = await core.reopenEvent('rc2', { reason: 'mistake', retractSignatures: [bobHash] });
    assert.equal(re.reopened, true);
    assert.equal(re.event.signatures.length, 1);

    // bob re-signs (seq 4 — the reopen took seq 3) → 2/2 again, engine re-completes.
    const b2 = await core.ingest(await signer.sign({ from: 'bob@corp.example', to }), envOf(to, 'bob@corp.example'));
    assert.equal(b2.eventComplete, true);
    assert.equal(b2.committedSeq, 4);

    // The ledger record now tracks the CURRENT completion, not the stale first one.
    rec = JSON.parse(await fs.readFile(completionPath, 'utf8'));
    assert.equal(rec.triggering_commit_sequence, 4, 'completion.json refreshed to the re-completing reply');
    assert.equal((await core.loadEvent('rc2')).status, 'complete');

    // Tamper-evidence intact: the first completion stays in the git chain, with
    // the reopen and the supersede commit recorded after it, in order.
    const log = execFileSync('git', ['-C', path.join(tmp, 'repos', 'rc2'), 'log', '--format=%s'], { encoding: 'utf8' });
    assert.match(log, /completion: rc2 complete/, 'first completion still in history');
    assert.match(log, /completion: rc2 re-completed/, 'supersede commit recorded');
    assert.match(log, /reopen: rc2/, 'reopen recorded between them');
  } finally {
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
