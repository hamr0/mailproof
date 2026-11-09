// Option B: git fast-export | Node stdlib transform | git fast-import into a fresh repo.
// The transform drops pruned paths, folds the pruned prefix into one root commit (the prune notice: trail.json and the
// archived keys kept records still need), skips kept commits that become empty (a reply-text commit for a pruned record),
// and strips marks/from so fast-import chains every commit onto the previous one (linear).
// Usage: node b.js <oldRepo> <cutoffISO> <newRepo> [--data]    (default: --no-data export + alternates + repack)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { plan, keepPath, noticeMessage, IDENT, sh, parseFastExport as parse } from './lib.js';

const [oldRepo, cutoff, newRepo, flag] = process.argv.slice(2);
const WITH_DATA = flag === '--data';
const t0 = Date.now();
const pl = await plan(oldRepo, cutoff);
const tPlan = Date.now() - t0;

fs.rmSync(newRepo, { recursive: true, force: true });
fs.mkdirSync(newRepo, { recursive: true });
sh(newRepo, ['init', '-q', '--initial-branch=main', '--bare']);
if (!WITH_DATA) fs.writeFileSync(path.join(newRepo, 'objects/info/alternates'), path.resolve(oldRepo, sh(oldRepo, ['rev-parse', '--git-path', 'objects'])) + '\n');

const exp = spawn('git', ['fast-export', '--reencode=no', ...(WITH_DATA ? [] : ['--no-data']), 'refs/heads/main'], { cwd: oldRepo, stdio: ['ignore', 'pipe', 'inherit'] });
const imp = spawn('git', ['-c', 'pack.compression=0', '-c', 'core.compression=0', 'fast-import', '--quiet', `--depth=${process.env.FI_DEPTH ?? 50}`], { cwd: newRepo, stdio: ['pipe', 'inherit', 'inherit'] });
const impDone = new Promise((res, rej) => imp.on('exit', (c) => (c === 0 ? res() : rej(new Error('fast-import exit ' + c)))));
imp.stdin.on('error', () => {});

const w = (s) => { if (!imp.stdin.write(s)) return new Promise((r) => imp.stdin.once('drain', r)); };
const opLine = (o) => (o.st === 'D' ? `D ${o.path}\n` : `M ${o.mode} ${o.ref} ${o.path}\n`);
const dataBlock = (b) => Buffer.concat([Buffer.from(`data ${b.length}\n`), b, Buffer.from('\n')]);

let seen = 0, kept = 0, emptied = 0, notice = false;
const carry = new Map(); // path -> op of the pruned prefix that survives (trail.json, needed keys)
const blobMarks = new Set(); // data mode: marks of blobs referenced by emitted ops
const pendingBlobs = new Map(); // data mode: mark -> Buffer (held until a kept op references it; bounded by one commit)
const stats = { maxPending: 0 };

async function emitNotice() {
  const now = Math.floor(Date.now() / 1000);
  const id = `${IDENT.name} <${IDENT.email}> ${now} +0000`;
  if (WITH_DATA) for (const o of carry.values()) if (o.st === 'M') { await w(`blob\nmark ${o.ref}\n`); await w(dataBlock(carryBlobs.get(o.ref))); }
  await w(`commit refs/heads/main\nauthor ${id}\ncommitter ${id}\n`); await w(dataBlock(Buffer.from(noticeMessage(pl))));
  for (const o of carry.values()) await w(opLine(o));
  await w('\n');
  notice = true;
}
const carryBlobs = new Map();
let lastBlobs = new Map();

for await (const x of parse(exp.stdout)) {
  if (x.type === 'blob') {
    // data mode: hold until a commit references the mark and keeps it
    pendingBlobs.set(x.mark.slice(5), x.data); // key ':N'
    stats.maxPending = Math.max(stats.maxPending, pendingBlobs.size);
    continue;
  }
  const inPrefix = seen < pl.prefixCommits;
  seen++;
  const ops = x.ops.filter((o) => keepPath(o.path, pl, inPrefix));
  if (inPrefix) {
    for (const o of ops) {
      if (o.st === 'D') carry.delete(o.path); else carry.set(o.path, o);
      if (WITH_DATA && o.st === 'M') { carryBlobs.set(o.ref, pendingBlobs.get(o.ref)); }
    }
    for (const o of x.ops) pendingBlobs.delete(o.ref);
    continue;
  }
  if (!notice) await emitNotice();
  if (ops.length === 0) { emptied++; for (const o of x.ops) pendingBlobs.delete(o.ref); continue; }
  await w(`commit refs/heads/main\n${x.author}\n${x.committer}\n`);
  await w(dataBlock(x.msg));
  // data mode: blobs precede the commit in fast-import's input too, but inline blobs keep memory flat
  for (const o of ops) {
    if (WITH_DATA && o.st === 'M') await w(`M ${o.mode} inline ${o.path}\ndata ${pendingBlobs.get(o.ref).length}\n`), await w(Buffer.concat([pendingBlobs.get(o.ref), Buffer.from('\n')]));
    else await w(opLine(o));
  }
  for (const o of x.ops) pendingBlobs.delete(o.ref);
  await w('\n');
  kept++;
}
imp.stdin.end();
await impDone;
const tImport = Date.now() - t0 - tPlan;
// make the new repo self-contained: pack everything reachable (also what came through the alternates), drop alternates
sh(newRepo, ['repack', '-a', '-d', '-q', '-c', 'pack.compression=1'].filter((a) => a !== '-c' && a !== 'pack.compression=1'));
fs.rmSync(path.join(newRepo, 'objects/info/alternates'), { force: true });
const tAll = Date.now() - t0;
console.log(JSON.stringify({ option: WITH_DATA ? 'B-data' : 'B-nodata', removed: pl.removed, kept: pl.kept, stragglers: pl.stragglers, prefixCommits: pl.prefixCommits, keptCommitsEmitted: kept, emptiedDropped: emptied, carriedPaths: carry.size, msPlan: tPlan, msExportImport: tImport, msRepack: tAll - tPlan - tImport, msTotal: tAll, newHead: sh(newRepo, ['rev-parse', 'HEAD']) }));
