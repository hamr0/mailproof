
// Integration tests for the optional OTS anchor. stampFile/upgradeProof/
// readBlockHeight are thin wrappers around the `ots` CLI, so we cover the
// always-reproducible paths with a real spawn — binary missing, and (when the
// `ots` client is installed) a non-proof input. The fully happy path (a real
// Bitcoin-confirmed proof) needs the client + calendar network + ~1h of
// confirmations and is verified in deployment, not CI (matching gitdone's
// note). The PURE output parser is unit-tested in tests/unit/ots.test.js.
// moveProofIntoTree was dropped in the lift (gitrepo files the proof itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createOts } from '../../src/ots.js';

// Is a real `ots` client on PATH? Skip the real-binary smoke tests if not.
const HAS_OTS = (() => {
  try {
    const r = spawnSync('ots', ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
})();

test('createOts: requires otsBin', () => {
  assert.throws(() => createOts({}), /otsBin required/);
  assert.throws(() => createOts(), /otsBin required/);
});

test('stampFile: returns {error}, never throws, when the ots binary is missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'dummy.json');
    await fs.writeFile(f, '{}');
    const ots = createOts({ otsBin: '/nonexistent/ots', timeoutMs: 3000 });
    const r = await ots.stampFile(f);
    assert.equal(r.proof_path, undefined);
    assert.ok(r.error, 'error should be populated');
    assert.match(r.error, /not found|exit|ENOENT|timeout/i);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('upgradeProof: returns {error}, never throws, when the ots binary is missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'commit-001.ots');
    await fs.writeFile(f, 'not a real proof');
    const ots = createOts({ otsBin: '/nonexistent/ots', timeoutMs: 3000 });
    const r = await ots.upgradeProof(f);
    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
    assert.equal(r.anchored, false);
    assert.ok(r.error, 'error should be populated');
    assert.match(r.error, /not found|ENOENT|timeout/i);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('readBlockHeight: returns null, never throws, when the ots binary is missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'commit-001.ots');
    await fs.writeFile(f, 'not a real proof');
    const ots = createOts({ otsBin: '/nonexistent/ots', timeoutMs: 3000 });
    assert.equal(await ots.readBlockHeight(f), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Real-binary smoke tests: exercise the actual `ots` spawn + non-zero-exit
// handling deterministically (a non-proof input fails locally — no network, no
// Bitcoin confirmation needed). Skipped when no `ots` client is installed.
test('upgradeProof: real ots on a non-proof file reports pending/no-anchor without throwing', { skip: !HAS_OTS }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'garbage.ots');
    const before = 'definitely not a serialized ots proof';
    await fs.writeFile(f, before);
    const ots = createOts({ otsBin: 'ots', timeoutMs: 15000 });
    const r = await ots.upgradeProof(f);
    // ots can't parse it → non-zero exit, no spawn error. We classify that as
    // pending (not anchored), and the file is untouched (no merge happened).
    assert.equal(r.ok, true, 'binary ran, so ok');
    assert.equal(r.changed, false);
    assert.equal(r.anchored, false);
    assert.equal(r.pending, true);
    assert.equal(await fs.readFile(f, 'utf8'), before, 'a failed upgrade leaves the file untouched');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('readBlockHeight: real ots on a non-proof file returns null without throwing', { skip: !HAS_OTS }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'garbage.ots');
    await fs.writeFile(f, 'definitely not a serialized ots proof');
    const ots = createOts({ otsBin: 'ots', timeoutMs: 15000 });
    assert.equal(await ots.readBlockHeight(f), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
