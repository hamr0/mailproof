// Option C: B, but (1) only the KEPT range is exported, in chunks of K commits with --reference-excluded-parents (the first
// commit of a chunk is a diff against its excluded parent), so git's per-commit memory is bounded by K, and (2) the root's tree
// (trail.json + the keys kept records need) is read from the last pruned commit's tree instead of replayed from the prefix.
// Option B (kept for comparison) exports the whole history in one process.
// The transform drops pruned paths, folds the pruned prefix into one root commit (the prune notice: trail.json and the
// archived keys kept records still need), skips kept commits that become empty (a reply-text commit for a pruned record),
// and strips marks/from so fast-import chains every commit onto the previous one (linear).
// Usage: node c.js <oldRepo> <cutoffISO> <newRepo> [--chunk=2000]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { plan, keepPath, noticeMessage, IDENT, sh, parseFastExport as parse, chunks } from './lib.js';

const [oldRepo, cutoff, newRepo, flag] = process.argv.slice(2);
const K = Number((flag || '--chunk=2000').split('=')[1]);
const WITH_DATA = false;
const t0 = Date.now();
const pl = await plan(oldRepo, cutoff);
const tPlan = Date.now() - t0;

fs.rmSync(newRepo, { recursive: true, force: true });
fs.mkdirSync(newRepo, { recursive: true });
sh(newRepo, ['init', '-q', '--initial-branch=main', '--bare']);
if (!WITH_DATA) fs.writeFileSync(path.join(newRepo, 'objects/info/alternates'), path.resolve(oldRepo, sh(oldRepo, ['rev-parse', '--git-path', 'objects'])) + '\n');

const imp = spawn('git', ['-c', 'pack.compression=0', '-c', 'core.compression=0', 'fast-import', '--quiet', `--depth=${process.env.FI_DEPTH ?? 50}`], { cwd: newRepo, stdio: ['pipe', 'inherit', 'inherit'] });
const impDone = new Promise((res, rej) => imp.on('exit', (c) => (c === 0 ? res() : rej(new Error('fast-import exit ' + c)))));
imp.stdin.on('error', () => {});

const w = (s) => { if (!imp.stdin.write(s)) return new Promise((r) => imp.stdin.once('drain', r)); };
const opLine = (o) => (o.st === 'D' ? `D ${o.path}\n` : `M ${o.mode} ${o.ref} ${o.path}\n`);
const dataBlock = (b) => Buffer.concat([Buffer.from(`data ${b.length}\n`), b, Buffer.from('\n')]);

// root: the filtered tree of the last pruned commit
const carry = sh(oldRepo, ['ls-tree', '-r', '--full-tree', pl.tail]).split('\n').map((l) => { const [m, p] = l.split('\t'); const f = m.split(' '); return { st: 'M', mode: f[0], ref: f[2], path: p }; }).filter((o) => keepPath(o.path, pl, true));
{
  const id = `${IDENT.name} <${IDENT.email}> ${Math.floor(Date.now() / 1000)} +0000`;
  await w(`commit refs/heads/main\nauthor ${id}\ncommitter ${id}\n`); await w(dataBlock(Buffer.from(noticeMessage(pl))));
  for (const o of carry) await w(opLine(o));
  await w('\n');
}
let kept = 0, emptied = 0, procs = 0;
for (const ch of chunks(oldRepo, K, { from: pl.tail })) {
  procs++;
  const exp = spawn('git', ['fast-export', '--reencode=no', '--no-data', '--reference-excluded-parents', `${ch.after}..${ch.upto}`], { cwd: oldRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  for await (const x of parse(exp.stdout)) {
    if (x.type !== 'commit') continue;
    const ops = x.ops.filter((o) => keepPath(o.path, pl, false));
    if (ops.length === 0) { emptied++; continue; }
    await w(`commit refs/heads/main\n${x.author}\n${x.committer}\n`);
    await w(dataBlock(x.msg));
    for (const o of ops) await w(opLine(o));
    await w('\n');
    kept++;
  }
}
imp.stdin.end();
await impDone;
const tImport = Date.now() - t0 - tPlan;
sh(newRepo, ['repack', '-a', '-d', '-q']);
fs.rmSync(path.join(newRepo, 'objects/info/alternates'), { force: true });
const tAll = Date.now() - t0;
console.log(JSON.stringify({ option: 'C', removed: pl.removed, kept: pl.kept, stragglers: pl.stragglers, prefixCommits: pl.prefixCommits, keptCommitsEmitted: kept, emptiedDropped: emptied, carriedPaths: carry.length, exportProcesses: procs, msPlan: tPlan, msExportImport: tImport, msRepack: tAll - tPlan - tImport, msTotal: tAll, newHead: sh(newRepo, ['rev-parse', 'HEAD']) }));
