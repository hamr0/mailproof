// Prune before date (SPEC B9, M3 step 3): rewrite the trail so that everything captured before a cutoff is gone and
// every kept commit keeps its message, author and dates, and every kept file stays byte-identical.
//
//   plan    one `git fast-export --no-data` walk of a snapshot HEAD, no lock: where the pruned prefix ends, which records
//           it holds, which files it leaves behind (trail.json, archived keys)
//   build   `git fast-export` of the kept range -> this file's filter -> `git fast-import` into `<trail>.prune-build`,
//           borrowing the old objects through alternates, then `repack -a -d` and the alternates are dropped, no lock
//   append  under the locks: the commits made since the snapshot go through the same filter, then the swap
//   swap    journal, two renames, sync-cursor repoint (prune-swap.js); the content sweep runs after the locks are released
//
// Writers are not blocked while the pruned trail is built: the trail lock (and the sync lock) are held only for the
// append and the swap, so the hold time follows the number of new commits, not the size of the trail (findings F25).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, GIT_IDENTITY } from './git.js';
import { PRUNE_SYNC_WAIT_MS, PRUNE_GIT_CONFIG } from './limits.js';
import {
  withTrailLock, trailLockFile, syncLockFile, pruneLockFile, TRAIL_LOCK, PRUNE_LOCK, SYNC_LOCK_WAIT,
  headOf, isAncestor, idsAt,
} from './trail.js';
import { recordPath, parseRecordPath, parseReplyPath, assertTrailLayout } from './layout.js';
import { verifyRecord } from './recheck.js';
import { contentDirOf, sweepOrphans, toMs, exists } from './content.js';
import { exportRange, startImport, catFile, lsTree, diffTree } from './prune-stream.js';
import { pathsOf, writeJournal, rollForward } from './prune-swap.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/**
 * @typedef {Object} PruneResult
 * @property {string} cutoff  ISO time.
 * @property {boolean} noop  True when the cutoff removed nothing: nothing was rewritten, no backup was made.
 * @property {boolean} dryRun  True for a `dryRun` call: the numbers are what a real prune would produce, nothing was built, swapped or written; `head` is null and `content` is zero.
 * @property {string | null} previousHead  HEAD of the old trail when the swap began (a no-op: the current HEAD).
 * @property {string | null} head  HEAD of the pruned trail (a no-op: the current HEAD).
 * @property {number} removed  Records removed.
 * @property {number} kept  Records kept.
 * @property {string[]} stragglers  Ids of records kept although captured before the cutoff (they sit after a later one).
 * @property {number} dropped  Commits not carried over because they only touched removed records (reply-text commits).
 * @property {number} keysCarried  Archived key files kept in the notice commit or added to a kept commit although first committed before the cutoff.
 * @property {{ ok: number, failed: string[] }} reverify  `verifyRecord` over every kept record: how many verify, and the ids that do not (the prune cannot have caused that: the files are byte-identical).
 * @property {string | null} backup  Path of the old trail (`<trail>.pre-prune-<date>`), null for a no-op or after `deleteBackup`; for a `dryRun`, the path a real prune would use.
 * @property {{ removed: number, attachments: number, error?: string }} content  Content deleted for the removed records.
 * @property {{ planMs: number, buildMs: number, lockMs: number, totalMs: number }} timing  `lockMs`: how long the trail lock was held.
 */

/**
 * Test seams (internal): called at named points; a hook may throw, record, or kill the process.
 * @typedef {Object} PruneHooks
 * @property {() => Promise<void> | void} [afterPlan]  After the plan, before the build (the trail lock is NOT held).
 * @property {() => Promise<void> | void} [afterBuild]  After the pruned trail is built, before the locks are taken (NOT held).
 * @property {() => Promise<void> | void} [afterLocks]  Inside both locks, before the append.
 * @property {(name: string) => Promise<void> | void} [point]  `journal`, `renamed-live`, `renamed-tmp`, `cursor`, `swapped`: inside the swap.
 * @property {number} [syncWaitMs]  How long to wait for a running sync (default PRUNE_SYNC_WAIT_MS).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What one path of the trail is, for prune.
 * @param {string} p
 * @returns {{ kind: 'record' | 'reply', id: string } | { kind: 'key' } | null}  null: something else (kept).
 */
