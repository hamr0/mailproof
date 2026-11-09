// Shared by the prune POC scripts: git helpers, a log-with-ops stream, the plan (what to prune), the path filter.
// Stdlib only; git via the `git` binary.
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';

export const IDENT = { name: 'mailproof', email: 'noreply@mailproof.invalid' };
export const sh = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, maxBuffer: 1 << 30, ...opts }).toString().trim();
export const ID = '[0-9a-f]{32}';
const RE_REC = new RegExp(`^records/(${ID})\\.json(\\.ots)?$`);
const RE_REP = new RegExp(`^replies/(${ID})\\.[a-z0-9-]+\\.json$`);

/** Which pruned class is this path? Returns the record id it belongs to, 'key', or null (neither). */
export function classify(p) {
  let m = RE_REC.exec(p); if (m) return m[1];
  m = RE_REP.exec(p); if (m) return m[1];
  if (p.startsWith('keys/')) return 'key';
  return null;
}

/**
 * Stream commits oldest first with their raw tree ops (linear history assumed; a merge is an error).
 * Yields { h, parents, an, ae, ad, cn, ce, cd, msg, ops: [{ st:'A'|'M'|'D', sha, path }] }; dates are git's raw `<unix> <tz>`.
 */
export async function* logOps(repo, { extra = [] } = {}) {
  const fmt = '%x01%H%x02%P%x02%an%x02%ae%x02%ad%x02%cn%x02%ce%x02%cd%x02%B%x03';
  const p = spawn('git', ['log', '--reverse', '--root', '--no-renames', '--raw', '-r', '--no-abbrev', '--date=raw', `--format=${fmt}`, ...extra], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise((r) => p.on('close', r));
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  let cur = null, inMsg = false, msgBuf = '';
  const flushOps = [];
  for await (const line of rl) {
    if (inMsg) {
      const k = line.indexOf('\x03');
      if (k < 0) { msgBuf += line + '\n'; continue; }
      msgBuf += line.slice(0, k);
      inMsg = false;
      cur.msg = msgBuf; msgBuf = '';
      const rest = line.slice(k + 1);
      if (rest) throw new Error('unexpected text after message terminator');
      continue;
    }
    if (line.startsWith('\x01')) {
      if (cur) yield cur;
      const [h, parents, an, ae, ad, cn, ce, cd, msg0] = line.slice(1).split('\x02');
      cur = { h, parents: parents ? parents.split(' ') : [], an, ae, ad, cn, ce, cd, msg: '', ops: [] };
      if (parents.includes(' ')) throw new Error('merge commit in trail: history is not linear: ' + h);
      const k = msg0.indexOf('\x03');
      if (k >= 0) cur.msg = msg0.slice(0, k); else { inMsg = true; msgBuf = msg0 + '\n'; }
      continue;
    }
    if (line.startsWith(':')) {
      const [meta, path] = line.split('\t');
      const f = meta.split(' ');
      const st = f[4];
      if (path.includes('"')) throw new Error('quoted path: ' + path);
      cur.ops.push({ st: st === 'D' ? 'D' : st, sha: f[3], mode: f[1], path });
    }
  }
  if (cur) yield cur;
  await closed;
}

/** Persistent `git cat-file --batch`: get(sha) -> Buffer. */
export function catFile(repo) {
  const p = spawn('git', ['cat-file', '--batch'], { cwd: repo, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0), waiter = null;
  p.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); if (waiter) waiter(); });
  const need = () => new Promise((r) => { waiter = r; });
  let chain = Promise.resolve();
  const get = (sha) => (chain = chain.then(async () => {
    p.stdin.write(sha + '\n');
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl >= 0) {
        const head = buf.subarray(0, nl).toString();
        if (head.endsWith('missing')) throw new Error('missing object ' + sha);
        const size = Number(head.split(' ')[2]);
        if (buf.length >= nl + 1 + size + 1) {
          const body = Buffer.from(buf.subarray(nl + 1, nl + 1 + size));
          buf = buf.subarray(nl + 1 + size + 1);
          return body;
        }
      }
      await need();
    }
  }));
  return { get, close: () => { p.stdin.end(); } };
}

