// The admission gate. ONE linear pass over the raw bytes decides whether a message is small and
// plain enough to hand to the parsers (mailparser, mailauth, our own search) at all. Over any limit
// the message is recorded unverified and never parsed (SPEC Part B, "Limits").
//
// No regex and no per-line re-scan: every byte is looked at a constant number of times. Header
// lines are found with Buffer.indexOf (native memchr; the header block is capped, so its line count
// is too), the body with one byte loop (indexOf per line costs ~100 ns a line, so a body of nothing
// but newlines would be the worst case for it).
//
// The header block and its fields are read the way the parsers read them, so the gate cannot be
// shown fewer signatures or a shorter block than they will see:
//   - the block ends at the first empty line (`\n` or `\r\n`), including an empty FIRST line
//     (mailsplit, mailauth's MessageParser and `splitMessage` all agree; a bare `\r` is no line end);
//   - a DKIM-Signature field is read the way mailauth's `parseHeaders` reads one: `DKIM-Signature`,
//     optional blanks, then the colon, on the same line or (after a fold) on the next, and it runs
//     until the next line that opens a field, junk lines without a colon included.

import {
  MAX_TOTAL_BYTES, MAX_HEADER_BYTES, MAX_HEADER_LINES, MAX_HEADER_FIELDS, MAX_SIGNATURES, MAX_H_NAMES,
  MAX_SIG_BYTES, MAX_MIME_PARTS, MAX_BODY_LINE,
} from './limits.js';

const LF = 10, CR = 13, SP = 32, TAB = 9, DASH = 45, COLON = 58, SEMI = 59, EQ = 61;
const DKIM = Buffer.from('dkim-signature');

/** @param {number} c @returns {number} */
const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);

/**
 * What the gate measured, up to where it stopped (all of it for an admitted message).
 * @typedef {Object} Measure
 * @property {number} bytes
 * @property {number} headerBytes  Header block including its empty line.
 * @property {number} headerLines
 * @property {number} headerFields  Lines that do not start with a space or tab.
 * @property {number} signatures  DKIM-Signature fields.
 * @property {number} maxHNames  Most names in one `h=` (colons + 1, an upper bound).
 * @property {number} maxSigBytes  Largest DKIM-Signature field, folds included.
 * @property {number} mimeParts  Body lines that can be a MIME delimiter (start with `--` or `\r--`).
 * @property {number} maxBodyLine  Longest body line, line ending not counted.
 */

/** `reason` of both verdicts on a message the gate refused. The one form, used everywhere. */
const overLimitReason = (/** @type {string} */ limit) => `over limit: ${limit}`;

/**
 * Length of the field name when the line `[p, e)` opens a header field the way mailauth reads it:
 * printable ASCII without the colon, optional blanks, then the colon, on this line or (the line
 * being only the name and blanks) at the start of the next, which begins at `np` (-1 if none).
 * 0 when it does not open a field (it then continues the field above).
 * @param {Buffer} buf @param {number} p @param {number} e @param {number} np
 * @returns {number}
 */
function fieldNameLength(buf, p, e, np) {
  let q = p;
  while (q < e && buf[q] >= 0x21 && buf[q] <= 0x7e && buf[q] !== COLON) q++;
  const len = q - p;
  if (len === 0) return 0;
  while (q < e && (buf[q] === SP || buf[q] === TAB || buf[q] === CR)) q++;
  if (q < e) return buf[q] === COLON ? len : 0;
  if (np < 0) return 0;
  let r = np;
  while (r < buf.length && (buf[r] === SP || buf[r] === TAB || buf[r] === CR)) r++;
  return r < buf.length && buf[r] === COLON ? len : 0;
}

/** @param {Buffer} buf @param {number} p  Start of a name of length 14. @returns {boolean} */
function isDkimName(buf, p) {
  for (let i = 0; i < 14; i++) if (lower(buf[p + i]) !== DKIM[i]) return false;
  return true;
}

/**
 * Body: the longest line and the MIME-delimiter-like lines, in `m`. Short lines (most of them) end
 * within a few bytes, so the first 32 bytes of a line are searched with a plain loop and only a longer
 * line costs an indexOf call; an empty line costs one compare. (indexOf alone is ~100 ns a line,
 * which makes a body of nothing but newlines the worst case.) A function of its own so the engine
 * compiles the loop on its own.
 * @param {Buffer} buf @param {number} start @param {Measure} m
 */
function scanBody(buf, start, m) {
  const n = buf.length;
  let ls = start, maxLine = 0, parts = 0;
  while (ls < n) {
    if (buf[ls] === LF) { ls++; continue; }
    let e = ls;
    const stop = ls + 32 < n ? ls + 32 : n;
    while (e < stop && buf[e] !== LF) e++;
    if (e === stop && stop < n) { e = buf.indexOf(LF, e); if (e < 0) e = n; }
    let len = e - ls;
    if (e < n && buf[e - 1] === CR) len--;
    if (len > maxLine) maxLine = len;
    // a MIME delimiter starts with `--`; mailsplit also takes a lone CR in front of it
    const c = buf[ls];
    if (c === DASH ? buf[ls + 1] === DASH : (c === CR && buf[ls + 1] === DASH && buf[ls + 2] === DASH)) parts++;
    ls = e + 1;
  }
  m.maxBodyLine = maxLine;
  m.mimeParts = parts;
}