function classify(p) {
  const r = parseRecordPath(p);
  if (r) return { kind: 'record', id: r.id };
  const y = parseReplyPath(p);
  if (y) return { kind: 'reply', id: y.id };
  return p.startsWith('keys/') ? { kind: 'key' } : null;
}

// ---- the prune notice (the root commit of a pruned trail) ----

const NOTICE_FIELDS = ['cutoff', 'previous-head', 'removed', 'kept', 'stragglers', 'dropped', 'pruned-at'];
const NOTICE_SUBJECT = 'prune notice: everything captured before ';

/**
 * The prune notices a root commit message carries: the notice itself first, then the earlier ones, newest first.
 * @param {string} msg
 * @returns {Array<Record<string, string>>}  Empty when the message is not a prune notice.
 */
function parseNotice(msg) {
  if (!msg.startsWith(NOTICE_SUBJECT)) return [];
  /** @type {Array<Record<string, string>>} */
  const out = [{}];
  for (const l of msg.split('\n').slice(1)) {
    const k = l.indexOf(': ');
    if (k < 0) continue;
    const m = /^earlier-(\d+)-(.+)$/.exec(l.slice(0, k));
    const n = m ? Number(m[1]) : 0;
    (out[n] ??= {})[m ? m[2] : l.slice(0, k)] = l.slice(k + 2);
  }
  return out.map((x) => x ?? {});
}

/**
 * @param {Record<string, string>} fields  This prune's fields (NOTICE_FIELDS).
 * @param {Array<Record<string, string>>} earlier  The notices of the prunes before it, newest first.
 * @returns {string}
 */
function noticeMessage(fields, earlier) {
  const lines = [`${NOTICE_SUBJECT}${fields.cutoff} removed`, ''];
  for (const k of NOTICE_FIELDS) lines.push(`${k}: ${fields[k]}`);
  earlier.forEach((e, i) => { for (const k of NOTICE_FIELDS) if (e[k] !== undefined) lines.push(`earlier-${i + 1}-${k}: ${e[k]}`); });
  return lines.join('\n') + '\n';
}

// ---- plan ----

/**
 * @typedef {Object} Plan
 * @property {number} prefixCommits
 * @property {string} tail  The last pruned commit (the kept range starts after it).
 * @property {Set<string>} prunedIds
 * @property {Map<string, { mode: string, ref: string }>} carry  Files of the pruned prefix that stay and are not records, replies or keys (trail.json, ...).
 * @property {Map<string, { mode: string, ref: string }>} prefixKeys  Archived keys first committed in the pruned prefix.
 * @property {number} dropped  Kept-range commits that touch only removed records.
 * @property {boolean} boundary  A commit that is kept was found (else every record is before the cutoff).
 */

/**
 * @param {ReturnType<typeof catFile>} cat
 * @param {string} spec
 * @returns {Promise<MpRecord | null>}
 */
