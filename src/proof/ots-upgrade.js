// OpenTimestamps upgrade of the proofs already in a trail (Mailproof#upgradeStamps, and step 6 of the stamp job, SPEC B13.1.5/8).
// A proof is committed calendar-pending (`ots stamp`); `ots upgrade` folds in the Bitcoin attestation hours later. The proofs are
// the manifests' (`manifests/<seq>.json.ots`) and, for a 3.3.0 trail or `record` mode, the per-record ones
// (`records/<2hex>/<id>.json.ots`). Each proof is upgraded one at a time: its committed bytes are copied to the job's scratch
// directory, `ots upgrade` runs on the COPY with no lock held (the network call), and only a proof that changed takes the short
// trail lock: confirm the committed bytes are still the ones copied, replace the file, commit. The trail lock is never held
// over a network call.
//
// "Anchored" is remembered in a sidecar beside the trail, not in git: `<trailDir>/.<trail>.ots-state.json`
// `{ "v": 1, "anchored": [record ids], "manifests": [seq numbers] }`. It is a cache: a lost or stale file only means every proof
// is asked once more. (`manifests` is additive: an older reader ignores it.)

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { git, gitLines } from './git.js';
import { withTrailLock, trailLockFile, stampLockFile, stampScratchDir, STAMP_LOCK, headOf, clearLeftovers } from './trail.js';
import { parseRecordPath, parseManifestPath, recordOtsPath, manifestOtsPath, assertTrailLayout } from './layout.js';
import { STAMP_JOB_MAX_MS } from './limits.js';

/**
 * @typedef {Object} StampUpgrade
 * @property {boolean} enabled  False when the instance has no `otsBin`: nothing was done.
 * @property {number} upgraded  Proofs rewritten with the Bitcoin attestation (and committed) in this call.
 * @property {number} pending  Proofs still not anchored after the call (those not reached because of `error` included).
 * @property {string} [error]  The `ots` binary itself failed (`ots not found`, `ots timeout`, ...): the pass stopped there.
 */

/** @typedef {{ records: Set<string>, manifests: Set<number> }} Anchored */

/** @param {string} root @param {string} trail @returns {string} */
const stateFile = (root, trail) => path.join(path.dirname(root), `.${trail}.ots-state.json`);

/**
 * @param {string} root
 * @param {string} trail
 * @returns {Promise<Anchored>}  What is remembered as anchored; empty for a missing or unreadable file.
 */
async function readAnchored(root, trail) {
  try {
    const j = JSON.parse(await fs.readFile(stateFile(root, trail), 'utf8'));
    return {
      records: new Set(Array.isArray(j?.anchored) ? j.anchored.filter((/** @type {unknown} */ x) => typeof x === 'string') : []),
      manifests: new Set(Array.isArray(j?.manifests) ? j.manifests.filter((/** @type {unknown} */ x) => Number.isInteger(x)) : []),
    };
  } catch { return { records: new Set(), manifests: new Set() }; }
}

/**
 * @param {string} root
 * @param {string} trail
 * @param {Anchored} anchored
 * @returns {Promise<void>}  Atomic (temp file, then rename); a failure only means the next call asks again.
 */
async function writeAnchored(root, trail, anchored) {
  const file = stateFile(root, trail);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ v: 1, anchored: [...anchored.records].sort(), manifests: [...anchored.manifests].sort((a, b) => a - b) }) + '\n');
    await fs.rename(tmp, file);
  } catch { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

/**
 * The proofs committed at HEAD.
 * @param {string} root
 * @returns {Promise<{ manifests: number[], records: string[] }>}  Both sorted.
 */
async function proofsAtHead(root) {
  /** @type {number[]} */
  const manifests = [];
  /** @type {string[]} */
  const records = [];
  if ((await headOf(root)) === null) return { manifests, records };
  await gitLines(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'records', 'manifests'], (p) => {
    const r = parseRecordPath(p);
    if (r) { if (r.ots) records.push(r.id); return; }
    const m = parseManifestPath(p);
    if (m && m.ots) manifests.push(m.seq);
  }, { sep: '\0' });
  return { manifests: manifests.sort((a, b) => a - b), records: records.sort() };
}

/**
 * How many committed proofs (manifests' and per-record) are not yet known to be anchored. Read-only, no lock, no `ots`.
 * @param {string} root
 * @param {string} trail
 * @returns {Promise<number>}
 */
async function countPendingStamps(root, trail) {
  const anchored = await readAnchored(root, trail);
  const p = await proofsAtHead(root);
  return p.manifests.filter((s) => !anchored.manifests.has(s)).length + p.records.filter((id) => !anchored.records.has(id)).length;
}

/**
 * @typedef {Object} PassCtx
 * @property {string} root
 * @property {string} trail
 * @property {ReturnType<typeof import('./ots.js').createOts>} ots
 * @property {number} lockTimeoutMs
 * @property {string} scratch  The job's scratch directory (exists, empty or not).
 * @property {number | null} [except]  A manifest seq not to ask about (just stamped), still counted pending.
 * @property {{ clock?: () => number, jobMaxMs?: number, beforeUpgrade?: (rel: string) => Promise<void> | void, afterOtsUpgrade?: (rel: string) => Promise<void> | void }} [hooks]  Test seams.
 */

