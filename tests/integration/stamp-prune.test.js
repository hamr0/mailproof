// Prune with manifests (SPEC B13.1.11): the manifests of the pruned prefix go with the records they list except the newest,
// which is carried with its proof; kept-range manifests are byte-identical; an upgrade commit of a removed manifest's proof is
// dropped; the chain stays usable; a job straddling the swap ends skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTrail, DAY, T0 } from '../helpers/prune-trail.js';
import { checkPruned } from '../helpers/prune-check.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { manifestPath, manifestOtsPath } from '../../src/proof/layout.js';
import { findSeal, readChain } from '../../src/proof/seal.js';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sha = (b) => import('node:crypto').then((c) => c.createHash('sha256').update(b).digest('hex'));

function fakeOts() {
  const dir = makeTmpDir('mp-stamp-prune-ots-');
  const bin = path.join(dir, 'ots');
  const anchored = path.join(dir, 'anchored');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in stamp) cp "$2" "$2.ots";; upgrade) if [ -f '${anchored}' ]; then grep -q anchored "$2" || { cp "$2" "$2.bak"; echo anchored >> "$2"; }; exit 0; else exit 1; fi;; esac\n`, { mode: 0o755 });
  return { bin, anchor: () => fs.writeFileSync(anchored, '') };
}

/** Records 0-3 (days 0-3), manifest 1; record at day 4, manifest 2; records at days 6 and 7, manifest 3; then everything anchored. Cutoff: day 5. */
async function manifestTrail() {
  const ots = fakeOts();
  const t = await makeTrail({ n: 4, extra: { otsBin: ots.bin } });
  const at = async (days, tag) => { t.clock.t = T0 + days * DAY; const raw = await t.mailFor('B', tag); const r = await t.mp.record(raw, { direction: 'in', source: 'test' }); t.recs.push({ id: r.id, raw, sender: 'B', at: t.clock.t }); return r; };
  t.clock.t = T0 + 3.5 * DAY; await t.mp.stamp();
  await at(4, 'm4'); await t.mp.stamp();
  await at(6, 'm6'); await at(7, 'm7'); await t.mp.stamp();
  ots.anchor();
  t.clock.t = T0 + 8 * DAY; await t.mp.stamp();   // upgrades: manifests 1, 2, 3
  t.clock.t = T0 + 20 * DAY;
  return { ...t, ots, at };
}

test('prune: prefix manifests go except the newest (carried with its proof), kept-range manifests stay byte-identical, the upgrade commit of a removed proof is dropped', async () => {
  const t = await manifestTrail();
  assert.deepEqual(fs.readdirSync(path.join(t.root, 'manifests')).sort(), ['00000001.json', '00000001.json.ots', '00000002.json', '00000002.json.ots', '00000003.json', '00000003.json.ots']);
  const m3 = fs.readFileSync(path.join(t.root, manifestPath(3)));
  const m3ots = fs.readFileSync(path.join(t.root, manifestOtsPath(3)));
  const m2 = fs.readFileSync(path.join(t.root, manifestPath(2)));
  const r = await t.mp.prune({ before: t.cutoff });
  assert.equal(r.manifestsRemoved, 1);
  assert.equal(r.removed, 5);
  assert.deepEqual(fs.readdirSync(path.join(t.root, 'manifests')).sort(), ['00000002.json', '00000002.json.ots', '00000003.json', '00000003.json.ots']);
  assert.deepEqual(fs.readFileSync(path.join(t.root, manifestPath(3))), m3);
  assert.deepEqual(fs.readFileSync(path.join(t.root, manifestOtsPath(3))), m3ots);
  assert.deepEqual(fs.readFileSync(path.join(t.root, manifestPath(2))), m2);
  assert.ok(r.dropped >= 1, 'the upgrade commit of removed manifest 1 is dropped');
  assert.ok(!sh(t.root, 'log', '--format=%s').split('\n').includes('ots upgrade manifest 1'));
  const check = checkPruned(r.backup, t.cutoff, t.root);
  assert.deepEqual(check.problems, []);
  // the first kept manifest names one that is gone: not a broken link
  const chain = await readChain(t.root, 'HEAD');
  assert.equal(chain.broken, null);
  assert.deepEqual(chain.files.map((f) => f.seq), [2, 3]);
  // a record kept after the prune keeps its seal
  const kept = t.recs.find((x) => x.at === T0 + 6 * DAY);
  const seal = await findSeal(t.root, kept.id);
  assert.deepEqual([seal.via, seal.seq, seal.stamp], ['manifest', 3, { seq: 3, own: true }]);
  // a job after the prune continues seq and chain
  t.clock.t = T0 + 21 * DAY;
  const raw = await t.mailFor('C', 'after');
  await t.mp.record(raw, { direction: 'in', source: 'test' });
  const j = await t.mp.stamp();
  assert.equal(j.manifests[0].seq, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, manifestPath(4)), 'utf8')).previous_sha256, await sha(m3));
});

test('prune: the newest manifest of the prefix is the only one: nothing is removed, it is carried', async () => {
  const ots = fakeOts();
  const t = await makeTrail({ n: 4, extra: { otsBin: ots.bin } });
  t.clock.t = T0 + 3.5 * DAY; await t.mp.stamp();
  t.clock.t = T0 + 6 * DAY;
  await t.mp.record(await t.mailFor('B', 'late'), { direction: 'in', source: 'test' });
  const r = await t.mp.prune({ before: t.cutoff });
  assert.equal(r.manifestsRemoved, 0);
  assert.deepEqual(fs.readdirSync(path.join(t.root, 'manifests')).sort(), ['00000001.json', '00000001.json.ots']);
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
});

test('prune: a trail without manifests reports manifestsRemoved 0; a dry run reports the same number a real one removes', async () => {
  const t = await makeTrail({ extra: { otsBin: null } });
  assert.equal((await t.mp.prune({ before: t.cutoff, dryRun: true })).manifestsRemoved, 0);
  const m = await manifestTrail();
  const dry = await m.mp.prune({ before: m.cutoff, dryRun: true });
  const real = await m.mp.prune({ before: m.cutoff });
  assert.equal(dry.manifestsRemoved, 1);
  assert.equal(real.manifestsRemoved, dry.manifestsRemoved);
});

test('a stamp job straddling a prune swap ends skipped: rewritten and writes nothing', async () => {
  const t = await manifestTrail();
  t.clock.t = T0 + 21 * DAY;
  await t.mp.record(await t.mailFor('C', 'straddle'), { direction: 'in', source: 'test' });
  let pruned = false;
  t.mp._stampHooks.afterSnapshot = async () => { pruned = true; await t.mp.prune({ before: t.cutoff }); };
  const r = await t.mp.stamp();
  assert.equal(pruned, true);
  assert.equal(r.skipped, 'rewritten');
  assert.deepEqual(r.manifests, []);
  assert.equal(sh(t.root, 'status', '--porcelain'), '');
  t.mp._stampHooks.afterSnapshot = undefined;
  const again = await t.mp.stamp();
  assert.equal(again.manifests[0].seq, 4, 'the next job seals what the skipped one left');
});
