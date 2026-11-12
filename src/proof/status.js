// `Mailproof#status` (SPEC B5.4, B11.5): what a trail holds and how it is kept. Read-only: no lock, no index build or catch-up,
// no network, no `ots`. The account-level facts (last sync, last backup, a running watch, the config, the installed version)
// are not here: they live in the CLI's state file and config, and `src/cli/status.js` adds them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { headOf, trailIndexFile } from './trail.js';
import { countPendingStamps } from './ots-upgrade.js';
import { sealStatus } from './stamp.js';
import { indexOverview } from './index-db.js';

/**
 * @typedef {Object} TrailStatus
 * @property {string} trail  The trail directory (absolute).
 * @property {null | { error: string } | { total: number, totalSource: 'index' | 'git', in: number | null, out: number | null, oldest: string | null, newest: string | null, verified: number | null, unverified: number | null }} records  Null: no trail yet. `totalSource: 'git'` (the index is not current): `in`, `out`, `oldest`, `newest`, `verified`, `unverified` are null. `{ error }`: the index overview failed.
 * @property {'off' | { files: number, bytes: number }} content  `'off'` when the content store is turned off.
 * @property {'absent' | 'present' | 'stale' | 'unreadable' | 'unknown'} index
 * @property {number | null} pendingStamps  Proofs not yet anchored; null with the seal off or no trail.
 * @property {Awaited<ReturnType<typeof sealStatus>> | null} seal
 */

/** @param {string} dir @returns {Promise<{ files: number, bytes: number }>} */
async function sizeOf(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = await sizeOf(p); files += s.files; bytes += s.bytes; }
    else if (e.isFile()) { files++; bytes += (await fs.stat(p)).size; }
  }
  return { files, bytes };
}

/**
 * @param {{ root: string, trail: string, contentDir: string, contentStore: boolean, lockTimeoutMs: number, otsBin: string | null, stamp: import('./stamp.js').StampOptions }} c
 * @returns {Promise<TrailStatus>}
 */
export async function runStatus(c) {
  const head = await headOf(c.root).catch(() => null);
  /** @type {import('./index-db.js').IndexOverview | null} */
  let ov = null;
  /** @type {TrailStatus['records']} */
  let records = null;
  if (head !== null) {
    try { ov = await indexOverview({ root: c.root, trail: c.trail, lockTimeoutMs: c.lockTimeoutMs }, path.join(path.dirname(c.root), trailIndexFile(c.trail))); } catch (e) { records = { error: String(/** @type {any} */ (e)?.code ?? 'error') }; }
  }
  // in/out/oldest/newest are null while the index is not current: counting then needs a read that rebuilds it (`list`).
  if (ov) records = { total: ov.total, totalSource: ov.totalSource, in: ov.in, out: ov.out, oldest: ov.oldest, newest: ov.newest, verified: ov.verified, unverified: ov.unverified };
  /** @type {TrailStatus['content']} */
  let content = 'off';
  if (c.contentStore) {
    try { content = await sizeOf(c.contentDir); } catch { content = { files: 0, bytes: 0 }; }
  }
  const enabled = c.otsBin !== null;
  return {
    trail: c.root,
    records,
    content,
    index: ov ? ov.state : head === null ? 'absent' : 'unknown',
    pendingStamps: enabled && head !== null ? await countPendingStamps(c.root, c.trail) : null,
    seal: await sealStatus({ root: c.root, trail: c.trail, stamp: c.stamp, enabled }).catch(() => null),
  };
}
