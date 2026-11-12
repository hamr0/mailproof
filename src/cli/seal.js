// The `seal` line of `show` (SPEC B13.1.12): text for the library's seal facts (`describe`, `FactsSeal`), shared by the one-record and
// the by-person views. The facts are read in the library (`src/proof/describe.js`); this only words them.

import { printable as p } from './printable.js';

/**
 * @param {import('../proof/describe.js').FactsSeal} seal
 * @returns {string}
 */
export function sealText(seal) {
  switch (seal.state) {
    case 'unsealed': return 'unsealed';
    case 'own-stamp': return `own stamp ${p(String(seal.stamp))}`;
    case 'not-stamped': return `manifest ${seal.manifest}, not stamped yet`;
    default: return `manifest ${seal.manifest}, stamped by manifest ${seal.stamped_by} (${seal.anchored ? `anchored${seal.block ? `, block ${seal.block}` : ''}` : 'pending'})`;
  }
}
