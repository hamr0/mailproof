'use strict';

// Integration tests for the git ledger, lifted from gitdone's gitrepo.test.js
// and adapted to: the injected-config factory (createGitrepo({ dataDir }));
// raw `git` for the test's own commit counting (gitdone used simpleGit().log());
// and no OTS stamper wired (commits are unanchored, ots_proof_file: null). The
// reverify writer is deferred (no caller yet — module note in src/gitrepo.js),
// so its tests are not lifted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createGitrepo } = require('../../src/gitrepo');

const _exec = promisify(execFile);
const gitOut = async (cwd, args) => (await _exec('git', args, { cwd })).stdout.trim();
const commitCount = async (root) => parseInt(await gitOut(root, ['rev-list', '--count', 'HEAD']), 10);
const latestMsg = (root) => gitOut(root, ['log', '-1', '--format=%s']);

const SALT = 'a'.repeat(64);

let tmp;
let repo;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-repo-'));
  repo = createGitrepo({ dataDir: tmp }); // no ots → unanchored
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('initRepoIfNeeded: creates fresh repo with event.json first commit', async () => {
  const event = { id: 'testA', title: 'Test A', steps: [] };
  const r = await repo.initRepoIfNeeded('testA', event);
  assert.equal(r.initialised, true);
  assert.equal(r.root, repo.repoPath('testA'));

  const evt = JSON.parse(await fs.readFile(path.join(r.root, 'event.json'), 'utf8'));
  assert.equal(evt.id, 'testA');
  for (const d of ['commits', 'dkim_keys', 'ots_proofs']) {
    assert.equal((await fs.stat(path.join(r.root, d))).isDirectory(), true);
  }
  assert.equal(await commitCount(r.root), 1);
  assert.match(await latestMsg(r.root), /event created/);
});

test('initRepoIfNeeded: idempotent — does not reinit existing repo', async () => {
  const r1 = await repo.initRepoIfNeeded('testA', { id: 'testA', title: 'Test A', steps: [] });
  assert.equal(r1.initialised, false);
});

test('initRepoIfNeeded: rejects bad event ids (path traversal guard)', async () => {
  await assert.rejects(() => repo.initRepoIfNeeded('../bad', { id: '../bad' }), /invalid eventId/);
});

test('nextSequence: returns 1 on empty commits dir', async () => {
  const { root } = await repo.initRepoIfNeeded('testB', { id: 'testB', title: 'B', steps: [] });
  assert.equal(await repo.nextSequence(root), 1);
});

test('nextSequence: finds max then +1, ignores non-matching files', async () => {
  const { root } = await repo.initRepoIfNeeded('testC', { id: 'testC', title: 'C', steps: [] });
  await fs.writeFile(path.join(root, 'commits', 'commit-001.json'), '{}');
  await fs.writeFile(path.join(root, 'commits', 'commit-012.json'), '{}');
  await fs.writeFile(path.join(root, 'commits', 'not-a-commit.txt'), 'x');
  await fs.writeFile(path.join(root, 'commits', 'commit-003.json'), '{}');
  assert.equal(await repo.nextSequence(root), 13);
});

