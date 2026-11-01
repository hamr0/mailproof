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
import { relayEvidence } from './relay.js';

/** @typedef {import('./types.js').BodyResult} BodyResult */
/** @typedef {import('./types.js').BodyExplain} BodyExplain */
/** @typedef {import('./types.js').BodyStatus} BodyStatus */
/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

/** Search caps: cut points further than this from the matching end are not tried. */
const MAX_LINES = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
/** Total bytes the prepended search may hash (it is O(candidates x size)). */
const MAX_WORK = 64 * 1024 * 1024;

const RANK = { matched: 3, partial: 2, mismatch: 1 };

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
  const lines = mode === 'relaxed' ? parts.map((l) => l.replace(/[ \t]+$/, '').replace(/[ \t]+/g, ' ')) : parts;
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
 * Appended content: some canonical prefix, cut at a line boundary, hashes to bh.
 * @returns {{ found: BodyExplain | null, capped: boolean }}
 */
function findAppended(lines, mode, alg, bh) {
  const m = lines.length;
  const sizes = lines.map((l) => l.length + 2);
  const total = sizes.reduce((a, b) => a + b, 0);
  // j = -1 is the empty prefix: the signed body was empty
  if (digest(alg, canonBytes([], mode)) === bh) return { found: { kind: 'appended', detail: { bytes: total, lines: m } }, capped: false };
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
 * Prepended content: some canonical suffix, cut at a line boundary, hashes to bh.
 * @returns {{ found: BodyExplain | null, capped: boolean }}
 */
function findPrepended(lines, mode, alg, bh) {
  const m = lines.length;
  let removed = 0;
  let work = 0;
  for (let i = 1; i < m; i++) {
    removed += lines[i - 1].length + 2;
    if (i > MAX_LINES || removed > MAX_BYTES) return { found: null, capped: true };
    const bytes = canonBytes(lines.slice(i), mode);
    work += bytes.length;
    if (work > MAX_WORK) return { found: null, capped: true };
    if (digest(alg, bytes) === bh) return { found: { kind: 'prepended', detail: { bytes: removed, lines: i } }, capped: false };
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
 * @param {{ rows?: HeaderRow[], arc?: string | null }} [ctx]
 * @returns {BodyResult}
 */
function analyseBody(tags, body, ctx = {}) {
  const rows = ctx.rows || [];
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

    // mismatch: try to explain it
    const lines = canonLines(body, mode);
    let capped = false;
    /** @type {BodyExplain | null} */
    let found = null;
    if (l === null) {
      const a = findAppended(lines, mode, alg, bh);
      found = a.found; capped = a.capped;
      if (!found) { const p = findPrepended(lines, mode, alg, bh); found = p.found; capped = capped || p.capped; }
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

export { analyseBody, summariseBody, canonLines, MAX_LINES, MAX_BYTES };
