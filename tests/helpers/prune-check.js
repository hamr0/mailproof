// TEST-ONLY. An independent correctness checker for a pruned trail (ported from poc/m3-prune/check.js, adapted to the
// sharded layout; it does not use src/proof/prune*.js). Given the OLD trail (the backup), the cutoff and the NEW trail
// it recomputes what a prune must produce from first principles and compares commit by commit:
//   linear history, the root is the prune notice with the right counts; every kept commit has identical message,
//   author, author date, committer, committer date; the tree ops of every kept commit equal the old ops minus pruned
//   paths (blob ids equal = bytes identical); the final trees agree; no pruned path anywhere; every key a kept record
//   names is present; the object store is self-contained and holds no unreachable object.
// NEVER imported from src/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRecordPath, parseReplyPath, parseManifestPath } from '../../src/proof/layout.js';

const sh = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, maxBuffer: 1 << 30, ...opts }).toString().replace(/\n$/, '');

/** Commits oldest first with their raw tree ops (history must be linear). */
export function logOps(repo) {
  const fmt = '%x01%H%x02%P%x02%an%x02%ae%x02%ad%x02%cn%x02%ce%x02%cd%x02%B%x03';
  const out = sh(repo, ['log', '--reverse', '--root', '--no-renames', '--raw', '-r', '--no-abbrev', '--date=raw', `--format=${fmt}`]);
  const commits = [];
  for (const chunk of out.split('\x01').slice(1)) {
    const end = chunk.indexOf('\x03');
    const [h, parents, an, ae, ad, cn, ce, cd, ...msg] = chunk.slice(0, end).split('\x02');
    const ops = [];
    for (const l of chunk.slice(end + 1).split('\n')) {
      if (!l.startsWith(':')) continue;
      const [meta, p] = l.split('\t');
      const f = meta.split(' ');
      ops.push({ st: f[4] === 'D' ? 'D' : 'U', sha: f[3], path: p });
    }
    if (parents.includes(' ')) throw new Error('merge commit: ' + h);
    commits.push({ h, parents: parents ? parents.split(' ') : [], an, ae, ad, cn, ce, cd, msg: msg.join('\x02'), ops });
  }
  return commits;
}

const lsMap = (repo) => new Map(sh(repo, ['ls-tree', '-r', '--full-tree', 'HEAD']).split('\n').filter(Boolean).map((l) => { const [m, p] = l.split('\t'); return [p, m.split(' ')[2]]; }));
const blob = (repo, sha) => JSON.parse(execFileSync('git', ['cat-file', 'blob', sha], { cwd: repo, maxBuffer: 1 << 30 }).toString());
const idOf = (p) => { const r = parseRecordPath(p) ?? parseReplyPath(p); return r ? r.id : null; };

/** What the old trail says: the pruned prefix, the pruned ids, the keys the kept records need. */
export function planOf(oldRepo, cutoffMs) {
  const commits = logOps(oldRepo);
  const prunedIds = new Set();
  const prefixManifests = new Set();
  let prefix = 0;
  let found = false;
  for (const c of commits) {
    let boundary = false;
    for (const o of c.ops) {
      const r = parseRecordPath(o.path);
      if (r && !r.ots && o.st === 'U' && !(Date.parse(blob(oldRepo, o.sha).captured) < cutoffMs)) boundary = true;
    }
    if (boundary) { found = true; break; }
    for (const o of c.ops) { const r = parseRecordPath(o.path); if (r && !r.ots && o.st === 'U') prunedIds.add(r.id); const m = parseManifestPath(o.path); if (m) prefixManifests.add(m.seq); }
    prefix++;
  }
  // M4 (SPEC B13.1.11): the manifests of the pruned prefix go, except the newest one, which is carried with its proof
  const prunedManifests = new Set([...prefixManifests].sort((a, b) => a - b).slice(0, -1));
  const old = lsMap(oldRepo);
  const needed = new Set();
  let kept = 0;
  const stragglers = [];
  for (const [p, sha] of old) {
    const r = parseRecordPath(p);
    if (!r || r.ots || prunedIds.has(r.id)) continue;
    kept++;
    const rec = blob(oldRepo, sha);
    if (Date.parse(rec.captured) < cutoffMs) stragglers.push(r.id);
    for (const s of rec.signatures || []) if (s.key_file) needed.add(s.key_file);
  }
  return { commits, prefix, found, prunedIds, prunedManifests, needed, kept, stragglers, old };
}

/** Is this path kept? `inPrefix`: it was committed in the pruned prefix (a key there stays only when a kept record names it). */
function keepPath(p, plan, inPrefix) {
  const m = parseManifestPath(p);
  if (m) return !plan.prunedManifests.has(m.seq);
  const id = idOf(p);
  if (id !== null) return !plan.prunedIds.has(id);
  if (p.startsWith('keys/')) return inPrefix ? plan.needed.has(p) : true;
  return true;
}

export const parseNotice = (msg) => Object.fromEntries(msg.split('\n').slice(2).filter(Boolean).map((l) => { const k = l.indexOf(': '); return [l.slice(0, k), l.slice(k + 2)]; }));

/**
 * @param {string} oldRepo  The old trail (the backup).
 * @param {string} cutoff  ISO.
 * @param {string} newRepo  The pruned trail.
 * @param {{ lateKeys?: string[], expectPreviousHead?: string }} [o]  `lateKeys`: archived keys expected to be ADDED to a kept commit (first committed before the cutoff, named only by a record made during the build).
 * @returns {{ ok: boolean, problems: string[], keptCommits: number, dropped: number, plan: ReturnType<typeof planOf> }}
 */
