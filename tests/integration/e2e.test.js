'use strict';

// Kitchen-sink end-to-end (m7c-5) — the "all the pillars compose" proof. Drives
// a FULL lifecycle of each coordination mode through the public create() API
// against the real ledger + mailauth + a fake capture transport, offline. This
// is the continuous proof that mailproof delivers the whole stack — git ledger,
// events (sequential), crypto (threshold/open), DKIM verify + durable archive,
// salted-at-rest, doc hashing, one-source-of-truth offline verify, and
// email-triggered advancement — before the gitdone reconverge (P2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');
const { verifiedSigner, noDnsResolver } = require('../helpers/dkim');

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-e2e-'));

function fakeSendmail() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'mailproof-e2e-cap-'));
  const script = path.join(dir, 'sendmail.sh');
  fss.writeFileSync(script, `#!/bin/sh\nf=$(mktemp "${dir}/msg.XXXXXX")\ncat > "$f"\nexit 0\n`, { mode: 0o755 });
  return { script, cleanup: () => fss.rmSync(dir, { recursive: true, force: true }) };
}

test('e2e workflow: two sequential steps drive themselves to completion, then verify offline', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });

    await core.createEvent({
      id: 'e2ewf', type: 'workflow', flow: 'sequential', title: 'Onboarding',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    // Step 1 — verified participant reply: counts, completes s1, pings s2.
    const s1eml = await signer.sign({ from: 'alice@corp.example', to: `event+e2ewf-s1@${OPERATOR}` });
    const r1 = await core.ingest(s1eml, envOf(`event+e2ewf-s1@${OPERATOR}`, 'alice@corp.example'));
    assert.equal(r1.counted, true);
    assert.equal(r1.completedStep, 's1');
    assert.equal(r1.eventComplete, false);
    assert.deepEqual(r1.notified, [{ kind: 'advance', to: 'bob@corp.example', ok: true, reason: null }]);

    // Step 2 — completes the event; the initiator gets the completion notice.
    const s2eml = await signer.sign({ from: 'bob@corp.example', to: `event+e2ewf-s2@${OPERATOR}` });
    const r2 = await core.ingest(s2eml, envOf(`event+e2ewf-s2@${OPERATOR}`, 'bob@corp.example'));
    assert.equal(r2.eventComplete, true);
    assert.deepEqual(r2.notified, [{ kind: 'completion', to: 'boss@corp.example', ok: true, reason: null }]);

    // Ledger: two counted replies + the event is complete and persisted.
    const commits = await core.listCommits('e2ewf');
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c) => c.counted), [true, true]);
    assert.equal((await core.loadEvent('e2ewf')).status, 'complete');

    // Salted-at-rest: no plaintext sender on the ledger, only a salted hash.
    assert.ok(!JSON.stringify(commits).includes('alice@corp.example'));
    assert.match(commits[0].sender_hash, /^sha256:/);

    // One source of truth: re-verify step 1's exact email offline (archived key).
    const v = await core.verify('e2ewf', s1eml, { resolver: noDnsResolver });
    assert.equal(v.matched, true);
    assert.equal(v.matchType, 'raw_email');
    assert.equal(v.dkim_reverify.ok, true);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e crypto: open threshold-2 sign-off counts distinct verified signers, rejects self/dupe, locks', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });

    await core.createEvent({
      id: 'e2ecr', type: 'crypto', title: 'Board resolution',
      initiator: 'boss@signer.example', open: true, threshold: 2,
      activated_at: '2026-01-01T00:00:00Z',
    });

    // Each call signs a fresh message (verifiedSigner varies the Message-ID), so
    // distinct-dedup keys on the SIGNER, not the message bytes.
    const sendFrom = async (from) => {
      const eml = await signer.sign({ from, to: `attest+e2ecr@${OPERATOR}` });
      return core.ingest(eml, envOf(`attest+e2ecr@${OPERATOR}`, from));
    };

    // Signer A — first distinct signature.
    const a = await sendFrom('alice@signer.example');
    assert.equal(a.counted, true);
    assert.equal(a.signatureCount, 1);
    assert.equal(a.eventComplete, false);

    // Initiator's own reply — committed for audit, never counts (anti-self-dealing).
    const init = await sendFrom('boss@signer.example');
    assert.equal(init.counted, false);
    assert.equal(init.count_reason, 'initiator_self_reply');

    // Signer A again — distinct-dedup: committed, doesn't count twice.
    const aDup = await sendFrom('alice@signer.example');
    assert.equal(aDup.counted, false);
    assert.equal(aDup.count_reason, 'already_signed');

    // Signer B — the second distinct signature locks the event at threshold.
    const b = await sendFrom('bob@signer.example');
    assert.equal(b.counted, true);
    assert.equal(b.signatureCount, 2);
    assert.equal(b.eventComplete, true);
    // The locking reply acks the signer AND notifies the initiator.
    assert.deepEqual(b.notified, [
      { kind: 'ack', to: 'bob@signer.example', ok: true, reason: null },
      { kind: 'completion', to: 'boss@signer.example', ok: true, reason: null },
    ]);

    // Ledger + state: 4 commits (A, initiator, dupe, B); 2 counted signatures; locked.
    const commits = await core.listCommits('e2ecr');
    assert.deepEqual(commits.map((c) => c.counted), [true, false, false, true]);
    const event = await core.loadEvent('e2ecr');
    assert.equal(event.status, 'complete');
    assert.equal(event.signatures.length, 2);
    assert.deepEqual(event.signatures.map((s) => s.sender_domain), ['signer.example', 'signer.example']);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
