// `describe` and `verifyWith` (SPEC B8.5): the facts of one email, or of every email with an address, as plain JSON, and the
// offline re-check of all of them. ONE definition: the CLI `show` and `verify` render these results and the MCP tools return
// them; nothing downstream recomputes a fact. Everything is the record, the content store and the trail: no DNS, no network.
// Absent values are `null` (the CLI prints `N/A`). Body text and every string taken from an email are untrusted data.

import fs from 'node:fs/promises';
import path from 'node:path';
import { participantsOf, signedHeaderValue, addressCoverage } from './participants.js';
import { claimedHeader, headerText } from './header-text.js';
import { bodyText } from './body-text.js';
import { verifyRecord } from './recheck.js';
import { explain, shortReason } from './explain.js';
import { classifyTarget, targetRecords } from './target.js';
import { readAnchored } from './ots-upgrade.js';
import { manifestOtsPath, manifestPath } from './layout.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./mailproof.js').Mailproof} Mailproof */
/** @typedef {import('./target.js').Target} Target */
/** @typedef {'signed' | 'failing' | 'none'} AddressCoverage */
/** @typedef {{ address: string, signed: boolean, coverage: AddressCoverage }} FactsAddress  `address` as written; `signed` is true only for `coverage: 'signed'` (a verifying, aligned signature covers the line). */
/** @typedef {{ value: string | null, coverage: 'signed' | 'failing' | 'claimed' | 'none' }} FactsHeader  `claimed`: only the stored raw email has it (the sender's word); `none`: nothing has it (`value` null). */
/** @typedef {{ via: 'record' | 'manifest' | null, state: 'unsealed' | 'own-stamp' | 'not-stamped' | 'pending' | 'anchored', manifest: number | null, stamped_by: number | null, stamp: unknown, anchored: boolean, block: number | null, sealed_at: string | null }} FactsSeal  `sealed_at`: when the stamping manifest was made (its own `created`, local data, no network); null without a manifest stamp. */
/**
 * @typedef {Object} Facts
 * @property {string} id
 * @property {string | null} message_id
 * @property {string | null} message_key
 * @property {string} captured  This machine's clock at capture (ISO).
 * @property {string} direction  `in` or `out`.
 * @property {string | null} source
 * @property {FactsHeader} date
 * @property {FactsHeader} subject
 * @property {FactsAddress[]} from
 * @property {FactsAddress[]} to
 * @property {FactsAddress[]} cc
 * @property {FactsAddress[]} reply_to
 * @property {string | null} bcc  Only the own copy has it; read from the stored raw email, never signed.
 * @property {{ value: string, strength: string | null } | null} in_reply_to
 * @property {Array<{ value: string, strength: string | null }>} references
 * @property {Array<{ id: string, message_id: string | null, strength: string }>} children
 * @property {boolean} children_more
 * @property {string | null} copy  direct, relayed, forward, digest or unknown.
 * @property {Array<{ d: string | null, s: string | null, a: string | null, result: string | null, aligned: boolean | null, recheck: { ok: boolean, why: string | null } | null, body: string | null, key_archived: boolean }>} dkim
 * @property {{ result: string | null, policy: string | null, published: boolean } | null} dmarc
 * @property {{ result: string } | null} spf
 * @property {{ result: string, sealers: string[] } | null} arc
 * @property {{ live: string | null, portable: string | null, rules: string | null }} trust
 * @property {{ ok: boolean, trust: string }} recheck  The offline re-check.
 * @property {string | null} why  The reason in plain words when not verified (`explain`), null when it verifies.
 * @property {string} reason  The same in a few plain words (at most 40 characters, `shortReason`): `verifies`, `no DKIM signature`, `no DKIM key in DNS`, `signature fails`, `body changed after signing`, `DMARC fails`, `key expired (x=)`, `over limit: size`, ...; what a list row shows.
 * @property {string | null} body_proof  The record's `body_status`, verbatim.
 * @property {{ proof: 'proven' | 'partial' | 'not', stored: boolean, source: string | null, limit: string | null, text: string | null, more_lines: number }} body  `text`: the whole text with `full: true`, else its first 10 lines (`more_lines` says how many were cut); null when there is no stored raw email or no text part.
 * @property {Array<{ filename: string | null, size: number | null, sha256: string | null, stored: boolean, match: boolean | null }>} attachments
 * @property {{ raw_stored: boolean, raw_sha256: string | null, gone: { reason: 'forgotten' | 'expired' | 'never-stored', at: string | null } | null }} content
 * @property {FactsSeal | null} seal  Null when sealing is off for this instance.
 */
