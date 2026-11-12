// `explain` (SPEC B8.5): why a record is not verified, in plain words, from what was recorded (no DNS). ONE definition: the
// `why` of `describe`, of `verifyWith` rows and of the CLI's `show` and `verify`.

import { verifyRecord } from './recheck.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */

/**
 * Why a record is not verified, in plain words, from the recorded DKIM/DMARC/ARC results, the recorded key-lookup errors and
 * the offline re-check. A recorded DNS error is stated as the fact; the hedged "typically no public key" inference appears only
 * for a neutral or none result with no recorded lookup error. Null when the record verifies live and on re-check. The words
 * are built from untrusted email data (domains, selectors, DNS text): treat the sentence as data.
 * @param {MpRecord} rec
 * @param {{ ok: boolean, signatures: Array<Record<string, any>> }} [v]  The offline re-check to use (default: `verifyRecord(rec)`; pass the one you already have, e.g. an `at` re-check).
 * @returns {string | null}
 */
export function explain(rec, v = verifyRecord(rec)) {
  const live = /** @type {Record<string, any> | undefined} */ (rec.verdicts?.live);
  if (live?.trust === 'verified' && v.ok) return null;
  /** @type {string[]} */
  const why = [];
  const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
  if (!sigs.length) why.push('there is no DKIM signature on this email');
  /** Signatures with a recorded key-lookup error: that error is the fact, so the hedged inference is left out for them. */
  const lookup = new Map(sigs.filter((s) => s.key_error).map((s) => [`${s.tags?.d}\0${s.tags?.s}`, String(s.key_error)]));
  for (const d of Array.isArray(live?.dkim) ? live.dkim : []) {
    if (!d.d && !d.s) continue;   // mailauth's placeholder for "no signature"
    const where = `${d.s ?? '?'}._domainkey.${d.d ?? '?'}`;
    if (d.result !== 'pass') why.push(`DKIM ${d.result}${lookup.has(`${d.d}\0${d.s}`) ? '' : d.result === 'neutral' || d.result === 'none' ? ` (typically no public key is published at ${where})` : ` for ${where}`}`);
    else if (!d.aligned) why.push(`DKIM passed for ${d.d} but that is not the From domain (not aligned)`);
  }
  for (const s of sigs) {
    if (!s.key_error) continue;
    const where = `${s.tags?.s ?? '?'}._domainkey.${s.tags?.d ?? '?'}`;
    const err = String(s.key_error);
    why.push(/ENODATA|ENOTFOUND|NXDOMAIN|no record|no key/i.test(err) ? `no public key published at ${where} at capture (DNS: ${err})` : `the public key at ${where} could not be fetched at capture (DNS: ${err})`);
  }
  if (live?.dmarc?.published && live.dmarc.result !== 'pass') why.push(`DMARC ${live.dmarc.result} (policy ${live.dmarc.policy ?? 'none'})`);
  if (live?.arc && live.arc.result !== 'pass') why.push(`ARC ${live.arc.result}`);
  if (!v.ok) for (const s of v.signatures) if (!s.ok) why.push(`offline re-check of ${s.d ?? '?'}: ${s.why ?? s.reason ?? 'does not verify'}`);
  if (!why.length) why.push(`live verdict ${live?.trust ?? 'N/A'}, portable ${rec.verdicts?.portable?.trust ?? 'N/A'}`);
  return why.join('; ');
}
