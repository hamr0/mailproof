'use strict';

// Inbound pipeline core (m7b-3 Commit B). Drives create().ingest end to end on
// a tmp dir against the real store + git ledger + both sequencing engines + the
// real mailauth/mailparser decode path (offline via an injected resolver). No
// mocks. The trigger/send layer (Commit C) is absent, so `notified` is empty.
//
// Proves the invariants: accept-with-flag (every routed reply is committed,
// counted or not), the count decision drives both the commit flag and the
// transition, workflow vs crypto routing by plus-tag, and completion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');
const { verifiedFixture, noDnsResolver } = require('../helpers/dkim');

const CRLF = '\r\n';
const OPERATOR = 'app.example';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ingest-'));
}

// An unsigned plaintext reply — authenticates to 'unverified' under noDnsResolver.
function unsignedEml({ from, to, subject = 'Re: step', extraHeaders = [] }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${Date.now()}@example.com>`,
    ...extraHeaders,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'done',
    '',
  ].join(CRLF));
}

const envOf = (recipient, sender) => ({
  recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example',
});

// --- workflow mode (event+) — countable offline (no minTrust ⇒ unverified passes) ---

test('ingest: a workflow reply from the participant counts, completes, and is committed', async () => {
  const tmp = await tmpDir();
  try {
    // A real step keeps the default minTrust ('verified'), so the participant's
    // reply must be DKIM-verified to count — exercise the full verify path.
    const { signedEml, resolver } = await verifiedFixture({
      domain: 'corp.example', from: 'alice@corp.example', to: `event+wf01-sign@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'wf01', type: 'workflow', flow: 'sequential', title: 'Onboard',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'sign', participant: 'alice@corp.example' }],
    });

    const r = await core.ingest(
      signedEml,
      envOf(`event+wf01-sign@${OPERATOR}`, 'alice@corp.example'),
    );

    assert.equal(r.routed, true);
    assert.equal(r.mode, 'workflow');
    assert.equal(r.counted, true);
    assert.equal(r.count_reason, null);
    assert.equal(r.completedStep, 'sign');
    assert.equal(r.eventComplete, true);
    assert.equal(r.committedSeq, 1);
    assert.deepEqual(r.notified, []);

    // State persisted to the master JSON.
    const ev = await core.loadEvent('wf01');
    assert.equal(ev.status, 'complete');
    assert.equal(ev.steps[0].status, 'complete');

    // The reply IS on the ledger, flagged counted.
    const commits = await core.listCommits('wf01');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].counted, true);
    assert.equal(commits[0].count_reason, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ingest: accept-with-flag — a wrong-participant reply is committed but does not count', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    await core.createEvent({
      id: 'wf02', type: 'workflow', flow: 'sequential',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'sign', participant: 'alice@corp.example' }],
    });

    const r = await core.ingest(
      unsignedEml({ from: 'mallory@evil.example', to: `event+wf02-sign@${OPERATOR}` }),
      envOf(`event+wf02-sign@${OPERATOR}`, 'mallory@evil.example'),
    );

    assert.equal(r.routed, true);
    assert.equal(r.counted, false);
    assert.equal(r.count_reason, 'wrong_participant');
    assert.equal(r.eventComplete, false);
    assert.equal(r.committedSeq, 1); // committed anyway

    const ev = await core.loadEvent('wf02');
    assert.equal(ev.status, 'open');
    const commits = await core.listCommits('wf02');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].counted, false);
    assert.equal(commits[0].count_reason, 'wrong_participant');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// --- crypto mode (attest+) — counting needs trust_level 'verified' ---

test('ingest: a verified signer reply counts as a signature and locks a threshold-1 event', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await verifiedFixture({
      from: 'alice@signer.example', to: `attest+cr01@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'cr01', type: 'crypto', title: 'Sign the deed',
      activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@signer.example'], threshold: 1,
    });

    const r = await core.ingest(
      signedEml,
      envOf(`attest+cr01@${OPERATOR}`, 'alice@signer.example'),
    );

    assert.equal(r.routed, true);
    assert.equal(r.mode, 'crypto');
    assert.equal(r.trustLevel, 'verified');
    assert.equal(r.counted, true);
    assert.equal(r.signatureCount, 1);
    assert.equal(r.eventComplete, true);

    const ev = await core.loadEvent('cr01');
    assert.equal(ev.status, 'complete');
    assert.equal(ev.signatures.length, 1);
    assert.equal(ev.signatures[0].sender_domain, 'signer.example');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ingest: an unverified attest reply is committed but does not count (high-assurance gate)', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    await core.createEvent({
      id: 'cr02', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@signer.example'], threshold: 1,
    });

    const r = await core.ingest(
      unsignedEml({ from: 'alice@signer.example', to: `attest+cr02@${OPERATOR}` }),
      envOf(`attest+cr02@${OPERATOR}`, 'alice@signer.example'),
    );

    assert.equal(r.routed, true);
    assert.equal(r.counted, false);
    assert.equal(r.count_reason, 'unverified_trust');
    assert.equal(r.eventComplete, false);
    assert.equal(r.committedSeq, 1);
    assert.equal((await core.loadEvent('cr02')).status, 'open');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ingest: anti-self-dealing — the initiators own verified reply is committed but never counts', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await verifiedFixture({
      from: 'boss@signer.example', to: `attest+cr03@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'cr03', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      initiator: 'boss@signer.example', open: true, threshold: 1,
    });

    const r = await core.ingest(
      signedEml,
      envOf(`attest+cr03@${OPERATOR}`, 'boss@signer.example'),
    );

    assert.equal(r.trustLevel, 'verified');
    assert.equal(r.counted, false);
    assert.equal(r.count_reason, 'initiator_self_reply');
    assert.equal(r.eventComplete, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// --- the not-committed paths (no event to attach to) ---

test('ingest: humans-only prefilter drops an auto-submitted reply (routed:false, no commit)', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    await core.createEvent({
      id: 'wf04', type: 'workflow', flow: 'sequential', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'sign', participant: 'alice@corp.example' }],
    });

    const r = await core.ingest(
      unsignedEml({
        from: 'alice@corp.example', to: `event+wf04-sign@${OPERATOR}`,
        extraHeaders: ['Auto-Submitted: auto-replied'],
      }),
      envOf(`event+wf04-sign@${OPERATOR}`, 'alice@corp.example'),
    );

    assert.equal(r.routed, false);
    assert.equal(r.rejected, true);
    assert.match(r.reason, /auto-submitted/);
    assert.deepEqual(await core.listCommits('wf04'), []); // nothing committed
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ingest: an unknown event and a tagless recipient both route to nothing (no commit)', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });

    const unknown = await core.ingest(
      unsignedEml({ from: 'a@corp.example', to: `event+nope01-x@${OPERATOR}` }),
      envOf(`event+nope01-x@${OPERATOR}`, 'a@corp.example'),
    );
    assert.equal(unknown.routed, false);
    assert.equal(unknown.reason, 'unknown_event');

    const tagless = await core.ingest(
      unsignedEml({ from: 'a@corp.example', to: `hello@${OPERATOR}` }),
      envOf(`hello@${OPERATOR}`, 'a@corp.example'),
    );
    assert.equal(tagless.routed, false);
    assert.equal(tagless.reason, 'no_event_tag');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
