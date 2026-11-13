// Trust profiles in plain words (SPEC B11.5): the built-in default profile, a one-line meaning of any profile, and one ✓/✗ line per rule of a
// check. Presentation only: whether a profile passes is the library's `checkProfile` (src/proof/profile.js); the rules listed here are the keys
// the profile names, a rule passes when the library did not list it as failed.

import { printable as p } from './printable.js';
import { normaliseProfile } from '../proof/profile.js';

/**
 * The profile `check` uses when none is chosen: the DKIM baseline of the trust rule (PRD §3). A file `<configDir>/profiles/default.json` replaces it.
 * @type {import('../proof/profile.js').TrustProfile}
 */
export const DEFAULT_PROFILE = { checks: { dkimAligned: true } };

/** The checks in plain words. */
const CHECK_WORDS = /** @type {Record<string, string>} */ ({ dkimAligned: 'DKIM signature verifies and covers the From', dmarc: 'DMARC passes', spf: 'SPF passes', arc: 'ARC passes' });

/**
 * One line that says what a profile requires. Never throws: a profile that is not valid says so.
 * @param {unknown} profile
 * @returns {string}
 */
export function profileSummary(profile) {
  let n;
  try { n = normaliseProfile(profile); } catch (e) { return `not a valid profile (${p(/** @type {Error} */ (e).message.replace(/^checkProfile: /, ''), { max: 80 })})`; }
  /** @type {string[]} */
  const parts = [];
  if (n.senders) parts.push(`sender ${n.senders.join(' or ')}`);
  for (const [k, on] of Object.entries(n.checks)) if (on) parts.push(CHECK_WORDS[k] ?? k);
  if (n.body && n.body !== 'any') parts.push(`body ${n.body}`);
  if (n.link) parts.push(`link ${n.link.join(' or ')}`);
  return parts.length ? p(parts.join('; '), { max: 200 }) : 'accepts any email';
}

/**
 * The rules a profile checks, in a fixed order, each with its outcome and a plain reason. A rule fails when the library listed it in `failed`.
 * @param {unknown} profile  The profile that was checked.
 * @param {Array<{ rule: string, want: unknown, got: unknown }>} failed  The library's `failed`.
 * @returns {Array<{ rule: string, ok: boolean, text: string }>}
 */
export function ruleLines(profile, failed) {
  /** @type {Array<{ rule: string, ok: boolean, text: string }>} */
  const out = [];
  const bad = (/** @type {string} */ rule) => failed.find((f) => f.rule === rule);
  const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.map((x) => String(x)).join(' or ') : String(v));
  const rec = bad('record');
  if (rec) return [{ rule: 'record', ok: false, text: `the record is ${p(list(rec.got))}, not a readable version 2 record` }];
  let n;
  try { n = normaliseProfile(profile); } catch { return out; }
  if (n.senders) {
    const f = bad('senders');
    out.push({ rule: 'senders', ok: !f, text: f ? `sender ${Array.isArray(f.got) && f.got.length ? p(list(f.got)) : 'not covered by a verifying signature'} is not ${p(list(f.want))}` : `sender is ${n.senders.join(' or ')}` });
  }
  for (const [k, on] of Object.entries(n.checks)) {
    if (!on) continue;
    const f = bad(`checks.${k}`);
    out.push({ rule: `checks.${k}`, ok: !f, text: f ? (k === 'dkimAligned' ? 'no DKIM signature verifies and covers the From' : `${(CHECK_WORDS[k] ?? k).replace(' passes', '')} did not pass (it said ${p(list(f.got))})`) : (CHECK_WORDS[k] ?? k) });
  }
  if (n.body && n.body !== 'any') {
    const f = bad('body');
    out.push({ rule: 'body', ok: !f, text: f ? `body is ${p(list(f.got))}, not ${p(list(f.want))}` : `body ${n.body}` });
  }
  if (n.link) {
    const f = bad('link');
    out.push({ rule: 'link', ok: !f, text: f ? `link to the request is ${p(list(f.got))}, not ${p(list(f.want))}` : `link ${p(String(n.link.join(' or ')))}` });
  }
  return out;
}
