// The `show` view of one record (SPEC B11.5a): every field on its own labelled line, always, in one fixed order, `N/A` when a
// value does not exist, so the layout never shifts. `gather` reads the facts (the record, an offline re-check, the stored raw email,
// the seal), `render` turns them into lines. The compact form (the per-record block of `show <address>`) is the same lines minus
// the long-tail facts and with the body cut. No DNS and no network: everything is the record, the content store and the trail.

import { participantsOf, signedHeaderValue } from '../proof/participants.js';
import { claimedHeader, headerText } from '../proof/header-text.js';
import { asText } from '../proof/bundle-readme.js';
import { bodyText } from '../proof/body-text.js';
import { verifyRecord } from '../proof/recheck.js';
import { printable as p } from './printable.js';
import { sealLine } from './seal.js';

/** @typedef {import('../proof/types.js').MpRecord} MpRecord */
/** @typedef {import('./session.js').Session} Session */

export const NA = 'N/A';
const LABEL = 12;
const COMPACT_BODY_LINES = 10;

/** @param {string | null | undefined} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Why a record is not verified, in plain words, from what was recorded (no DNS). Null when it verifies live and on re-check.
 * @param {MpRecord} rec
 * @param {{ ok: boolean, signatures: Array<Record<string, any>> }} v  The offline re-check.
 * @returns {string | null}
 */
export function whyNot(rec, v) {
  const live = /** @type {Record<string, any> | undefined} */ (rec.verdicts?.live);
  if (live?.trust === 'verified' && v.ok) return null;
  /** @type {string[]} */
  const why = [];
  const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
  if (!sigs.length) why.push('there is no DKIM signature on this email');
  for (const d of Array.isArray(live?.dkim) ? live.dkim : []) {
    if (!d.d && !d.s) continue;   // mailauth's placeholder for "no signature"
    const where = `${d.s ?? '?'}._domainkey.${d.d ?? '?'}`;
    if (d.result !== 'pass') why.push(`DKIM ${d.result}${d.result === 'neutral' || d.result === 'none' ? ` (typically no public key is published at ${where})` : ` for ${where}`}`);
    else if (!d.aligned) why.push(`DKIM passed for ${d.d} but that is not the From domain (not aligned)`);
  }
  for (const s of sigs) if (s.key_error) why.push(`the public key for ${s.tags?.s ?? '?'}._domainkey.${s.tags?.d ?? '?'} was not archived (${s.key_error})`);
  if (live?.dmarc?.published && live.dmarc.result !== 'pass') why.push(`DMARC ${live.dmarc.result} (policy ${live.dmarc.policy ?? 'none'})`);
  if (live?.arc && live.arc.result !== 'pass') why.push(`ARC ${live.arc.result}`);
  if (!v.ok) for (const s of v.signatures) if (!s.ok) why.push(`offline re-check of ${s.d ?? '?'}: ${s.why ?? s.reason ?? 'does not verify'}`);
  if (!why.length) why.push(`live verdict ${live?.trust ?? NA}, portable ${rec.verdicts?.portable?.trust ?? NA}`);
  return why.join('; ');
}

/**
 * Everything `show` prints for one record.
 * @param {Session['mp']} mp
 * @param {Session['account']} account
 * @param {MpRecord} rec
 * @param {{ links?: boolean }} [opts]  `links`: also read the thread (the strength of In-Reply-To and References).
 */
