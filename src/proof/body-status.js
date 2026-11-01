// Body status (SPEC Part B1, `signatures[].body` and `body_status`). Whether the
// body the sender signed is the body we were handed, per signature, plus a
// machine-readable explanation of WHAT changed where it can be determined. It
// never changes a trust verdict (the portable verdict covers the signed headers
// only) and it never contains body text: only counts, byte sizes and domains.
//
// Detectors run cheapest first and stop at the first that explains the mismatch:
// l= tag, appended content, prepended content, other canonicalisation, line
// endings. Context hints (ARC seal, List-Id) sit alongside.

import crypto from 'node:crypto';
import { dkimBody } from 'mailauth/lib/dkim/body';
import { canonPair } from './signed-headers.js';
import { MAX_LINES, MAX_BYTES, MAX_WORK } from './limits.js';
import { relayEvidence } from './relay.js';

/** @typedef {import('./types.js').BodyResult} BodyResult */
/** @typedef {import('./types.js').BodyExplain} BodyExplain */
/** @typedef {import('./types.js').BodyStatus} BodyStatus */
/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

/**
 * The work the mismatch searches of ONE message may still spend, in bytes processed. Every signature and
 * every detector of that message draws on the same budget (`newBudget()`), so a sender cannot multiply the
 * cost of the search by adding signatures.
 * @typedef {{ left: number }} WorkBudget
 */

/** @returns {WorkBudget} a full budget for one message */
const newBudget = () => ({ left: MAX_WORK });

/**
 * Take `bytes` from the budget. When it cannot cover them nothing is left, so every later search of the
 * message is refused too.
 * @param {WorkBudget} budget
 * @param {number} bytes
 * @returns {boolean} whether the work may go ahead
 */
function spend(budget, bytes) {
  if (bytes > budget.left) { budget.left = 0; return false; }
  budget.left -= bytes;
  return true;
}

const RANK = { matched: 3, partial: 2, mismatch: 1 };

/**
 * `s` without its trailing spaces and tabs, in one backwards pass (a regex for
 * this is quadratic on a long run of spaces that does not end the line).
 * @param {string} s
 * @returns {string}
 */
