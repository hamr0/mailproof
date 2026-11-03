// The sync lock (SPEC B4.5): the same lock implementation as the trail lock, a different file, fail-fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withTrailLock, trailLockFile, syncLockFile, SYNC_LOCK } from '../../src/proof/trail.js';
import { makeTmpDir } from '../helpers/tmp.js';

const setup = () => {
  const trailDir = makeTmpDir('mp-sync-lock-');
  return { trailDir, root: path.join(trailDir, 'default') };
};
const mine = () => JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });

test('the lock file name is a parameter: trail lock and sync lock are different files', async () => {
  const { trailDir, root } = setup();
  assert.equal(trailLockFile('default'), '.default.lock');
  assert.equal(syncLockFile('default'), '.default.sync.lock');
  await withTrailLock(root, syncLockFile('default'), 0, async () => {
    assert.equal(fs.existsSync(path.join(trailDir, '.default.sync.lock')), true);
    assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false, 'the trail lock is untouched');
    // sync lock first, then the trail lock inside: the order B4.5 fixes, and it must not deadlock in one process
    await withTrailLock(root, trailLockFile('default'), 1000, async () => {
      assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), true);
    });
  }, SYNC_LOCK);
  assert.equal(fs.existsSync(path.join(trailDir, '.default.sync.lock')), false, 'released');
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false, 'released');
});

test('the sync lock is fail-fast in one process: a second holder gets ERR_SYNC_LOCKED at once, not queued', async () => {
  const { root } = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = withTrailLock(root, syncLockFile('default'), 0, () => gate, SYNC_LOCK);
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(() => withTrailLock(root, syncLockFile('default'), 0, async () => 'second', SYNC_LOCK), { code: 'ERR_SYNC_LOCKED' });
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await withTrailLock(root, syncLockFile('default'), 0, async () => 'third', SYNC_LOCK), 'third', 'free again after release');
});

test('the sync lock is fail-fast against another process holding the file', async () => {
  const { trailDir, root } = setup();
  fs.writeFileSync(path.join(trailDir, '.default.sync.lock'), mine());
  await assert.rejects(() => withTrailLock(root, syncLockFile('default'), 0, async () => 1, SYNC_LOCK), { code: 'ERR_SYNC_LOCKED' });
  assert.equal(fs.existsSync(path.join(trailDir, '.default.sync.lock')), true, 'a live lock is not touched');
});

test('a stale sync lock (dead pid, this host) is taken over even though the wait is zero', async () => {
  const { trailDir, root } = setup();
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise((r) => dead.on('close', r));
  fs.writeFileSync(path.join(trailDir, '.default.sync.lock'), JSON.stringify({ pid, host: os.hostname(), started: new Date().toISOString() }));
  assert.equal(await withTrailLock(root, syncLockFile('default'), 0, async () => 'took over', SYNC_LOCK), 'took over');
  assert.equal(fs.existsSync(path.join(trailDir, '.default.sync.lock')), false);
});

test('a lock from another host is never taken over, for the sync lock too', async () => {
  const { trailDir, root } = setup();
  fs.writeFileSync(path.join(trailDir, '.default.sync.lock'), JSON.stringify({ pid: 999999, host: 'some-other-host.invalid', started: new Date().toISOString() }));
  await assert.rejects(() => withTrailLock(root, syncLockFile('default'), 0, async () => 1, SYNC_LOCK), { code: 'ERR_SYNC_LOCKED' });
});

test('a young unparseable sync lock (just created, not yet written) is not judged stale by a zero wait', async () => {
  const { trailDir, root } = setup();
  fs.writeFileSync(path.join(trailDir, '.default.sync.lock'), '');
  await assert.rejects(() => withTrailLock(root, syncLockFile('default'), 0, async () => 1, SYNC_LOCK), { code: 'ERR_SYNC_LOCKED' });
});

test('the trail lock still reports ERR_TRAIL_LOCKED', async () => {
  const { trailDir, root } = setup();
  fs.writeFileSync(path.join(trailDir, '.default.lock'), mine());
  await assert.rejects(() => withTrailLock(root, trailLockFile('default'), 100, async () => 1), { code: 'ERR_TRAIL_LOCKED' });
});