export async function gather(mp, account, rec, opts = {}) {
  const id = rec.id;
  const [raw, parts, ver, seal, links] = await Promise.all([
    mp.rawEmail(id).catch(() => null), mp.proofParts(rec), mp.verify(rec), sealLine(mp, id), opts.links ? mp.linked(id).catch(() => null) : Promise.resolve(null),
  ]);
  const passing = verifyRecord(rec).passing;
  const roles = participantsOf(rec);
  /** @param {string} role */
  const addrs = (role) => roles.filter((x) => x.role === role).map((x) => ({ address: x.raw, signed: x.signed }));
  /** A header: the value a passing signature covers (signed), else the one in the stored raw email (claimed), else absent. @param {string} name @param {(s: string) => string} dec */
  const header = (name, dec) => {
    const s = passing.length ? signedHeaderValue(rec, name, passing) : null;
    if (s !== null) return { value: asText(s), basis: /** @type {'signed' | 'claimed' | null} */ ('signed') };
    const c = raw ? claimedHeader(raw, name) : null;
    return c !== null ? { value: dec(c), basis: /** @type {'signed' | 'claimed' | null} */ ('claimed') } : { value: null, basis: /** @type {'signed' | 'claimed' | null} */ (null) };
  };
  const bcc = raw ? claimedHeader(raw, 'bcc') : null;
  const live = /** @type {Record<string, any>} */ (rec.verdicts?.live ?? {});
  const liveDkim = Array.isArray(live.dkim) ? live.dkim : [];
  const sigs = (Array.isArray(rec.signatures) ? rec.signatures : []).map((s, i) => {
    const l = liveDkim.find((x) => x.d === s.tags?.d && x.s === s.tags?.s) ?? liveDkim[i] ?? null;
    return {
      d: str(s.tags?.d), s: str(s.tags?.s), a: str(s.tags?.a), result: l ? String(l.result) : null, aligned: l ? Boolean(l.aligned) : null,
      recheck: ver.signatures[i] ? (ver.signatures[i].ok ? 'ok' : `fails: ${ver.signatures[i].why ?? ver.signatures[i].reason ?? 'unknown'}`) : null,
      body: str(s.body?.status), key_archived: Boolean(s.key || s.key_file),
    };
  });
  const strengthOf = (/** @type {string} */ mid) => links?.parents.find((x) => x.message_id === mid)?.strength ?? null;
  const m = rec.message ?? {};
  const bt = raw ? bodyText(raw) : null;
  return {
    account: { user: account.user ?? null, name: account.name },
    direction: rec.direction, source: str(rec.source),
    date: header('date', headerText), captured: rec.captured,
    from: addrs('from'), to: addrs('to'), cc: addrs('cc'), reply_to: addrs('reply-to'), bcc: bcc === null ? null : headerText(bcc),
    subject: header('subject', headerText),
    in_reply_to: str(m.in_reply_to) ? { value: /** @type {string} */ (m.in_reply_to), strength: strengthOf(/** @type {string} */ (m.in_reply_to)) } : null,
    references: (Array.isArray(m.references) ? m.references : []).map((r) => ({ value: String(r), strength: strengthOf(String(r)) })),
    children: (links?.children ?? []).map((x) => ({ id: x.id, message_id: x.message_id, strength: x.strength })), children_more: Boolean(links?.more),
    copy: str(rec.copy?.kind),
    dkim: sigs,
    dmarc: live.dmarc ? { result: live.dmarc.result ?? null, policy: live.dmarc.policy ?? null, published: Boolean(live.dmarc.published) } : null,
    spf: live.spf?.result ? { result: String(live.spf.result) } : null,
    arc: live.arc ? { result: String(live.arc.result), sealers: Array.isArray(live.arc.sealers) ? live.arc.sealers.map(String) : [] } : null,
    trust: { live: rec.verdicts?.live?.trust ?? null, portable: rec.verdicts?.portable?.trust ?? null, rules: live.engine?.rules ?? rec.verdicts?.portable?.engine?.rules ?? null },
    recheck: parts ? { ok: parts.email.ok, trust: parts.email.trust } : null,
    why: whyNot(rec, ver),
    body_proof: rec.body_status ?? null,
    body: { stored: raw !== null, source: bt?.source ?? null, limit: bt?.limit ?? null, text: bt && bt.source !== 'none' ? bt.text : null },
    attachments: (parts?.attachments ?? []).map((a) => ({
      filename: a.filename, size: typeof rec.attachments?.[a.index]?.size === 'number' ? rec.attachments[a.index].size : null, sha256: a.sha256, stored: a.stored, match: a.match,
    })),
    content: { raw_stored: raw !== null, raw_sha256: str(m.raw_sha256) },
    seal: seal.text, seal_data: seal.data,
    message_key: str(rec.message_key), message_id: str(m.message_id), id,
  };
}

/** @typedef {Awaited<ReturnType<typeof gather>>} Facts */

/** @param {Facts['from']} l @returns {string} */
const addrText = (l) => (l.length ? l.map((x) => `${p(x.address)} (${x.signed ? 'signed' : 'not signed'})`).join(', ') : NA);
/** @param {{ value: string | null, basis: string | null }} h @returns {string} */
const headText = (h, max = 300) => (h.value === null ? NA : `${p(h.value, { max })} (${h.basis === 'signed' ? 'signed' : 'claimed, not signed'})`);
/** @param {string | null} s @returns {string} */
const link = (s) => (s ? `, link ${s}` : ', link not recorded');

/**
 * The labelled lines of one record.
 * @param {Facts} f
 * @param {{ compact?: boolean, full?: boolean }} [o]  `compact`: the block of a multi-record view (the long-tail facts are left out, the body is cut to 10 lines unless `full`).
 * @returns {string[]}
 */