function trimTrailingWs(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Canonical body lines (no CRLF), after the signature's body canonicalization:
 * relaxed takes a bare LF as a line break and folds whitespace; simple breaks
 * lines on CRLF only (a bare LF stays content); trailing empty lines go. This
 * is used only to EXPLAIN a mismatch, never to decide a match (mailauth does).
 * @param {Buffer} body
 * @param {'simple' | 'relaxed'} mode
 * @returns {string[]}
 */
function canonLines(body, mode) {
  const s = body.toString('binary');
  if (s === '') return [];
  const parts = s.split(mode === 'relaxed' ? /\r?\n/ : '\r\n');
  if (mode === 'relaxed' ? /\n$/.test(s) : s.endsWith('\r\n')) parts.pop();
  const lines = mode === 'relaxed' ? parts.map((l) => trimTrailingWs(l).replace(/[ \t]+/g, ' ')) : parts;
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Canonical bytes of a run of lines (an empty run is CRLF under simple, empty under relaxed).
 * @param {string[]} lines
 * @param {'simple' | 'relaxed'} mode
 */
const canonBytes = (lines, mode) => Buffer.from(lines.length ? lines.map((l) => l + '\r\n').join('') : (mode === 'simple' ? '\r\n' : ''), 'binary');

/**
 * @param {string} alg
 * @param {Buffer | string} bytes
 * @returns {string}
 */
const digest = (alg, bytes) => crypto.createHash(alg).update(bytes).digest('base64');

/**
 * Appended content: some canonical prefix, cut at a line boundary, hashes to bh. Hashing the lines costs
 * their total size, taken from `budget` up front.
 * @param {string[]} lines @param {'simple' | 'relaxed'} mode @param {string} alg @param {string} bh @param {WorkBudget} budget
 * @returns {{ found: BodyExplain | null, capped: boolean }}
 */
function findAppended(lines, mode, alg, bh, budget) {
  const m = lines.length;
  const sizes = lines.map((l) => l.length + 2);
  const total = sizes.reduce((a, b) => a + b, 0);
  // j = -1 is the empty prefix: the signed body was empty
  if (digest(alg, canonBytes([], mode)) === bh) return { found: { kind: 'appended', detail: { bytes: total, lines: m } }, capped: false };
  if (!spend(budget, total)) return { found: null, capped: true };
  const H = crypto.createHash(alg);
  let fed = 0;
  for (let j = 0; j < m - 1; j++) {
    H.update(lines[j] + '\r\n', 'binary');
    fed += sizes[j];
    const lineCount = m - 1 - j;
    if (lineCount > MAX_LINES || total - fed > MAX_BYTES) continue;
    if (lines[j] === '') continue; // trailing empties are stripped, so the digest equals an earlier one
    if (H.copy().digest('base64') === bh) return { found: { kind: 'appended', detail: { bytes: total - fed, lines: lineCount } }, capped: false };
  }
  return { found: null, capped: m - 1 > MAX_LINES || total > MAX_BYTES };
}

/**
 * Prepended content: some canonical suffix, cut at a line boundary, hashes to bh. The canonical bytes
 * of the lines from `i` on are the tail of the canonical bytes of all of them, so they are built once and
 * each candidate hashes a view of the tail. Each candidate costs the size of that tail, taken from `budget`.
 * @param {string[]} lines @param {'simple' | 'relaxed'} mode @param {string} alg @param {string} bh @param {WorkBudget} budget
 * @returns {{ found: BodyExplain | null, capped: boolean }}
 */
function findPrepended(lines, mode, alg, bh, budget) {
  const m = lines.length;
  const all = canonBytes(lines, mode);
  let removed = 0;   // size of the canonical lines before line i
  for (let i = 1; i < m; i++) {
    removed += lines[i - 1].length + 2;
    if (i > MAX_LINES || removed > MAX_BYTES) return { found: null, capped: true };
    if (!spend(budget, all.length - removed)) return { found: null, capped: true };
    if (digest(alg, all.subarray(removed)) === bh) return { found: { kind: 'prepended', detail: { bytes: removed, lines: i } }, capped: false };
  }
  return { found: null, capped: false };
}

/**
 * Context hints from the header block: ARC seals and List-Id.
 * @param {HeaderRow[]} rows
 * @param {string | null | undefined} arcResult
 * @returns {BodyExplain[]}
 */
function contextHints(rows, arcResult) {
  /** @type {BodyExplain[]} */
  const out = [];
  const { arc_sealers, list_id_domain } = relayEvidence(rows);
  if (arc_sealers.length) out.push({ kind: 'forwarded', detail: { sealers: arc_sealers, arc: arcResult || 'none' } });
  if (list_id_domain) out.push({ kind: 'mailing_list', detail: { list_id_domain } });
  return out;
}

/**
 * Body status of ONE signature against the body we were handed.
 * @param {Record<string, string>} tags  Parsed tags of the DKIM-Signature.
 * @param {Buffer} body  Raw body bytes (after the header block).
 * @param {{ rows?: HeaderRow[], arc?: string | null, budget?: WorkBudget }} [ctx]  `budget`: the message's
 *   shared search budget (default: a fresh one, for a signature analysed on its own).
 * @returns {BodyResult}
 */
function analyseBody(tags, body, ctx = {}) {
  const rows = ctx.rows || [];
  const budget = ctx.budget || newBudget();
  const bh = (tags.bh || '').replace(/\s+/g, '');
  const alg = (tags.a || '').split('-').pop() || '';
  const mode = /** @type {'simple' | 'relaxed'} */ (canonPair(tags.c).b === 'relaxed' ? 'relaxed' : 'simple');
  const l = tags.l !== undefined && tags.l !== '' && Number.isFinite(Number(tags.l)) ? Number(tags.l) : null;
  /** @type {BodyExplain[]} */
  let explain = [];
  let canonLen = 0;
  try {
    const h = dkimBody(mode, alg, l === null ? false : l);
    h.update(body);
    const got = h.digest('base64');
    canonLen = /** @type {any} */ (h).canonicalizedLength;
    if (bh && got === bh) {
      if (l !== null && l < canonLen) return { status: 'partial', explain: [{ kind: 'l_tag', detail: { signed: l, canonical: canonLen, unsigned: canonLen - l } }] };
      return { status: 'matched', explain: [] };
    }
    if (!bh) return { status: 'mismatch', explain: [{ kind: 'unknown' }] };

    // mismatch: try to explain it. The appended/prepended searches are super-linear, so each pays for the
    // bytes it processes out of the message's budget; one the budget cannot cover is skipped and reported
    // as `search_capped`. The canonicalisation and line-ending detectors are one linear pass each, already
    // bounded by MAX_TOTAL_BYTES x MAX_SIGNATURES, so they are never charged to the budget nor blocked by it.
    let capped = false;
    /** @type {BodyExplain | null} */
    let found = null;
    if (l === null) {
      if (!spend(budget, body.length)) capped = true;   // entering the searches (the line split) is charged too
      else {
        const lines = canonLines(body, mode);
        const a = findAppended(lines, mode, alg, bh, budget);
        found = a.found; capped = a.capped;
        if (!found) { const p = findPrepended(lines, mode, alg, bh, budget); found = p.found; capped = capped || p.capped; }
      }
    }
    if (!found) {
      const other = mode === 'simple' ? 'relaxed' : 'simple';
      const o = dkimBody(other, alg, l === null ? false : l);
      o.update(body);
      if (o.digest('base64') === bh) found = { kind: 'canonicalisation', detail: { signed_as: mode, matches_as: other } };
    }
    if (!found && /\r(?!\n)/.test(body.toString('binary'))) {
      const fixed = Buffer.from(body.toString('binary').replace(/\r\n|\r|\n/g, '\r\n'), 'binary');
      const n = dkimBody(mode, alg, l === null ? false : l);
      n.update(fixed);
      if (n.digest('base64') === bh) found = { kind: 'line_endings', detail: { lone_cr: (body.toString('binary').match(/\r(?!\n)/g) || []).length } };
    }
    if (found) explain.push(found);
    else {
      if (capped) explain.push({ kind: 'search_capped', detail: { max_lines: MAX_LINES, max_bytes: MAX_BYTES, max_work_bytes: MAX_WORK } });
      explain.push({ kind: 'unknown' });
    }
  } catch {
    return { status: 'mismatch', explain: [{ kind: 'unknown' }] };
  }
  explain = explain.concat(contextHints(rows, ctx.arc));
  return { status: 'mismatch', explain };
}

/**
 * Record-level summary: the best status over the signatures that verify (all of
 * them when none does). `not-checked` when there is no signature or no raw email.
 * @param {Array<{ body?: BodyResult }>} signatures
 * @param {boolean[]} verifies  Per signature: does it verify at capture?
 * @returns {BodyStatus}
 */
function summariseBody(signatures, verifies) {
  const all = signatures.map((s, i) => ({ s: s.body?.status, ok: !!verifies[i] })).filter((x) => x.s && x.s !== 'not-checked');
  const pool = all.some((x) => x.ok) ? all.filter((x) => x.ok) : all;
  if (!pool.length) return 'not-checked';
  return /** @type {BodyStatus} */ (pool.map((x) => /** @type {'matched' | 'partial' | 'mismatch'} */ (x.s)).sort((a, b) => RANK[b] - RANK[a])[0]);
}

export { analyseBody, summariseBody, canonLines, trimTrailingWs, newBudget };
