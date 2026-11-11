// The `sealed:` line of `show` (SPEC B13.1.12), shared by the one-record and the by-person views.

import path from 'node:path';
import { readAnchored } from '../proof/ots-upgrade.js';
import { manifestOtsPath } from '../proof/layout.js';
import { printable as p } from './printable.js';

/**
 * The `sealed:` line of `show` (SPEC B13.1.12), from `findSeal`: read-only, no lock; `ots info` (local) only for the block number.
 * @param {import('./session.js').Session['mp']} mp @param {string} id
 * @returns {Promise<{ text: string | null, data: unknown }>}  text null: the seal is off for this account.
 */
export async function sealLine(mp, id) {
  if (!mp.otsBin) return { text: null, data: null };
  const seal = await mp._findSeal(id).catch(() => null);
  if (!seal) return { text: 'unsealed', data: null };
  if (seal.via === 'record') return { text: `own stamp ${p(seal.stamp)}`, data: seal };
  if (!seal.stamp) return { text: `manifest ${seal.seq}, not stamped yet`, data: seal };
  const anchored = (await readAnchored(mp.root, mp.trail)).manifests.has(seal.stamp.seq);
  let block = null;
  if (anchored && mp.jobOts) block = await mp.jobOts.readBlockHeight(path.join(mp.root, manifestOtsPath(seal.stamp.seq))).catch(() => null);
  return { text: `manifest ${seal.seq}, stamped by manifest ${seal.stamp.seq} (${anchored ? `anchored${block ? `, block ${block}` : ''}` : 'pending'})`, data: { ...seal, anchored, block } };
}
