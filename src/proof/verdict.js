// The two verdicts (PRD section 3). LIVE is decided at capture from mailauth's
// full result (DKIM + DMARC + SPF + ARC); PORTABLE is recomputable by anyone
// from the stored record alone (DKIM only, never SPF or ARC). Each carries the
// engine/rules version that produced it: verdicts are not timeless.

import { createRequire } from 'node:module';
import { classifyTrust, dmarcPublished, arcSealers } from './trust.js';
import { verifyRecord } from './recheck.js';

/** @typedef {import('./types.js').MailauthResult} MailauthResult */
/** @typedef {import('./types.js').MpRecord} MpRecord */

/** Bump when the trust rules change; stored in every verdict. */
const RULES_VERSION = 'mp-rules/1';

const require = createRequire(import.meta.url);
const MAILAUTH_VERSION = /** @type {string} */ (require('mailauth/package.json').version);

/** @returns {{ rules: string, mailauth: string }} */
function engine() {
  return { rules: RULES_VERSION, mailauth: MAILAUTH_VERSION };
}

/**
 * Live verdict from a mailauth result.
 * @param {MailauthResult} auth
 * @param {{ trustedSealers?: string[], hasEnvelope?: boolean }} [opts]
 *   `hasEnvelope`: SPF is only meaningful when the caller supplied connection data.
 * @returns {Record<string, any>}
 */
function buildLive(auth, { trustedSealers = [], hasEnvelope = false } = {}) {
  /** @type {Array<Record<string, any>>} */
  const sigs = (auth && auth.dkim && auth.dkim.results) || [];
  const dmarc = auth && auth.dmarc ? auth.dmarc : null;
  const arcRes = auth && auth.arc && auth.arc.status && auth.arc.status.result;
  return {
    trust: classifyTrust(auth, { trustedSealers }),
    engine: engine(),
    dkim: sigs.map((r) => ({
      d: r.signingDomain || null, s: r.selector || null,
      result: (r.status && r.status.result) || 'none', aligned: !!(r.status && r.status.aligned),
    })),
    dmarc: {
      result: (dmarc && dmarc.status && dmarc.status.result) || 'none',
      published: dmarcPublished(auth), policy: (dmarc && dmarc.policy) || null, rr: (dmarc && dmarc.rr) || null,
    },
    spf: hasEnvelope && auth.spf && auth.spf.status ? { result: auth.spf.status.result } : null,
    arc: arcRes && arcRes !== 'none' ? { result: arcRes, sealers: arcSealers(auth) } : null,
  };
}

/**
 * Portable verdict, recomputed from the record alone at `at` (default: capture time).
 * @param {MpRecord} rec
 * @param {{ at?: Date | number | string, now?: number }} [opts]
 * @returns {{ trust: 'verified' | 'unverified', engine: { rules: string, mailauth: string }, basis: 'dkim' | 'none', passing: number[] }}
 */
function buildPortable(rec, opts = {}) {
  const v = verifyRecord(rec, opts);
  return { trust: v.trust, engine: engine(), basis: v.basis, passing: v.passing };
}

export { RULES_VERSION, engine, buildLive, buildPortable };