/** @typedef {{ target: Target, total: number, more: boolean, records: Facts[] }} Described */
/**
 * @typedef {Object} VerifyRow
 * @property {string} id @property {string} captured @property {string} direction
 * @property {boolean} counted  Whether it counts toward `ok` (received ones, or every one with `all: true`).
 * @property {boolean} ok @property {string} trust
 * @property {string | null} reason  The short re-check reason (null when it verifies).
 * @property {string | null} why  `explain`, the plain-words sentence (null when it verifies).
 * @property {string | null} subject  The Subject a signature covers (decoded), null when none does.
 */
/** @typedef {{ target: Target, total: number, checked: number, counted: number, verified: number, not_verified: number, sent_copies: number, inbound: { verified: number, failed: number }, outbound: { verified: number, failed: number }, all: boolean, ok: boolean, records: VerifyRow[] }} VerifiedWith */

/** Lines of body text kept without `full: true`. */
export const BODY_LINES = 10;
/** Most records one call examines at once. */
const BATCH = 10;

/** @param {string | null | undefined} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The seal of one record or reply-text file (SPEC B13.1.12), read-only, no lock; `ots info` (local) only for the block number.
 * @param {Mailproof} mp
 * @param {string} id
 * @returns {Promise<FactsSeal | null>}  Null when sealing is off for this instance.
 */
export async function sealOf(mp, id) {
  if (!mp.otsBin) return null;
  const seal = await mp._findSeal(id).catch(() => null);
  if (!seal) return { via: null, state: 'unsealed', manifest: null, stamped_by: null, stamp: null, anchored: false, block: null, sealed_at: null };
  if (seal.via === 'record') return { via: 'record', state: 'own-stamp', manifest: null, stamped_by: null, stamp: seal.stamp, anchored: false, block: null, sealed_at: null };
  if (!seal.stamp) return { via: 'manifest', state: 'not-stamped', manifest: seal.seq, stamped_by: null, stamp: null, anchored: false, block: null, sealed_at: null };
  const anchored = (await readAnchored(mp.root, mp.trail)).manifests.has(seal.stamp.seq);
  let block = null;
  if (anchored && mp.jobOts) block = await mp.jobOts.readBlockHeight(path.join(mp.root, manifestOtsPath(seal.stamp.seq))).catch(() => null);
  let sealedAt = null;
  try { const c = JSON.parse(await fs.readFile(path.join(mp.root, manifestPath(seal.stamp.seq)), 'utf8')).created; sealedAt = typeof c === 'string' ? c : null; } catch { /* the manifest cannot be read: no time */ }
  return { via: 'manifest', state: anchored ? 'anchored' : 'pending', manifest: seal.seq, stamped_by: seal.stamp.seq, stamp: seal.stamp, anchored, block, sealed_at: sealedAt };
}

/**
 * The facts of one record (SPEC B8.5).
 * @param {Mailproof} mp
 * @param {MpRecord} rec
 * @param {{ full?: boolean }} [opts]
 * @returns {Promise<Facts>}
 */