test('commitReply: writes commit-NNN.json (v2 schema), no plaintext, increments', async () => {
  const event = { id: 'testD', title: 'D', salt: SALT, steps: [{ id: 'step1' }] };
  const ctx = {
    eventId: 'testD', stepId: 'step1', receivedAt: '2026-04-17T14:22:00Z',
    envelope: { sender: 'alice@example.com', client_ip: '1.2.3.4' },
    from: 'alice@example.com', trustLevel: 'verified', participantMatch: true,
    attachments: [{ filename: 'x.pdf', size: 100, sha256: 'sha256:deadbeef' }],
    dkim: { result: 'pass' }, rawSha256: 'sha256:feed', rawSize: 500,
  };
  const r = await repo.commitReply('testD', event, ctx);
  assert.ok(r.sha, 'commit sha returned');
  assert.match(r.sha, /^[0-9a-f]+$/);
  assert.equal(r.sequence, 1);
  assert.match(r.file, /^commits\/commit-001\.json$/);
  assert.equal(r.ots_proof_file, null, 'unanchored when no ots wired');

  const saved = JSON.parse(await fs.readFile(path.join(r.repo_path, r.file), 'utf8'));
  assert.equal(saved.schema_version, 2);
  assert.equal(saved.event_id, 'testD');
  assert.equal(saved.step_id, 'step1');
  // SPEC §0.1 — no plaintext leaks:
  assert.equal(saved.sender, undefined);
  assert.equal(saved.subject, undefined);
  assert.equal(saved.body_preview, undefined);
  assert.equal(saved.message_id, undefined);
  // ...but hashed + domain survive:
  assert.equal(saved.sender_domain, 'example.com');
  assert.match(saved.sender_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(saved.trust_level, 'verified');
  assert.equal(saved.attachments.length, 1);
  // Accept-with-flag fields persist through the real write path (SPEC §4).
  assert.equal(saved.kind, 'reply');
  assert.equal(saved.counted, false, 'ctx omitted counted → false, not undefined');
  assert.equal(saved.count_reason, null);

  const r2 = await repo.commitReply('testD', event, ctx);
  assert.equal(r2.sequence, 2);
  assert.match(r2.file, /^commits\/commit-002\.json$/);

  // Git history: initial + 2 replies.
  assert.equal(await commitCount(r.repo_path), 3);
});

test('commitCompletion: writes commits/completion.json once, idempotent', async () => {
  const event = { id: 'testCompl', title: 'C', type: 'workflow', salt: SALT, steps: [{ id: 's1' }] };
  // Need a repo first (a reply establishes it).
  await repo.commitReply('testCompl', event, {
    eventId: 'testCompl', stepId: 's1', receivedAt: '2026-04-18T00:00:00Z',
    envelope: { sender: 'a@example.com' }, from: 'a@example.com',
    trustLevel: 'verified', participantMatch: true, counted: true,
    rawSha256: 'sha256:aa', rawSize: 10,
  });
  const commitsBefore = await commitCount(path.join(tmp, 'repos', 'testCompl'));

  const r = await repo.commitCompletion('testCompl', event, {
    completedAt: '2026-04-18T01:00:00Z', triggeringSequence: 1,
  });
  assert.equal(r.alreadyWritten, false);
  assert.match(r.file, /^commits\/completion\.json$/);
  assert.match(r.sha, /^[0-9a-f]+$/);

  const saved = JSON.parse(await fs.readFile(path.join(r.repo_path, r.file), 'utf8'));
  assert.equal(saved.kind, 'completion');
  assert.equal(saved.event_type, 'workflow');
  assert.equal(saved.event_mode, undefined, 'gitdone event_mode dropped (no mode in two-mode model)');
  assert.equal(saved.completed_at, '2026-04-18T01:00:00Z');
  assert.equal(saved.triggering_commit_sequence, 1);
  assert.equal(await commitCount(r.repo_path), commitsBefore + 1);

  // Idempotent: a second call writes nothing and adds no commit.
  const r2 = await repo.commitCompletion('testCompl', event, {
    completedAt: '2026-04-18T02:00:00Z', triggeringSequence: 1,
  });
  assert.equal(r2.alreadyWritten, true);
  assert.equal(await commitCount(r.repo_path), commitsBefore + 1, 'no new commit on second call');
});

test('loadCommit: returns null when commit missing', async () => {
  assert.equal(await repo.loadCommit('nonexistent', 1), null);
});

test('listCommits: returns reply commits ascending, [] for unknown repo', async () => {
  assert.deepEqual(await repo.listCommits('nonexistent'), []);
  const commits = await repo.listCommits('testD');
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sequence, 1);
  assert.equal(commits[1].sequence, 2);
});

// --- syncEventJson ---

test('syncEventJson: no-op when repo does not exist', async () => {
  const r = await repo.syncEventJson('neverActivated', { id: 'neverActivated', title: 'X' }, 'msg');
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'no_repo');
});

test('syncEventJson: no commit when event.json bytes match HEAD', async () => {
  const event = { id: 'syncA', title: 'Sync A', steps: [] };
  await repo.initRepoIfNeeded('syncA', event);
  const before = await commitCount(repo.repoPath('syncA'));

  const r = await repo.syncEventJson('syncA', event, 'no-change attempt');
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'no_change');
  assert.equal(await commitCount(repo.repoPath('syncA')), before);
});

test('syncEventJson: commits when event content changes', async () => {
  const event = { id: 'syncB', title: 'Sync B', steps: [] };
  await repo.initRepoIfNeeded('syncB', event);
  const before = await commitCount(repo.repoPath('syncB'));

  const updated = { ...event, title: 'Sync B (updated)', activated_at: '2026-05-06T00:00:00Z' };
  const r = await repo.syncEventJson('syncB', updated, 'event activated');
  assert.equal(r.synced, true);
  assert.match(r.sha, /^[0-9a-f]+$/);

  const onDisk = JSON.parse(await fs.readFile(path.join(repo.repoPath('syncB'), 'event.json'), 'utf8'));
  assert.equal(onDisk.title, 'Sync B (updated)');
  assert.equal(onDisk.activated_at, '2026-05-06T00:00:00Z');

  assert.equal(await commitCount(repo.repoPath('syncB')), before + 1);
  assert.match(await latestMsg(repo.repoPath('syncB')), /event activated/);
});

