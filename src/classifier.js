// Trust-level classifier (SPEC §1). Pure function over a mailauth
// authenticate() result — no I/O, no config, no policy.
//
//   verified   — DKIM pass + aligned + DMARC pass
//   forwarded  — DKIM fail/none, but ARC pass via trusted intermediary
//   authorized — DKIM fail/none, but SPF pass + DMARC pass
//   unverified — none of the above
//
// Levels are ranked strongest-first; a step's minTrust gate (in the
// sequencing module) compares against this ordering.

'use strict';

/** @typedef {import('./types').TrustLevel} TrustLevel */
/** @typedef {import('./types').MailauthResult} MailauthResult */

/** @type {readonly TrustLevel[]} */
const TRUST_LEVELS = ['verified', 'forwarded', 'authorized', 'unverified'];

/**
 * Classify a mailauth `authenticate()` result into a trust level (SPEC §1).
 * Pure — no I/O, no config, no policy.
 * @param {MailauthResult} auth
 * @returns {TrustLevel}
 */
function classifyTrust(auth) {
  const dkimResults = (auth && auth.dkim && auth.dkim.results) || [];
  const dkimPassAligned = dkimResults.some(
    (r) => r.status && r.status.result === 'pass' && r.status.aligned
  );
  const dmarcPass = !!(auth && auth.dmarc && auth.dmarc.status && auth.dmarc.status.result === 'pass');
  const arcPass = !!(auth && auth.arc && auth.arc.status && auth.arc.status.result === 'pass');
  const spfPass = !!(auth && auth.spf && auth.spf.status && auth.spf.status.result === 'pass');

  if (dkimPassAligned && dmarcPass) return 'verified';
  if (arcPass) return 'forwarded';
  if (spfPass && dmarcPass) return 'authorized';
  return 'unverified';
}

module.exports = { classifyTrust, TRUST_LEVELS };
