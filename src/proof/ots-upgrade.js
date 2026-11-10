// OpenTimestamps upgrade of the stamps already in a trail (Mailproof#upgradeStamps). `record()` writes a calendar-pending
// stamp beside each record (`records/<id[0:2]>/<id>.json.ots`); `ots upgrade` folds in the Bitcoin attestation hours later.
// This module finds the stamps not yet known to be anchored, upgrades each under the trail lock (one lock window per
// stamp, so writers wait for one `ots` run at most, never for the whole pass) and commits a changed proof as its own commit.
//
// "Anchored" is remembered in a sidecar beside the trail, not in git: `<trailDir>/.<trail>.ots-state.json`
// `{ "v": 1, "anchored": [ids] }`. It is a cache: a lost or stale file only means every stamp is asked once more.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitLines } from './git.js';
import { withTrailLock, trailLockFile, headOf } from './trail.js';
import { parseRecordPath, recordOtsPath, assertTrailLayout } from './layout.js';

/**
 * @typedef {Object} StampUpgrade
 * @property {boolean} enabled  False when the instance has no `otsBin`: nothing was done.
 * @property {number} upgraded  Stamps whose proof was rewritten with the Bitcoin attestation (and committed) in this call.
 * @property {number} pending  Stamps still not anchored after the call (those not reached because of `error` included).
 * @property {string} [error]  The `ots` binary itself failed (`ots not found`, `ots timeout`, ...): the pass stopped there.
 */

/** @param {string} root @param {string} trail @returns {string} */
const stateFile = (root, trail) => path.join(path.dirname(root), `.${trail}.ots-state.json`);

/**
 * @param {string} root
 * @param {string} trail
 * @returns {Promise<Set<string>>}  Ids remembered as anchored; empty for a missing or unreadable file.
 */
async function readAnchored(root, trail) {
  try {
    const j = JSON.parse(await fs.readFile(stateFile(root, trail), 'utf8'));
    return new Set(Array.isArray(j?.anchored) ? j.anchored.filter((/** @type {unknown} */ x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/**
 * @param {string} root
 * @param {string} trail
 * @param {Set<string>} anchored
 * @returns {Promise<void>}  Atomic (temp file, then rename); a failure only means the next call asks again.
 */
async function writeAnchored(root, trail, anchored) {
  const file = stateFile(root, trail);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ v: 1, anchored: [...anchored].sort() }) + '\n');
    await fs.rename(tmp, file);
  } catch { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

/**
 * Ids of the stamps committed at HEAD.
 * @param {string} root
 * @returns {Promise<string[]>}  Sorted.
 */
async function stampIds(root) {
  if ((await headOf(root)) === null) return [];
  /** @type {string[]} */
  const ids = [];
  await gitLines(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'records'], (p) => { const r = parseRecordPath(p); if (r && r.ots) ids.push(r.id); }, { sep: '\0' });
  return ids.sort();
}

/**
 * How many committed stamps are not yet known to be anchored. Read-only, no lock, no `ots`.
 * @param {string} root
 * @param {string} trail
 * @returns {Promise<number>}
 */
async function countPendingStamps(root, trail) {
  const anchored = await readAnchored(root, trail);
  return (await stampIds(root)).filter((id) => !anchored.has(id)).length;
}

/**
 * @param {Object} a
 * @param {string} a.root
 * @param {string} a.trail
 * @param {ReturnType<typeof import('./ots.js').createOts> | null} a.ots
 * @param {number} a.lockTimeoutMs
 * @returns {Promise<StampUpgrade>}
 */
async function runUpgradeStamps({ root, trail, ots, lockTimeoutMs }) {
  if (!ots) return { enabled: false, upgraded: 0, pending: 0 };
  await assertTrailLayout(root);
  const anchored = await readAnchored(root, trail);
  const todo = (await stampIds(root)).filter((id) => !anchored.has(id));
  let upgraded = 0;
  /** @type {string | undefined} */
  let error;
  for (const id of todo) {
    const rel = recordOtsPath(id);
    const res = await withTrailLock(root, trailLockFile(trail), lockTimeoutMs, async () => {
      const abs = path.join(root, rel);
      const r = await ots.upgradeProof(abs);
      await fs.rm(`${abs}.bak`, { force: true });   // `ots upgrade` leaves the old proof beside the new one
      if (r.changed) {
        try {
          await git(root, ['add', '--', rel]);
          await git(root, ['commit', '-q', '-m', `ots upgrade ${id.slice(0, 12)}`]);
        } catch (e) {
          try { await git(root, ['reset', '-q']); await git(root, ['checkout', '-q', 'HEAD', '--', rel]); } catch { /* the next write clears leftovers */ }
          throw e;
        }
      }
      return r;
    });
    if (res.error) { error = res.error; break; }   // the binary is missing or hung: asking for every other stamp would fail the same way
    if (res.changed) upgraded++;
    if (res.anchored) anchored.add(id);
  }
  await writeAnchored(root, trail, anchored);
  const pending = todo.filter((id) => !anchored.has(id)).length;
  return { enabled: true, upgraded, pending, ...(error ? { error } : {}) };
}

export { runUpgradeStamps, countPendingStamps };
