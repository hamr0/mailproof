// Swap + crash analysis. A journal `<trailDir>/.<trail>.prune.json` sits beside the lock file (outside the repo, so it
// survives the swap). Steps (all under the trail lock):
//   0 journal {state:'building'}          1 build bare repo with option B (b.js)      2 materialise <trail>.prune-tmp, check, fsck
//   3 journal {state:'swapping'}          4 rename <trail> -> <trail>.pre-prune-<date>
//   5 rename <trail>.prune-tmp -> <trail> 6 journal {state:'swapped'}, post steps (sync cursor, content sweep)   7 remove journal
// `recover()` runs when the lock is acquired, BEFORE ensureTrail, and rolls forward or back.
// Usage: node swap.js <scratchDir>      (builds a 300-record synthetic trail, injects a crash at every step, recovers, asserts)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sh } from './lib.js';
import { ensureTrail, isAncestor } from '../../src/proof/trail.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const rn = (a, b) => fs.renameSync(a, b);
const ex = (p) => fs.existsSync(p);
const fsyncWrite = (p, obj) => { const t = p + '.tmp'; const fd = fs.openSync(t, 'w'); fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); rn(t, p); };
class Crash extends Error {}

export function paths(trailDir, trail, date) {
  return { live: path.join(trailDir, trail), tmp: path.join(trailDir, trail + '.prune-tmp'), bak: path.join(trailDir, `${trail}.pre-prune-${date}`), journal: path.join(trailDir, `.${trail}.prune.json`), cursor: path.join(trailDir, `.${trail}.sync.json`) };
}

/** Turn the bare repo b.js built into a normal trail directory at P.tmp: .git, config, working tree. */
export function materialise(bare, P) {
  fs.rmSync(P.tmp, { recursive: true, force: true });
  fs.mkdirSync(P.tmp);
  rn(bare, path.join(P.tmp, '.git'));
  const cfg = (k) => { try { return sh(P.live, ['config', '--local', k]); } catch { return null; } };
  for (const k of ['user.name', 'user.email']) { const v = cfg(k); if (v) sh(P.tmp, ['config', k, v]); }
  sh(P.tmp, ['config', 'core.bare', 'false']);
  sh(P.tmp, ['reset', '-q', '--hard', 'HEAD']);
  fs.mkdirSync(path.join(P.tmp, 'records'), { recursive: true });
}

/** Post steps after the swap: the sync cursor must follow the new HEAD (see README: otherwise sync re-records every pruned mail). */
function postSteps(P) {
  if (ex(P.cursor)) { const c = JSON.parse(fs.readFileSync(P.cursor, 'utf8')); c.head = sh(P.live, ['rev-parse', 'HEAD']); fsyncWrite(P.cursor, c); }
  // content sweep (not simulated here): delete content/raw/<id>.eml for every id with no records/<id>.json in the new HEAD
}

/** Called under the lock before anything else touches the trail. Returns what it did. */
export function recover(trailDir, trail) {
  const j = ex(path.join(trailDir, `.${trail}.prune.json`)) ? JSON.parse(fs.readFileSync(path.join(trailDir, `.${trail}.prune.json`), 'utf8')) : null;
  if (!j) return 'no journal';
  const P = paths(trailDir, trail, j.date);
  let did;
  if (j.state === 'building') { fs.rmSync(P.tmp, { recursive: true, force: true }); fs.rmSync(path.join(trailDir, trail + '.prune-bare'), { recursive: true, force: true }); did = 'rolled back: discarded partial build'; }
  else if (j.state === 'swapping') {
    if (ex(P.live) && !ex(P.bak) && ex(P.tmp)) { rn(P.live, P.bak); rn(P.tmp, P.live); postSteps(P); did = 'rolled forward from before step 4'; }
    else if (!ex(P.live) && ex(P.bak) && ex(P.tmp)) { rn(P.tmp, P.live); postSteps(P); did = 'rolled forward from the gap between step 4 and 5'; }
    else if (ex(P.live) && ex(P.bak) && !ex(P.tmp)) { postSteps(P); did = 'rolled forward: swap was complete'; }
    else if (!ex(P.live) && ex(P.bak) && !ex(P.tmp)) { rn(P.bak, P.live); did = 'rolled back: build lost, original restored'; }
    else throw new Error('unrecognised swap state; leave everything and report');
  } else if (j.state === 'swapped') { postSteps(P); did = 'finished post steps'; }
  fs.rmSync(path.join(trailDir, `.${trail}.prune.json`), { force: true });
  return did;
}