/**
 * The plan. `cutoff` is an ISO instant. The pruned prefix = the commits before the first commit that adds a record
 * whose `captured` is at or after the cutoff (position based, never a middle range). Needs one pass over the prefix
 * (reading the record blobs it adds) and one pass over the kept records at HEAD (their key_file refs).
 * @returns {{ cutoff, previousHead, prefixCommits, prunedIds:Set<string>, neededKeys:Set<string>, removed, kept, stragglers, total }}
 */
export async function plan(repo, cutoff) {
  const cf = catFile(repo);
  const prunedIds = new Set();
  let prefixCommits = 0, found = false, tail = null;
  const cutMs = Date.parse(cutoff);
  for await (const c of logOpsChunked(repo)) {
    let boundary = false;
    for (const o of c.ops) {
      const m = RE_REC.exec(o.path);
      if (m && o.path.endsWith('.json') && o.st === 'A') {
        const rec = JSON.parse((await cf.get(o.sha)).toString());
        if (Date.parse(rec.captured) >= cutMs) { boundary = true; break; }
      }
    }
    if (boundary) { found = true; break; }
    for (const o of c.ops) { const m = RE_REC.exec(o.path); if (m && o.path.endsWith('.json') && o.st === 'A') prunedIds.add(m[1]); }
    prefixCommits++; tail = c.h;
  }
  if (!found) throw new Error('cutoff is after the last record: nothing would be kept');
  if (prefixCommits === 0 || prunedIds.size === 0) throw new Error('nothing to prune');
  // kept records at HEAD: key refs, stragglers (kept although captured before the cutoff)
  const neededKeys = new Set();
  let kept = 0, stragglers = 0, total = 0;
  const ls = sh(repo, ['ls-tree', '-r', '--full-tree', 'HEAD', '--', 'records/']).split('\n');
  for (const l of ls) {
    const [meta, path] = l.split('\t');
    const m = RE_REC.exec(path);
    if (!m || path.endsWith('.ots')) continue;
    total++;
    if (prunedIds.has(m[1])) continue;
    kept++;
    const rec = JSON.parse((await cf.get(meta.split(' ')[2])).toString());
    if (Date.parse(rec.captured) < cutMs) stragglers++;
    for (const s of rec.signatures || []) if (s.key_file) neededKeys.add(s.key_file);
  }
  cf.close();
  const rootMsg = sh(repo, ['log', '--max-parents=0', '--format=%B']);
  const earlier = rootMsg.startsWith('prune notice:') ? parseNotice(rootMsg + '\n') : null; // a second prune keeps a trace of the first
  return { earlier, cutoff, previousHead: sh(repo, ['rev-parse', 'HEAD']), prefixCommits, tail, prunedIds, neededKeys, removed: prunedIds.size, kept, stragglers, total };
}

/** Keep this op? `inPrefix`: the op belongs to a pruned-prefix commit (keys there survive only if needed). */
export function keepPath(path, plan, inPrefix) {
  const c = classify(path);
  if (c === null) return true;
  if (c === 'key') return inPrefix ? plan.neededKeys.has(path) : true;
  return !plan.prunedIds.has(c);
}

export const noticeMessage = (pl) =>
  `prune notice: everything captured before ${pl.cutoff} removed\n\ncutoff: ${pl.cutoff}\nprevious-head: ${pl.previousHead}\nremoved: ${pl.removed}\nkept: ${pl.kept}\n` +
  (pl.earlier ? `earlier-prune-cutoff: ${pl.earlier.cutoff}\nearlier-prune-removed: ${pl.earlier.removed}\nearlier-prune-previous-head: ${pl.earlier['previous-head']}\n` : '');
export const parseNotice = (msg) => Object.fromEntries(msg.split('\n').slice(2).filter(Boolean).map((l) => { const k = l.indexOf(': '); return [l.slice(0, k), l.slice(k + 2)]; }));