async function readJson(cat, spec) {
  const b = await cat.get(spec);
  if (!b) return null;
  try { const j = JSON.parse(b.toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

/** @param {MpRecord | null} rec @returns {number} NaN when there is no usable `captured`. */
const capturedMs = (rec) => (rec && typeof rec.captured === 'string' ? Date.parse(rec.captured) : NaN);

/**
 * Walk the history of `snapshot` and find the pruned prefix: the commits before the first one that adds a record
 * captured at or after the cutoff (a record with no usable `captured` counts as after: never delete on doubt). Only a
 * prefix is ever pruned, never a range in the middle.
 * @param {string} root
 * @param {string} snapshot
 * @param {number} cutoffMs
 * @param {ReturnType<typeof catFile>} cat
 * @returns {Promise<Plan>}
 */
async function planPrune(root, snapshot, cutoffMs, cat) {
  const exp = exportRange(root, snapshot, { data: false });
  /** @type {Plan} */
  const plan = { prefixCommits: 0, tail: '', prunedIds: new Set(), carry: new Map(), prefixKeys: new Map(), dropped: 0, boundary: false };
  for await (const c of exp.items) {
    if (c.type !== 'commit') continue;
    if (!plan.boundary) {
      /** @type {string[]} */
      const ids = [];
      for (const o of c.ops) {
        const r = o.st === 'M' ? parseRecordPath(o.path) : null;
        if (!r || r.ots) continue;
        if (capturedMs(await readJson(cat, o.ref)) < cutoffMs) ids.push(r.id); else plan.boundary = true;
      }
      if (!plan.boundary) {
        for (const id of ids) plan.prunedIds.add(id);
        for (const o of c.ops) {
          const k = classify(o.path);
          if (k && k.kind !== 'key') continue;   // records and replies are pruned
          const into = k ? plan.prefixKeys : plan.carry;
          if (o.st === 'D') into.delete(o.path); else into.set(o.path, { mode: o.mode, ref: o.ref });
        }
        plan.prefixCommits++;
        plan.tail = c.oid;
        continue;
      }
    }
    if (c.ops.every((o) => { const k = classify(o.path); return k !== null && k.kind !== 'key' && plan.prunedIds.has(k.id); })) plan.dropped++;
  }
  await exp.done;
  return plan;
}

// ---- kept records ----

/**
 * What is learned from reading the kept records: counted once at the snapshot, then for the commits appended.
 * @typedef {Object} KeptState
 * @property {number} kept
 * @property {number} ok  Records whose offline `verifyRecord` passes.
 * @property {string[]} failed  Ids whose does not.
 * @property {string[]} stragglers  Kept although captured before the cutoff.
 * @property {Set<string>} keys  Every `key_file` a kept record names.
 */

/** @returns {KeptState} */
const newKeptState = () => ({ kept: 0, ok: 0, failed: [], stragglers: [], keys: new Set() });

/**
 * Account for one kept record: re-verify it, note a straggler, collect the key files it names.
 * @param {KeptState} st
 * @param {string} id
 * @param {MpRecord | null} rec
 * @param {number} cutoffMs
 */
function noteKept(st, id, rec, cutoffMs) {
  st.kept++;
  if (capturedMs(rec) < cutoffMs) st.stragglers.push(id);
  if (rec && verifyRecord(rec).ok) st.ok++; else st.failed.push(id);
  if (rec && Array.isArray(rec.signatures)) for (const s of rec.signatures) if (s && typeof s.key_file === 'string') st.keys.add(s.key_file);
}

// ---- build ----

/**
 * @param {{ st: 'M' | 'D', mode: string, ref: string, path: string }} o
 * @returns {string}
 */
const opLine = (o) => (o.st === 'D' ? `D ${o.path}\n` : `M ${o.mode} ${o.ref} ${o.path}\n`);

/**
 * `commit refs/heads/main` with its headers and message, ready for the ops.
 * @param {string} author  A whole `author ...` line.
 * @param {string} committer
 * @param {string[]} extra
 * @param {Buffer} msg
 * @param {boolean} [continues]  The first commit of a later fast-import run: it names the branch tip as its parent (a new run does not load it by itself).
 * @returns {Buffer[]}
 */
const commitHead = (author, committer, extra, msg, continues = false) => [
  Buffer.from(`commit refs/heads/main\n${author}\n${committer}\n${extra.map((x) => `${x}\n`).join('')}data ${msg.length}\n`, 'latin1'), msg, Buffer.from(continues ? '\nfrom refs/heads/main^0\n' : '\n'),
];

/**
 * Build the pruned repo (bare) from the plan: the notice commit, then every kept commit through the filter.
 * @param {Object} a
 * @param {string} a.root
 * @param {string} a.snapshot
 * @param {string} a.build  Directory of the bare repo to create.
 * @param {Plan} a.plan
 * @param {Set<string>} a.carried  Archived keys of the prefix that stay (named by a kept record).
 * @param {string} a.notice  The notice message.
 * @param {number} a.nowSec
 * @returns {Promise<{ commits: number }>}  `commits`: kept commits written (the notice not counted).
 */
async function buildPruned({ root, snapshot, build, plan, carried, notice, nowSec }) {
  await git(path.dirname(build), ['init', '-q', '--bare', '--initial-branch=main', build]);
  const objects = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'objects']));
  await fs.mkdir(path.join(build, 'objects', 'info'), { recursive: true });
  await fs.writeFile(path.join(build, 'objects', 'info', 'alternates'), `${objects}\n`);
  if (!/^[0-9a-f]{40,64}$/.test(plan.tail)) throw new Error('prune: git did not report the last pruned commit');
  const imp = startImport(build);
  const exp = exportRange(root, `${plan.tail}..${snapshot}`, { data: false });
  let commits = 0;
  try {
    const who = `${GIT_IDENTITY.name} <${GIT_IDENTITY.email}> ${nowSec} +0000`;
    for (const b of commitHead(`author ${who}`, `committer ${who}`, [], Buffer.from(notice))) await imp.write(b);
    const root0 = [...plan.carry, ...[...plan.prefixKeys].filter(([p]) => carried.has(p))].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [p, o] of root0) await imp.write(opLine({ st: 'M', mode: o.mode, ref: o.ref, path: p }));
    await imp.write('\n');
    for await (const c of exp.items) {
      if (c.type !== 'commit') continue;
      const ops = c.ops.filter((o) => { const k = classify(o.path); return k === null || k.kind === 'key' || !plan.prunedIds.has(k.id); });
      if (ops.length === 0) continue;   // a reply-text commit for a removed record
      for (const b of commitHead(c.author, c.committer, c.extra, c.msg)) await imp.write(b);
      for (const o of ops) await imp.write(opLine(o));
      await imp.write('\n');
      commits++;
    }
    await exp.done;
    await imp.end();
  } catch (e) { exp.kill(); imp.kill(); throw e; }
  // Self-contained: pack everything reachable (also what came through the alternates), then drop them.
  await git(build, ['repack', '-a', '-d', '-q'], { config: PRUNE_GIT_CONFIG });
  await fs.rm(path.join(build, 'objects', 'info', 'alternates'), { force: true });
  await git(build, ['fsck', '--connectivity-only', '--no-dangling'], { config: PRUNE_GIT_CONFIG });
  return { commits };
}

