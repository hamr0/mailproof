// POC admission gate: ONE linear pass over raw bytes, no regex, no per-line re-scan.
// Every byte is looked at O(1) times: lines are found with Buffer.indexOf(0x0a) (native memchr, each
// byte covered once); the only per-byte JS loop runs over the bytes of DKIM-Signature fields (once).
import { LIMITS } from './limits.js';

const LF = 10, CR = 13, SP = 32, TAB = 9, DASH = 45, COLON = 58, SEMI = 59, EQ = 61;
const DKIM = Buffer.from('dkim-signature'); // compared lower-cased, byte by byte (14 bytes, constant)

const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);

/** Does the field starting at `p` (line end `e`) begin with `DKIM-Signature` + optional WSP + ':' ? */
function isDkimField(buf, p, e) {
  if (e - p < 15) return false;
  for (let i = 0; i < 14; i++) if (lower(buf[p + i]) !== DKIM[i]) return false;
  let q = p + 14;
  while (q < e && (buf[q] === SP || buf[q] === TAB)) q++;
  return buf[q] === COLON;
}

/**
 * Measure `buf`. With `stopEarly` (production) the pass ends at the first limit exceeded.
 * @returns {{ ok: boolean, reason: string|null, m: object }}
 */
export function admit(buf, L = LIMITS, { stopEarly = true } = {}) {
  const n = buf.length;
  const m = { bytes: n, headerBytes: 0, headerLines: 0, headerFields: 0, signatures: 0, maxHNames: 0, maxSigBytes: 0, mimeLines: 0, maxBodyLine: 0, bodyLines: 0 };
  let reason = null;
  const over = (name, v, lim) => { if (v > lim && !reason) reason = name; return stopEarly && reason; };

  let pos = 0, inDkim = false, hCount = 0, tagMode = 0;
  let sigBytes = 0;
  const closeSig = () => { if (inDkim && hCount > m.maxHNames) m.maxHNames = hCount; if (inDkim && sigBytes > m.maxSigBytes) m.maxSigBytes = sigBytes; inDkim = false; };

  // ---- header block: ends at the first empty line ----
  let bodyStart = n;
  while (pos < n) {
    let e = buf.indexOf(LF, pos);
    const next = e < 0 ? n : e + 1;
    if (e < 0) e = n;
    let end = e; if (end > pos && buf[end - 1] === CR) end--;
    if (end === pos) { bodyStart = next; break; }           // empty line: end of headers
    m.headerLines++;
    if (buf[pos] === SP || buf[pos] === TAB) {
      /* fold: belongs to the current field */
    } else {
      closeSig();
      m.headerFields++;
      if (isDkimField(buf, pos, end)) { m.signatures++; inDkim = true; hCount = 0; sigBytes = 0; }
    }
    if (inDkim) {
      sigBytes += next - pos;
      // tag walk over this line's bytes only (once); state (tagMode) carries across folds.
      // 0 = at tag start, 1 = saw 'h', 2 = inside h= value (counting ':'), 3 = inside another tag's value
      let i = pos;
      if (buf[pos] !== SP && buf[pos] !== TAB) { i = buf.indexOf(COLON, pos) + 1; tagMode = 0; }
      for (; i < end; i++) {
        const c = buf[i];
        if (tagMode === 2) { if (c === COLON) hCount++; else if (c === SEMI) tagMode = 0; continue; }
        if (c === SEMI) { tagMode = 0; continue; }
        if (c === SP || c === TAB) continue;
        if (tagMode === 0) tagMode = lower(c) === 104 ? 1 : 3;
        else if (tagMode === 1) { if (c === EQ) { tagMode = 2; hCount = 1; } else tagMode = 3; }
      }
    }
    pos = next;
    if (over('header_bytes', pos, L.MAX_HEADER_BYTES) || over('header_lines', m.headerLines, L.MAX_HEADER_LINES) ||
        over('header_fields', m.headerFields, L.MAX_HEADER_FIELDS) || over('signatures', m.signatures, L.MAX_SIGNATURES) ||
        over('h_names', Math.max(m.maxHNames, inDkim ? hCount : 0), L.MAX_H_NAMES) || over('sig_bytes', Math.max(m.maxSigBytes, inDkim ? sigBytes : 0), L.MAX_SIG_BYTES)) { m.headerBytes = pos; return { ok: false, reason, m }; }
  }
  closeSig();
  m.headerBytes = bodyStart;
  if (!reason) { over('h_names', m.maxHNames, L.MAX_H_NAMES); over('sig_bytes', m.maxSigBytes, L.MAX_SIG_BYTES); }

  // ---- body: one tight byte loop (per-line indexOf costs ~100 ns/line: 25 MB of "\n" took 2.5 s) ----
  // longest line, lines, and lines that start with "--" (MIME boundary upper bound)
  let lineStart = bodyStart, maxLine = 0, lines = 0, dashes = 0;
  for (let i = bodyStart; i < n; i++) {
    if (buf[i] !== LF) continue;
    const len = i - lineStart;
    if (len > maxLine) maxLine = len;
    lines++;
    if (len > 1 && buf[lineStart] === DASH && buf[lineStart + 1] === DASH) dashes++;
    lineStart = i + 1;
  }
  if (lineStart < n) {                         // last line without a final LF
    const len = n - lineStart;
    if (len > maxLine) maxLine = len;
    lines++;
    if (len > 1 && buf[lineStart] === DASH && buf[lineStart + 1] === DASH) dashes++;
  }
  m.maxBodyLine = maxLine; m.bodyLines = lines; m.mimeLines = dashes;
  over('body_line', maxLine, L.MAX_BODY_LINE); over('mime_parts', dashes, L.MAX_MIME_PARTS);
  return { ok: !reason, reason, m };
}