export function checkPruned(oldRepo, cutoff, newRepo, { lateKeys = [], expectPreviousHead } = {}) {
  const problems = [];
  const fail = (m) => { if (problems.length < 20) problems.push(m); };
  const plan = planOf(oldRepo, Date.parse(cutoff));
  const lateSet = new Set(lateKeys);
  for (const k of lateKeys) plan.needed.delete(k);   // named only by a record made during the build: not in the notice tree, added to that record's commit
  const next = logOps(newRepo);
  const root = next[0];
  if (root.parents.length !== 0) fail('notice commit has a parent');
  const nt = parseNotice(root.msg);
  if (nt.cutoff !== cutoff) fail('notice cutoff ' + nt.cutoff);
  if (nt['previous-head'] !== (expectPreviousHead ?? plan.commits.at(-1).h)) fail('notice previous-head ' + nt['previous-head']);
  if (Number(nt.removed) !== plan.prunedIds.size) fail(`notice removed ${nt.removed} vs ${plan.prunedIds.size}`);
  const actual = new Map();
  for (const o of root.ops) { actual.set(o.path, o.sha); if (!keepPath(o.path, plan, true) || lateSet.has(o.path)) fail('pruned or late path in the notice tree: ' + o.path); }
  const expected = new Map();
  let compared = 0;
  let dropped = 0;
  let ni = 1;
  let prev = root.h;
  plan.commits.forEach((c, i) => {
    const inPrefix = i < plan.prefix;
    const ops = c.ops.filter((o) => keepPath(o.path, plan, inPrefix));
    for (const o of ops) { if (o.st === 'D') expected.delete(o.path); else expected.set(o.path, o.sha); }
    if (inPrefix) {
      if (i === plan.prefix - 1) {
        if (expected.size !== actual.size) fail(`notice tree size ${actual.size} vs ${expected.size}`);
        for (const [p, s] of expected) if (actual.get(p) !== s) fail('notice tree differs at ' + p);
      }
      return;
    }
    if (ops.length === 0) { dropped++; return; }
    const n = next[ni++];
    if (!n) { fail('new history too short at old ' + c.h); return; }
    compared++;
    if (n.parents.length !== 1 || n.parents[0] !== prev) fail('not linear at ' + n.h);
    prev = n.h;
    for (const f of ['msg', 'an', 'ae', 'ad', 'cn', 'ce', 'cd']) if (n[f] !== c[f]) fail(`${f} differs at old ${c.h.slice(0, 10)}`);
    // the ops are the old ops minus pruned paths, plus a late key where a kept record names one
    const key = (o) => `${o.st} ${o.path} ${o.st === 'D' ? '' : o.sha}`;
    const extra = n.ops.filter((o) => lateSet.has(o.path));
    const a = ops.map(key).sort().join('\n');
    const b = n.ops.filter((o) => !lateSet.has(o.path)).map(key).sort().join('\n');
    if (a !== b) fail('tree ops differ at old ' + c.h.slice(0, 10));
    for (const o of n.ops) { if (o.st === 'D') actual.delete(o.path); else actual.set(o.path, o.sha); if (!keepPath(o.path, plan, false) && !lateSet.has(o.path)) fail('pruned path in tree: ' + o.path); }
    for (const o of extra) expected.set(o.path, o.sha);
  });
  if (ni !== next.length) fail('new history has extra commits');
  const fin = lsMap(newRepo);
  const old = plan.old;
  for (const [p, s] of fin) if (old.get(p) !== s) fail('final blob differs from old: ' + p);
  for (const [p, s] of old) {
    const id = idOf(p);
    const mf = parseManifestPath(p);
    const want = mf ? !plan.prunedManifests.has(mf.seq) : id !== null ? !plan.prunedIds.has(id) : p.startsWith('keys/') ? plan.needed.has(p) || lateSet.has(p) || !plan.commits.slice(0, plan.prefix).some((c) => c.ops.some((o) => o.path === p)) : true;
    if (want && fin.get(p) !== s) fail('kept path missing or different in the new trail: ' + p);
    if (!want && fin.has(p)) fail('pruned path still in the new trail: ' + p);
  }
  for (const k of [...plan.needed, ...lateKeys]) if (!fin.has(k)) fail('a key a kept record names is missing: ' + k);
  // object store: self-contained, nothing unreachable, no pruned record blob
  const gitDir = path.join(newRepo, '.git');
  if (fs.existsSync(path.join(gitDir, 'objects/info/alternates'))) fail('alternates still present');
  try { sh(newRepo, ['fsck', '--strict', '--no-dangling']); } catch (e) { fail('fsck: ' + String(e.stderr || e.message).slice(0, 200)); }
  const reach = new Set(sh(newRepo, ['rev-list', '--objects', '--all']).split('\n').map((l) => l.split(' ')[0])).size;
  const all = sh(newRepo, ['cat-file', '--batch-all-objects', '--batch-check']).split('\n').length;
  if (all !== reach) fail(`object store has ${all} objects, ${reach} reachable`);
  for (const [p, s] of old) {
    const id = idOf(p);
    if (id !== null && plan.prunedIds.has(id)) { try { sh(newRepo, ['cat-file', '-e', s]); fail('a pruned blob exists in the new store: ' + p); } catch { /* absent: good */ } }
  }
  return { ok: problems.length === 0, problems, keptCommits: compared, dropped, plan };
}
