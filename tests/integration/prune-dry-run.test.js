// prune({ dryRun: true }) (SPEC B9.7, B11.12): the real plan and the real re-check, nothing built, swapped or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTrail } from '../helpers/prune-trail.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const snapshot = (dir) => fs.readdirSync(dir).sort();

test('dryRun returns the numbers of the real prune and changes nothing', async () => {
  const t = await makeTrail();
  const head = git(t.root, 'rev-parse', 'HEAD');
  const tree = git(t.root, 'ls-tree', '-r', 'HEAD');
  const dirBefore = snapshot(t.dir);
  const contentBefore = execFileSync('find', [t.cdir, '-type', 'f'], { encoding: 'utf8' }).split('\n').sort().join('\n');
  const plan = await t.mp.prune({ before: t.cutoff, dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.noop, false);
  assert.equal(plan.head, null);
  assert.equal(plan.previousHead, head);
  assert.deepEqual(git(t.root, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
  assert.equal(git(t.root, 'ls-tree', '-r', 'HEAD'), tree, 'tree unchanged');
  assert.equal(git(t.root, 'status', '--porcelain'), '');
  assert.deepEqual(snapshot(t.dir), dirBefore, 'no backup, no build directory, no journal');
  assert.equal(execFileSync('find', [t.cdir, '-type', 'f'], { encoding: 'utf8' }).split('\n').sort().join('\n'), contentBefore, 'content untouched');

  const real = await t.mp.prune({ before: t.cutoff });
  assert.equal(real.dryRun, false);
  for (const k of ['cutoff', 'noop', 'removed', 'kept', 'stragglers', 'dropped', 'keysCarried', 'reverify', 'previousHead']) {
    assert.deepEqual(plan[k], real[k], k);
  }
  assert.equal(plan.backup, real.backup, 'the dry run names the backup the real run makes');
});

test('dryRun on a cutoff that removes nothing is a no-op result; a bad value is a TypeError; an all-old trail is refused', async () => {
  const t = await makeTrail();
  const r = await t.mp.prune({ before: '2000-01-01', dryRun: true });
  assert.equal(r.noop, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.backup, null);
  await assert.rejects(t.mp.prune({ before: t.cutoff, dryRun: 'yes' }), TypeError);
  await assert.rejects(t.mp.prune({ before: '2100-01-01', dryRun: true }), { code: 'ERR_PRUNE_CUTOFF' });
  assert.equal(path.basename(t.root), 'default');
});
