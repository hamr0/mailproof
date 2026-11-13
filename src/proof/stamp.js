// The stamp job (SPEC B13.1, M4): the batch OpenTimestamps seal. Capture never stamps and never waits for the network; this
// job, run by `sync` when due, by `Mailproof#stamp()` and by `mailproof stamp`, writes a manifest of the files added since the
// last one (seal.js), commits it, stamps the newest manifest once, and upgrades older pending proofs (ots-upgrade.js).
//
// Locks (order: sync lock, stamp lock, trail lock): the stamp lock is held for the whole job; the trail lock only for the file
// writes and the one commit of step 3, step 5 and each changed upgrade. `ots` never runs under the trail lock and never inside
// the trail: it works on copies in `<trailDir>/.<trail>.stamp/`, because a stray untracked `.ots` in `manifests/` would be
// deleted by another writer's `clearLeftovers`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import { catFile } from './prune-stream.js';
import {
  withTrailLock, trailLockFile, stampLockFile, stampMarkerFile, stampScratchDir, STAMP_LOCK, ensureTrail, clearLeftovers, headOf, isAncestor, isTracked,
} from './trail.js';
import { manifestPath, manifestOtsPath, recordPath, parseRecordPath, parseReplyPath, assertTrailLayout } from './layout.js';
import { chainError, serialiseManifest, listManifests, readChain, scanFiles, unsealedOf, sha256Hex } from './seal.js';
import { upgradePass, countPendingStamps, committedBytes } from './ots-upgrade.js';
import { OTS_MISSING_MESSAGE } from './ots.js';
import { STAMP_MAX_ENTRIES, STAMP_MAX_MANIFESTS, STAMP_EVERY_HOURS, STAMP_EVERY_HOURS_MIN, STAMP_EVERY_HOURS_MAX } from './limits.js';

/**
 * @typedef {Object} StampResult
 * @property {boolean} enabled  False: `otsBin` is null. Nothing was done, nothing touched.
 * @property {'batch' | 'record'} mode
 * @property {boolean} ran  False only for the automatic run (not due, or locked).
 * @property {'not due' | 'locked' | 'rewritten'} [skipped]
 * @property {Array<{ seq: number, records: number, replies: number, sha256: string, commit: string }>} manifests  Made by this call.
 * @property {number | null} stamped  The seq stamped by this call, else null.
 * @property {number} unstamped  Committed manifests without an `.ots` after the call (covered by a later one).
 * @property {number} unsealed  Files not in any manifest after the call (a backlog beyond the caps, or committed after the snapshot).
 * @property {number} upgraded  Proofs rewritten in this call.
 * @property {number} pending  Proofs not yet anchored after the call.
 * @property {string} [error]  `ots not found`, `ots timeout`, `ots exit N: ...`.
 */

/**
 * The validated `stamp` option (SPEC B13.1.1).
 * @typedef {{ mode: 'batch' | 'record', everyHours: number }} StampOptions
 */

/**
 * Test seams (internal).
 * @typedef {Object} StampHooks
 * @property {() => Promise<void> | void} [afterSnapshot]  After the unsealed set is computed, before the manifests are committed (no lock held).
 * @property {() => Promise<void> | void} [afterManifests]  After step 3's commit (no lock held).
 * @property {() => Promise<void> | void} [afterStamp]  After `ots stamp`, before the proof is committed (no lock held).
 * @property {number} [maxEntries]  Lowers STAMP_MAX_ENTRIES.
 * @property {number} [maxManifests]  Lowers STAMP_MAX_MANIFESTS.
 * @property {number} [jobMaxMs]  Lowers STAMP_JOB_MAX_MS.
 * @property {() => number} [clock]  Milliseconds for the upgrade-pass deadline.
 * @property {(rel: string) => Promise<void> | void} [beforeUpgrade]
 * @property {(rel: string) => Promise<void> | void} [afterOtsUpgrade]
 */

/**
 * @typedef {Object} StampCtx
 * @property {string} root
 * @property {string} trail
 * @property {ReturnType<typeof import('./ots.js').createOts> | null} ots  The `ots` runner for jobs (STAMP_OTS_TIMEOUT_MS); null: off.
 * @property {StampOptions} stamp
 * @property {number} lockTimeoutMs
 * @property {() => Date} now
 * @property {StampHooks} hooks
 */

