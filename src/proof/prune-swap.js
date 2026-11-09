// The swap half of prune (SPEC B9.4): the journal, the two renames, the sync-cursor repoint and crash recovery.
// Everything here runs under the trail lock. `recoverPrune` is also called by `withTrailLock` (trail.js) on every trail
// lock acquisition when a journal exists, before the caller's work can create a fresh trail in the gap between the
// two renames.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { headOf, pidAlive, pruneJournalFile, serialise } from './trail.js';
import { readCursorFile, writeCursorFile, cursorPath } from './sync.js';
import { contentDirOf, sweepOrphans } from './content.js';
import { PRUNE_JOURNAL_LIVE_MS } from './limits.js';

/**
 * @typedef {Object} Journal
 * @property {1} v
 * @property {'swapping' | 'swapped'} state  `swapping`: the pruned trail is complete beside the live one, the renames are (partly) done. `swapped`: both renames and the cursor repoint are done; the content sweep is pending.
 * @property {number} pid  The pruning process.
 * @property {string} host
 * @property {string} updated  ISO time of the last write.
 * @property {string} backup  File name (in the trail directory) the old trail is renamed to.
 * @property {string} cutoff
 * @property {string} previous_head  HEAD of the old trail when the swap began.
 * @property {string} new_head
 */

/** The name a backup directory can have: what `backupName` (prune.js) builds, so a journal cannot point a rename elsewhere. */
const BACKUP_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.pre-prune-\d{4}-\d{2}-\d{2}(-\d+)?$/;

/** @param {string} p @returns {Promise<boolean>} */
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

/** @param {string} root @returns {{ trailDir: string, trail: string, journal: string, tmp: string, build: string }} */
const pathsOf = (root) => {
  const trailDir = path.dirname(root);
  const trail = path.basename(root);
  return { trailDir, trail, journal: path.join(trailDir, pruneJournalFile(trail)), tmp: `${root}.prune-tmp`, build: `${root}.prune-build` };
};

/**
 * Write a file whole: temp file, fsync, rename (a reader sees the old or the new file, never half), then fsync the directory.
 * @param {string} file @param {string} text @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
  try {
    const d = await fs.open(path.dirname(file), 'r');
    try { await d.sync(); } finally { await d.close(); }
  } catch { /* a filesystem that cannot fsync a directory */ }
}

/**
 * @param {string} root
 * @param {Journal} j
 * @param {'swapping' | 'swapped'} state
 * @returns {Promise<Journal>}
 */
async function writeJournal(root, j, state) {
  const next = { ...j, state, updated: new Date().toISOString() };
  await writeAtomic(pathsOf(root).journal, serialise(next));
  return next;
}

/**
 * Point the sync cursor's `head` at the trail's current HEAD (B4.2): after a prune the old HEAD is not an ancestor of
 * the new one, and without this `sync` would rescan every folder and record the pruned mail again. Idempotent. A
 * missing or unreadable cursor file is left alone (an unreadable one already makes `sync` rescan).
 * @param {string} root
 * @returns {Promise<void>}
 */
async function repointCursor(root) {
  const { trailDir, trail } = pathsOf(root);
  const file = cursorPath(trailDir, trail);
  const cur = await readCursorFile(file);
  const head = await headOf(root);
  if (cur.unreadable || head === null || !(await exists(file))) return;
  if (cur.data.head === head) return;
  await writeCursorFile(file, serialise({ ...cur.data, head }));
}

/**
 * Finish a swap from whatever state a crash left: the renames that remain, then the cursor repoint.
 * @param {string} root
 * @param {string} backup  Absolute path of the backup directory.
 * @param {(name: string) => Promise<void> | void} [point]  Called after each step (tests kill the process here).
 * @returns {Promise<'done' | 'restored' | 'nothing'>}  `restored`: the pruned trail was lost and the old one is back; `nothing`: no pruned trail was ever placed.
 * @throws {Error & { code: 'ERR_PRUNE_JOURNAL' }} for a combination of directories it does not recognise (nothing is changed).
 */
async function rollForward(root, backup, point = () => {}) {
  const { tmp } = pathsOf(root);
  const live = await exists(root);
  const bak = await exists(backup);
  const next = await exists(tmp);
  if (live && !bak && next) { await fs.rename(root, backup); await point('renamed-live'); await fs.rename(tmp, root); }
  else if (!live && bak && next) await fs.rename(tmp, root);
  else if (live && bak && !next) { /* both renames were done */ }
  else if (!live && bak && !next) { await fs.rename(backup, root); return 'restored'; }
  else if (live && !bak && !next) return 'nothing';
  else throw Object.assign(new Error(`prune: unrecognised state of ${root} (live ${live}, backup ${bak}, new ${next}); left untouched, see ${pathsOf(root).journal}`), { code: 'ERR_PRUNE_JOURNAL' });
  await point('renamed-tmp');
  await repointCursor(root);
  await point('cursor');
  return 'done';
}

/**
 * Finish or roll back an unfinished prune swap. Called with the trail lock held. A journal whose owner is a live
 * process on this host (and recent) is left to it: the prune is still working.
 * @param {string} root
 * @returns {Promise<string>}  What it did (for tests and logs).
 * @throws {Error & { code: 'ERR_PRUNE_JOURNAL' }} when the journal cannot be read or the directories are in a state it does not recognise.
 */
async function recoverPrune(root) {
  const p = pathsOf(root);
  /** @type {Journal} */
  let j;
  try { j = JSON.parse(await fs.readFile(p.journal, 'utf8')); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return 'no journal';
    throw Object.assign(new Error(`prune: the journal ${p.journal} cannot be read; the trail may be half swapped. Check ${p.trailDir} for <trail>.prune-tmp and <trail>.pre-prune-*`), { code: 'ERR_PRUNE_JOURNAL' });
  }
  if (j.v !== 1 || typeof j.backup !== 'string' || !BACKUP_RE.test(j.backup) || (j.state !== 'swapping' && j.state !== 'swapped')) {
    throw Object.assign(new Error(`prune: the journal ${p.journal} is not one this version wrote`), { code: 'ERR_PRUNE_JOURNAL' });
  }
  const age = Date.now() - Date.parse(j.updated);
  if (j.host === os.hostname() && Number.isInteger(j.pid) && pidAlive(j.pid) && age < PRUNE_JOURNAL_LIVE_MS) return 'owner alive';
  let did = 'rolled forward';
  if (j.state === 'swapping') {
    const r = await rollForward(root, path.join(p.trailDir, j.backup));
    if (r !== 'done') { await fs.rm(p.journal, { force: true }); await fs.rm(p.tmp, { recursive: true, force: true }); return r === 'restored' ? 'rolled back: the old trail restored' : 'journal dropped: nothing was swapped'; }
  } else {
    await repointCursor(root);
    did = 'finished the post-swap steps';
  }
  await sweepOrphans(root, contentDirOf(root), (w) => w());   // already inside the trail lock
  await fs.rm(p.journal, { force: true });
  return did;
}

export { pathsOf, writeJournal, rollForward, repointCursor, recoverPrune, writeAtomic };
