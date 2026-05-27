'use strict';

// Inbound bounce (m7d-3). A DSN delivered to a plus-tagged reply address (our
// outbound return path) is recognised BEFORE the humans-only prefilter, routed
// to the event/step by that tag, recorded as a per-step send error, and the
// initiator is notified with the `bounce` occasion. A bounce is operational, not
// a participant reply — it is never committed to the ledger. Drives the public
// create() surface against a fake capture transport.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');

const OPERATOR = 'app.example';
const CRLF = '\r\n';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-bnc-'));
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

// A DSN addressed to `returnPath` (the plus-tag we sent from).
function dsnTo(returnPath, { action = 'failed', status = '5.1.1', diagnostic = 'smtp; 550 5.1.1 user unknown', finalRecipient = 'alice@corp.example', boundary = 'BOUND' } = {}) {
  return Buffer.from([
    'From: MAILER-DAEMON@mx.example',
    `To: ${returnPath}`,
    'Subject: Undelivered Mail Returned to Sender',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'Delivery failed permanently.',
    '',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example',
    '',
    `Final-Recipient: rfc822;${finalRecipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    `Diagnostic-Code: ${diagnostic}`,
    '',
    `--${boundary}--`,
    '',
  ].join(CRLF));
}

const env = (recipient) => ({ recipient, sender: 'MAILER-DAEMON@mx.example', clientIp: '198.51.100.9', clientHelo: 'mx.example' });

test('bounce: routes by plus-tag, records the step error, notifies the initiator', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfX', type: 'workflow', flow: 'sequential', title: 'Onboard',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });

    const r = await core.ingest(dsnTo(`event+wfX-s1@${OPERATOR}`), env(`event+wfX-s1@${OPERATOR}`));
    assert.equal(r.bounce, true);
    assert.equal(r.routed, false);
    assert.equal(r.eventId, 'wfX');
    assert.equal(r.stepId, 's1');
    assert.deepEqual(r.failedRecipients, ['alice@corp.example']);
    assert.deepEqual(r.notified, [{ kind: 'bounce', to: 'boss@corp.example', ok: true, reason: null }]);

    // The per-step send error is recorded on the event...
    const ev = await core.loadEvent('wfX');
    const err = ev.steps[0].last_send_error;
    assert.ok(err, 'last_send_error set');
    assert.equal(err.code, '5.1.1');
    assert.match(err.reason, /550 5\.1\.1 user unknown/);

    // ...and NOT committed to the ledger (a bounce is operational, not a reply).
    assert.deepEqual(await core.listCommits('wfX'), []);

    // The notice goes to the initiator, From the event reply address, naming the
    // failed recipient and the server's diagnostic.
    const msg = cap.captures().find((m) => /To:\s*boss@corp.example/i.test(m));
    assert.match(msg, /From:\s*event\+wfX@app\.example/i);
    assert.match(msg, /alice@corp.example/);
    assert.match(msg, /550 5\.1\.1 user unknown/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('bounce: a transient (delayed) DSN records nothing and notifies no one', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'wfD', type: 'workflow', flow: 'sequential', title: 'Onboard',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });

    const r = await core.ingest(
      dsnTo(`event+wfD-s1@${OPERATOR}`, { action: 'delayed', status: '4.4.1' }),
      env(`event+wfD-s1@${OPERATOR}`),
    );
    assert.equal(r.bounce, true);
    assert.deepEqual(r.failedRecipients, []);
    assert.deepEqual(r.notified, []);
    assert.equal(cap.captures().length, 0);
    const ev = await core.loadEvent('wfD');
    assert.ok(!ev.steps[0].last_send_error, 'no error recorded for a transient delay');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('bounce: an untagged or unknown-event DSN is reported, not routed', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });

    const noTag = await core.ingest(dsnTo(`postmaster@${OPERATOR}`), env(`postmaster@${OPERATOR}`));
    assert.deepEqual(noTag, { routed: false, bounce: true, reason: 'no_event_tag' });

    const unknown = await core.ingest(dsnTo(`event+ghost-s1@${OPERATOR}`), env(`event+ghost-s1@${OPERATOR}`));
    assert.equal(unknown.bounce, true);
    assert.equal(unknown.reason, 'unknown_event');
    assert.equal(unknown.eventId, 'ghost');
    assert.equal(cap.captures().length, 0);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('bounce: a crypto event DSN notifies the initiator without a step error', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent({
      id: 'cyX', type: 'crypto', title: 'Resolution', initiator: 'chair@corp.example',
      threshold: 2, signers: ['a@corp.example', 'b@corp.example'], activated_at: '2026-01-01T00:00:00Z',
    });

    const r = await core.ingest(
      dsnTo(`attest+cyX@${OPERATOR}`, { finalRecipient: 'a@corp.example' }),
      env(`attest+cyX@${OPERATOR}`),
    );
    assert.equal(r.bounce, true);
    assert.equal(r.eventId, 'cyX');
    assert.equal(r.stepId, null);
    assert.deepEqual(r.notified, [{ kind: 'bounce', to: 'chair@corp.example', ok: true, reason: null }]);
    const msg = cap.captures().find((m) => /To:\s*chair@corp.example/i.test(m));
    assert.match(msg, /From:\s*attest\+cyX@app\.example/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