/**
 * Validate the `stamp` constructor option like `content` (SPEC B13.1.1): an unknown key, a bad `mode` or an `everyHours`
 * that is not an integer in range throws.
 * @param {unknown} v
 * @returns {StampOptions}
 */
function parseStampOptions(v) {
  if (v === undefined) return { mode: 'batch', everyHours: STAMP_EVERY_HOURS };
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Mailproof: stamp must be an object');
  const o = /** @type {Record<string, unknown>} */ (v);
  for (const k of Object.keys(o)) if (k !== 'mode' && k !== 'everyHours') throw new Error(`Mailproof: unknown stamp option "${k}"`);
  if (o.mode !== undefined && o.mode !== 'batch' && o.mode !== 'record') throw new Error('Mailproof: stamp.mode must be "batch" or "record"');
  const h = o.everyHours;
  if (h !== undefined && !(typeof h === 'number' && Number.isInteger(h) && h >= STAMP_EVERY_HOURS_MIN && h <= STAMP_EVERY_HOURS_MAX)) {
    throw new Error(`Mailproof: stamp.everyHours must be an integer from ${STAMP_EVERY_HOURS_MIN} to ${STAMP_EVERY_HOURS_MAX}`);
  }
  return { mode: o.mode === 'record' ? 'record' : 'batch', everyHours: typeof h === 'number' ? h : STAMP_EVERY_HOURS };
}

/** @param {string} root @param {string} trail @returns {string} */
const markerFile = (root, trail) => path.join(path.dirname(root), stampMarkerFile(trail));

/**
 * @param {string} root
 * @param {string} trail
 * @returns {Promise<{ last: string, error?: string } | null>}  null: missing or unreadable.
 */
async function readMarker(root, trail) {
  try {
    const j = JSON.parse(await fs.readFile(markerFile(root, trail), 'utf8'));
    return j && typeof j.last === 'string' ? { last: j.last, ...(typeof j.error === 'string' ? { error: j.error } : {}) } : null;
  } catch { return null; }
}

/**
 * Record that a job completed (atomic: temp file, then rename). Best effort: a failure only means the next run is due again.
 * @param {string} root @param {string} trail @param {Date} now @param {string | undefined} error
 * @returns {Promise<void>}
 */
