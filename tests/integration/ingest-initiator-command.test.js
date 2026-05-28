'use strict';

// Initiator commands (m7d-5b) — `remind+{id}@` and `stats+{id}@`. These are
// not participant replies and are never committed to the ledger; they're the
// initiator's keyboard for the live event. Auth is DKIM-verified + envelope
// sender == event.initiator (PRD §6.4 — gitdone's `authenticateInitiatorCommand`).
//
// remind re-fires pending-step prompts through the SAME `deliver()` + kinds
// that the cascade-advance / activation-kickoff paths already use, with
// `ctx.reminder = true` so a composer can distinguish a remind from a
// first-time prompt — matching gitdone's `notifyWorkflowParticipants({reminder:true})`
// reuse. stats returns a structured kernel snapshot; composing the reply body
// is policy (gitdone's `statsBody` is a rendered text composition, not a kernel
// mechanism — there is no outbound for stats here).

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
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-cmd-'));
}

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

test('remind+: workflow — initiator triggers reminder to every eligible step (ctx.reminder=true)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const seenCtx = [];
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
      composeNotification: (ctx) => { seenCtx.push({ kind: ctx.kind, to: ctx.to, reminder: !!ctx.reminder }); return null; },
    });
    // Two-step parallel (no dependsOn): BOTH steps are eligible from the start.
    await core.createEvent({
      id: 'wf31', type: 'workflow', flow: 'parallel', title: 'Two-track',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });
    // The bound activateEvent already fired (status was activated at create
    // via activated_at). The activation kickoff in create.js runs on the
    // FIRST activateEvent transition — we never called activateEvent, so
    // no activation occasion fired. Good: seenCtx is empty.
    assert.deepEqual(seenCtx, [], 'no kickoff yet (we passed activated_at directly)');

    // Initiator sends remind+{id}@ — DKIM-verified, from the initiator.
    const r = await core.ingest(
      await signer.sign({ from: 'boss@corp.example', to: `remind+wf31@${OPERATOR}` }),
      envOf(`remind+wf31@${OPERATOR}`, 'boss@corp.example'),
    );
    assert.equal(r.routed, false);
    assert.equal(r.command, 'remind');
    assert.equal(r.authenticated, true);
    assert.equal(r.notified.length, 2);
    assert.ok(r.notified.every((n) => n.kind === 'advance' && n.ok === true));
    const recipients = new Set(r.notified.map((n) => n.to));
    assert.deepEqual(recipients, new Set(['alice@corp.example', 'bob@corp.example']));

    // Each remind ctx carried reminder:true and the kind matched the gitdone
    // body path (advance for workflow).
    assert.equal(seenCtx.length, 2);
    assert.ok(seenCtx.every((s) => s.kind === 'advance' && s.reminder === true));

    // The outbound is From the per-step plus-tag so a reply routes back.
    const aliceMsg = cap.captures().find((m) => /To:\s*alice@corp.example/i.test(m));
    assert.match(aliceMsg, /From:\s*event\+wf31-s1@app\.example/i);
    assert.match(aliceMsg, /Reminder: Two-track/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('remind+: crypto — pings every signer that has not yet signed (kind:activation, reminder:true)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
    });
    await core.createEvent({
      id: 'cr30', type: 'crypto', title: 'Sign',
      initiator: 'boss@signer.example',
      signers: ['alice@signer.example', 'eve@signer.example'],
      threshold: 2, activated_at: '2026-01-01T00:00:00Z',
    });

    // Alice signs (counts but does NOT complete — threshold 2).
    await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr30@${OPERATOR}` }),
      envOf(`attest+cr30@${OPERATOR}`, 'alice@signer.example'),
    );

    // Initiator reminds: alice (signed) is skipped; only eve gets the prompt.
    const r = await core.ingest(
      await signer.sign({ from: 'boss@signer.example', to: `remind+cr30@${OPERATOR}` }),
      envOf(`remind+cr30@${OPERATOR}`, 'boss@signer.example'),
    );
    assert.equal(r.command, 'remind');
    assert.equal(r.authenticated, true);
    assert.deepEqual(
      r.notified,
      [{ kind: 'activation', to: 'eve@signer.example', ok: true, reason: null }],
    );
    const eveMsg = cap.captures().find((m) => /To:\s*eve@signer.example/i.test(m));
    assert.match(eveMsg, /From:\s*attest\+cr30@app\.example/i);
    assert.match(eveMsg, /Reminder: Sign/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('stats+: returns a kernel snapshot AND sends a neutral default reply (kind:stats)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
    });
    await core.createEvent({
      id: 'wf32', type: 'workflow', flow: 'sequential', title: 'Two-step',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    const r = await core.ingest(
      await signer.sign({ from: 'boss@corp.example', to: `stats+wf32@${OPERATOR}` }),
      envOf(`stats+wf32@${OPERATOR}`, 'boss@corp.example'),
    );
    assert.equal(r.command, 'stats');
    assert.equal(r.authenticated, true);
    // Auto-send a neutral default reply to the initiator (kind:'stats').
    assert.deepEqual(r.notified, [{ kind: 'stats', to: 'boss@corp.example', ok: true, reason: null }]);
    const statsMsg = cap.captures().find((m) => /To:\s*boss@corp.example/i.test(m));
    assert.match(statsMsg, /From:\s*stats\+wf32@app\.example/i);
    assert.match(statsMsg, /Subject:\s*Status: Two-step/);
    assert.match(statsMsg, /Type: workflow/);
    assert.match(statsMsg, /\[ \] s1 → alice@corp.example/);
    assert.match(statsMsg, /\[ \] s2 → bob@corp.example/);

    // The snapshot reshapes loadEvent(id) into a stable surface (still on the
    // result so policy can override via composeNotification keyed on 'stats').
    assert.equal(r.snapshot.eventId, 'wf32');
    assert.equal(r.snapshot.type, 'workflow');
    assert.equal(r.snapshot.title, 'Two-step');
    assert.equal(r.snapshot.flow, 'sequential');
    assert.equal(r.snapshot.status, 'open'); // activated, no transitions yet
    assert.equal(r.snapshot.steps.length, 2);
    assert.equal(r.snapshot.steps[0].id, 's1');
    assert.equal(r.snapshot.steps[0].participant, 'alice@corp.example');
    assert.equal(r.snapshot.steps[0].status, 'pending');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('stats+: composeNotification override wins over the neutral default body', async () => {
  // The snapshot in ctx lets a consumer render any body it wants — branding/
  // prose stays policy (§8.6), same boundary as every other kind.
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
      composeNotification: (ctx) => {
        if (ctx.kind !== 'stats') return null;
        return `CUSTOM-STATS ${ctx.snapshot.eventId} sigs=${ctx.snapshot.signatureCount}/${ctx.snapshot.threshold}`;
      },
    });
    await core.createEvent({
      id: 'cr40', type: 'crypto', title: 'Sign',
      initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1,
      activated_at: '2026-01-01T00:00:00Z',
    });

    await core.ingest(
      await signer.sign({ from: 'boss@signer.example', to: `stats+cr40@${OPERATOR}` }),
      envOf(`stats+cr40@${OPERATOR}`, 'boss@signer.example'),
    );
    const msg = cap.captures()[0];
    assert.match(msg, /CUSTOM-STATS cr40 sigs=0\/1/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('initiator command auth: non-initiator sender is rejected (DKIM ok, identity wrong)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
    });
    await core.createEvent({
      id: 'wf33', type: 'workflow', flow: 'sequential', title: 'X',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });

    // Alice (verified by DKIM) tries remind+ — she's not the initiator.
    const r = await core.ingest(
      await signer.sign({ from: 'alice@corp.example', to: `remind+wf33@${OPERATOR}` }),
      envOf(`remind+wf33@${OPERATOR}`, 'alice@corp.example'),
    );
    assert.equal(r.command, 'remind');
    assert.equal(r.authenticated, false);
    assert.equal(r.reason, 'sender_not_initiator');
    assert.equal(cap.captures().length, 0, 'no outbound on rejected command');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('initiator command auth: unverified DKIM is rejected even when identity matches', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver, sendmailBin: cap.script,
    });
    await core.createEvent({
      id: 'wf34', type: 'workflow', flow: 'sequential', title: 'X',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });

    // Offline (no DKIM) reply from the initiator — DKIM ≠ verified, so reject.
    const r = await core.ingest(
      Buffer.from([
        'From: boss@corp.example', `To: remind+wf34@${OPERATOR}`, 'Subject: remind',
        'Message-ID: <x@corp.example>', 'Content-Type: text/plain', '', 'remind', '',
      ].join('\r\n')),
      envOf(`remind+wf34@${OPERATOR}`, 'boss@corp.example'),
    );
    assert.equal(r.authenticated, false);
    assert.equal(r.reason, 'unverified');
    assert.equal(cap.captures().length, 0);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('remind+: already-complete event short-circuits with reason:already_complete, no sends', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
    });
    await core.createEvent({
      id: 'cr31', type: 'crypto', title: 'Already done',
      initiator: 'boss@signer.example', signers: ['alice@signer.example'],
      threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });
    // Alice signs → threshold:1 → event completes.
    await core.ingest(
      await signer.sign({ from: 'alice@signer.example', to: `attest+cr31@${OPERATOR}` }),
      envOf(`attest+cr31@${OPERATOR}`, 'alice@signer.example'),
    );
    const beforeRemind = cap.captures().length;

    const r = await core.ingest(
      await signer.sign({ from: 'boss@signer.example', to: `remind+cr31@${OPERATOR}` }),
      envOf(`remind+cr31@${OPERATOR}`, 'boss@signer.example'),
    );
    assert.equal(r.authenticated, true);
    assert.equal(r.reason, 'already_complete');
    assert.deepEqual(r.notified, []);
    assert.equal(cap.captures().length, beforeRemind, 'no extra outbound after remind on a done event');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('remind+: unknown event returns reason:unknown_event without auth (no event to bind it to)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({
      dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script,
    });
    const r = await core.ingest(
      await signer.sign({ from: 'boss@corp.example', to: `remind+ghost@${OPERATOR}` }),
      envOf(`remind+ghost@${OPERATOR}`, 'boss@corp.example'),
    );
    assert.equal(r.command, 'remind');
    assert.equal(r.eventId, 'ghost');
    assert.equal(r.reason, 'unknown_event');
    assert.equal(cap.captures().length, 0);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
