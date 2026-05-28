'use strict';

// m7d end-to-end (m7d-5c) — the full trigger surface, exercised through ONE
// `create()` instance against real I/O (real outbound to a fake sendmail, real
// per-event git repos, fake `ots` binary that simulates stamp+upgrade). The
// goal isn't to re-prove each occasion's contract (every kind has its own
// dedicated integration test) — it's to assert the COMPOSITION: every kernel-
// derivable occasion fires through the same `deliver()` seam, keyed by `kind`,
// over a single bound notifier.
//
// 9-occasion checklist (m7d table):
//   activation    — first activateEvent transition pings the eligible roster
//   advance       — counted reply completes a step but not the event
//   ack           — counted crypto reply, threshold>1 so it doesn't complete
//   remind (advance|activation + ctx.reminder=true) — initiator command path
//   bounce        — inbound DSN → operational nudge to the initiator
//   overdue       — sweep() past overdueDays
//   archived      — sweep() past archiveDays (separate event so it doesn't
//                   race with overdue on the same id; precedence is archive)
//   completion    — final counted reply that completes the event
//   proof_anchored — upgradeProofs() finds every .ots fully anchored
//
// All on one event where possible (workflow `wf` carries activation, advance,
// remind, bounce, overdue, completion, proof_anchored); a separate crypto
// event `cr` exercises ack + reassigned; a third event `arch` exercises
// archived (precedence prevents overdue+archived on the same id in one tick).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { create } = require('../../src/create');
const { verifiedSigner } = require('../helpers/dkim');

const OPERATOR = 'app.example';
const CRLF = '\r\n';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-m7d-e2e-'));
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

