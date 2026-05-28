'use strict';

// Inbound pipeline — the trigger/send layer (m7b-3 Commit C). On a COUNTED
// reply ingest() drives the next email: workflow pings the participant(s) of
// every newly-eligible step; crypto acks the verified signer; both notify the
// initiator on the completing edge. Non-counting replies send nothing. Sends go
// through the REAL outbound path (buildRawMessage + sendmail) to a fake capture
// binary in tmp — no mocks. Bodies route through the optional composeNotification
// hook (neutral default otherwise).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');
const { verifiedSigner, noDnsResolver } = require('../helpers/dkim');

const OPERATOR = 'app.example';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-trig-'));
}

// A fake sendmail binary that captures each submitted message to its own file.
function fakeSendmail() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'mailproof-cap-'));
  const script = path.join(dir, 'sendmail.sh');
  fss.writeFileSync(script, `#!/bin/sh\nf=$(mktemp "${dir}/msg.XXXXXX")\ncat > "$f"\nexit 0\n`, { mode: 0o755 });
  return {
    script,
    cleanup: () => fss.rmSync(dir, { recursive: true, force: true }),
    captures: () => fss.readdirSync(dir)
      .filter((f) => f.startsWith('msg.'))
      .map((f) => fss.readFileSync(path.join(dir, f), 'utf8')),
  };
}

const envOf = (recipient, sender) => ({
  recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example',
});

