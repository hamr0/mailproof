// Trust profiles (SPEC B8): a read-side policy over ONE stored record. Pure: no DNS, no clock, no trail, no content
// store; the same record, profile and `at` always give the same answer, so a decision can be replayed in an audit.
// mailproof evaluates, the consumer decides what to do with the answer.

import { verifyRecord } from './recheck.js';
import { RULES_VERSION } from './verdict.js';
import { signedFromAddresses, linksOf, strongest } from './participants.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/**
 * @typedef {Object} TrustProfile
 * @property {string[]} [senders]  Exact addresses or `@domain` entries; matched against the From a DKIM-aligned signature covers.
 * @property {{ dkimAligned?: boolean, dmarc?: boolean, spf?: boolean, arc?: boolean }} [checks]  `true` requires a pass.
 * @property {'proven' | 'partial' | 'any'} [body]  Required body level (from `body_status`).
 * @property {Array<'signed' | 'unsigned' | 'none'>} [link]  Allowed strengths of the record's link to its parent.
 */
/** @typedef {{ rule: string, want: unknown, got: unknown }} ProfileFailure */

const PROFILE_KEYS = ['senders', 'checks', 'body', 'link'];
const CHECK_KEYS = ['dkimAligned', 'dmarc', 'spf', 'arc'];
const BODY_LEVELS = ['proven', 'partial', 'any'];
const STRENGTHS = ['signed', 'unsigned', 'none'];
const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;
const DOMAIN_RE = /^@[^\s@<>()",;:\\[\]]+$/;

/** @param {string} msg @returns {Error & { code: string }} */
const bad = (msg) => Object.assign(new Error(`checkProfile: ${msg}`), { code: 'ERR_BAD_PROFILE' });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a profile strictly and return it normalised (senders lower-cased). Throws `ERR_BAD_PROFILE`.
 * @param {unknown} profile
 * @returns {{ senders?: string[], checks: Record<string, boolean>, body?: string, link?: string[] }}
 */
function normaliseProfile(profile) {
  if (!plain(profile)) throw bad('the profile must be an object');
  for (const k of Object.keys(profile)) if (!PROFILE_KEYS.includes(k)) throw bad(`unknown profile key "${k}"`);
  /** @type {ReturnType<typeof normaliseProfile>} */
  const out = { checks: {} };
  if (profile.senders !== undefined) {
    const s = profile.senders;
    if (!Array.isArray(s) || s.length === 0) throw bad('senders must be a non-empty array (omit it to allow any sender)');
    out.senders = s.map((e) => {
      if (typeof e !== 'string' || !(ADDR_RE.test(e) || DOMAIN_RE.test(e))) throw bad(`senders entry ${JSON.stringify(e)} is neither an address nor "@domain"`);
      return e.toLowerCase();
    });
  }
  if (profile.checks !== undefined) {
    if (!plain(profile.checks)) throw bad('checks must be an object');
    for (const [k, v] of Object.entries(profile.checks)) {
      if (!CHECK_KEYS.includes(k)) throw bad(`unknown check "${k}"`);
      if (typeof v !== 'boolean') throw bad(`checks.${k} must be a boolean`);
      out.checks[k] = v;
    }
  }
  if (profile.body !== undefined) {
    if (typeof profile.body !== 'string' || !BODY_LEVELS.includes(profile.body)) throw bad(`body must be one of ${BODY_LEVELS.join(', ')}`);
    out.body = profile.body;
  }
  if (profile.link !== undefined) {
    const l = profile.link;
    if (!Array.isArray(l) || l.length === 0 || l.some((x) => typeof x !== 'string' || !STRENGTHS.includes(x))) throw bad(`link must be a non-empty array of ${STRENGTHS.join(', ')}`);
    out.link = [...new Set(/** @type {string[]} */ (l))];
  }
  return out;
}

/**
 * Does a lower-cased address satisfy one sender entry (an exact address, or `@domain`: that exact domain, no subdomains)?
 * @param {string} address @param {string} entry @returns {boolean}
 */
const matches = (address, entry) => (entry.startsWith('@') ? address.endsWith(entry) && address.lastIndexOf('@') === address.length - entry.length : address === entry);

/**
 * Evaluate a trust profile against one stored record. Pure, synchronous, offline and deterministic: no DNS, no
 * clock (the DKIM re-check is judged at `at`, default the record's capture time), so re-running it later on the
 * same record gives the same answer (audit replay). Every rule is evaluated (no early exit), so `failed` lists them all.
 * @param {MpRecord | string | null} record  A record object or its JSON text.
 * @param {TrustProfile} profile  All keys optional; unknown keys throw. `senders`: exact addresses or `@domain` (that exact domain); the From must be one a DKIM-aligned signature covers, so an unsigned From never satisfies it. `checks`: `dkimAligned` (portable re-check from the record), `dmarc`, `spf`, `arc` (the live results recorded at capture), each `true` to require `pass`. `body`: `proven` (body_status `matched`), `partial` (`matched` or `partial`), `any`. `link`: allowed strengths of the link to the parent.
 * @param {{ at?: Date | number | string, parent?: string }} [opts]  `at`: judge the signatures as of this time. `parent`: a Message-ID; the `link` rule then looks at the link to that id only (the request an approval answers), not at the strongest link to any parent.
 * @returns {{ ok: boolean, failed: Array<{ rule: string, want: unknown, got: unknown }>, record: string | null, rules: string }}
 * @when Use to gate which email an agent may act on: allowed senders, required checks, required body level, required link strength. Local and free, so re-evaluate it any time on the same record to replay a decision. It tells you pass or fail with the reasons; what to do about it is yours.
 * @category verify
 * @signature checkProfile(record: Record|string, profile: { senders?: string[], checks?: { dkimAligned?, dmarc?, spf?, arc? }, body?: 'proven'|'partial'|'any', link?: Array<'signed'|'unsigned'|'none'> }, opts?: { at?: Date|number|string, parent?: string }) => { ok, failed: [{ rule, want, got }], record, rules }
 * @fails Throws `ERR_BAD_PROFILE` for an invalid profile (not an object, an unknown key, an empty `senders`/`link`, a value of the wrong type). Never throws for the record: one that is missing, not version 2 or junk fails the `record` rule (`record: null`).
 * @example
 * import { checkProfile } from 'mailproof';
 * const r = checkProfile(record, { senders: ['@gmail.com'], checks: { dkimAligned: true, dmarc: true }, body: 'proven', link: ['signed'] });
 * if (!r.ok) console.log(r.failed);
 */
function checkProfile(record, profile, opts = {}) {
  const p = normaliseProfile(profile);
  /** @type {any} */
  let rec = null;
  try { rec = typeof record === 'string' ? JSON.parse(record) : record; } catch { rec = null; }
  if (!plain(rec) || rec.v !== 2 || !Array.isArray(rec.signatures)) {
    return { ok: false, failed: [{ rule: 'record', want: 'a version 2 record', got: rec === null || rec === undefined ? 'missing' : 'unreadable' }], record: null, rules: RULES_VERSION };
  }
  const o = opts && typeof opts === 'object' ? opts : {};
  rec = /** @type {MpRecord} */ (/** @type {unknown} */ (rec));
  const v = verifyRecord(rec, o.at === undefined ? {} : { at: o.at });
  /** @type {ProfileFailure[]} */
  const failed = [];
  const live = plain(rec.verdicts) && plain(rec.verdicts.live) ? /** @type {Record<string, any>} */ (rec.verdicts.live) : {};

  if (p.senders) {
    const got = [...new Set(signedFromAddresses(rec, v.passing).map((a) => a.toLowerCase()))];
    const senders = p.senders;
    if (!got.length || !got.every((a) => senders.some((e) => matches(a, e)))) failed.push({ rule: 'senders', want: senders, got });
  }
  const checks = p.checks;
  if (checks.dkimAligned) {
    const got = v.passing.length ? 'pass' : 'fail';
    if (got !== 'pass') failed.push({ rule: 'checks.dkimAligned', want: 'pass', got });
  }
  for (const [k, field] of /** @type {const} */ ([['dmarc', 'dmarc'], ['spf', 'spf'], ['arc', 'arc']])) {
    if (!checks[k]) continue;
    const r = live[field] && typeof live[field].result === 'string' ? live[field].result : 'none';
    if (r !== 'pass') failed.push({ rule: `checks.${k}`, want: 'pass', got: r });
  }
  if (p.body && p.body !== 'any') {
    const ok = p.body === 'proven' ? ['matched'] : ['matched', 'partial'];
    const got = typeof rec.body_status === 'string' ? rec.body_status : 'not-checked';
    if (!ok.includes(got)) failed.push({ rule: 'body', want: p.body, got });
  }
  if (p.link) {
    const got = strongest(linksOf(rec, v.passing), typeof o.parent === 'string' ? o.parent : undefined);
    if (!p.link.includes(got)) failed.push({ rule: 'link', want: p.link, got });
  }
  return { ok: failed.length === 0, failed, record: typeof rec.id === 'string' ? rec.id : null, rules: RULES_VERSION };
}

export { checkProfile, normaliseProfile };