// A fake `ots` binary. Handles the three subcommands the kernel uses:
//   stamp <abs>   → write a pending proof at <abs>.ots, exit 0
//   upgrade <abs> → mutate the proof bytes (sha changes ⇒ changed:true), exit 0 (anchored)
//   info <abs>    → print a block height ots.js's parseOtsBlockHeight accepts
function fakeOts() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'mailproof-ots-'));
  const script = path.join(dir, 'ots.sh');
  fss.writeFileSync(script, [
    '#!/bin/sh',
    'case "$1" in',
    '  stamp)   printf pending > "$2.ots"; exit 0 ;;',
    '  upgrade) printf upgraded > "$2";    exit 0 ;;',
    '  info)    echo "Bitcoin block 850000"; exit 0 ;;',
    '  *)       exit 2 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  return { script, cleanup: () => fss.rmSync(dir, { recursive: true, force: true }) };
}

const envOf = (recipient, sender) => ({
  recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example',
});

// A minimal RFC 3464 DSN addressed to our return path (= the plus-tag we sent
// from). Same shape the ingest-bounce test uses.
function dsnTo(returnPath, { finalRecipient = 'alice@corp.example' } = {}) {
  const b = 'BOUND';
  return Buffer.from([
    'From: MAILER-DAEMON@mx.example',
    `To: ${returnPath}`,
    'Subject: Undelivered Mail Returned to Sender',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain', '',
    'Delivery failed permanently.', '',
    `--${b}`,
    'Content-Type: message/delivery-status', '',
    'Reporting-MTA: dns; mx.example', '',
    `Final-Recipient: rfc822;${finalRecipient}`,
    'Action: failed', 'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 user unknown', '',
    `--${b}--`, '',
  ].join(CRLF));
}

test('m7d e2e: every kernel occasion fires through one deliver(), keyed by kind', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  const ots = fakeOts();

  // Capture every composeNotification ctx so we can assert each occasion was
  // seen with the right (kind, recipient, reminder?) shape — the proof that
  // the one body hook actually sees every kind.
  const seen = [];
  const corpSigner = verifiedSigner({ domain: 'corp.example' });
  const sigSigner = verifiedSigner({ domain: 'signer.example' });
  // Both signers' DKIM keys must resolve; chain the resolvers (the test
  // helper's noDnsResolver-or-key shape: chain by trying each).
  const resolver = async (name, type) => {
    try { return await corpSigner.resolver(name, type); }
    catch { return await sigSigner.resolver(name, type); }
  };
  const core = create({
    dataDir: tmp, domain: OPERATOR, resolver, sendmailBin: cap.script,
    otsBin: ots.script,
    overdueDays: 1, archiveDays: 2,
    composeNotification: (ctx) => {
      seen.push({ kind: ctx.kind, to: ctx.to, eventId: ctx.eventId, reminder: !!ctx.reminder });
      return null; // neutral default body
    },
  });

  try {
    // ── workflow event (activation, advance, remind, bounce, overdue, completion, proof_anchored)
    await core.createEvent({
      id: 'wf', type: 'workflow', flow: 'sequential', title: 'Wf',
      initiator: 'boss@corp.example',
      steps: [
        { id: 's1', participant: 'alice@corp.example' },
        { id: 's2', participant: 'bob@corp.example' },
      ],
    });

    // [activation] First activateEvent → kickoff to initially-eligible step (s1 → alice).
    const act = await core.activateEvent('wf', { now: '2026-01-01T00:00:00Z' });
    assert.equal(act.alreadyActive, false);
    assert.deepEqual(act.notified.map((n) => n.kind), ['activation']);
    assert.equal(act.notified[0].to, 'alice@corp.example');

    // [advance] s1 reply counts + completes s1 → cascade to s2 (bob).
    const r1 = await core.ingest(
      await corpSigner.sign({ from: 'alice@corp.example', to: `event+wf-s1@${OPERATOR}` }),
      envOf(`event+wf-s1@${OPERATOR}`, 'alice@corp.example'),
    );
    assert.equal(r1.completedStep, 's1');
    assert.equal(r1.eventComplete, false);
    assert.deepEqual(r1.notified.map((n) => n.kind), ['advance']);

    // [remind] initiator triggers a reminder to bob (the currently-eligible step).
    const rem = await core.ingest(
      await corpSigner.sign({ from: 'boss@corp.example', to: `remind+wf@${OPERATOR}` }),
      envOf(`remind+wf@${OPERATOR}`, 'boss@corp.example'),
    );
    assert.equal(rem.command, 'remind');
    assert.equal(rem.authenticated, true);
    assert.deepEqual(rem.notified.map((n) => n.kind), ['advance']);
    // The remind reuses kind:'advance' but ctx.reminder=true distinguishes it.
    assert.ok(seen.some((s) => s.kind === 'advance' && s.reminder === true && s.to === 'bob@corp.example'));

    // [bounce] inbound DSN names the s2 return path → operational nudge to the initiator.
    const bnc = await core.ingest(
      dsnTo(`event+wf-s2@${OPERATOR}`, { finalRecipient: 'bob@corp.example' }),
      envOf(`event+wf-s2@${OPERATOR}`, 'MAILER-DAEMON@mx.example'),
    );
    assert.equal(bnc.bounce, true);
    assert.deepEqual(bnc.notified.map((n) => n.kind), ['bounce']);
    assert.equal(bnc.notified[0].to, 'boss@corp.example');

    // [overdue] sweep at clock+1.5 days → nudge to the initiator (idempotent flag flips).
    const clock = new Date('2026-01-01T00:00:00Z').getTime();
    const overSweep = await core.sweep({ now: clock + 1.5 * 86400 * 1000 });
    assert.deepEqual(overSweep.overdue.map((o) => o.eventId), ['wf']);
    assert.deepEqual(overSweep.notified.map((n) => n.kind), ['overdue']);

    // [completion] s2 reply completes the event → completion notice to the initiator,
    // ctx carries countedCommits + receipts (m7d-5a).
    const r2 = await core.ingest(
      await corpSigner.sign({ from: 'bob@corp.example', to: `event+wf-s2@${OPERATOR}` }),
      envOf(`event+wf-s2@${OPERATOR}`, 'bob@corp.example'),
    );
    assert.equal(r2.eventComplete, true);
    assert.deepEqual(r2.notified.map((n) => n.kind), ['completion']);
    const completionCtx = seen.find((s) => s.kind === 'completion' && s.eventId === 'wf');
    assert.ok(completionCtx, 'completion composer ctx was seen');

    // [proof_anchored] upgradeProofs sees every .ots fold in the Bitcoin attestation
    // (fake ots: upgrade mutates → changed → anchored), records into the ledger,
    // emits once to the initiator.
    assert.equal(typeof core.upgradeProofs, 'function', 'upgradeProofs surfaced when otsBin is configured');
    const up = await core.upgradeProofs();
    assert.ok(up.events.length >= 1, 'walked at least one event');
    assert.deepEqual(up.notified.map((n) => n.kind), ['proof_anchored']);
    // Re-run is a no-op (already notified once via the per-event flag).
    const up2 = await core.upgradeProofs();
    assert.deepEqual(up2.notified, []);

    // ── crypto event (ack — threshold>1 so the first reply doesn't complete) ──
    await core.createEvent({
      id: 'cr', type: 'crypto', title: 'Sign',
      initiator: 'boss@signer.example',
      signers: ['alice@signer.example', 'eve@signer.example'],
      threshold: 2, activated_at: '2026-01-01T00:00:00Z',
    });
    const rc1 = await core.ingest(
      await sigSigner.sign({ from: 'alice@signer.example', to: `attest+cr@${OPERATOR}` }),
      envOf(`attest+cr@${OPERATOR}`, 'alice@signer.example'),
    );
    // [ack] verified + counted + NOT yet complete → ack to the signer only.
    assert.equal(rc1.counted, true);
    assert.equal(rc1.eventComplete, false);
    assert.deepEqual(rc1.notified.map((n) => n.kind), ['ack']);

    // ── archived event (separate id; archive precedence so it doesn't race overdue) ──
    await core.createEvent({
      id: 'arch', type: 'workflow', flow: 'sequential', title: 'Stale',
      initiator: 'boss@corp.example', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', participant: 'alice@corp.example' }],
    });
    // [archived] sweep at clock+3 days (> archiveDays=2) → state transition + notice.
    const archSweep = await core.sweep({ now: clock + 3 * 86400 * 1000 });
    assert.ok(archSweep.archived.some((a) => a.eventId === 'arch'), 'arch was archived');
    assert.ok(archSweep.notified.some((n) => n.kind === 'archived'), 'archived occasion fired');

    // ── full coverage check: every kernel-derivable occasion was seen ────────
    const kindsSeen = new Set(seen.map((s) => s.kind));
    for (const kind of ['activation', 'advance', 'ack', 'completion', 'overdue', 'archived', 'bounce', 'proof_anchored']) {
      assert.ok(kindsSeen.has(kind), `composer saw kind:'${kind}' at least once`);
    }
    // remind reuses kind:'advance' + ctx.reminder=true (one source of truth: same body path).
    assert.ok(seen.some((s) => s.kind === 'advance' && s.reminder === true), 'remind seen as advance+reminder');
  } finally {
    cap.cleanup();
    ots.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
