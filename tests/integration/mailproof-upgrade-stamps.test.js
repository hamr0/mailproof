// Mailproof#upgradeStamps with a fake `ots` binary (a shell script): the no-op paths, the upgrade commit, the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { countPendingStamps } from '../../src/proof/ots-upgrade.js';
import { recordOtsPath } from '../../src/proof/layout.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

function fakeOts(body) {
  const f = path.join(makeTmpDir('mp-ots-bin-'), 'ots');
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}
// stamp copies the file; upgrade rewrites it (and leaves a .bak, as the real client does) once a marker file exists
const flag = path.join(makeTmpDir('mp-ots-flag-'), 'anchored');
const OTS = (marker) => `case "$1" in stamp) cp "$2" "$2.ots";; upgrade) if [ -f "${marker}" ]; then cp "$2" "$2.bak"; echo anchored >> "$2"; exit 0; else exit 1; fi;; info) echo "Bitcoin block 850123";; esac`;
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function trailWith(bin, n = 2) {
  const dir = makeTmpDir('mp-ots-up-');
  const ids = [];
  const mp = new Mailproof({ trailDir: dir, worker: { size: 0 }, ...(bin ? { otsBin: bin } : {}) });
  for (let i = 0; i < n; i++) {
    const m = await signedMail({ body: `m${i}\r\n` });
    const r = await new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, ...(bin ? { otsBin: bin } : {}) }).record(m.raw, { direction: 'in' });
    ids.push(r.id);
  }
  return { mp, dir, root: path.join(dir, 'default'), ids };
}

test('OTS off: a no-op result, nothing written', async () => {
  const t = await trailWith(null);
  const head = gitOut(t.root, 'rev-parse', 'HEAD');
  assert.deepEqual(await t.mp.upgradeStamps(), { enabled: false, upgraded: 0, pending: 0 });
  assert.equal(gitOut(t.root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(t.dir).filter((f) => f.startsWith('.')), []);
});

test('binary missing: no throw, the error is reported, the pending stamps are counted, nothing committed', async () => {
  const t = await trailWith(fakeOts(OTS('/nonexistent')));
  const mp = new Mailproof({ trailDir: t.dir, otsBin: '/nonexistent/ots', worker: { size: 0 } });
  const head = gitOut(t.root, 'rev-parse', 'HEAD');
  assert.deepEqual(await mp.upgradeStamps(), { enabled: true, upgraded: 0, pending: 2, error: 'ots not found' });
  assert.equal(gitOut(t.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await countPendingStamps(t.root, 'default'), 2);
});

test('still calendar-pending: stays pending, no commit; once anchored: each proof is committed, the .bak is removed, and it is not asked again', async () => {
  const marker = path.join(makeTmpDir('mp-ots-marker-'), 'm');
  const bin = fakeOts(OTS(marker));
  const t = await trailWith(bin);
  const head0 = gitOut(t.root, 'rev-parse', 'HEAD');
  const count0 = Number(gitOut(t.root, 'rev-list', '--count', 'HEAD'));
  assert.deepEqual(await t.mp.upgradeStamps(), { enabled: true, upgraded: 0, pending: 2 });
  assert.equal(gitOut(t.root, 'rev-parse', 'HEAD'), head0);

  fs.writeFileSync(marker, '');
  assert.deepEqual(await t.mp.upgradeStamps(), { enabled: true, upgraded: 2, pending: 0 });
  assert.equal(Number(gitOut(t.root, 'rev-list', '--count', 'HEAD')), count0 + 2, 'one commit per upgraded stamp');
  assert.match(gitOut(t.root, 'log', '-1', '--format=%s'), /^ots upgrade [0-9a-f]{12}$/);
  assert.equal(gitOut(t.root, 'status', '--porcelain'), '');
  for (const id of t.ids) {
    assert.match(fs.readFileSync(path.join(t.root, recordOtsPath(id)), 'utf8'), /anchored/);
    assert.ok(!fs.existsSync(path.join(t.root, `${recordOtsPath(id)}.bak`)));
  }
  assert.equal(await countPendingStamps(t.root, 'default'), 0);
  const head1 = gitOut(t.root, 'rev-parse', 'HEAD');
  assert.deepEqual(await t.mp.upgradeStamps(), { enabled: true, upgraded: 0, pending: 0 }, 'the anchored ones are remembered');
  assert.equal(gitOut(t.root, 'rev-parse', 'HEAD'), head1);
  // the records still verify and the trail still lists them
  assert.equal((await t.mp.verify(t.ids[0])).ok, true);
});

test('a lost cache only means the stamps are asked again (idempotent)', async () => {
  const marker = path.join(makeTmpDir('mp-ots-marker-'), 'm');
  fs.writeFileSync(marker, '');
  const t = await trailWith(fakeOts(OTS(marker)), 1);
  await t.mp.upgradeStamps();
  fs.rmSync(path.join(t.dir, '.default.ots-state.json'));
  const r = await t.mp.upgradeStamps();
  assert.equal(r.pending, 0);
  assert.equal(r.enabled, true);
});