export function prune(trailDir, trail, cutoff, date, { crashAt = null, bDir } = {}) {
  const P = paths(trailDir, trail, date);
  const at = (n) => { if (crashAt === n) throw new Crash('crash at step ' + n); };
  const old = sh(P.live, ['rev-parse', 'HEAD']);
  fsyncWrite(P.journal, { v: 1, state: 'building', date, cutoff, previous_head: old }); at(0);
  const bare = path.join(trailDir, trail + '.prune-bare');
  fs.rmSync(bare, { recursive: true, force: true });
  execFileSync('node', [path.join(HERE, 'b.js'), P.live, cutoff, bare], { stdio: ['ignore', 'pipe', 'inherit'] }); at(1);
  materialise(bare, P);
  sh(P.tmp, ['fsck', '--strict', '--no-dangling']);
  if (sh(P.tmp, ['status', '--porcelain']) !== '') throw new Error('tmp working tree not clean'); at(2);
  fsyncWrite(P.journal, { v: 1, state: 'swapping', date, cutoff, previous_head: old, new_head: sh(P.tmp, ['rev-parse', 'HEAD']) }); at(3);
  rn(P.live, P.bak); at(4);
  rn(P.tmp, P.live); at(5);
  fsyncWrite(P.journal, { v: 1, state: 'swapped', date }); postSteps(P); at(6);
  fs.rmSync(P.journal); at(7);
}

// ---- demo / assertions
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const scratch = process.argv[2];
  const results = [];
  const src = path.join(scratch, 'trail-300', 't');
  if (!ex(src)) execFileSync('node', [path.join(HERE, 'gen.js'), scratch, '300'], { stdio: 'ignore' });
  const cutoff = (await import('./lib.js')).cutoffAtFraction(src, 0.5);
  for (const crashAt of [null, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const trailDir = path.join(scratch, 'swap-' + crashAt);
    fs.rmSync(trailDir, { recursive: true, force: true });
    fs.mkdirSync(trailDir);
    execFileSync('git', ['clone', '-q', src, path.join(trailDir, 'default')]);
    sh(path.join(trailDir, 'default'), ['config', 'user.name', 'mailproof']); sh(path.join(trailDir, 'default'), ['config', 'user.email', 'noreply@mailproof.invalid']);
    const oldHead = sh(path.join(trailDir, 'default'), ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(trailDir, '.default.lock'), JSON.stringify({ pid: process.pid, host: 'h', started: 'x' }));
    fs.writeFileSync(path.join(trailDir, '.default.sync.json'), JSON.stringify({ v: 1, head: oldHead, accounts: { 'h/u': { INBOX: { uidvalidity: '1', last_uid: 57, updated: 'x' } } } }));
    let crashed = false;
    try { prune(trailDir, 'default', cutoff, '2026-11-09', { crashAt }); } catch (e) { if (!(e instanceof Crash)) throw e; crashed = true; }
    const P = paths(trailDir, 'default', '2026-11-09');
    const state = { live: ex(P.live), tmp: ex(P.tmp), bak: ex(P.bak), journal: ex(P.journal) };
    let naive = null;
    if (crashed && !state.live) { // what a plain open would do now: ensureTrail makes a fresh, empty trail at the live path
      const copy = path.join(scratch, 'naive'); fs.rmSync(copy, { recursive: true, force: true }); fs.cpSync(trailDir, copy, { recursive: true });
      await ensureTrail(path.join(copy, 'default'), 'default', new Date().toISOString());
      naive = 'plain open creates an empty trail (' + sh(path.join(copy, 'default'), ['rev-list', '--count', 'HEAD']) + ' commit) at the live path';
      fs.rmSync(copy, { recursive: true, force: true });
    }
    const did = crashed ? recover(trailDir, 'default') : 'n/a (no crash)';
    const live = P.live, head = sh(live, ['rev-parse', 'HEAD']);
    const isNew = head !== oldHead;
    const count = Number(sh(live, ['rev-list', '--count', 'HEAD']));
    const clean = sh(live, ['status', '--porcelain']) === '';
    sh(live, ['fsck', '--strict', '--no-dangling']);
    const cursor = JSON.parse(fs.readFileSync(P.cursor, 'utf8'));
    const anc = isNew ? await isAncestor(live, cursor.head, head) : true;
    results.push({ crashAt: crashAt ?? 'none', stateAfterCrash: crashed ? state : 'n/a', naiveOpenInGap: naive, recovery: did, liveIs: isNew ? 'new (pruned)' : 'old (original)', commits: count, workingTreeClean: clean, backupKept: ex(P.bak), tmpLeft: ex(P.tmp), journalLeft: ex(P.journal), oldHeadIsAncestorOfNewHead: isNew ? await isAncestor(live, oldHead, head) : true, cursorHeadIsAncestorOfHead: anc, cursorHeadFollowsNewHead: cursor.head === head });
    if (!ex(P.bak) && isNew) throw new Error('new live without a backup');
    if (ex(P.tmp) || ex(P.journal) || ex(path.join(trailDir, 'default.prune-bare'))) throw new Error('leftovers after recovery');
  }
  console.log(JSON.stringify(results, null, 1));
  for (const r of results) fs.rmSync(path.join(scratch, 'swap-' + (r.crashAt === 'none' ? null : r.crashAt)), { recursive: true, force: true });
}
