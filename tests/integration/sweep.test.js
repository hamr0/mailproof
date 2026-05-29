
// Integration tests for sweep() — the time-driven trigger pass (m7d-1). Drives
// the public create() surface against a real event store + ledger + a fake
// capture transport (no mocks). Proves: the overdue nudge fires once and is
// idempotent; auto-archive is a persisted + ledger-mirrored transition; archive
// takes precedence over a same-tick overdue; the reference clock honours pending
// step deadlines; not-yet-due events are untouched; and composeNotification
// overrides the body. Time is injected via sweep({ now }) for determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';
import { verifiedSigner } from '../helpers/dkim.js';

const OPERATOR = 'app.example';
const DAY = 86400 * 1000;
const ACTIVATED = '2026-01-01T00:00:00Z';
const ACT_MS = new Date(ACTIVATED).getTime();

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-sweep-'));
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

// A workflow event activated at ACTIVATED with one pending, deadline-less step.
function wfEvent(id, extra = {}) {
  return {
    id, type: 'workflow', flow: 'sequential', title: 'Quarterly review',
    initiator: 'boss@corp.example', activated_at: ACTIVATED,
    steps: [{ id: 's1', participant: 'alice@corp.example' }],
    ...extra,
  };
}

test('sweep: overdue nudges the initiator once, then is idempotent', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent(wfEvent('ov1'));

    // 20 days past the clock: past overdueDays (14), short of archiveDays (45).
    const r = await core.sweep({ now: ACT_MS + 20 * DAY });
    assert.deepEqual(r.archived, []);
    assert.equal(r.overdue.length, 1);
    assert.equal(r.overdue[0].eventId, 'ov1');
    assert.equal(r.overdue[0].daysOver, 20);
    assert.deepEqual(r.notified, [{ kind: 'overdue', to: 'boss@corp.example', ok: true, reason: null }]);

    // The nudge is From the event reply address (so a reply routes back) and is
    // marked machine-generated.
    const msg = cap.captures().find((m) => /To:\s*boss@corp.example/i.test(m));
    assert.match(msg, /From:\s*event\+ov1@app\.example/i);
    assert.match(msg, /Auto-Submitted:\s*auto-generated/i);

    // Persisted idempotency flag.
    const ev = await core.loadEvent('ov1');
    assert.ok(ev.nudged_overdue_at, 'nudged_overdue_at recorded');

    // A second sweep (even later, still pre-archive) sends nothing more.
    const r2 = await core.sweep({ now: ACT_MS + 30 * DAY });
    assert.deepEqual(r2.overdue, []);
    assert.deepEqual(r2.notified, []);
    assert.equal(cap.captures().length, 1, 'no second nudge');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: auto-archive transitions the event (persisted + ledger-mirrored) and notifies', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent(wfEvent('ar1'));

    const r = await core.sweep({ now: ACT_MS + 50 * DAY }); // past archiveDays (45)
    assert.equal(r.archived.length, 1);
    assert.equal(r.archived[0].eventId, 'ar1');
    assert.equal(r.archived[0].daysIdle, 50);
    assert.deepEqual(r.notified, [{ kind: 'archived', to: 'boss@corp.example', ok: true, reason: null }]);

    // The transition is on the master JSON. (This event never received a reply,
    // so it has no per-event repo yet; the ledger mirror is a best-effort no-op
    // — the next test proves it DOES commit when a repo exists.)
    const ev = await core.loadEvent('ar1');
    assert.ok(ev.archived_at, 'archived_at set');
    assert.equal(ev.archive_reason, 'auto_stale');

    // Now inactive → a later sweep does nothing.
    const r2 = await core.sweep({ now: ACT_MS + 60 * DAY });
    assert.deepEqual(r2.archived, []);
    assert.deepEqual(r2.overdue, []);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: auto-archive is mirrored into an existing per-event ledger', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'corp.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });
    // Two steps so a verified reply to s1 creates the repo + advances state but
    // leaves the event ACTIVE (s2 still pending) — eligible to age out.
    await core.createEvent(wfEvent('arm1', {
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    }));
    await core.ingest(
      await signer.sign({ from: 'alice@corp.example', to: `event+arm1-s1@${OPERATOR}` }),
      { recipient: `event+arm1-s1@${OPERATOR}`, sender: 'alice@corp.example', clientIp: '198.51.100.9', clientHelo: 'mta.example' },
    );

    await core.sweep({ now: ACT_MS + 50 * DAY });

    // The repo's mirrored working-tree event.json reflects the archive — so the
    // offline verifier reads fresh state, not a pre-archive snapshot.
    const repoEvent = JSON.parse(
      fss.readFileSync(path.join(tmp, 'repos', 'arm1', 'event.json'), 'utf8'),
    );
    assert.ok(repoEvent.archived_at, 'archive mirrored into the ledger event.json');
    assert.equal(repoEvent.archive_reason, 'auto_stale');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: archive takes precedence over a same-tick overdue (one email, not two)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent(wfEvent('pr1')); // never nudged, will appear already-stale

    const r = await core.sweep({ now: ACT_MS + 60 * DAY }); // past BOTH thresholds
    assert.deepEqual(r.overdue, [], 'no overdue nudge when archiving');
    assert.equal(r.archived.length, 1);
    assert.deepEqual(r.notified.map((n) => n.kind), ['archived']);
    assert.equal(cap.captures().length, 1);

    const ev = await core.loadEvent('pr1');
    assert.ok(ev.archived_at);
    assert.ok(!ev.nudged_overdue_at, 'not nudged — it was archived instead');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: the reference clock honours a pending step deadline, not just activated_at', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    // Activated only 1 day before "now", but a step deadline sits 20 days back —
    // the clock is the deadline, so this is overdue despite recent activation.
    const now = ACT_MS + 100 * DAY;
    await core.createEvent(wfEvent('dl1', {
      activated_at: new Date(now - 1 * DAY).toISOString(),
      steps: [{ id: 's1', participant: 'alice@corp.example', deadline: new Date(now - 20 * DAY).toISOString().slice(0, 10) }],
    }));

    const r = await core.sweep({ now });
    assert.equal(r.overdue.length, 1, 'overdue by the deadline clock');
    assert.equal(r.overdue[0].eventId, 'dl1');
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: leaves not-yet-due events untouched and sends nothing', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    await core.createEvent(wfEvent('fresh1'));

    const r = await core.sweep({ now: ACT_MS + 5 * DAY }); // well under 14 days
    assert.deepEqual(r, { overdue: [], archived: [], notified: [] });
    assert.equal(cap.captures().length, 0);
    const ev = await core.loadEvent('fresh1');
    assert.ok(!ev.nudged_overdue_at);
    assert.ok(!ev.archived_at);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: composeNotification overrides the occasion body (kind-keyed)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({
      dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script,
      composeNotification: ({ kind, event }) =>
        kind === 'overdue' ? `CUSTOM overdue body for ${event.id}` : null,
    });
    await core.createEvent(wfEvent('cn1'));

    await core.sweep({ now: ACT_MS + 20 * DAY });
    const msg = cap.captures().find((m) => /To:\s*boss@corp.example/i.test(m));
    assert.match(msg, /CUSTOM overdue body for cn1/);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sweep: custom thresholds (overdueDays/archiveDays) are honoured', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({
      dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script,
      overdueDays: 2, archiveDays: 5,
    });
    await core.createEvent(wfEvent('th1'));

    // 3 days: past the custom overdue (2), short of the custom archive (5).
    const r = await core.sweep({ now: ACT_MS + 3 * DAY });
    assert.equal(r.overdue.length, 1);
    assert.deepEqual(r.archived, []);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
