// Correctness checker for a pruned trail. Usage: node check.js <oldRepo> <cutoffISO> <newRepo>
// Recomputes the plan from the OLD repo (shared lib), then verifies the NEW repo:
//  1. linear; first commit is the notice with cutoff / previous-head / removed / kept (values match the plan and the old HEAD)
//  2. every kept commit that still changes something has identical message, author, author date, committer, committer date;
//     commits dropped are exactly those whose every op touches a pruned path; order preserved
//  3. per commit, the new tree ops equal the old ops minus pruned paths (blob shas equal => bytes identical), applied from the
//     notice tree; by induction every tree equals (old tree minus pruned). Final HEAD trees compared as full path->sha maps.
//  4. no pruned path in any new tree op or the final tree; every key_file of every kept record is in the root tree's
//     lineage (checked in the root tree and in the final tree); keys only used by pruned records are gone
//  5. object store: no alternates, `git fsck --strict`, object count == reachable objects (no leaked pruned blob)
import fs from 'node:fs';
import path from 'node:path';
import { logOpsChunked as logOps, plan, keepPath, classify, parseNotice, sh } from './lib.js';

const [oldRepo, cutoff, newRepo] = process.argv.slice(2);
const bad = [];
const fail = (m) => { if (bad.length < 20) bad.push(m); else if (bad.length === 20) bad.push('...'); };
const pl = await plan(oldRepo, cutoff);
const newIt = logOps(newRepo)[Symbol.asyncIterator]();
const root = (await newIt.next()).value;
if (root.parents.length !== 0) fail('notice commit has a parent');
const nt = parseNotice(root.msg);
if (nt.cutoff !== cutoff) fail('notice cutoff ' + nt.cutoff);
if (nt['previous-head'] !== pl.previousHead) fail('notice previous-head');
if (Number(nt.removed) !== pl.removed || Number(nt.kept) !== pl.kept) fail(`notice counts ${nt.removed}/${nt.kept} vs ${pl.removed}/${pl.kept}`);
const actual = new Map(); // new tree path -> sha
for (const o of root.ops) { if (o.st === 'D') fail('root deletes'); actual.set(o.path, o.sha); if (!keepPath(o.path, pl, true)) fail('pruned path in root: ' + o.path); }
const expected = new Map(); // old tree filtered
let i = 0, compared = 0, droppedEmpty = 0, prevNew = root.h;
let strag = 0;
for await (const c of logOps(oldRepo)) {
  const inPrefix = i++ < pl.prefixCommits;
  const ops = c.ops.filter((o) => keepPath(o.path, pl, inPrefix));
  for (const o of ops) { if (o.st === 'D') expected.delete(o.path); else expected.set(o.path, o.sha); }
  if (inPrefix) {
    if (i === pl.prefixCommits) { // root tree must equal the filtered prefix tree
      if (expected.size !== actual.size) fail(`root tree size ${actual.size} vs ${expected.size}`);
      for (const [p, s] of expected) if (actual.get(p) !== s) fail('root tree differs at ' + p);
    }
    continue;
  }
  if (ops.length === 0) { droppedEmpty++; if (c.ops.some((o) => keepPath(o.path, pl, false))) fail('dropped a commit with kept ops'); continue; }
  const n = (await newIt.next()).value;
  if (!n) { fail('new history too short at old ' + c.h); break; }
  compared++;
  if (n.parents.length !== 1 || n.parents[0] !== prevNew) fail('not linear at ' + n.h);
  prevNew = n.h;
  for (const f of ['msg', 'an', 'ae', 'ad', 'cn', 'ce', 'cd']) if (n[f] !== c[f]) fail(`${f} differs at old ${c.h.slice(0, 10)}`);
  // ops: same set (path, status, sha), ignoring status A/M difference which can arise only if the base differs
  const key = (o) => `${o.st === 'D' ? 'D' : 'U'} ${o.path} ${o.st === 'D' ? '' : o.sha}`;
  const a = ops.map(key).sort().join('\n'), b = n.ops.map(key).sort().join('\n');
  if (a !== b) fail('tree ops differ at old ' + c.h.slice(0, 10));
  for (const o of n.ops) { if (o.st === 'D') actual.delete(o.path); else actual.set(o.path, o.sha); if (!keepPath(o.path, pl, false)) fail('pruned path in tree: ' + o.path); }
}
if ((await newIt.next()).value) fail('new history has extra commits');
if (actual.size !== expected.size) fail(`final tree size ${actual.size} vs ${expected.size}`);
for (const [p, s] of expected) if (actual.get(p) !== s) { fail('final tree differs at ' + p); break; }
// also straight from git: ls-tree of both HEADs
const lsMap = (repo) => new Map(sh(repo, ['ls-tree', '-r', '--full-tree', 'HEAD']).split('\n').map((l) => { const [m, p] = l.split('\t'); return [p, m.split(' ')[2]]; }));
const fin = lsMap(newRepo), old = lsMap(oldRepo);
let leaked = 0, keptKeysMissing = 0;
for (const [p] of fin) if (!keepPath(p, pl, false) || (classify(p) === 'key' && !pl.neededKeys.has(p) && !old.has(p))) leaked++;
for (const [p] of fin) if (old.get(p) !== fin.get(p)) fail('final blob differs from old: ' + p);
for (const k of pl.neededKeys) if (!fin.has(k)) keptKeysMissing++;
let droppedKeys = 0; for (const [p] of old) if (classify(p) === 'key' && !fin.has(p)) droppedKeys++;
let prunedPathsLeft = 0; for (const [p] of fin) { const c = classify(p); if (c && c !== 'key' && pl.prunedIds.has(c)) prunedPathsLeft++; }
if (leaked || keptKeysMissing || prunedPathsLeft) fail(`leaked=${leaked} keysMissing=${keptKeysMissing} prunedLeft=${prunedPathsLeft}`);
// object store
const alt = fs.existsSync(path.join(newRepo.endsWith('.git') ? newRepo : path.join(newRepo, '.git'), 'objects/info/alternates'));
if (alt) fail('alternates still present');
let fsck = 'ok';
try { sh(newRepo, ['fsck', '--strict', '--no-dangling']); } catch (e) { fsck = 'FAILED'; fail('fsck: ' + String(e.stderr || e.message).slice(0, 200)); }
const reach = Number(sh(newRepo, ['rev-list', '--objects', '--all']).split('\n').length);
const cnt = sh(newRepo, ['count-objects', '-v']);
const inpack = Number(/in-pack: (\d+)/.exec(cnt)[1]), loose = Number(/^count: (\d+)/m.exec(cnt)[1]);
if (inpack + loose !== reach) fail(`object store has ${inpack + loose} objects, reachable ${reach} (unreachable objects kept)`);
// pruned blob leak sample: a pruned record's blob must not exist in the new store
let sample = 0, present = 0;
for (const [p, s] of old) { const c = classify(p); if (c && c !== 'key' && pl.prunedIds.has(c) && sample < 200 && p.startsWith('records/') && p.endsWith('.json')) { sample++; try { sh(newRepo, ['cat-file', '-e', s]); present++; } catch { /* absent: good */ } } }
if (present) fail(`${present}/${sample} sampled pruned record blobs still exist in the new store`);
console.log(JSON.stringify({ ok: bad.length === 0, problems: bad, keptCommitsCompared: compared, droppedEmptyCommits: droppedEmpty, newCommits: compared + 1, finalPaths: fin.size, oldPaths: old.size, keysDropped: droppedKeys, keysCarried: pl.neededKeys.size, fsck, objects: inpack + loose, reachable: reach, stragglersKept: pl.stragglers }));
process.exit(bad.length ? 2 : 0);