test('triggers: workflow advance pings the next step, then notifies the initiator on completion', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wf10', type: 'workflow', flow: 'sequential', title: 'Onboard',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    // Step 1 reply → counts, completes s1, NOT whole-event → advance to s2's owner.
    const r1 = await core.ingest(
      await signer.sign({ from: 'alice@corp.example', to: `event+wf10-s1@${OPERATOR}` }),
      envOf(`event+wf10-s1@${OPERATOR}`, 'alice@corp.example'),
    );
    assert.equal(r1.completedStep, 's1');
    assert.equal(r1.eventComplete, false);
    assert.deepEqual(r1.notified, [{ kind: 'advance', to: 'bob@corp.example', ok: true, reason: null }]);

    // The advance message is From the s2 reply address so bob's reply routes back.
    const advanceMsg = cap.captures().find((m) => /To:\s*bob@corp.example/i.test(m));
    assert.match(advanceMsg, /From:\s*event\+wf10-s2@app\.example/i);
    assert.match(advanceMsg, /Auto-Submitted:\s*auto-generated/i);

    // Step 2 reply → completes the event → completion notice to the initiator.
    const r2 = await core.ingest(
      await signer.sign({ from: 'bob@corp.example', to: `event+wf10-s2@${OPERATOR}` }),
      envOf(`event+wf10-s2@${OPERATOR}`, 'bob@corp.example'),
    );
    assert.equal(r2.eventComplete, true);
    assert.deepEqual(r2.notified, [{ kind: 'completion', to: 'boss@corp.example', ok: true, reason: null }]);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: crypto sign-off acks the signer AND notifies the initiator on the locking reply', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'cr10', type: 'crypto', title: 'Sign the deed',
      initiator: 'boss@signer.example', signers: ['alice@signer.example'], threshold: 1,
      activated_at: '2026-01-01T00:00:00Z',
    });

    const r = await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr10@${OPERATOR}` }),
      envOf(`attest+cr10@${OPERATOR}`, 'alice@signer.example'),
    );

    assert.equal(r.counted, true);
    assert.equal(r.eventComplete, true);
    assert.deepEqual(r.notified, [
      { kind: 'ack', to: 'alice@signer.example', ok: true, reason: null },
      { kind: 'completion', to: 'boss@signer.example', ok: true, reason: null },
    ]);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: a non-counting reply sends nothing', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'cr11', type: 'crypto', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });

    // Unverified (offline) attest reply → committed but not counted → no sends.
    const r = await core.ingest(
      Buffer.from([
        'From: alice@signer.example', `To: attest+cr11@${OPERATOR}`, 'Subject: Re',
        'Message-ID: <x@signer.example>', 'Content-Type: text/plain', '', 'sign', '',
      ].join('\r\n')),
      envOf(`attest+cr11@${OPERATOR}`, 'alice@signer.example'),
    );
    assert.equal(r.counted, false);
    assert.deepEqual(r.notified, []);
    assert.deepEqual(cap.captures(), []);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: composeNotification overrides the body; neutral default otherwise', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const seen = [];
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
      composeNotification: (ctx) => {
        seen.push({ kind: ctx.kind, to: ctx.to });
        return ctx.kind === 'ack' ? 'CUSTOM-ACK-BODY for ' + ctx.eventId : null; // null → default
      },
    });
    await core.createEvent({
      id: 'cr12', type: 'crypto', title: 'Deed', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });

    await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr12@${OPERATOR}` }),
      envOf(`attest+cr12@${OPERATOR}`, 'alice@signer.example'),
    );

    // The hook saw both messages with full ctx.
    assert.deepEqual(seen, [
      { kind: 'ack', to: 'alice@signer.example' },
      { kind: 'completion', to: 'boss@signer.example' },
    ]);
    // The ack body is the custom one; the completion fell back to the neutral default.
    const ackMsg = cap.captures().find((m) => /To:\s*alice@signer.example/i.test(m));
    assert.match(ackMsg, /CUSTOM-ACK-BODY for cr12/);
    const doneMsg = cap.captures().find((m) => /To:\s*boss@signer.example/i.test(m));
    assert.match(doneMsg, /"Deed" is now complete/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: with no sendmailBin, sends degrade to ok:false without throwing', async () => {
  const tmp = await tmpDir();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver }); // no sendmailBin
    await core.createEvent({
      id: 'cr13', type: 'crypto', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });

    const r = await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr13@${OPERATOR}` }),
      envOf(`attest+cr13@${OPERATOR}`, 'alice@signer.example'),
    );
    // The transition still happened; only the (unconfigured) send failed.
    assert.equal(r.counted, true);
    assert.equal(r.eventComplete, true);
    assert.equal(r.notified.length, 2);
    assert.ok(r.notified.every((n) => n.ok === false && /not configured/.test(n.reason)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: completion ctx exposes countedCommits + per-reply receipts from the ledger', async () => {
  // m7d-5a — the completion-edge composer needs enough to render a "proof
  // block" (PRD §0.1.4 "the proof comes to the user"). The kernel sources
  // those receipts from the ledger we just finalised — one source of truth,
  // sender stays hashed (SPEC §6).
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const seenCtx = [];
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
      composeNotification: (ctx) => {
        if (ctx.kind === 'completion') seenCtx.push(ctx);
        return null; // fall back to the neutral default body
      },
    });
    await core.createEvent({
      id: 'wf20', type: 'workflow', flow: 'sequential', title: 'Two-step',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    // First reply counts but doesn't complete; second triggers the completion ctx.
    await core.ingest(
      await signer.sign({ from: 'alice@corp.example', to: `event+wf20-s1@${OPERATOR}` }),
      envOf(`event+wf20-s1@${OPERATOR}`, 'alice@corp.example'),
    );
    await core.ingest(
      await signer.sign({ from: 'bob@corp.example', to: `event+wf20-s2@${OPERATOR}` }),
      envOf(`event+wf20-s2@${OPERATOR}`, 'bob@corp.example'),
    );

    assert.equal(seenCtx.length, 1, 'composer saw the one completion edge');
    const c = seenCtx[0];
    assert.equal(c.countedCommits, 2);
    assert.equal(c.receipts.length, 2);
    // Receipts are ledger-sourced + ordered by sequence; senders stay hashed.
    assert.deepEqual(c.receipts.map((r) => r.step_id), ['s1', 's2']);
    assert.deepEqual(c.receipts.map((r) => r.sequence), [1, 2]);
    for (const r of c.receipts) {
      assert.equal(r.sender_domain, 'corp.example');
      assert.match(r.sender_hash, /^sha256:[0-9a-f]{64}$/, 'salted sender hash, no plaintext');
      assert.ok(r.received_at, 'received_at present');
      assert.equal(r.trust_level, 'verified');
    }
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('triggers: completion ctx for crypto carries the one signer receipt', async () => {
  // Crypto sign-off completing on the first locking reply: countedCommits == 1,
  // receipt has no step_id (crypto has no steps), sender_hash present.
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const seenCtx = [];
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
      composeNotification: (ctx) => {
        if (ctx.kind === 'completion') seenCtx.push(ctx);
        return null;
      },
    });
    await core.createEvent({
      id: 'cr20', type: 'crypto', title: 'Sign', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });
    await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr20@${OPERATOR}` }),
      envOf(`attest+cr20@${OPERATOR}`, 'alice@signer.example'),
    );

    assert.equal(seenCtx.length, 1);
    assert.equal(seenCtx[0].countedCommits, 1);
    assert.equal(seenCtx[0].receipts.length, 1);
    assert.equal(seenCtx[0].receipts[0].step_id, null);
    assert.equal(seenCtx[0].receipts[0].sender_domain, 'signer.example');
    assert.match(seenCtx[0].receipts[0].sender_hash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