/**
 * Measure `buf` against every limit in one pass; stops at the first limit exceeded.
 * @param {Buffer} buf
 * @returns {{ ok: boolean, limit: string | null, m: Measure }}  `limit` names the limit exceeded
 *   (`total_bytes`, `header_bytes`, `header_lines`, `header_fields`, `signatures`, `h_names`,
 *   `sig_bytes`, `mime_parts`, `body_line`), else null.
 */
function admit(buf) {
  const n = buf.length;
  /** @type {Measure} */
  const m = { bytes: n, headerBytes: 0, headerLines: 0, headerFields: 0, signatures: 0, maxHNames: 0, maxSigBytes: 0, mimeParts: 0, maxBodyLine: 0 };
  const refuse = (/** @type {string} */ limit) => ({ ok: false, limit, m });
  if (n > MAX_TOTAL_BYTES) return refuse('total_bytes');

  // ---- header block: ends at the first empty line ----
  let pos = 0, bodyStart = n;
  let inSig = false, seenColon = false, hCount = 0, sigBytes = 0;
  // tag state inside a signature: 0 at a tag start, 1 after `h`, 2 in the h= value, 3 in another tag's value
  let tag = 0;
  // The first line always opens a field in mailauth, and the name of a field is the text up to the
  // first colon in it with line breaks removed and blanks trimmed, so the first field can be a
  // signature although no line of it looks like one. It is decided here byte by byte (`fk` bytes of
  // the name matched, 14 = complete) while it is `pending`.
  let pending = false, fk = 0;
  /** Count one more signature. @returns {boolean} true when that is over the limit */
  const sign = () => { m.signatures++; inSig = true; seenColon = false; hCount = 0; tag = 0; return m.signatures > MAX_SIGNATURES; };
  /** The first field ends: if its name turned out to be DKIM-Signature with no colon at all, it is a signature. @returns {string | null} the limit exceeded */
  const endFirst = () => {
    if (!pending || fk !== 14) return null;
    if (sign()) return 'signatures';
    if (sigBytes > m.maxSigBytes) m.maxSigBytes = sigBytes;
    return m.maxSigBytes > MAX_SIG_BYTES ? 'sig_bytes' : null;
  };
  while (pos < n) {
    const e = buf.indexOf(LF, pos);
    const next = e < 0 ? n : e + 1;
    if (next > MAX_HEADER_BYTES) { m.headerBytes = next; return refuse('header_bytes'); }
    let end = e < 0 ? n : e;
    if (e >= 0 && end > pos && buf[end - 1] === CR) end--;
    if (end === pos && e >= 0) { bodyStart = next; break; }
    m.headerLines++;
    if (m.headerLines > MAX_HEADER_LINES) return refuse('header_lines');
    const fold = buf[pos] === SP || buf[pos] === TAB;
    if (!fold) {
      m.headerFields++;
      if (m.headerFields > MAX_HEADER_FIELDS) return refuse('header_fields');
    }
    if (m.headerLines === 1) { pending = true; fk = 0; sigBytes = 0; }
    else if (!fold) {
      const nameLen = fieldNameLength(buf, pos, end, next < n ? next : -1);
      if (nameLen > 0) {                       // a new field: the one before it is complete
        const bare = endFirst();
        if (bare) return refuse(bare);
        pending = false; inSig = false;
        if (nameLen === 14 && isDkimName(buf, pos)) { if (sign()) return refuse('signatures'); sigBytes = 0; }
      }
    }
    if (inSig || pending) {
      sigBytes += next - pos;
      for (let i = pos; i < end; i++) {
        const c = buf[i];
        if (pending) {
          if (c === COLON) { pending = false; if (fk === 14) { if (sign()) return refuse('signatures'); seenColon = true; } }
          else if (c === SP || c === TAB) { if (fk !== 0 && fk !== 14) pending = false; }
          else if (fk < 14 && lower(c) === DKIM[fk]) fk++;
          else pending = false;
          continue;
        }
        if (!inSig) break;
        if (!seenColon) { if (c === COLON) seenColon = true; continue; }
        if (tag === 2) {
          if (c === COLON) { hCount++; if (hCount > m.maxHNames) m.maxHNames = hCount; } else if (c === SEMI) tag = 0;
          continue;
        }
        if (c === SEMI) { tag = 0; continue; }
        if (c === SP || c === TAB) continue;
        if (tag === 0) tag = lower(c) === 104 ? 1 : 3;
        else if (tag === 1) {
          if (c === EQ) { tag = 2; hCount = 1; if (m.maxHNames < 1) m.maxHNames = 1; } else tag = 3;
        }
      }
      if (inSig) {
        if (sigBytes > m.maxSigBytes) m.maxSigBytes = sigBytes;
        if (m.maxHNames > MAX_H_NAMES) return refuse('h_names');
        if (m.maxSigBytes > MAX_SIG_BYTES) return refuse('sig_bytes');
      }
    }
    pos = next;
  }
  const bare = endFirst();
  if (bare) return refuse(bare);
  m.headerBytes = bodyStart;

  scanBody(buf, bodyStart, m);
  if (m.maxBodyLine > MAX_BODY_LINE) return refuse('body_line');
  if (m.mimeParts > MAX_MIME_PARTS) return refuse('mime_parts');
  return { ok: true, limit: null, m };
}

export { admit, overLimitReason };
