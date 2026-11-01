// Building the signature half of a record from a message's header rows. Pure:
// the (async) key lookup and verdicts are composed around this by the Mailproof
// class, so this is testable with a plain key object.

import { dkimBody } from 'mailauth/lib/dkim/body';
import { parseTags, canonPair, selectSigned, H_TOO_LONG } from './signed-headers.js';
import { analyseBody } from './body-status.js';

/** @typedef {import('./types.js').RecordSignature} RecordSignature */
/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

/** @param {string | Buffer} s */
const b64 = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'binary')).toString('base64');

/**
 * Length of the body after the signature's body canonicalization.
 * @param {Buffer} body
 * @param {string} canon  `simple` or `relaxed`
 * @returns {number}
 */
function canonicalBodyLength(body, canon) {
  const h = dkimBody(canon, 'sha256', false);
  h.update(body);
  h.digest('base64');
  return /** @type {any} */ (h).canonicalizedLength;
}

/**
 * Build one stored signature entry: the raw DKIM-Signature line, the exact
 * header lines it covers (hashing order), and the key it was checked with.
 * `partial_body` is the `l=` flag: an `l=` shorter than the canonical body
 * leaves the tail of the body unsigned.
 * @param {HeaderRow[]} rows
 * @param {HeaderRow} sigRow
 * @param {Buffer} body
 * @param {{ key: { k: string, p: string } | null, key_error?: string | null, key_file?: string | null }} keyInfo
 * @param {{ arc?: string | null }} [ctx]  `arc`: the ARC chain result at capture (a body-status context hint).
 * @returns {RecordSignature}
 */
function buildSignatureEntry(rows, sigRow, body, keyInfo, ctx = {}) {
  const t = parseTags(sigRow.raw);
  const l = t.l !== undefined && t.l !== '' ? Number(t.l) : null;
  const partial = l !== null && Number.isFinite(l) && l < canonicalBodyLength(body, canonPair(t.c).b);
  return {
    dkim_signature: b64(sigRow.raw),
    tags: {
      d: t.d ?? null, s: t.s ?? null, a: t.a ?? null, c: t.c || 'simple/simple', h: t.h ?? null,
      bh: t.bh ?? null, l: t.l ?? null, t: t.t ?? null, x: t.x ?? null,
    },
    signed_headers: selectSigned(rows, t.h || '').map((r) => b64(r)),
    key: keyInfo.key,
    key_error: keyInfo.key_error ?? null,
    key_file: keyInfo.key_file ?? null,
    partial_body: partial,
    body: analyseBody(t, body, { rows, arc: ctx.arc }),
  };
}

/**
 * The entry for a signature that is NOT evaluated because its `h=` lists more than `MAX_H_NAMES`
 * names: the raw line is kept, no key is fetched, nothing is verified or hashed. It can never
 * verify (`key` is null; `verifyRecord` reports `why: 'h= too long'`).
 * @param {HeaderRow} sigRow
 * @returns {RecordSignature}
 */
function buildRejectedSignatureEntry(sigRow) {
  const t = parseTags(sigRow.raw);
  return {
    dkim_signature: b64(sigRow.raw),
    tags: { d: t.d ?? null, s: t.s ?? null, a: t.a ?? null, c: t.c || 'simple/simple', h: null, bh: t.bh ?? null, l: t.l ?? null, t: t.t ?? null, x: t.x ?? null },
    signed_headers: [],
    key: null,
    key_error: H_TOO_LONG,
    key_file: null,
    partial_body: false,
    body: { status: 'not-checked', explain: [] },
  };
}

export { buildSignatureEntry, buildRejectedSignatureEntry, canonicalBodyLength };
