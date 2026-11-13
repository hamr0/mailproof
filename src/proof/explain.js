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

/** Longest short reason, in characters. */
const SHORT_MAX = 40;

/** The first clause of a long why, cut at a word so it is at most SHORT_MAX characters. @param {string} why @returns {string} */
function firstClause(why) {
  const clause = (why.split(/;| \(/)[0] ?? '').trim();
  if (clause.length <= SHORT_MAX) return clause;
  const cut = clause.slice(0, SHORT_MAX + 1);
  const at = cut.lastIndexOf(' ');
  return (at > 0 ? cut.slice(0, at) : clause.slice(0, SHORT_MAX)).replace(/[\s,:.]+$/, '');
}

/** The short plain words for one failed offline re-check (`verifyRecord` signature `why`). @param {string} why @returns {string} */
function recheckShort(why) {
  if (why === 'bad signature') return 'signature fails';
  if (why === 'expired') return 'key expired (x=)';
  if (why === 'timestamp in future') return 'signature dated in the future';
  if (why === 'no archived key') return 'no DKIM key archived';
  if (why === 'h= too long') return 'signed headers too long';
  if (why.startsWith('unsupported a=')) return 'unsupported algorithm';
  if (why === 'no usable capture time') return 'no usable capture time';
  if (why === 'malformed signature entry') return 'malformed signature';
  if (why.startsWith('error:')) return 'signature check error';
  return firstClause(why);
}

/**
 * The reason in a few plain words, at most 40 characters, for a list row: `verifies`, `no DKIM signature`, `no DKIM key in DNS`,
 * `signature fails`, `body changed after signing`, `key expired (x=)`, `DMARC fails`, `over limit: size`, ... ONE definition, next to
 * `explain` and derived from the same recorded verdicts and re-check; `explain` stays the full sentence. An unknown cause falls back to
 * the first clause of the long sentence, cut at a word.
 * @param {MpRecord} rec
 * @param {{ ok: boolean, signatures: Array<Record<string, any>> }} [v]  The offline re-check to use (default: `verifyRecord(rec)`).
 * @returns {string}
 */
export function shortReason(rec, v = verifyRecord(rec)) {
  const long = explain(rec, v);
  if (long === null) return 'verifies';
  const live = /** @type {Record<string, any> | undefined} */ (rec.verdicts?.live);
  const over = [live?.reason, rec.verdicts?.portable?.reason].find((r) => typeof r === 'string' && r.startsWith('over limit: '));
  if (over) return over.length <= SHORT_MAX ? over : firstClause(over);
  const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
  if (!sigs.length) return 'no DKIM signature';
  const dkim = Array.isArray(live?.dkim) ? live.dkim.filter((/** @type {Record<string, any>} */ d) => d.d || d.s) : [];
  const keyErr = sigs.find((s) => s.key_error);
  if (keyErr) return /ENODATA|ENOTFOUND|NXDOMAIN|no record|no key/i.test(String(keyErr.key_error)) ? 'no DKIM key in DNS' : 'DKIM key not fetched';
  const failed = dkim.filter((/** @type {Record<string, any>} */ d) => d.result !== 'pass');
  if (failed.some((/** @type {Record<string, any>} */ d) => d.result === 'neutral' || d.result === 'none') && !v.ok) return 'no DKIM key in DNS';
  if (v.ok && failed.length && sigs.some((s) => s.body?.status === 'mismatch')) return 'body changed after signing';
  const bad = v.signatures.find((s) => !s.ok);
  if (bad) return recheckShort(String(bad.why ?? bad.reason ?? ''));
  if (failed.length) return 'signature fails';
  if (dkim.some((/** @type {Record<string, any>} */ d) => d.result === 'pass' && !d.aligned)) return 'DKIM not aligned with From';
  if (live?.dmarc?.published && live.dmarc.result !== 'pass') return 'DMARC fails';
  if (live?.arc && live.arc.result !== 'pass') return 'ARC fails';
  return firstClause(long);
}