test('syncEventJson: reflects deeply-nested mutations', async () => {
  const event = { id: 'syncC', title: 'Sync C', steps: [] };
  await repo.initRepoIfNeeded('syncC', event);
  const completed = { ...event, completion: { status: 'complete', completed_at: '2026-05-06T12:00:00Z', commit_sequence: 1 } };
  const r = await repo.syncEventJson('syncC', completed, 'reply 001 counted');
  assert.equal(r.synced, true);
  const onDisk = JSON.parse(await fs.readFile(path.join(repo.repoPath('syncC'), 'event.json'), 'utf8'));
  assert.equal(onDisk.completion.status, 'complete');
  assert.equal(onDisk.completion.commit_sequence, 1);
});

test('syncEventJson: rejects bad event ids (path-traversal guard)', async () => {
  await assert.rejects(() => repo.syncEventJson('../bad', { id: '../bad' }, 'msg'), /invalid eventId/);
});

// --- OTS anchoring (injected stamper; covers gitrepo's `if (ots)` branch) ---

test('commitReply with an OTS stamper: anchors the commit and files the proof', async () => {
  // Fake stamper, like the real `ots stamp`: writes <input>.ots next to the
  // input and reports its path. Dependency injection, not a mock.
  const fakeOts = {
    async stampFile(absPath) {
      const proof = absPath + '.ots';
      await fs.writeFile(proof, 'fake-proof-bytes');
      return { proof_path: proof };
    },
  };
  const anchored = createGitrepo({ dataDir: tmp, ots: fakeOts });
  const event = { id: 'otsOk', title: 'O', salt: SALT, steps: [{ id: 'step1' }] };
  const ctx = { eventId: 'otsOk', stepId: 'step1', receivedAt: 'now',
    envelope: { sender: 'a@example.com' }, from: 'a@example.com',
    trustLevel: 'verified', participantMatch: true, rawSha256: 'sha256:x', rawSize: 1 };

  const r = await anchored.commitReply('otsOk', event, ctx);
  assert.equal(r.ots_proof_file, path.join('ots_proofs', 'commit-001.ots'));
  // The proof landed in the tree and the sidecar was moved (not left behind).
  const proofAbs = path.join(r.repo_path, r.ots_proof_file);
  assert.equal(await fs.readFile(proofAbs, 'utf8'), 'fake-proof-bytes');
  await assert.rejects(() => fs.access(path.join(r.repo_path, r.file + '.ots')));
  const saved = JSON.parse(await fs.readFile(path.join(r.repo_path, r.file), 'utf8'));
  assert.equal(saved.ots_proof_file, r.ots_proof_file);
});

test('commitReply with a failing OTS stamper: records the error, leaves path null', async () => {
  const failOts = { async stampFile() { return { error: 'calendar down' }; } };
  const anchored = createGitrepo({ dataDir: tmp, ots: failOts });
  const event = { id: 'otsFail', title: 'O', salt: SALT, steps: [{ id: 'step1' }] };
  const ctx = { eventId: 'otsFail', stepId: 'step1', receivedAt: 'now',
    envelope: { sender: 'a@example.com' }, from: 'a@example.com',
    trustLevel: 'verified', participantMatch: true, rawSha256: 'sha256:x', rawSize: 1 };

  const r = await anchored.commitReply('otsFail', event, ctx);
  assert.equal(r.ots_proof_file, null, 'no proof path on stamp failure');
  const saved = JSON.parse(await fs.readFile(path.join(r.repo_path, r.file), 'utf8'));
  assert.equal(saved.ots_proof_file, null);
  assert.equal(saved.ots_archive.error, 'calendar down');
});

// Byte-strict no-diff invariant: identical bytes → no_change; reordered keys →
// different bytes → exactly one commit. Pins the byte-strict staged detection
// so a future refactor that reorders keys can't silently pollute the ledger.
test('syncEventJson: byte-strict — reordered keys serialize differently and commit', async () => {
  const eventAB = { id: 'syncOrder', title: 'Order Test', steps: [] };
  const eventBA = { title: 'Order Test', id: 'syncOrder', steps: [] };
  await repo.initRepoIfNeeded('syncOrder', eventAB);
  const before = await commitCount(repo.repoPath('syncOrder'));

  const sA = JSON.stringify(eventAB, null, 2) + '\n';
  const sB = JSON.stringify(eventBA, null, 2) + '\n';
  assert.notEqual(sA, sB, 'V8 stopped preserving insertion order — assumption violated');

  const same = await repo.syncEventJson('syncOrder', eventAB, 'identical');
  assert.equal(same.synced, false);
  assert.equal(same.reason, 'no_change');

  const reordered = await repo.syncEventJson('syncOrder', eventBA, 'reordered keys');
  assert.equal(reordered.synced, true, 'reordered keys should produce a new commit');
  assert.equal(await commitCount(repo.repoPath('syncOrder')), before + 1);
});
