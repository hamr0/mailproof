#!/usr/bin/env node
// gitcore POC — proves the extracted kernel composes as vanilla code,
// decoupled from gitdone's config singleton and crypto policy:
//
//   verify (trust classify) → sequence (workflow completion) →
//   git ledger (hash-chained commits) → email trigger (compose → outbox)
//
// Vanilla only: node stdlib + the `git` binary. No npm deps. Hardcoded
// happy path + 3 edge cases. NOT production — validates the boundary,
// then P1 rewrites it by lifting the real modules. (AGENT_RULES: POC first.)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DATA = path.join(__dirname, '.data');

// ---------------------------------------------------------------------------
// git ledger (stand-in for gitrepo.js; real lib uses simple-git)
// ---------------------------------------------------------------------------
function git(repo, args) {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=gitcore', '-c', 'user.email=gitcore@localhost', ...args],
    { encoding: 'utf8' },
  );
}
function repoPath(id) { return path.join(DATA, 'repos', id); }
function eventPath(id) { return path.join(DATA, 'events', `${id}.json`); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function initRepo(id, event) {
  const repo = repoPath(id);
  fs.mkdirSync(path.join(repo, 'commits'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'event.json'), JSON.stringify(event, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', `event created: ${event.title}`]);
}
function nextSeq(id) {
  const dir = path.join(repoPath(id), 'commits');
  return fs.readdirSync(dir).filter((f) => f.startsWith('commit-')).length + 1;
}
// Every accepted reply is committed (accept-with-flag) — even rejected ones,
// so the audit trail is complete. `counted` records whether it advanced state.
function commitReply(id, record) {
  const repo = repoPath(id);
  const seq = nextSeq(id);
  const name = `commit-${String(seq).padStart(3, '0')}.json`;
  const payload = { sequence: seq, ...record };
  fs.writeFileSync(path.join(repo, 'commits', name), JSON.stringify(payload, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m',
    `${record.kind || 'reply'} step=${record.step_id || '-'} counted=${record.counted} trust=${record.trust_level}`]);
  return seq;
}
function syncEvent(id, event, msg) {
  const repo = repoPath(id);
  fs.writeFileSync(path.join(repo, 'event.json'), JSON.stringify(event, null, 2));
  fs.writeFileSync(eventPath(id), JSON.stringify(event, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

// ---------------------------------------------------------------------------
// verify (stand-in for classifier.js; real lib feeds a mailauth result in)
// ---------------------------------------------------------------------------
const TRUST = ['unverified', 'authorized', 'forwarded', 'verified']; // rank asc
function classifyTrust(auth) {
  if (auth.dkimPassAligned && auth.dmarcPass) return 'verified';
  if (auth.arcPass) return 'forwarded';
  if (auth.spfPass && auth.dmarcPass) return 'authorized';
  return 'unverified';
}
function meetsTrust(level, min) { return TRUST.indexOf(level) >= TRUST.indexOf(min); }

// ---------------------------------------------------------------------------
// sequence (stand-in for the workflow subset of completion.js)
// ---------------------------------------------------------------------------
function loadEvent(id) { return JSON.parse(fs.readFileSync(eventPath(id), 'utf8')); }

function createEvent({ id, title, flow, steps, initiator }) {
  const event = {
    id, title, type: 'workflow', flow, initiator,
    status: 'open',
    created_at: new Date().toISOString(),
    steps: steps.map((s) => ({ status: 'pending', dependsOn: [], minTrust: 'verified', commit_sequence: null, ...s })),
  };
  fs.mkdirSync(path.dirname(eventPath(id)), { recursive: true });
  fs.writeFileSync(eventPath(id), JSON.stringify(event, null, 2));
  initRepo(id, event);
  return event;
}
function firstPendingStep(event) { return event.steps.find((s) => s.status === 'pending') || null; }
function stepDepsMet(event, step) {
  return (step.dependsOn || []).every((d) => {
    const dep = event.steps.find((s) => s.id === d);
    return dep && dep.status === 'complete';
  });
}
// A reply counts for step S iff: trust ≥ S.minTrust, sender is S's participant,
// S's deps are met, and (sequential) S is the earliest pending step.
function shouldCount(event, step, { trustLevel, participantMatch }) {
  if (!step || step.status === 'complete') return false;
  if (!participantMatch) return false;
  if (!meetsTrust(trustLevel, step.minTrust)) return false;
  if (!stepDepsMet(event, step)) return false;
  if (event.flow === 'sequential') {
    const earliest = firstPendingStep(event);
    return earliest && earliest.id === step.id;
  }
  return true;
}

// ---------------------------------------------------------------------------
// email triggers (stand-in for outbound.js buildRawMessage + sendmail)
// ---------------------------------------------------------------------------
function buildRawMessage({ from, to, subject, body }) {
  const date = new Date().toUTCString();
  const mid = `<${crypto.randomUUID()}@gitcore.local>`;
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    `Date: ${date}`, `Message-ID: ${mid}`,
    `Auto-Submitted: auto-generated`, ``, body, ``,
  ].join('\r\n');
}
// POC stand-in for sendmail(8): write the composed message to an outbox dir
// instead of injecting into Postfix. The real lib pipes this to /usr/sbin/sendmail.
function send({ from, to, subject, body }) {
  const outbox = path.join(DATA, 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const n = fs.readdirSync(outbox).length + 1;
  fs.writeFileSync(path.join(outbox, `${String(n).padStart(2, '0')}.eml`),
    buildRawMessage({ from, to, subject, body }));
  return { to, subject };
}
function stepReplyAddr(eventId, stepId) { return `event+${eventId}-${stepId}@gitcore.local`; }
function notifyStep(event, step) {
  return send({
    from: `gitcore <event+${event.id}@gitcore.local>`,
    to: step.participant,
    subject: `[${event.title}] your step: ${step.name}`,
    body: `Please reply to this email to confirm "${step.name}".\nReply address: ${stepReplyAddr(event.id, step.id)}`,
  });
}

// ---------------------------------------------------------------------------
// the pipeline — the one function that wires the four pillars together
// (this is what receive.js does in gitdone; here it's ~20 lines)
// ---------------------------------------------------------------------------
function ingest({ eventId, stepId, sender, auth }) {
  const event = loadEvent(eventId);
  const step = event.steps.find((s) => s.id === stepId) || null;

  // verify
  const trustLevel = classifyTrust(auth);
  const participantMatch = !!step && sender.toLowerCase() === step.participant.toLowerCase();

  // sequence (decide) — but ALWAYS commit (accept-with-flag audit trail)
  const counted = shouldCount(event, step, { trustLevel, participantMatch });
  const seq = commitReply(eventId, {
    event_id: eventId, step_id: stepId, sender,
    trust_level: trustLevel, participant_match: participantMatch, counted,
    received_at: new Date().toISOString(),
  });

  const out = { seq, trustLevel, participantMatch, counted, completedStep: null, notified: [], eventComplete: false };
  if (!counted) return out;

  // advance state
  step.status = 'complete';
  step.commit_sequence = seq;
  out.completedStep = step.id;

  // git trigger: notify newly-eligible next steps
  const newlyEligible = event.steps.filter(
    (s) => s.status === 'pending' && stepDepsMet(event, s) &&
      (event.flow !== 'sequential' || firstPendingStep(event).id === s.id),
  );

  if (event.steps.every((s) => s.status === 'complete')) {
    event.status = 'complete';
    event.completed_at = new Date().toISOString();
    out.eventComplete = true;
  }
  syncEvent(eventId, event, `step ${step.id} complete${out.eventComplete ? ' — event complete' : ''}`);

  for (const s of newlyEligible) out.notified.push(notifyStep(event, s).to);
  if (out.eventComplete) {
    send({ from: `gitcore <event+${event.id}@gitcore.local>`, to: event.initiator,
      subject: `[${event.title}] complete`, body: `All steps confirmed. The git ledger is your proof.` });
    out.notified.push(event.initiator);
  }
  return out;
}

// ===========================================================================
// RUNNER — happy path + 3 edges on one sequential 2-step event
// ===========================================================================
const PASS = { dkimPassAligned: true, dmarcPass: true };          // → verified
const UNVERIFIED = { dkimPassAligned: false, dmarcPass: false };  // → unverified

function show(label, r) {
  console.log(`  ${label.padEnd(42)} seq#${r.seq}  counted=${String(r.counted).padEnd(5)} trust=${r.trustLevel}` +
    (r.completedStep ? `  ✓${r.completedStep}` : '') +
    (r.notified.length ? `  → notified: ${r.notified.join(', ')}` : '') +
    (r.eventComplete ? '  🏁 EVENT COMPLETE' : ''));
}

fs.rmSync(DATA, { recursive: true, force: true });

console.log('\ngitcore POC — sequential workflow: legal → finance\n');
createEvent({
  id: 'demo1', title: 'Contract sign-off', flow: 'sequential', initiator: 'organiser@acme.com',
  steps: [
    { id: 'legal', name: 'Legal review', participant: 'legal@acme.com' },
    { id: 'finance', name: 'Finance approval', participant: 'finance@acme.com', dependsOn: ['legal'] },
  ],
});

console.log('Ingesting replies:');
show('1. finance replies first (out of order)', ingest({ eventId: 'demo1', stepId: 'finance', sender: 'finance@acme.com', auth: PASS }));
show('2. legal — wrong participant', ingest({ eventId: 'demo1', stepId: 'legal', sender: 'intruder@evil.com', auth: PASS }));
show('3. legal — unverified DKIM', ingest({ eventId: 'demo1', stepId: 'legal', sender: 'legal@acme.com', auth: UNVERIFIED }));
show('4. legal — verified, right sender', ingest({ eventId: 'demo1', stepId: 'legal', sender: 'legal@acme.com', auth: PASS }));
show('5. finance — verified, right sender', ingest({ eventId: 'demo1', stepId: 'finance', sender: 'finance@acme.com', auth: PASS }));

const ev = loadEvent('demo1');
console.log(`\nFinal event state: status=${ev.status}  steps=[${ev.steps.map((s) => `${s.id}:${s.status}`).join(', ')}]`);

console.log('\nGit ledger (hash-chained — every reply committed, even rejected ones):');
console.log(git(repoPath('demo1'), ['log', '--oneline', '--no-decorate']).split('\n').filter(Boolean).map((l) => '  ' + l).join('\n'));

const outbox = fs.readdirSync(path.join(DATA, 'outbox'));
console.log(`\nOutbox (composed notifications): ${outbox.length} message(s)`);
for (const f of outbox) {
  const subj = fs.readFileSync(path.join(DATA, 'outbox', f), 'utf8').split('\r\n').find((l) => l.startsWith('Subject:'));
  console.log(`  ${f}: ${subj}`);
}

// assertions — the POC must hold these or the boundary is wrong
const assert = require('node:assert');
assert.strictEqual(ev.status, 'complete', 'event should complete');
assert.strictEqual(git(repoPath('demo1'), ['rev-list', '--count', 'HEAD']).trim(), '8',
  '8 commits: init + 5 replies + 2 state-syncs');
assert.strictEqual(outbox.length, 2, 'finance invite + completion notice');
console.log('\n✅ POC assertions passed — verify+sequence+git+email compose cleanly.\n');