export async function factsOf(mp, rec, opts = {}) {
  const id = rec.id;
  const [raw, parts, seal, links] = await Promise.all([
    mp.rawEmail(id).catch(() => null), mp.proofParts(rec), sealOf(mp, id), mp.linked(id).catch(() => null),
  ]);
  const ver = verifyRecord(rec);
  const passing = ver.passing;
  const roles = participantsOf(rec);
  const cover = addressCoverage(rec, passing);
  /** "signed" only when a verifying, aligned signature covers the header; `failing` when only signatures that do not verify do. @param {string} role @returns {FactsAddress[]} */
  const addrs = (role) => roles.filter((x) => x.role === role).map((x) => {
    const c = cover.get(`${x.role}\0${x.address}`) ?? 'none';
    return { address: x.raw, signed: c === 'signed', coverage: /** @type {AddressCoverage} */ (c) };
  });
  /** A header: the value a passing signature covers (signed), else the one a failing signature covers, else the one in the stored raw email (claimed), else absent. @param {string} name @returns {FactsHeader} */
  const header = (name) => {
    const s = passing.length ? signedHeaderValue(rec, name, passing) : null;
    if (s !== null) return { value: headerText(s), coverage: 'signed' };
    const f = signedHeaderValue(rec, name);
    if (f !== null) return { value: headerText(f), coverage: 'failing' };
    const c = raw ? claimedHeader(raw, name) : null;
    return c !== null ? { value: headerText(c), coverage: 'claimed' } : { value: null, coverage: 'none' };
  };
  const bcc = raw ? claimedHeader(raw, 'bcc') : null;
  const live = /** @type {Record<string, any>} */ (rec.verdicts?.live ?? {});
  const liveDkim = Array.isArray(live.dkim) ? live.dkim : [];
  const sigs = (Array.isArray(rec.signatures) ? rec.signatures : []).map((s, i) => {
    const l = liveDkim.find((x) => x.d === s.tags?.d && x.s === s.tags?.s) ?? liveDkim[i] ?? null;
    const re = ver.signatures[i];
    return {
      d: str(s.tags?.d), s: str(s.tags?.s), a: str(s.tags?.a), result: l ? String(l.result) : null, aligned: l ? Boolean(l.aligned) : null,
      recheck: re ? { ok: Boolean(re.ok), why: re.ok ? null : String(re.why ?? 'unknown') } : null,
      body: str(s.body?.status), key_archived: Boolean(s.key || s.key_file),
    };
  });
  const strengthOf = (/** @type {string} */ mid) => links?.parents.find((x) => x.message_id === mid)?.strength ?? null;
  const m = rec.message ?? {};
  const bt = raw ? bodyText(raw) : null;
  let text = bt && bt.source !== 'none' ? bt.text : null;
  let moreLines = 0;
  if (text !== null && !opts.full) {
    const lines = text.split('\n');
    if (lines.length > BODY_LINES) { text = lines.slice(0, BODY_LINES).join('\n'); moreLines = lines.length - BODY_LINES; }
  }
  const status = rec.body_status ?? null;
  return {
    id, message_id: str(m.message_id), message_key: str(rec.message_key), captured: rec.captured,
    direction: rec.direction, source: str(rec.source),
    date: header('date'), subject: header('subject'),
    from: addrs('from'), to: addrs('to'), cc: addrs('cc'), reply_to: addrs('reply-to'), bcc: bcc === null ? null : headerText(bcc),
    in_reply_to: str(m.in_reply_to) ? { value: /** @type {string} */ (m.in_reply_to), strength: strengthOf(/** @type {string} */ (m.in_reply_to)) } : null,
    references: (Array.isArray(m.references) ? m.references : []).map((r) => ({ value: String(r), strength: strengthOf(String(r)) })),
    children: (links?.children ?? []).map((x) => ({ id: x.id, message_id: x.message_id, strength: x.strength })), children_more: Boolean(links?.more),
    copy: str(rec.copy?.kind),
    dkim: sigs,
    dmarc: live.dmarc ? { result: live.dmarc.result ?? null, policy: live.dmarc.policy ?? null, published: Boolean(live.dmarc.published) } : null,
    spf: live.spf?.result ? { result: String(live.spf.result) } : null,
    arc: live.arc ? { result: String(live.arc.result), sealers: Array.isArray(live.arc.sealers) ? live.arc.sealers.map(String) : [] } : null,
    trust: { live: rec.verdicts?.live?.trust ?? null, portable: rec.verdicts?.portable?.trust ?? null, rules: live.engine?.rules ?? rec.verdicts?.portable?.engine?.rules ?? null },
    recheck: { ok: ver.ok, trust: ver.trust },
    why: explain(rec, ver),
    reason: shortReason(rec, ver),
    body_proof: status,
    body: { proof: status === 'matched' ? 'proven' : status === 'partial' ? 'partial' : 'not', stored: raw !== null, source: bt?.source ?? null, limit: bt?.limit ?? null, text, more_lines: moreLines },
    attachments: (parts?.attachments ?? []).map((a) => ({
      filename: a.filename, size: typeof rec.attachments?.[a.index]?.size === 'number' ? rec.attachments[a.index].size : null, sha256: a.sha256, stored: a.stored, match: a.match,
    })),
    content: { raw_stored: raw !== null, raw_sha256: str(m.raw_sha256), gone: raw === null ? await mp._contentGone(id).catch(() => null) : null },
    seal,
  };
}

