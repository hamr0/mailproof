// Option A: plumbing replay with a temp index. One pass over `git log --raw` (the same ops the checker uses); per kept commit:
//   git update-index --index-info (the commit's kept ops)  ->  git write-tree  ->  git commit-tree -p <prev>
// with GIT_AUTHOR_* / GIT_COMMITTER_* taken from the original commit, message passed byte-for-byte on stdin.
// Root = the prune notice: an index holding trail.json and the keys kept records still need.
// Objects are written loose (that is how plumbing writes); `--repack-every K` packs them (git repack -d) so disk stays bounded.
// Usage: node a.js <oldRepo> <cutoffISO> <newRepo> [--repack-every=2000] [--sample=<kept index>,<count>]
//   --sample: cost sampling for sizes where a full run is not practical: the root holds the whole filtered tree of kept
//   commit j, then `count` commits are replayed and timed; no correctness claim.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { plan, keepPath, logOpsChunked as logOps, noticeMessage, IDENT, sh } from './lib.js';

const [oldRepo, cutoff, newRepo, ...flags] = process.argv.slice(2);
const REPACK = Number((flags.find((f) => f.startsWith('--repack-every=')) || '--repack-every=2000').split('=')[1]);
const SAMPLE = (flags.find((f) => f.startsWith('--sample=')) || '').split('=')[1]?.split(',').map(Number);
const t0 = Date.now();
const pl = await plan(oldRepo, cutoff);
const tPlan = Date.now() - t0;
fs.rmSync(newRepo, { recursive: true, force: true });
fs.mkdirSync(newRepo, { recursive: true });
sh(newRepo, ['init', '-q', '--initial-branch=main', '--bare']);
sh(newRepo, ['config', 'core.compression', '0']);
fs.writeFileSync(path.join(newRepo, 'objects/info/alternates'), path.resolve(oldRepo, sh(oldRepo, ['rev-parse', '--git-path', 'objects'])) + '\n'); // blobs are referenced, not copied; removed after the repack
const INDEX = path.join(newRepo, 'tmp-index');
const env0 = { ...process.env, GIT_DIR: newRepo, GIT_INDEX_FILE: INDEX };

const run = (args, { input, env = {} } = {}) => new Promise((res, rej) => {
  const p = spawn('git', args, { env: { ...env0, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
  p.on('close', (c) => (c === 0 ? res(o.trim()) : rej(new Error(`git ${args[0]} ${c}: ${e}`))));
  p.stdin.end(input ?? '');
});
const indexInfo = (ops) => ops.map((o) => (o.st === 'D' ? `0 ${'0'.repeat(40)}\t${o.path}` : `${o.mode} ${o.sha}\t${o.path}`)).join('\n') + '\n';

async function commit(treeSha, parent, who, message) {
  const env = who
    ? { GIT_AUTHOR_NAME: who.an, GIT_AUTHOR_EMAIL: who.ae, GIT_AUTHOR_DATE: who.ad, GIT_COMMITTER_NAME: who.cn, GIT_COMMITTER_EMAIL: who.ce, GIT_COMMITTER_DATE: who.cd }
    : { GIT_AUTHOR_NAME: IDENT.name, GIT_AUTHOR_EMAIL: IDENT.email, GIT_COMMITTER_NAME: IDENT.name, GIT_COMMITTER_EMAIL: IDENT.email };
  return run(['commit-tree', treeSha, ...(parent ? ['-p', parent] : [])], { input: message, env });
}

let prev = null, n = 0, i = 0, emptied = 0, sampleT = null, sampleCount = 0;
const carry = new Map();
let rootDone = false;
async function makeRoot(ops, extraTreeFrom) {
  await run(['read-tree', '--empty']);
  const all = ops ?? [...carry.values()];
  if (all.length) await run(['update-index', '--add', '--index-info'], { input: indexInfo(all) });
  prev = await commit(await run(['write-tree']), null, null, noticeMessage(pl));
  rootDone = true;
}
const sampleSkip = SAMPLE ? SAMPLE[0] : 0;
let keptSeen = 0;
for await (const c of logOps(oldRepo)) {
  const inPrefix = i++ < pl.prefixCommits;
  const ops = c.ops.filter((o) => keepPath(o.path, pl, inPrefix));
  if (inPrefix) { for (const o of ops) { if (o.st === 'D') carry.delete(o.path); else carry.set(o.path, o); } continue; }
  if (SAMPLE && keptSeen < sampleSkip) { for (const o of ops) { if (o.st === 'D') carry.delete(o.path); else carry.set(o.path, o); } keptSeen++; continue; }
  if (!rootDone) { await makeRoot(); sampleT = Date.now(); }
  if (ops.length === 0) { emptied++; continue; }
  await run(['update-index', '--add', '--remove', '--index-info'], { input: indexInfo(ops) });
  prev = await commit(await run(['write-tree']), prev, c, c.msg);
  n++;
  if (REPACK && n % REPACK === 0) { await run(['repack', '-d', '-q']); }
  if (SAMPLE && n >= SAMPLE[1]) break;
}
const tReplay = Date.now() - t0 - tPlan;
if (SAMPLE) {
  console.log(JSON.stringify({ option: 'A-sample', keptStart: sampleSkip, commits: n, treeEntriesAtStart: carry.size, msPerCommit: +((Date.now() - sampleT) / n).toFixed(2) }));
  process.exit(0);
}
sh(newRepo, ['update-ref', 'refs/heads/main', prev]);
fs.rmSync(INDEX, { force: true });
sh(newRepo, ['repack', '-a', '-d', '-q']);
fs.rmSync(path.join(newRepo, 'objects/info/alternates'), { force: true });
const tAll = Date.now() - t0;
console.log(JSON.stringify({ option: 'A', removed: pl.removed, kept: pl.kept, prefixCommits: pl.prefixCommits, keptCommitsEmitted: n, emptiedDropped: emptied, msPlan: tPlan, msReplay: tReplay, msRepack: tAll - tPlan - tReplay, msTotal: tAll, newHead: prev }));
