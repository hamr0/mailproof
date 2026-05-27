'use strict';

// Organiser-action occasions (m7d-2). activateEvent fires the `activation`
// kickoff to every initially-eligible participant (workflow) / listed signer
// (crypto), once. editEvent fires `reassigned` to a participant moved onto a
// currently-eligible step of an activated event. Both go through the shared
// notifier to a fake capture transport — no mocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');

const OPERATOR = 'app.example';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-act-'));
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

test('activation: sequential workflow pings only the first eligible step, once', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfA', type: 'workflow', flow: 'sequential', title: 'Onboard',
      initiator: 'boss@corp.example',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    const r = await core.activateEvent('wfA');
    assert.equal(r.alreadyActive, false);
    assert.deepEqual(r.notified, [{ kind: 'activation', to: 'alice@corp.example', ok: true, reason: null }]);

    const msg = cap.captures().find((m) => /To:\s*alice@corp.example/i.test(m));
    assert.match(msg, /From:\s*event\+wfA-s1@app\.example/i);
    assert.match(msg, /Auto-Submitted:\s*auto-generated/i);

    // Idempotent: re-activating notifies no one.
    const r2 = await core.activateEvent('wfA');
    assert.equal(r2.alreadyActive, true);
    assert.deepEqual(r2.notified, []);
    assert.equal(cap.captures().length, 1);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('activation: parallel workflow pings every initial step', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfP', type: 'workflow', flow: 'parallel', title: 'Sign-offs',
      initiator: 'boss@corp.example',
      steps: [
        { id: 'a', participant: 'alice@corp.example' },
        { id: 'b', participant: 'bob@corp.example' },
      ],
    });
    const r = await core.activateEvent('wfP');
    assert.deepEqual(r.notified.map((n) => n.to).sort(), ['alice@corp.example', 'bob@corp.example']);
    assert.ok(r.notified.every((n) => n.kind === 'activation' && n.ok));
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('activation: crypto pings the listed signers (attest+ reply address)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'cyA', type: 'crypto', title: 'Board resolution',
      initiator: 'chair@corp.example', threshold: 2,
      signers: ['a@corp.example', 'b@corp.example'],
    });
    const r = await core.activateEvent('cyA');
    assert.deepEqual(r.notified.map((n) => n.to).sort(), ['a@corp.example', 'b@corp.example']);
    const msg = cap.captures().find((m) => /To:\s*a@corp.example/i.test(m));
    assert.match(msg, /From:\s*attest\+cyA@app\.example/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('activation: open crypto event (no roster) notifies no one', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'cyO', type: 'crypto', title: 'Open petition',
      initiator: 'chair@corp.example', open: true, threshold: 3,
    });
    const r = await core.activateEvent('cyO');
    assert.deepEqual(r.notified, []);
    assert.equal(cap.captures().length, 0);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('edit-renotify: reassigning an eligible step pings the new participant', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfE', type: 'workflow', flow: 'sequential', title: 'Review',
      initiator: 'boss@corp.example',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });
    await core.activateEvent('wfE'); // pings alice (s1)

    // Reassign the eligible step s1 → carol gets the kickoff.
    const r = await core.editEvent('wfE', { steps: [{ id: 's1', participant: 'carol@corp.example' }] });
    assert.deepEqual(r.notified, [{ kind: 'reassigned', to: 'carol@corp.example', ok: true, reason: null }]);
    const msg = cap.captures().find((m) => /To:\s*carol@corp.example/i.test(m));
    assert.match(msg, /From:\s*event\+wfE-s1@app\.example/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('edit-renotify: reassigning a BLOCKED step does not ping (advance will, later)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfB', type: 'workflow', flow: 'sequential', title: 'Review',
      initiator: 'boss@corp.example',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' }, // depends on s1 → not eligible yet
      ],
    });
    await core.activateEvent('wfB');
    cap.cleanup(); // ignore the activation send; fresh capture dir
    const cap2 = fakeSendmail();
    const core2 = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap2.script });
    try {
      const r = await core2.editEvent('wfB', { steps: [{ id: 's2', participant: 'dave@corp.example' }] });
      assert.deepEqual(r.notified, []);
      assert.equal(cap2.captures().length, 0);
    } finally {
      cap2.cleanup();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('edit-renotify: a non-participant edit, and edits on a pending event, ping no one', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfN', type: 'workflow', flow: 'sequential', title: 'Review',
      initiator: 'boss@corp.example',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });

    // Pending (never activated): even a participant change pings no one.
    const rp = await core.editEvent('wfN', { steps: [{ id: 's1', participant: 'zoe@corp.example' }] });
    assert.deepEqual(rp.notified, []);

    await core.activateEvent('wfN'); // pings zoe
    const before = cap.captures().length;
    // Activated, but a title-only edit is not a reassignment.
    const rt = await core.editEvent('wfN', { title: 'Review (Q2)' });
    assert.deepEqual(rt.notified, []);
    assert.equal(cap.captures().length, before, 'no new email for a title edit');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