async function writeMarker(root, trail, now, error) {
  const file = markerFile(root, trail);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ last: now.toISOString(), ...(error ? { error } : {}) }) + '\n');
    await fs.rename(tmp, file);
  } catch { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

/**
 * Is the automatic job due? A missing, unreadable or future-dated marker means due; else due when `last` is `everyHours` old.
 * @param {{ last: string } | null} marker
 * @param {number} everyHours
 * @param {number} nowMs
 * @returns {boolean}
 */
function isDue(marker, everyHours, nowMs) {
  const last = marker ? Date.parse(marker.last) : NaN;
  return !(Number.isFinite(last) && last <= nowMs && nowMs - last < everyHours * 3_600_000);
}

/**
 * Files committed after `from` (up to HEAD) that a manifest could list.
 * @param {string} root @param {string} from @param {string} to
 * @returns {Promise<number>}
 */
async function addedSince(root, from, to) {
  const out = await git(root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', from, to, '--', 'records', 'replies']);
  let n = 0;
  for (const p of out.split('\0')) { const r = parseRecordPath(p); if ((r && !r.ots) || parseReplyPath(p)) n++; }
  return n;
}

/** @param {StampCtx} c @param {Partial<StampResult>} over @returns {StampResult} */
function result(c, over = {}) {
  return { enabled: c.ots !== null, mode: c.stamp.mode, ran: true, manifests: [], stamped: null, unstamped: 0, unsealed: 0, upgraded: 0, pending: 0, ...over };
}

/**
 * Remove the files a failed step wrote (only those git does not track), then unstage.
 * @param {string} root @param {string[]} rels
 * @returns {Promise<void>}
 */
async function rollBack(root, rels) {
  try { await git(root, ['reset', '-q']); } catch { /* nothing staged */ }
  for (const r of rels) if (!(await isTracked(root, r))) await fs.rm(path.join(root, r), { force: true });
  try { await fs.rmdir(path.join(root, 'manifests')); } catch { /* not empty, or gone */ }
}

/**
 * Steps 2-5 of the job (SPEC B13.1.5): snapshot, manifests, stamp, seal. The caller holds the stamp lock.
 * @param {StampCtx} c
 * @param {string} scratch
 * @param {StampResult} res  Filled in.
 * @returns {Promise<{ rewritten: boolean, error?: string, backlog: number, snapshot: string }>}
 */
async function batchPhase(c, scratch, res) {
  const { root, trail, hooks } = c;
  const ots = /** @type {NonNullable<StampCtx['ots']>} */ (c.ots);
  // ---- step 2: snapshot, no trail lock
  const snapshot = /** @type {string} */ (await headOf(root));
  await assertTrailLayout(root);
  /** @type {{ records: Set<string>, replies: Set<string> }} */
  const listed = { records: new Set(), replies: new Set() };
  const chain = await readChain(root, snapshot, (m) => {
    for (const e of m.records) listed.records.add(e[0]);
    for (const e of m.replies) listed.replies.add(`${e[0]}.${e[1]}`);
  });
  if (chain.broken) throw chainError(chain.broken.seq, chain.broken.why);
  const un = unsealedOf(await scanFiles(root, snapshot), listed);
  /** @type {Array<{ rel: string, kind: 'r' | 'y', id: string, slug: string }>} */
  const entries = [
    ...un.records.map((id) => ({ rel: recordPath(id), kind: /** @type {const} */ ('r'), id, slug: '' })),
    ...un.replies.map((y) => ({ rel: y.path, kind: /** @type {const} */ ('y'), id: y.id, slug: y.slug })),
  ];
  const perManifest = hooks.maxEntries ?? STAMP_MAX_ENTRIES;
  const perJob = (hooks.maxManifests ?? STAMP_MAX_MANIFESTS) * perManifest;
  const take = entries.slice(0, perJob);
  const backlog = entries.length - take.length;
  /** @type {Array<{ seq: number, bytes: Buffer, sha256: string, records: number, replies: number }>} */
  const built = [];
  if (take.length) {
    const cat = catFile(root);
    try {
      let seq = (chain.latest?.seq ?? 0) + 1;
      let prev = chain.latest?.sha256 ?? null;
      const created = c.now().toISOString();
      for (let i = 0; i < take.length; i += perManifest) {
        /** @type {Array<[string, string]>} */
        const records = [];
        /** @type {Array<[string, string, string]>} */
        const replies = [];
        for (const e of take.slice(i, i + perManifest)) {
          const bytes = await cat.get(`${snapshot}:${e.rel}`);
          if (!bytes) throw new Error(`stamp: ${e.rel} is not readable at ${snapshot.slice(0, 12)}`);
          if (e.kind === 'r') records.push([e.id, sha256Hex(bytes)]); else replies.push([e.id, e.slug, sha256Hex(bytes)]);
        }
        const text = Buffer.from(serialiseManifest({ v: 1, seq, previous_sha256: prev, created, records, replies }), 'utf8');
        const sha = sha256Hex(text);
        built.push({ seq, bytes: text, sha256: sha, records: records.length, replies: replies.length });
        prev = sha;
        seq++;
      }
    } catch (e) {
      // a prune swapped the history while the hashes were read: the snapshot's objects are gone, which is `rewritten`, not a failure
      const head = await headOf(root);
      if (head === null || (head !== snapshot && !(await isAncestor(root, snapshot, head)))) return { rewritten: true, backlog: take.length + backlog, snapshot };
      throw e;
    } finally { cat.close(); }
  }
  await hooks.afterSnapshot?.();

  // ---- step 3: commit the manifests, short trail lock
  if (built.length) {
    const outcome = await withTrailLock(root, trailLockFile(trail), c.lockTimeoutMs, async () => {
      await ensureTrail(root, trail, c.now().toISOString());
      await assertTrailLayout(root);
      await clearLeftovers(root);
      const head = await headOf(root);
      if (head === null || (head !== snapshot && !(await isAncestor(root, snapshot, head)))) return /** @type {const} */ ('rewritten');
      const files = await listManifests(root, head);
      const before = (await listManifests(root, snapshot)).at(-1);
      const now = files.at(-1);
      if (before?.seq !== now?.seq || before?.blob !== now?.blob) return /** @type {const} */ ('rewritten');
      const rels = built.map((b) => manifestPath(b.seq));
      try {
        await fs.mkdir(path.join(root, 'manifests'), { recursive: true });
        for (let i = 0; i < built.length; i++) await fs.writeFile(path.join(root, rels[i]), built[i].bytes);
        await git(root, ['add', '--', ...rels]);
        const label = built.length === 1 ? String(built[0].seq) : `${built[0].seq}-${built[built.length - 1].seq}`;
        await git(root, ['commit', '-q', '-m', `stamp manifest ${label}`]);
      } catch (e) { await rollBack(root, rels); throw e; }
      const commit = await git(root, ['rev-parse', 'HEAD']);
      for (const b of built) res.manifests.push({ seq: b.seq, records: b.records, replies: b.replies, sha256: b.sha256, commit });
      return /** @type {const} */ ('ok');
    });
    if (outcome === 'rewritten') return { rewritten: true, backlog: take.length + backlog, snapshot };
  }
  await hooks.afterManifests?.();

  // ---- step 4: stamp the newest manifest if it has no proof, no trail lock, in the scratch directory
  const newest = built.length ? { seq: built[built.length - 1].seq, bytes: built[built.length - 1].bytes } : chain.latest && !chain.latest.ots ? { seq: chain.latest.seq, bytes: chain.latest.bytes } : null;
  if (!newest) return { rewritten: false, backlog, snapshot };
  const copy = path.join(scratch, `${String(newest.seq).padStart(8, '0')}.json`);
  await fs.writeFile(copy, newest.bytes);
  const st = await ots.stampFile(copy);
  if ('error' in st) return { rewritten: false, error: st.error, backlog, snapshot };
  const proof = await fs.readFile(st.proof_path);
  await hooks.afterStamp?.();

  // ---- step 5: commit the seal, short trail lock
  const rel = manifestPath(newest.seq);
  const proofRel = manifestOtsPath(newest.seq);
  const sealed = await withTrailLock(root, trailLockFile(trail), c.lockTimeoutMs, async () => {
    await assertTrailLayout(root);
    await clearLeftovers(root);
    const committed = await committedBytes(root, rel);
    if (!committed || !committed.equals(newest.bytes)) return false;   // a prune removed or rewrote it: the proof is discarded
    if (await committedBytes(root, proofRel)) return true;   // already has one (cannot happen under the stamp lock): leave it
    try {
      await fs.writeFile(path.join(root, proofRel), proof);
      await git(root, ['add', '--', proofRel]);
      await git(root, ['commit', '-q', '-m', `stamp seal ${newest.seq}`]);
    } catch (e) { await rollBack(root, [proofRel]); throw e; }
    res.stamped = newest.seq;
    return true;
  });
  return { rewritten: !sealed, backlog, snapshot };
}

/**
 * Run the job (SPEC B13.1.5). `auto` is the run `sync` makes: it checks the cadence marker first and treats a held stamp lock as
 * "skipped (locked)"; an explicit run always runs and refreshes the marker.
 * @param {StampCtx} c
 * @param {{ auto?: boolean }} [o]
 * @returns {Promise<StampResult>}
 * @throws {Error & { code: 'ERR_STAMP_LOCKED' | 'ERR_TRAIL_LOCKED' | 'ERR_TRAIL_LAYOUT' | 'ERR_STAMP_CHAIN' }}
 */
async function runStamp(c, { auto = false } = {}) {
  const { root, trail } = c;
  if (!c.ots) return result(c, { ran: true });
  if ((await headOf(root)) === null) return result(c, auto ? { ran: false, skipped: 'not due' } : {});   // no trail yet: nothing runs, nothing is written
  if (auto && !isDue(await readMarker(root, trail), c.stamp.everyHours, c.now().getTime())) {
    return result(c, { ran: false, skipped: 'not due', pending: await countPendingStamps(root, trail).catch(() => 0), unstamped: await unstampedCount(root) });
  }
  const ots = c.ots;
  try {
    return await withTrailLock(root, stampLockFile(trail), 0, async () => {
      const scratch = path.join(path.dirname(root), stampScratchDir(trail));
      await fs.rm(scratch, { recursive: true, force: true });
      await fs.mkdir(scratch, { mode: 0o700 });
      try {
        const res = result(c);
        /** @type {string | undefined} */
        let error;
        let backlog = 0;
        let snapshot = '';
        if (c.stamp.mode === 'batch') {
          const b = await batchPhase(c, scratch, res);
          backlog = b.backlog;
          snapshot = b.snapshot;
          if (b.rewritten) { res.skipped = 'rewritten'; res.unsealed = b.backlog; res.pending = await countPendingStamps(root, trail).catch(() => 0); res.unstamped = await unstampedCount(root); return res; }
          error = b.error;
        }
        if (!error) {
          const up = await upgradePass({ root, trail, ots, lockTimeoutMs: c.lockTimeoutMs, scratch, except: res.stamped, hooks: c.hooks });
          res.upgraded = up.upgraded;
          res.pending = up.pending;
          if (up.error) error = up.error;
        } else res.pending = await countPendingStamps(root, trail).catch(() => 0);
        if (error === 'ots not found') error = OTS_MISSING_MESSAGE;   // one plain message (owner decision 2026-11-11); upgradeStamps() keeps the raw code
        if (error) res.error = error;
        res.unsealed = backlog;
        if (snapshot) {
          const head = await headOf(root);
          if (head && head !== snapshot) res.unsealed += await addedSince(root, snapshot, head).catch(() => 0);
        }
        res.unstamped = await unstampedCount(root);
        await writeMarker(root, trail, c.now(), error);
        return res;
      } finally { await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
    }, STAMP_LOCK);
  } catch (e) {
    if (auto && /** @type {{ code?: string }} */ (e)?.code === 'ERR_STAMP_LOCKED') return result(c, { ran: false, skipped: 'locked', pending: await countPendingStamps(root, trail).catch(() => 0) });
    throw e;
  }
}

/** @param {string} root @returns {Promise<number>} Committed manifests without an `.ots`. */
async function unstampedCount(root) {
  if ((await headOf(root)) === null) return 0;
  return (await listManifests(root, 'HEAD')).filter((m) => !m.ots).length;
}

/**
 * The seal line of `status` (SPEC B13.1.12): read-only, takes no lock, runs no `ots`, never computes the unsealed set.
 * @param {{ root: string, trail: string, stamp: StampOptions, enabled: boolean }} c
 * @returns {Promise<{ enabled: boolean, mode: 'batch' | 'record', everyHours: number, last: string | null, nextDue: string | null, error: string | null, manifests: number, unstamped: number, pending: number, chain: 'ok' | { brokenAt: number, why: string } }>}
 */
async function sealStatus({ root, trail, stamp, enabled }) {
  const marker = await readMarker(root, trail);
  const last = marker ? Date.parse(marker.last) : NaN;
  const head = await headOf(root);
  let manifests = 0;
  let unstamped = 0;
  /** @type {'ok' | { brokenAt: number, why: string }} */
  let chain = 'ok';
  if (head !== null && enabled) {
    const c = await readChain(root, head);
    manifests = c.files.length;
    unstamped = c.files.filter((f) => !f.ots).length;
    if (c.broken) chain = { brokenAt: c.broken.seq, why: c.broken.why };
  }
  return {
    enabled, mode: stamp.mode, everyHours: stamp.everyHours,
    last: Number.isFinite(last) ? new Date(last).toISOString() : null,
    nextDue: Number.isFinite(last) ? new Date(last + stamp.everyHours * 3_600_000).toISOString() : null,
    error: marker?.error ?? null, manifests, unstamped, pending: enabled && head !== null ? await countPendingStamps(root, trail) : 0, chain,
  };
}

export { runStamp, sealStatus, parseStampOptions, readMarker, isDue };