/** Cutoff ISO for "about the given fraction of records": the captured of the record at that position (+1 ms). */
export function cutoffAtFraction(repo, frac) {
  const ls = sh(repo, ['ls-tree', '-r', '--full-tree', 'HEAD', '--', 'records/']).split('\n').filter((l) => l.endsWith('.json'));
  const caps = [];
  const cf = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, input: ls.map((l) => l.split('\t')[0].split(' ')[2]).join('\n') + '\n', maxBuffer: 1 << 30 }).toString('utf8');
  for (const m of cf.matchAll(/"captured": "([^"]+)"/g)) caps.push(m[1]);
  caps.sort();
  return new Date(Date.parse(caps[Math.floor(caps.length * frac)])).toISOString();
}

// --- stdlib fast-export stream parser: yields { type, ... } for blob (data mode) and commit
export async function* parseFastExport(stream) {
  let buf = Buffer.alloc(0);
  const it = stream[Symbol.asyncIterator]();
  let eof = false;
  const fill = async () => { const r = await it.next(); if (r.done) eof = true; else buf = Buffer.concat([buf, r.value]); };
  const line = async () => { for (;;) { const i = buf.indexOf(10); if (i >= 0) { const s = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 1); return s; } if (eof) return null; await fill(); } };
  const bytes = async (n) => { while (buf.length < n + 1 && !eof) await fill(); const b = Buffer.from(buf.subarray(0, n)); buf = buf.subarray(n); if (buf[0] === 10) buf = buf.subarray(1); return b; }; // the LF after a data block is optional
  let l;
  while ((l = await line()) !== null) {
    if (l === '' || l.startsWith('reset ') || l.startsWith('progress ')) continue;
    if (l === 'blob') {
      let mark = null, d = null;
      for (;;) { const x = await line(); if (x.startsWith('mark ')) mark = x; else if (x.startsWith('data ')) { d = await bytes(Number(x.slice(5))); break; } }
      yield { type: 'blob', mark, data: d };
    } else if (l.startsWith('commit ')) {
      const c = { type: 'commit', ref: l.slice(7), author: null, committer: null, msg: null, ops: [], other: [] };
      for (;;) {
        const x = await line();
        if (x === null || x === '') break;
        if (x.startsWith('mark ') || x.startsWith('from ') || x.startsWith('original-oid ')) continue;
        if (x.startsWith('merge ')) throw new Error('merge commit: not linear');
        if (x.startsWith('author ')) c.author = x;
        else if (x.startsWith('committer ')) c.committer = x;
        else if (x.startsWith('encoding ')) c.other.push(x);
        else if (x.startsWith('data ')) c.msg = await bytes(Number(x.slice(5)));
        else if (x === 'deleteall') throw new Error('deleteall in trail history');
        else if (x.startsWith('M ')) { const m = /^M (\d+) (\S+) (.+)$/.exec(x); c.ops.push({ st: 'M', mode: m[1], ref: m[2], path: m[3] }); }
        else if (x.startsWith('D ')) c.ops.push({ st: 'D', path: x.slice(2) });
        else throw new Error('unhandled fast-export line: ' + x);
      }
      yield c;
    } else throw new Error('unhandled top-level: ' + l);
  }
}


/** Commit hashes oldest first, in chunks of K (git log/fast-export keep ~10 KB per commit in memory, so long walks are done chunk by chunk). */
export function chunks(repo, k, { from = null } = {}) {
  const all = sh(repo, ['rev-list', '--reverse', 'HEAD']).split('\n');
  const out = [];
  let start = from ? all.indexOf(from) + 1 : 0;
  for (let i = start; i < all.length; i += k) out.push({ after: i === 0 ? null : all[i - 1], upto: all[Math.min(i + k, all.length) - 1], n: Math.min(k, all.length - i) });
  return out;
}

/** logOps in bounded memory: one `git log` per chunk. */
export async function* logOpsChunked(repo, k = 2000) {
  for (const c of chunks(repo, k)) yield* logOps(repo, { extra: [c.after ? `${c.after}..${c.upto}` : c.upto] });
}
