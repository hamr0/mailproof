// Address-first targets for `show` and `verify` (SPEC B11.5a): the CLI's wording of the library's one resolver
// (`src/proof/target.js`, shared with `describe` and `verifyWith`), plus the one-line facts of a record that `show` JSON rows carry.

import { UsageError } from './errors.js';
import { parseAddress } from './parse.js';
import { classifyTarget as classify, otherParty, TARGET_FORMS } from '../proof/target.js';
import { participantsOf, signedHeaderValue } from '../proof/participants.js';
import { headerText } from '../proof/header-text.js';

export { otherParty };

/** @typedef {import('../proof/types.js').MpRecord} MpRecord */
/** @typedef {import('../proof/target.js').Target} Target */

export const ID_HINT = 'ids are positional: mailproof show ea1fda2a (8+ characters), or use an address: mailproof show b@example.com';

/**
 * Classify a `show`/`verify` argument by shape (the library's resolver); a refusal is a usage error that names the three forms.
 * @param {string} s
 * @returns {Target}
 */
export function classifyTarget(s) {
  try { return classify(s); } catch (e) {
    const err = /** @type {{ code?: string, reason?: string, message: string }} */ (e);
    if (err.code !== 'ERR_TARGET') throw e;
    if (err.reason === 'address') parseAddress(s.trim(), 'target');   // throws the CLI's own words
    if (err.reason === 'flag') throw new UsageError(`"${s}" looks like a flag. ${ID_HINT}`);
    if (err.reason === 'short') throw new UsageError(`"${s}" is too short for a record id (8 or more hex characters). ${ID_HINT}`);
    if (err.reason === 'shape') throw new UsageError(`"${s}" is not something mailproof can look up. Give ${TARGET_FORMS}.`);
    throw new UsageError(err.message);
  }
}

/**
 * What a text line needs from one record: the other party (From of a received email, first To of a sent one), the signed
 * subject (an unsigned record keeps no subject: SPEC B1), attachments, trust. Never throws on a malformed record.
 * @param {MpRecord} rec
 * @returns {{ id: string, captured: string, direction: string, live: string, portable: string, other: string | null, subject: string | null, body: string, attachments: number }}
 */
export function factsOfRecord(rec) {
  const other = otherParty(rec.direction, participantsOf(rec));
  const subject = signedHeaderValue(rec, 'subject');
  return {
    id: rec.id, captured: rec.captured, direction: rec.direction,
    live: rec.verdicts?.live?.trust ?? '-', portable: rec.verdicts?.portable?.trust ?? '-',
    other, subject: subject === null ? null : headerText(subject),
    body: rec.body_status ?? '-', attachments: Array.isArray(rec.attachments) ? rec.attachments.length : 0,
  };
}

/** @param {string} iso @returns {string} `2026-11-01T08:00Z`. */
export const minute = (iso) => `${iso.slice(0, 16)}Z`;
