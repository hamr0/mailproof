// Candidate replyFacts: builds the flat string-only fact bundle (PRD 7 M3 "Approvals and the fact bundle") from the
// PUBLIC primitives plus the record JSON. Throwaway: NOT shipped. Places that needed something that is not public
// are marked  NEW:  (that is the answer to POC question 1).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyRecord, checkProfile } from '../../src/index.js';
import { recordPath } from '../../src/proof/layout.js';          // NEW-ish: layout is internal; a shipped version lives beside it
import { extractReplyText } from '../../src/proof/reply-text.js'; // only for textMode 'pure' (no trail write)

export const SEP = ',';                       // proposal: see README / F-entry
const lc = (s) => s.toLowerCase();
const firstLineOf = (text) => { for (const l of String(text).split(/\r\n|\n|\r/)) { const t = l.trim(); if (t) return t; } return ''; };
const str = (v) => (typeof v === 'string' ? v : '');
const VERDICT = new Set(['pass', 'fail', 'none']);
const closed = (v) => (VERDICT.has(v) ? v : v ? 'other' : 'none');

/** Headers a signature covers, decoded (lower-cased name -> first value as written). Pure read of the record. */
function signedHeader(rec, name) {
  for (const sig of rec.signatures ?? []) for (const l of sig.signed_headers ?? []) {
    const line = Buffer.from(l, 'base64').toString('binary'); const c = line.indexOf(':');
    if (c > 0 && line.slice(0, c).trim().toLowerCase() === name) return line.slice(c + 1).replace(/\r?\n(?=[ \t])/g, '').trim();
  }
  return null;
}

