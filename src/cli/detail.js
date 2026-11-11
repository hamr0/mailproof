// The `show` view of one record (SPEC B11.5a): every field on its own labelled line, always, in one fixed order, `N/A` when a
// value does not exist, so the layout never shifts. `gather` reads the facts (the record, an offline re-check, the stored raw email,
// the seal), `render` turns them into lines. The compact form (the per-record block of `show <address>`) is the same lines minus
// the long-tail facts and with the body cut. No DNS and no network: everything is the record, the content store and the trail.

import { participantsOf, signedHeaderValue, addressCoverage } from '../proof/participants.js';
import { claimedHeader, headerText } from '../proof/header-text.js';
import { bodyText } from '../proof/body-text.js';
import { verifyRecord } from '../proof/recheck.js';
import { printable as p } from './printable.js';
import { sealLine } from './seal.js';
import { makeStyle, rel } from './style.js';

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
  const cover = addressCoverage(rec, passing);
  /** "signed" only when a verifying, aligned signature covers the header; `failing` when only signatures that do not verify do. @param {string} role */
  const addrs = (role) => roles.map((x) => ({ x, c: cover.get(`${x.role}\0${x.address}`) })).filter(({ x }) => x.role === role)
    .map(({ x, c }) => ({ address: x.raw, signed: c === 'signed', coverage: /** @type {'signed' | 'failing' | 'none'} */ (c ?? 'none') }));
  /** A header: the value a passing signature covers (signed), else the one in the stored raw email (claimed), else absent. @param {string} name @param {(s: string) => string} dec */
  const header = (name, dec) => {
    /** @typedef {'signed' | 'failing' | 'claimed' | null} Basis */
    const s = passing.length ? signedHeaderValue(rec, name, passing) : null;
    if (s !== null) return { value: dec(s), basis: /** @type {Basis} */ ('signed') };
    const f = signedHeaderValue(rec, name);   // covered, but only by signatures that do not verify
    if (f !== null) return { value: dec(f), basis: /** @type {Basis} */ ('failing') };
    const c = raw ? claimedHeader(raw, name) : null;
    return c !== null ? { value: dec(c), basis: /** @type {Basis} */ ('claimed') } : { value: null, basis: /** @type {Basis} */ (null) };
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

/** One rule for every header line: `signed` only when a verifying signature covers it. */
const COVER = { signed: 'signed', failing: 'covered by a signature that does not verify', none: 'not signed' };
/** @param {string | null} s @returns {string} */
const link = (s) => (s ? `, link ${s}` : ', link not recorded');
/** The DNS names of a DKIM key (`selector._domainkey.domain`) in already-escaped text. */
const DKIM_NAME = /[A-Za-z0-9_.-]+\._domainkey\.[A-Za-z0-9.-]*[A-Za-z0-9]/g;

/**
 * The `why` text of a record: escaped (printable), the DNS name of a missing or unreadable DKIM key made a link (to a DNS lookup page: the
 * user clicks, mailproof never does), in yellow. The name is cut from already-escaped text, so it holds only name characters.
 * @param {import('./style.js').Style} st @param {string} why @returns {string}
 */
export function whyText(st, why) {
  return st.yellow(p(why, { max: 500 }).replace(DKIM_NAME, (name) => st.link(name, `https://dnschecker.org/#TXT/${encodeURIComponent(name)}`)));
}

/**
 * The labelled lines of one record, grouped under section headers (Message, People, Proof, Content, Seal). Every string from the record
 * goes through printable() BEFORE any style is applied.
 * @param {Facts} f
 * @param {{ compact?: boolean, full?: boolean, fullHashes?: boolean, st?: import('./style.js').Style, now?: Date }} [o]  `compact`: the block of a multi-record view (the long-tail facts are left out, the body is cut to 10 lines unless `full`); `fullHashes`: do not shorten hashes to 12 characters; `st`: the style (default none); `now`: for the relative times.
 * @returns {string[]}
 */
export function render(f, o = {}) {
  const st = o.st ?? makeStyle();
  const now = o.now ?? new Date();
  /** @type {string[]} */
  const out = [];
  const c = Boolean(o.compact);
  /** @param {string} h @returns {string} A hash, cut to 12 characters (dim) unless --full. */
  const hash = (h) => st.dim(o.fullHashes ? p(h) : p(h.replace(/^(sha256:)?(.*)$/s, (_, pre = '', rest) => `${pre}${rest.slice(0, 12)}`)));
  /** @param {string} v @returns {string} N/A (and its explanation) in dim. */
  const val = (v) => (v === NA || v.startsWith(`${NA} (`) ? st.dim(v) : v);
  let sections = 0;
  /** @param {string} name */
  const section = (name) => { if (sections++) out.push(''); out.push(st.bold(name)); };
  /** @param {string} label @param {string | string[]} value */
  const row = (label, value) => {
    const v = Array.isArray(value) ? value : [value];
    v.forEach((x, i) => out.push(`${st.dim((i === 0 ? label : '').padEnd(LABEL))} ${x}`));
  };
  /** @param {Facts['from']} l @returns {string} */
  const addrText = (l) => (l.length ? l.map((x) => `${x.coverage === 'signed' ? st.bold(p(x.address)) : p(x.address)} (${COVER[x.coverage]})`).join(', ') : st.dim(NA));
  /** @param {{ value: string | null, basis: string | null }} h */
  const headText = (h, max = 300) => (h.value === null ? st.dim(NA) : `${h.basis === 'signed' ? st.bold(p(h.value, { max })) : p(h.value, { max })} (${h.basis === 'signed' ? 'signed' : h.basis === 'failing' ? COVER.failing : 'claimed, not signed'})`);
  /** @param {string} t @param {string | null} v @returns {string} A trust word: green when verified, yellow otherwise (the word is always there). */
  const trustWord = (t, v) => (v === 'verified' ? st.green(t) : st.yellow(t));

  section('Message');
  row('account', f.account.user ? `${p(f.account.user)} ${st.dim(`(${p(f.account.name)})`)}` : `${st.dim(NA)} (${p(f.account.name)})`);
  row('direction', `${f.direction === 'out' ? 'sent' : 'received'}${f.source ? ` (${p(f.source)})` : ''}`);
  row('date', headText(f.date));
  const ago = rel(f.captured, now);
  row('captured', `${p(f.captured)} (${ago ? `${ago}; ` : ''}this machine's clock)`);
  row('subject', headText(f.subject, 200));
  if (!c) {
    row('in-reply-to', f.in_reply_to ? `${st.dim(p(f.in_reply_to.value))}${link(f.in_reply_to.strength)}` : st.dim(NA));
    row('references', f.references.length ? f.references.map((r) => `${st.dim(p(r.value))}${link(r.strength)}`) : st.dim(NA));
    row('children', f.children.length ? [...f.children.map((x) => `${st.dim(p(x.message_id ?? NA))}  ${p(x.strength)}  ${st.dim(p(x.id.slice(0, 12)))}`), ...(f.children_more ? ['... more'] : [])] : st.dim(NA));
    row('copy', f.copy ? p(f.copy) : st.dim(NA));
  }
  row('message-id', f.message_id ? st.dim(p(f.message_id)) : st.dim(NA));
  if (!c) row('message-key', f.message_key ? hash(f.message_key) : st.dim(NA));
  row('id', st.dim(p(f.id)));

  section('People');
  row('from', addrText(f.from));
  row('to', addrText(f.to));
  row('cc', addrText(f.cc));
  row('reply-to', addrText(f.reply_to));
  row('bcc', f.bcc === null ? st.dim(NA) : `${p(f.bcc, { max: 300 })} (not signed, own copy)`);

  section('Proof');
  row('trust', `live ${trustWord(p(f.trust.live ?? NA), f.trust.live)}, portable ${trustWord(p(f.trust.portable ?? NA), f.trust.portable)}${c ? '' : `; rules ${p(f.trust.rules ?? NA)}`}; re-check ${f.recheck ? `${f.recheck.ok ? st.green('ok') : st.red('not ok')} (${p(f.recheck.trust)})` : st.dim(NA)}`);
  row('why', f.why === null ? `${st.dim(NA)} (it verifies)` : whyText(st, f.why));
  row('body proof', f.body_proof === 'matched' ? st.green('matched') : f.body_proof === 'partial' ? st.yellow('partial (the signature covers only the first bytes)') : st.yellow(`not proven (${p(f.body_proof ?? NA)})`));
  if (!c) {
    row('dkim', f.dkim.length ? f.dkim.map((s) => `d=${p(s.d ?? NA)} s=${p(s.s ?? NA)} a=${p(s.a ?? NA)} result=${s.result === 'pass' ? st.green('pass') : p(s.result ?? NA)} aligned=${s.aligned === null ? NA : s.aligned ? 'yes' : 'no'} re-check=${p(s.recheck ?? NA)} body=${p(s.body ?? NA)} key archived=${s.key_archived ? 'yes' : 'no'}`) : `${st.dim(NA)} (no DKIM signature)`);
    row('dmarc', f.dmarc ? `${p(f.dmarc.result ?? NA)}, policy ${p(f.dmarc.policy ?? NA)}, published ${f.dmarc.published ? 'yes' : 'no'}` : st.dim(NA));
    row('spf', f.spf ? p(f.spf.result) : st.dim(NA));
    row('arc', f.arc ? `${p(f.arc.result)}${f.arc.sealers.length ? `, sealers ${f.arc.sealers.map((x) => p(x)).join(', ')}` : ''}` : st.dim(NA));
  }

  section('Content');
  if (!f.body.stored) row('body', val(`${NA} (not stored: expired, forgotten or the content store is off)`));
  else if (f.body.text === null) row('body', val(`${NA} (${f.body.limit ? `over limit: ${p(f.body.limit)}` : 'no text part'})`));
  else {
    const lines = f.body.text.split('\n');
    const cut = c && !o.full && lines.length > COMPACT_BODY_LINES;
    const shown = cut ? lines.slice(0, COMPACT_BODY_LINES) : lines;
    row('body', f.body.text === '' ? '(empty)' : `(${f.body.source})`);
    for (const l of f.body.text === '' ? [] : shown) out.push(`  ${p(l)}`);
    if (cut) out.push(`  ${st.dim(`... ${lines.length - COMPACT_BODY_LINES} more lines, use show ${p(f.id.slice(0, 12))} --full`)}`);
  }
  row('attachments', f.attachments.length
    ? f.attachments.map((a) => `${p(a.filename ?? '(no name)', { max: 200 })}  ${a.size === null ? NA : `${a.size} bytes`}  ${a.sha256 ? hash(a.sha256) : NA}  stored ${a.stored ? 'yes' : 'no'}${a.match === null ? '' : a.match ? '  match yes' : `  ${st.red('match NO (differs)')}`}`)
    : val(`${NA} (none)`));
  if (!c) row('content', f.content.raw_stored ? `raw email stored (${f.content.raw_sha256 ? hash(f.content.raw_sha256) : NA})` : val(`${NA} (raw email not stored)`));

  section('Seal');
  row('seal', f.seal ?? val(`${NA} (sealing is off for this account)`));
  return out;
}

/** The label column, for a test (the order of the labelled lines). */
export const LABELS = ['account', 'direction', 'date', 'captured', 'subject', 'in-reply-to', 'references', 'children', 'copy', 'message-id', 'message-key', 'id', 'from', 'to', 'cc', 'reply-to', 'bcc', 'trust', 'why', 'body proof', 'dkim', 'dmarc', 'spf', 'arc', 'body', 'attachments', 'content', 'seal'];
/** The section headers, in order. */
export const SECTIONS = ['Message', 'People', 'Proof', 'Content', 'Seal'];