/**
 * @param {Mailproof} mp
 * @param {string | Target} target  A record id (8 to 32 hex), a `<message-id>`, or one exact address.
 * @param {{ full?: boolean, after?: Date | number | string, before?: Date | number | string, limit?: number }} [opts]
 * @returns {Promise<Described>}
 */
export async function describe(mp, target, opts = {}) {
  const t = classifyTarget(target);
  const limit = opts.limit === undefined ? 50 : opts.limit;
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('describe: limit must be a non-negative integer (0 = all)');
  const { records, total } = await targetRecords(mp, t, { ...(opts.after !== undefined ? { after: opts.after } : {}), ...(opts.before !== undefined ? { before: opts.before } : {}), limit });
  /** @type {Facts[]} */
  const out = [];
  for (let i = 0; i < records.length; i += BATCH) out.push(...await Promise.all(records.slice(i, i + BATCH).map((r) => factsOf(mp, r, { full: Boolean(opts.full) }))));
  return { target: t, total, more: total > out.length, records: out };
}

/**
 * Why a re-check said no, in a few words.
 * @param {{ error?: string, trust: string, signatures: Array<Record<string, any>> }} v
 * @returns {string}
 */
function reasonOf(v) {
  if (v.error) return v.error;
  if (!v.signatures.length) return 'unsigned';
  const bad = v.signatures.find((s) => !s.ok);
  return bad ? `${bad.d ?? '-'}: ${bad.why ?? bad.reason ?? 'does not verify'}` : `trust ${v.trust}`;
}

/**
 * @param {Mailproof} mp
 * @param {string | Target} target
 * @param {{ after?: Date | number | string, before?: Date | number | string, limit?: number, all?: boolean, at?: Date | number | string }} [opts]
 * @returns {Promise<VerifiedWith>}
 */
export async function verifyWith(mp, target, opts = {}) {
  const t = classifyTarget(target);
  const all = Boolean(opts.all);
  const limit = opts.limit === undefined ? 0 : opts.limit;
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('verifyWith: limit must be a non-negative integer (0 = all)');
  const { records, total } = await targetRecords(mp, t, { ...(opts.after !== undefined ? { after: opts.after } : {}), ...(opts.before !== undefined ? { before: opts.before } : {}), limit });
  /** @type {VerifyRow[]} */
  const rows = [];
  for (const r of records) {
    const v = await mp.verify(r, opts.at === undefined ? undefined : { at: opts.at });
    const subject = signedHeaderValue(r, 'subject');
    rows.push({
      id: r.id, captured: r.captured, direction: r.direction, counted: all || r.direction !== 'out', ok: v.ok, trust: v.trust,
      reason: v.ok ? null : reasonOf(v), why: v.ok ? null : explain(r, v), subject: subject === null ? null : headerText(subject),
    });
  }
  const tally = (/** @type {string} */ dir) => {
    const x = rows.filter((r) => r.direction === dir);
    return { verified: x.filter((r) => r.ok).length, failed: x.filter((r) => !r.ok).length };
  };
  const counted = rows.filter((r) => r.counted);
  const verified = counted.filter((r) => r.ok).length;
  return {
    target: t, total, checked: rows.length, counted: counted.length, verified, not_verified: counted.length - verified,
    sent_copies: rows.filter((r) => r.direction === 'out').length, inbound: tally('in'), outbound: tally('out'), all,
    ok: counted.length > 0 && verified === counted.length, records: rows,
  };
}