/** NEW: commit that recorded `id` (the record JSON does not hold it). `git log -1 -- <record path>`. */
export function recordCommit(trailRoot, id) {
  try { return execFileSync('git', ['-C', trailRoot, 'log', '-1', '--format=%H', '--', recordPath(id)], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

/**
 * Lookup of the reply candidates to `messageId`. Strategy 'linked': needs the request recorded (id via list scan).
 * Strategy 'scan': request need not be recorded; reads every record (O(N)). A shipped version would be ONE indexed query
 * `SELECT ... FROM links WHERE mid = ?` (the links_mid index exists): NEW, in index-db.js.
 */
export async function candidates(mp, messageId, { strategy = 'linked', cap = 100000 } = {}) {
  if (strategy === 'linked') {
    const all = await mp.list({ limit: cap });
    const req = all.filter((r) => r.message_id === messageId).sort((a, b) => a.captured < b.captured ? -1 : 1)[0];
    if (!req) return { requestRecorded: false, rows: [] };
    const t = await mp.linked(req.id);
    return { requestRecorded: true, rows: t.children.map((c) => ({ id: c.id, via: c.via, strength: c.strength })) };
  }
  const rows = [];
  for (const s of await mp.list({ limit: cap })) {
    const rec = await mp.get(s.id); const m = rec.message ?? {};
    if (m.in_reply_to === messageId || (m.references ?? []).includes(messageId)) rows.push({ id: s.id });
  }
  return { requestRecorded: null, rows };
}

/**
 * PROPOSAL (owner decides): among records that name the request, keep inbound ones whose PARENT is the request (isImmediateChild); group by message_key
 * (copies of one reply) ; prefer a `signed` link, then the earliest captured. Returns the chosen id + the counts.
 */
export async function choose(mp, messageId, rows) {
  const recs = [];
  let deeper = 0;
  for (const r of rows) {
    const rec = await mp.get(r.id); if (!rec || rec.direction !== 'in') continue;
    if (!isImmediateChild(rec, messageId)) { deeper++; continue; }   // a later message in the thread that only lists the request in References
    recs.push(rec);
  }
  const groups = new Map(); for (const r of recs) { const k = r.message_key ?? r.id; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const scored = [];
  for (const rec of recs) {
    const link = await linkOf(rec, messageId);
    scored.push({ rec, link, rank: link === 'signed' ? 0 : link === 'unsigned' ? 1 : 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.rec.captured < b.rec.captured ? -1 : a.rec.captured > b.rec.captured ? 1 : a.rec.id < b.rec.id ? -1 : 1));
  return { chosen: scored[0]?.rec ?? null, inbound: recs.length, deeper, distinctMessages: groups.size, copiesMax: Math.max(0, ...[...groups.values()].map((g) => g.length)) };
}

/** The request is the reply's parent: In-Reply-To names it, or (no In-Reply-To) it is the LAST References id. */
export function isImmediateChild(rec, mid) {
  const m = rec.message ?? {};
  return m.in_reply_to ? m.in_reply_to === mid : (m.references ?? []).slice(-1)[0] === mid;
}

/** `signed` | `unsigned` | `none` for one record against one request Message-ID, via the public checkProfile. */
export async function linkOf(rec, messageId) {
  const r = checkProfile(rec, { link: ['signed'] }, { parent: messageId });
  return r.ok ? 'signed' : r.failed.find((f) => f.rule === 'link')?.got ?? 'none';
}

export function fromDkimAligned(rec) {
  if (!(rec.signatures ?? []).length) return 'none';
  const v = verifyRecord(rec);
  const from = (rec.addresses ?? []).find((a) => a.role === 'from');
  return v.passing.length > 0 && from?.signed === true ? 'pass' : 'fail';
}

/** The bundle. `textMode`: 'public' = Mailproof#replyText({id}) (writes a reply-text commit the first time), 'pure' = no write. */
export async function replyFacts(mp, { messageId, strategy = 'linked', textMode = 'public' }) {
  const { rows } = await candidates(mp, messageId, { strategy });
  const pick = await choose(mp, messageId, rows);
  const rec = pick.chosen; if (!rec) return { bundle: null, pick };
  const addr = (role) => (rec.addresses ?? []).filter((a) => a.role === role);
  const live = rec.verdicts?.live ?? {};
  let t = { text: '', quote: 'not-found', proven: false };
  const raw = await mp.rawEmail(rec.id);                       // content store; null when off/expired/forgotten
  if (textMode === 'public') { try { t = await mp.replyText({ id: rec.id }); } catch (e) { t = { text: '', quote: 'not-found', proven: false, err: e.code }; } }
  else if (raw) { const ex = extractReplyText(raw); if (ex.ok) t = { text: ex.stripped.text, quote: ex.stripped.quote, proven: ex.stripped.source === 'text/plain' && rec.body_status === 'matched' }; }
  const dkimPass = (live.dkim ?? []).some((d) => d.result === 'pass');
  const bundle = {
    messageId: str(rec.message.message_id),
    recordId: rec.id,
    commit: recordCommit(path.join(mp.root), rec.id),          // NEW: no public primitive returns a stored record's commit
    trail: mp.trail,
    from: lc(addr('from')[0]?.raw ?? str(rec.message.from)),
    fromRaw: addr('from')[0]?.raw ?? str(rec.message.from),
    fromDkimAligned: fromDkimAligned(rec),
    to: addr('to').map((a) => lc(a.raw)).join(SEP), toRaw: addr('to').map((a) => a.raw).join(SEP),
    cc: addr('cc').map((a) => lc(a.raw)).join(SEP), ccRaw: addr('cc').map((a) => a.raw).join(SEP),
    date: str(signedHeader(rec, 'date')),                       // NEW: only when a signature covers Date; else the raw email must be header-parsed
    subject: str(signedHeader(rec, 'subject')),                 // NEW: same, and RFC 2047 words stay encoded
    dkim: dkimPass ? 'pass' : (live.dkim ?? []).length ? 'fail' : 'none',   // NEW rule: the record stores an array per signature
    dmarc: closed(live.dmarc?.result), spf: closed(live.spf?.result), arc: closed(live.arc?.result),
    live: str(rec.verdicts?.live?.trust), portable: str(rec.verdicts?.portable?.trust),
    link: await linkOf(rec, messageId),
    text: t.text, firstLine: firstLineOf(t.text),
    bodyProven: t.proven ? 'proven' : 'unproven',
    quote: t.quote === 'found' || t.quote === 'inline' ? t.quote : 'not-found',
    attachments: (rec.attachments ?? []).map((a) => a.sha256).filter(Boolean).join(SEP),
  };
  return { bundle, pick };
}
