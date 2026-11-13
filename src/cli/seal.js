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

/** `11-11 21:03Z` (the year only when it is not this one): the short time of the seal phrase. @param {string} iso @param {Date} now @returns {string} */
const when = (iso, now) => `${iso.slice(iso.slice(0, 4) === String(now.getUTCFullYear()) ? 5 : 0, 10)} ${iso.slice(11, 16)}Z`;

/**
 * The one phrase for a seal, on every screen (show, verify-bundle, ...): when it was sealed (the stamping manifest's own time, local data: no
 * lookup of the block's time) and where the Bitcoin anchor stands, e.g. `sealed 11-11 21:03Z · anchored (Bitcoin block 975469)` or
 * `sealed 11-11 21:03Z · anchor pending`. Takes the facts of the library (`describe`) or of a bundle check (`verifyBundle`).
 * @param {{ state: string, sealed_at?: string | null, block?: number | null, anchored?: boolean }} seal
 * @param {Date} [now]
 * @param {string} [dot]  The separator (the style's `sym.dot`).
 * @param {string | null} [nextDue]  When the next seal run is due (ISO, the library's seal status), when known: a record still waiting says when (`waiting to be sealed (next 14:03Z)`); a time already past is left out.
 * @param {boolean} [received]  The record is in a bundle someone else made: an unsealed one reads `not sealed` (there is no seal run to wait for), never `waiting to be sealed`.
 * @returns {string}
 */
export function sealPhrase(seal, now = new Date(), dot = '·', nextDue = null, received = false) {
  const at = typeof seal.sealed_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(seal.sealed_at) ? `sealed ${when(seal.sealed_at, now)}` : 'sealed';
  const block = typeof seal.block === 'number' && seal.block > 0 ? ` (Bitcoin block ${seal.block})` : '';
  const due = typeof nextDue === 'string' ? Date.parse(nextDue) : NaN;
  const waiting = Number.isFinite(due) && due > now.getTime() ? `waiting to be sealed (next ${new Date(due).toISOString().slice(0, 10) === now.toISOString().slice(0, 10) ? `${new Date(due).toISOString().slice(11, 16)}Z` : when(new Date(due).toISOString(), now)})` : 'waiting to be sealed';
  switch (seal.state) {
    case 'unsealed': case 'not-stamped': case 'unstamped': return received ? 'not sealed' : waiting;
    case 'own-stamp': return 'sealed by its own stamp';
    case 'anchored': return `${at} ${dot} anchored${block}`;
    case 'pending': return `${at} ${dot} anchor pending`;
    case 'unchecked': return `${at} ${dot} anchor not checked`;
    case 'bad': return 'seal does not match';
    default: return p(seal.state);
  }
}