/**
 * The upgrade pass (SPEC B13.1.5 step 6): every committed proof not known to be anchored, manifests first (oldest first), then
 * per-record proofs, one at a time. Stops at the first `ots` error or after STAMP_JOB_MAX_MS. The caller holds the stamp lock.
 * @param {PassCtx} c
 * @returns {Promise<StampUpgrade>}
 */
async function upgradePass({ root, trail, ots, lockTimeoutMs, scratch, except = null, hooks = {} }) {
  await assertTrailLayout(root);
  const anchored = await readAnchored(root, trail);
  const proofs = await proofsAtHead(root);
  /** @type {Array<{ rel: string, name: string, done: () => void }>} */
  const todo = [
    ...proofs.manifests.filter((s) => !anchored.manifests.has(s)).map((s) => ({ rel: manifestOtsPath(s), name: `m${s}.json.ots`, done: () => { anchored.manifests.add(s); } })),
    ...proofs.records.filter((id) => !anchored.records.has(id)).map((id) => ({ rel: recordOtsPath(id), name: `r${id}.json.ots`, done: () => { anchored.records.add(id); } })),
  ];
  const clock = hooks.clock ?? Date.now;
  const jobMax = hooks.jobMaxMs ?? STAMP_JOB_MAX_MS;
  const skipRel = except === null ? null : manifestOtsPath(except);
  const started = clock();
  let upgraded = 0;
  /** @type {string | undefined} */
  let error;
  try {
    for (const t of todo) {
      if (t.rel === skipRel) continue;
      if (clock() - started >= jobMax) break;
      const orig = await committedBytes(root, t.rel);
      if (!orig) continue;   // removed meanwhile (a prune): nothing to ask about
      const copy = path.join(scratch, t.name);
      await fs.writeFile(copy, orig);
      await hooks.beforeUpgrade?.(t.rel);
      const r = await ots.upgradeProof(copy);
      await hooks.afterOtsUpgrade?.(t.rel);
      if (r.error) { error = r.error; break; }
      if (r.changed) {
        const bytes = await fs.readFile(copy);
        const did = await withTrailLock(root, trailLockFile(trail), lockTimeoutMs, async () => {
          await assertTrailLayout(root);
          await clearLeftovers(root);
          const now = await committedBytes(root, t.rel);
          if (!now || !now.equals(orig)) return false;   // someone else upgraded it (or a prune removed it): skip
          const abs = path.join(root, t.rel);
          await fs.writeFile(abs, bytes);
          await fs.rm(`${abs}.bak`, { force: true });
          const label = parseManifestPath(t.rel.replace(/\.ots$/, ''));
          try {
            await git(root, ['add', '--', t.rel]);
            await git(root, ['commit', '-q', '-m', label ? `ots upgrade manifest ${label.seq}` : `ots upgrade ${(parseRecordPath(t.rel.replace(/\.ots$/, ''))?.id ?? '').slice(0, 12)}`]);
          } catch (e) {
            try { await git(root, ['reset', '-q']); await git(root, ['checkout', '-q', 'HEAD', '--', t.rel]); } catch { /* the next write clears leftovers */ }
            throw e;
          }
          return true;
        });
        if (did) upgraded++;
      }
      if (r.anchored) t.done();
    }
  } finally { await writeAnchored(root, trail, anchored); }
  const left = await proofsAtHead(root);
  const pending = left.manifests.filter((s) => !anchored.manifests.has(s)).length + left.records.filter((id) => !anchored.records.has(id)).length;
  return { enabled: true, upgraded, pending, ...(error ? { error } : {}) };
}

/**
 * The bytes of `rel` as committed at HEAD, or null when it is not there.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<Buffer | null>}
 */
async function committedBytes(root, rel) {
  return new Promise((resolve) => {
    execFile('git', ['cat-file', 'blob', `HEAD:${rel}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * `Mailproof#upgradeStamps`: the upgrade pass on its own, under the stamp lock (fail-fast, so it cannot interleave with a job).
 * @param {Object} a
 * @param {string} a.root
 * @param {string} a.trail
 * @param {ReturnType<typeof import('./ots.js').createOts> | null} a.ots
 * @param {number} a.lockTimeoutMs
 * @param {PassCtx['hooks']} [a.hooks]
 * @returns {Promise<StampUpgrade>}
 */
async function runUpgradeStamps({ root, trail, ots, lockTimeoutMs, hooks }) {
  if (!ots) return { enabled: false, upgraded: 0, pending: 0 };
  await assertTrailLayout(root);
  if ((await headOf(root)) === null) return { enabled: true, upgraded: 0, pending: 0 };
  return withTrailLock(root, stampLockFile(trail), 0, async () => {
    const scratch = path.join(path.dirname(root), stampScratchDir(trail));
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.mkdir(scratch, { mode: 0o700 });
    try { return await upgradePass({ root, trail, ots, lockTimeoutMs, scratch, hooks }); }
    finally { await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }, STAMP_LOCK);
}

export { runUpgradeStamps, upgradePass, countPendingStamps, proofsAtHead, readAnchored, committedBytes };
