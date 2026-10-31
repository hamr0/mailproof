// Trust-level classifier (SPEC Part B2). Pure function over a mailauth
// authenticate() result: no I/O, no config, no policy.
//
//   verified   - aligned DKIM pass, AND DMARC pass if the From domain publishes
//                a DMARC record (no record: aligned DKIM is enough)
//   forwarded  - DKIM fail/none, but ARC pass (from a trusted sealer, if a list is given)
//   authorized - DKIM fail/none, but SPF pass + DMARC pass (live only)
//   unverified - none of the above
//
// Levels are ranked strongest-first.

/** @typedef {import('./types.js').TrustLevel} TrustLevel */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */

/** @type {readonly TrustLevel[]} */
const TRUST_LEVELS = ['verified', 'forwarded', 'authorized', 'unverified'];

/**
 * Did the From domain publish a DMARC record? mailauth reports `none` (and no
 * `rr`) when there is none; every other result - including temperror and
 * permerror - counts as published, so an unreadable policy fails closed.
 * @param {MailauthResult} auth
 * @returns {boolean}
 */
function dmarcPublished(auth) {
  const d = auth && auth.dmarc;
  if (!d) return false;
  const result = d.status && d.status.result;
  return Boolean(d.rr) || (Boolean(result) && result !== 'none');
}

/**
 * Signing domains of the ARC seals on a message (empty when no chain).
 * @param {MailauthResult} auth
 * @returns {string[]}
 */
function arcSealers(auth) {
  /** @type {Array<Record<string, any>>} */
  const chain = (auth && auth.arc && auth.arc.chain) || [];
  const out = new Set();
  for (const e of chain) {
    const d = e && e['arc-seal'] && e['arc-seal'].parsed && e['arc-seal'].parsed.d;
    if (d && d.value) out.add(String(d.value).toLowerCase());
  }
  return [...out];
}

/**
 * Classify a mailauth `authenticate()` result into a trust level (SPEC B2).
 * `trustedSealers`, when given, restricts `forwarded` to chains sealed by a
 * listed domain; when omitted any passing ARC chain counts (v1 behaviour).
 * @param {MailauthResult} auth
 * @param {{ trustedSealers?: string[] }} [opts]
 * @returns {TrustLevel}
 */
function classifyTrust(auth, { trustedSealers } = {}) {
  /** @type {Array<{ status?: { result?: string, aligned?: boolean } }>} */
  const dkimResults = (auth && auth.dkim && auth.dkim.results) || [];
  const dkimPassAligned = dkimResults.some(
    (r) => !!(r.status && r.status.result === 'pass' && r.status.aligned)
  );
  const dmarcPass = !!(auth && auth.dmarc && auth.dmarc.status && auth.dmarc.status.result === 'pass');
  const arcPass = !!(auth && auth.arc && auth.arc.status && auth.arc.status.result === 'pass');
  const spfPass = !!(auth && auth.spf && auth.spf.status && auth.spf.status.result === 'pass');
  const arcTrusted = arcPass && (!trustedSealers
    || arcSealers(auth).some((d) => trustedSealers.map((x) => x.toLowerCase()).includes(d)));

  if (dkimPassAligned && (dmarcPass || !dmarcPublished(auth))) return 'verified';
  if (arcTrusted) return 'forwarded';
  if (spfPass && dmarcPass) return 'authorized';
  return 'unverified';
}

export { classifyTrust, dmarcPublished, arcSealers, TRUST_LEVELS };