export function render(f, o = {}) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} label @param {string | string[]} value */
  const row = (label, value) => {
    const v = Array.isArray(value) ? value : [value];
    v.forEach((x, i) => out.push(`${(i === 0 ? label : '').padEnd(LABEL)} ${x}`));
  };
  const c = Boolean(o.compact);
  row('account', f.account.user ? `${p(f.account.user)} (${p(f.account.name)})` : `${NA} (${p(f.account.name)})`);
  row('direction', `${f.direction === 'out' ? 'sent' : 'received'}${f.source ? ` (${p(f.source)})` : ''}`);
  row('date', headText(f.date));
  row('captured', `${p(f.captured)} (this machine's clock)`);
  row('from', addrText(f.from));
  row('to', addrText(f.to));
  row('cc', addrText(f.cc));
  row('reply-to', addrText(f.reply_to));
  row('bcc', f.bcc === null ? NA : `${p(f.bcc, { max: 300 })} (not signed, own copy)`);
  row('subject', headText(f.subject, 200));
  if (!c) {
    row('in-reply-to', f.in_reply_to ? `${p(f.in_reply_to.value)}${link(f.in_reply_to.strength)}` : NA);
    row('references', f.references.length ? f.references.map((r) => `${p(r.value)}${link(r.strength)}`) : NA);
    row('children', f.children.length ? [...f.children.map((x) => `${p(x.message_id ?? NA)}  ${p(x.strength)}  ${p(x.id.slice(0, 12))}`), ...(f.children_more ? ['... more'] : [])] : NA);
    row('copy', f.copy ? p(f.copy) : NA);
    row('dkim', f.dkim.length ? f.dkim.map((s) => `d=${p(s.d ?? NA)} s=${p(s.s ?? NA)} a=${p(s.a ?? NA)} result=${p(s.result ?? NA)} aligned=${s.aligned === null ? NA : s.aligned ? 'yes' : 'no'} re-check=${p(s.recheck ?? NA)} body=${p(s.body ?? NA)} key archived=${s.key_archived ? 'yes' : 'no'}`) : `${NA} (no DKIM signature)`);
    row('dmarc', f.dmarc ? `${p(f.dmarc.result ?? NA)}, policy ${p(f.dmarc.policy ?? NA)}, published ${f.dmarc.published ? 'yes' : 'no'}` : NA);
    row('spf', f.spf ? p(f.spf.result) : NA);
    row('arc', f.arc ? `${p(f.arc.result)}${f.arc.sealers.length ? `, sealers ${f.arc.sealers.map((x) => p(x)).join(', ')}` : ''}` : NA);
  }
  row('trust', `live ${p(f.trust.live ?? NA)}, portable ${p(f.trust.portable ?? NA)}${c ? '' : `; rules ${p(f.trust.rules ?? NA)}`}; re-check ${f.recheck ? `${f.recheck.ok ? 'ok' : 'not ok'} (${p(f.recheck.trust)})` : NA}`);
  row('why', f.why === null ? `${NA} (it verifies)` : p(f.why, { max: 500 }));
  row('body proof', f.body_proof === 'matched' ? 'matched' : f.body_proof === 'partial' ? 'partial (the signature covers only the first bytes)' : `not proven (${p(f.body_proof ?? NA)})`);
  if (!f.body.stored) row('body', `${NA} (not stored: expired, forgotten or the content store is off)`);
  else if (f.body.text === null) row('body', `${NA} (${f.body.limit ? `over limit: ${p(f.body.limit)}` : 'no text part'})`);
  else {
    const lines = f.body.text.split('\n');
    const cut = c && !o.full && lines.length > COMPACT_BODY_LINES;
    const shown = cut ? lines.slice(0, COMPACT_BODY_LINES) : lines;
    row('body', f.body.text === '' ? '(empty)' : `(${f.body.source})`);
    for (const l of f.body.text === '' ? [] : shown) out.push(`  ${p(l)}`);
    if (cut) out.push(`  ... ${lines.length - COMPACT_BODY_LINES} more lines, use show ${p(f.id.slice(0, 12))} --full`);
  }
  row('attachments', f.attachments.length
    ? f.attachments.map((a) => `${p(a.filename ?? '(no name)', { max: 200 })}  ${a.size === null ? NA : `${a.size} bytes`}  ${p(a.sha256 ?? NA)}  stored ${a.stored ? 'yes' : 'no'}${a.match === null ? '' : a.match ? '  match yes' : '  match NO (differs)'}`)
    : `${NA} (none)`);
  if (!c) row('content', f.content.raw_stored ? `raw email stored (${p(f.content.raw_sha256 ?? NA)})` : `${NA} (raw email not stored)`);
  row('seal', f.seal ?? `${NA} (sealing is off for this account)`);
  if (!c) row('message-key', f.message_key ? p(f.message_key) : NA);
  row('message-id', f.message_id ? p(f.message_id) : NA);
  row('id', p(f.id));
  return out;
}

/** The label column, for a test. */
export const LABELS = ['account', 'direction', 'date', 'captured', 'from', 'to', 'cc', 'reply-to', 'bcc', 'subject', 'in-reply-to', 'references', 'children', 'copy', 'dkim', 'dmarc', 'spf', 'arc', 'trust', 'why', 'body proof', 'body', 'attachments', 'content', 'seal', 'message-key', 'message-id', 'id'];