/**
 * Turn the bare build into a normal trail directory at `tmp` (git dir, config, working tree).
 * @param {string} root  The live trail (its local identity is copied).
 * @param {string} build
 * @param {string} tmp
 * @returns {Promise<void>}
 */
async function materialise(root, build, tmp) {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp);
  await fs.rename(build, path.join(tmp, '.git'));
  for (const k of ['user.name', 'user.email']) {
    try { const v = await git(root, ['config', '--local', k]); if (v) await git(tmp, ['config', k, v]); } catch { /* not set */ }
  }
  await git(tmp, ['config', 'core.bare', 'false']);
  await git(tmp, ['reset', '-q', '--hard', 'HEAD'], { config: PRUNE_GIT_CONFIG });
  await fs.mkdir(path.join(tmp, 'records'), { recursive: true });
}

/**
 * Whether the pruned trail must hold this path of the old trail: everything except the files of removed records and
 * the archived keys of the prefix that no kept record names.
 * @param {string} p
 * @param {Plan} plan
 * @param {Set<string>} carried
 * @returns {boolean}
 */
function wanted(p, plan, carried) {
  const k = classify(p);
  if (k && k.kind !== 'key' && plan.prunedIds.has(k.id)) return false;
  if (k && k.kind === 'key' && plan.prefixKeys.has(p) && !carried.has(p)) return false;
  return true;
}

/**
 * @param {string[]} bad
 * @param {string} what
 * @returns {Error & { code: 'ERR_PRUNE_VERIFY' }}
 */
const verifyError = (bad, what) => Object.assign(new Error(`prune: the pruned trail does not match the old one (${what}): ${bad.length} paths differ, first ${bad[0]}. Nothing was changed.`), { code: /** @type {const} */ ('ERR_PRUNE_VERIFY') });

/**
 * The pruned trail's files must be the old trail's files minus those of removed records (and minus unneeded prefix
 * keys), blob ids equal. Both listings are streamed: one map (the wanted files) is held, and emptied as the new
 * listing matches it.
 * @param {string} root  The live trail.
 * @param {string} snapshot
 * @param {string} tmp  The pruned trail.
 * @param {string} builtTip
 * @param {Plan} plan
 * @param {Set<string>} carried
 * @returns {Promise<void>}
 * @throws {Error & { code: 'ERR_PRUNE_VERIFY' }}
 */
async function assertSnapshotFiles(root, snapshot, tmp, builtTip, plan, carried) {
  /** @type {Map<string, string>} */
  const want = new Map();
  await lsTree(root, snapshot, (p, sha) => { if (wanted(p, plan, carried)) want.set(p, sha); });
  /** @type {string[]} */
  const bad = [];
  await lsTree(tmp, builtTip, (p, sha) => { if (want.get(p) === sha) want.delete(p); else bad.push(p); });
  bad.push(...want.keys());
  if (bad.length) throw verifyError(bad, 'snapshot');
}

/**
 * @param {Map<string, string | null>} want
 * @param {Map<string, string | null>} got
 * @param {string} what
 * @throws {Error & { code: 'ERR_PRUNE_VERIFY' }}
 */
function assertSame(want, got, what) {
  /** @type {string[]} */
  const bad = [];
  for (const [p, s] of want) if (got.get(p) !== s) bad.push(p);
  for (const p of got.keys()) if (!want.has(p)) bad.push(p);
  if (bad.length) throw verifyError(bad, what);
}

/**
 * Append the commits made since the snapshot to the materialised pruned trail through the same filter. Blobs are
 * streamed (a few commits), so the pruned repo needs nothing from the old object store.
 * @param {Object} a
 * @param {string} a.root
 * @param {string} a.tmp  The materialised pruned trail.
 * @param {string} a.snapshot
 * @param {string} a.head
 * @param {Plan} a.plan
 * @param {Set<string>} a.carried  Mutated: a key a new kept record names that the pruned trail lacks is added here.
 * @param {KeptState} a.state  Mutated.
 * @param {number} a.cutoffMs
 * @param {ReturnType<typeof catFile>} a.cat  Reads from the old trail.
 * @returns {Promise<{ commits: number, dropped: number, added: Map<string, string> }>}  `added`: key path -> blob id of the keys added to a kept commit.
 */
async function appendSince({ root, tmp, snapshot, head, plan, carried, state, cutoffMs, cat }) {
  const imp = startImport(tmp);
  const exp = exportRange(root, `${snapshot}..${head}`, { data: true });
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  /** @type {Set<string>} */
  const written = new Set();
  /** @type {Map<string, string>} */
  const added = new Map();
  let commits = 0;
  let dropped = 0;
  try {
    for await (const c of exp.items) {
      if (c.type === 'blob') { blobs.set(c.mark, c.data); continue; }
      const ops = c.ops.filter((o) => { const k = classify(o.path); return k === null || k.kind === 'key' || !plan.prunedIds.has(k.id); });
      if (ops.length === 0) { dropped++; continue; }
      /** @type {string[]} */
      const wantKeys = [];
      for (const o of ops) {
        const r = o.st === 'M' ? parseRecordPath(o.path) : null;
        if (!r || r.ots) continue;
        let rec = null;
        try { rec = JSON.parse((blobs.get(o.ref) ?? Buffer.alloc(0)).toString('utf8')); } catch { /* unreadable: counted as failed */ }
        const before = new Set(state.keys);
        noteKept(state, r.id, rec && typeof rec === 'object' ? rec : null, cutoffMs);
        for (const k of state.keys) if (!before.has(k) && plan.prefixKeys.has(k) && !carried.has(k)) wantKeys.push(k);
      }
      // A key first committed before the cutoff, used by no record kept at the snapshot, but named by this one.
      /** @type {Array<{ path: string, bytes: Buffer }>} */
      const inline = [];
      for (const k of wantKeys) {
        const o = /** @type {{ mode: string, ref: string }} */ (plan.prefixKeys.get(k));
        const bytes = await cat.get(o.ref);
        if (!bytes) throw new Error(`prune: archived key ${k} is missing from the trail`);
        carried.add(k);
        added.set(k, o.ref);
        inline.push({ path: k, bytes });
      }
      for (const o of ops) {   // the blobs this commit keeps, before the commit that names them
        if (o.st === 'M' && o.ref.startsWith(':') && !written.has(o.ref)) {
          const data = blobs.get(o.ref);
          if (!data) throw new Error('prune: fast-export referred to a blob it did not send');
          await imp.write(`blob\nmark ${o.ref}\ndata ${data.length}\n`);
          await imp.write(data);
          await imp.write('\n');
          written.add(o.ref);
        }
      }
      for (const b of commitHead(c.author, c.committer, c.extra, c.msg, commits === 0)) await imp.write(b);
      for (const o of ops) await imp.write(opLine(o));
      for (const k of inline) { await imp.write(`M 100644 inline ${k.path}\ndata ${k.bytes.length}\n`); await imp.write(k.bytes); await imp.write('\n'); }
      await imp.write('\n');
      commits++;
    }
    await exp.done;
    await imp.end();
  } catch (e) { exp.kill(); imp.kill(); throw e; }
  return { commits, dropped, added };
}

/**
 * The backup directory name: `<trail>.pre-prune-<YYYY-MM-DD>`, with `-2`, `-3`... when it exists.
 * @param {string} trailDir
 * @param {string} trail
 * @param {Date} when
 * @returns {Promise<string>}
 */
async function backupName(trailDir, trail, when) {
  const day = when.toISOString().slice(0, 10);
  if (!DATE_RE.test(day)) throw new Error('prune: the clock gave no usable date');
  const base = `${trail}.pre-prune-${day}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(path.join(trailDir, name)))) return name;
  }
}

/**
 * @typedef {Object} PruneCtx
 * @property {string} root  The trail directory.
 * @property {string} trail
 * @property {number} lockTimeoutMs
 * @property {() => Date} now
 * @property {PruneHooks} hooks
 */

/**
 * Prune a trail (see the file header and SPEC B9). Never scheduled; the caller asked for it.
 * @param {PruneCtx} ctx
 * @param {{ before: Date | number | string, deleteBackup?: boolean, dryRun?: boolean, now?: Date | number }} opts
 * @returns {Promise<PruneResult>}
 */
async function runPrune(ctx, opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('prune: options required: { before }');
  for (const k of Object.keys(opts)) if (k !== 'before' && k !== 'deleteBackup' && k !== 'dryRun' && k !== 'now') throw new TypeError(`prune: unknown option "${k}"`);
  if (opts.before === undefined) throw new TypeError('prune: before is required (a Date, a timestamp or an ISO date string)');
  const cutoffMs = toMs(opts.before, 'before', 'prune');
  if (opts.deleteBackup !== undefined && typeof opts.deleteBackup !== 'boolean') throw new TypeError('prune: deleteBackup must be a boolean');
  if (opts.dryRun !== undefined && typeof opts.dryRun !== 'boolean') throw new TypeError('prune: dryRun must be a boolean');
  const dryRun = opts.dryRun === true;
  const nowMs = opts.now === undefined ? ctx.now().getTime() : toMs(opts.now, 'now', 'prune');
  const { root, trail, lockTimeoutMs, hooks } = ctx;
  const cutoff = new Date(cutoffMs).toISOString();
  await assertTrailLayout(root);
  const p = pathsOf(root);
  const lockTrail = (/** @type {() => Promise<any>} */ w) => withTrailLock(root, trailLockFile(trail), lockTimeoutMs, w, TRAIL_LOCK);
  const t0 = Date.now();

  return withTrailLock(root, pruneLockFile(trail), 0, async () => {
    // A short look under the trail lock: finishes an unfinished earlier swap (the lock does that), takes the snapshot,
    // clears what a crashed earlier build left.
    const snapshot = await lockTrail(async () => {
      if (!dryRun) {   // a dry run writes nothing: it leaves a crashed build where it is
        await fs.rm(p.build, { recursive: true, force: true });
        await fs.rm(p.tmp, { recursive: true, force: true });
      }
      return headOf(root);
    });
    /** @returns {PruneResult} */
    const noop = (/** @type {number} */ kept) => ({
      cutoff, noop: true, dryRun, previousHead: snapshot, head: snapshot, removed: 0, kept, stragglers: [], dropped: 0, keysCarried: 0,
      reverify: { ok: 0, failed: [] }, backup: null, content: { removed: 0, attachments: 0 }, timing: { planMs: 0, buildMs: 0, lockMs: 0, totalMs: Date.now() - t0 },
    });
    if (snapshot === null) return noop(0);

    const cat = catFile(root);
    let swapped = false;
    try {
      // ---- plan (no lock)
      const plan = await planPrune(root, snapshot, cutoffMs, cat);
      const planMs = Date.now() - t0;
      if (plan.prunedIds.size === 0) return noop((await idsAt(root, snapshot)).size);
      if (!plan.boundary) {
        throw Object.assign(new Error(`prune: every record in trail "${trail}" was captured before ${cutoff}; pruning would leave an empty trail, so it is refused`), { code: 'ERR_PRUNE_CUTOFF' });
      }
      if (!dryRun) await hooks.afterPlan?.();

      // kept records at the snapshot: re-verify, stragglers, the keys they need
      /** @type {KeptState} */
      const state = newKeptState();
      for (const id of await idsAt(root, snapshot)) {
        if (!plan.prunedIds.has(id)) noteKept(state, id, await readJson(cat, `${snapshot}:${recordPath(id)}`), cutoffMs);
      }
      /** @type {Set<string>} */
      const carried = new Set([...plan.prefixKeys.keys()].filter((k) => state.keys.has(k)));
      if (dryRun) {   // the plan and the kept-record check above are the real computation; nothing below runs
        return {
          cutoff, noop: false, dryRun: true, previousHead: snapshot, head: null, removed: plan.prunedIds.size, kept: state.kept, stragglers: state.stragglers,
          dropped: plan.dropped, keysCarried: carried.size, reverify: { ok: state.ok, failed: state.failed },
          backup: path.join(p.trailDir, await backupName(p.trailDir, trail, new Date(nowMs))), content: { removed: 0, attachments: 0 },
          timing: { planMs, buildMs: 0, lockMs: 0, totalMs: Date.now() - t0 },
        };
      }
      const earlier = parseNotice((await git(root, ['log', '--max-parents=0', '--format=%B', snapshot], { config: PRUNE_GIT_CONFIG })).replace(/$/, '\n'));
      const notice = noticeMessage({
        cutoff, 'previous-head': snapshot, removed: String(plan.prunedIds.size), kept: String(state.kept), stragglers: String(state.stragglers.length),
        dropped: String(plan.dropped), 'pruned-at': new Date(nowMs).toISOString(),
      }, earlier);

      // ---- build and check (no lock)
      await buildPruned({ root, snapshot, build: p.build, plan, carried, notice, nowSec: Math.floor(nowMs / 1000) });
      await materialise(root, p.build, p.tmp);
      const builtTip = await git(p.tmp, ['rev-parse', 'HEAD']);
      await assertSnapshotFiles(root, snapshot, p.tmp, builtTip, plan, carried);
      if ((await git(p.tmp, ['status', '--porcelain'], { config: PRUNE_GIT_CONFIG })) !== '') throw Object.assign(new Error('prune: the pruned working tree is not clean. Nothing was changed.'), { code: 'ERR_PRUNE_VERIFY' });
      const buildMs = Date.now() - t0 - planMs;
      await hooks.afterBuild?.();

      // ---- append and swap (both locks)
      let lockMs = 0;
      let backup = '';
      let previousHead = snapshot;
      let newHead = builtTip;
      let droppedLate = 0;
      let keptRecords = state.kept;
      await withTrailLock(root, syncLockFile(trail), hooks.syncWaitMs ?? PRUNE_SYNC_WAIT_MS, () => lockTrail(async () => {
        const locked = Date.now();
        await hooks.afterLocks?.();
        const head = await headOf(root);
        if (head === null || (head !== snapshot && !(await isAncestor(root, snapshot, head)))) {
          throw Object.assign(new Error(`prune: the trail's history changed while the pruned trail was built; nothing was changed, run prune again`), { code: 'ERR_PRUNE_REWRITTEN' });
        }
        previousHead = head;
        if (head !== snapshot) {
          const late = await appendSince({ root, tmp: p.tmp, snapshot, head, plan, carried, state, cutoffMs, cat });
          await git(p.tmp, ['reset', '-q', '--hard', 'HEAD'], { config: PRUNE_GIT_CONFIG });   // reads every new tree: a missing object fails here
          newHead = await git(p.tmp, ['rev-parse', 'HEAD']);
          assertSame(await filteredDiff(root, snapshot, head, plan, carried, late.added), await diffTree(p.tmp, builtTip, newHead), 'commits made during the build');
          droppedLate = late.dropped;
          keptRecords = state.kept;
        }
        backup = await backupName(p.trailDir, trail, new Date(nowMs));
        const j = await writeJournal(root, {
          v: 1, state: 'swapping', pid: process.pid, host: os.hostname(), updated: '', backup, cutoff, previous_head: previousHead, new_head: newHead,
        }, 'swapping');
        await hooks.point?.('journal');
        try { await rollForward(root, path.join(p.trailDir, backup), hooks.point); } catch (e) {
          // A failure, not a crash. Before the first rename or between the two: put the old trail back and drop the
          // journal. After both: the swap stands and the journal stays, so the next lock holder finishes the cursor.
          const bak = path.join(p.trailDir, backup);
          if (!(await exists(root)) && await exists(bak)) await fs.rename(bak, root);
          if (!(await exists(bak))) await fs.rm(p.journal, { force: true });
          else if (await exists(p.tmp)) await fs.rm(p.journal, { force: true });
          throw e;
        }
        await writeJournal(root, j, 'swapped');
        await hooks.point?.('swapped');
        swapped = true;
        lockMs = Date.now() - locked;
      }), SYNC_LOCK_WAIT);

      // ---- after the swap: content of the removed records, then the journal
      /** @type {PruneResult['content']} */
      let content = { removed: 0, attachments: 0 };
      try {
        content = await sweepOrphans(root, contentDirOf(root), lockTrail);
        await lockTrail(async () => { await fs.rm(p.journal, { force: true }); });
      } catch (e) {
        content = { ...content, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 300) };   // the journal stays: the next lock holder finishes the sweep
      }
      let backupPath = path.join(p.trailDir, backup);
      if (opts.deleteBackup === true && !content.error) {
        try { await fs.rm(backupPath, { recursive: true, force: true }); backupPath = ''; } catch { /* keep it: reported below */ }
      }
      return {
        cutoff, noop: false, dryRun: false, previousHead, head: newHead, removed: plan.prunedIds.size, kept: keptRecords, stragglers: state.stragglers, dropped: plan.dropped + droppedLate,
        keysCarried: carried.size, reverify: { ok: state.ok, failed: state.failed }, backup: backupPath || null, content,
        timing: { planMs, buildMs, lockMs, totalMs: Date.now() - t0 },
      };
    } finally {
      cat.close();
      if (!swapped) {
        await fs.rm(p.build, { recursive: true, force: true }).catch(() => {});
        await fs.rm(p.tmp, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, PRUNE_LOCK);
}

/**
 * What the net change old `snapshot`..`head` must look like in the pruned trail: the old change minus removed
 * records, plus the archived keys added to a kept commit.
 * @param {string} root
 * @param {string} snapshot
 * @param {string} head
 * @param {Plan} plan
 * @param {Set<string>} carried
 * @param {Map<string, string>} added
 * @returns {Promise<Map<string, string | null>>}
 */
async function filteredDiff(root, snapshot, head, plan, carried, added) {
  /** @type {Map<string, string | null>} */
  const out = new Map();
  for (const [p, sha] of await diffTree(root, snapshot, head)) {
    if (wanted(p, plan, carried)) out.set(p, sha);
  }
  for (const [p, sha] of added) out.set(p, sha);
  return out;
}

export { runPrune, parseNotice, noticeMessage, classify };
