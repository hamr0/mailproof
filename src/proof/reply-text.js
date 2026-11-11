// M2 reply text (SPEC B6): the text a sender newly wrote in a reply, with quoted history removed, by the versioned,
// deterministic stripper `mailproof-quote/1`. Stdlib only and no mailparser: the result depends on the raw bytes, the
// rules below and the platform's TextDecoder, nothing else, except two charsets whose Node 22.19.0 TextDecoder differs from later versions: windows-1252 (and every label WHATWG
// maps to it, including us-ascii and iso-8859-1) returns raw C1 controls for 0x80-0x9F, so it is decoded in-house
// (decodeWindows1252); GBK (gbk, gb2312, ...) maps some sequences to private-use code points, so it is decoded as
// gb18030, which the WHATWG standard defines it to be. The rules are FROZEN: a change is a new stripper version
// (`/2`) in a new file name, never an edit of `/1` (SPEC B6.5). The POC it was proven with is poc/m2-quotes/strip.mjs
// (findings F20); a test pins the two together.
//
// Linear in the input: no regular expression here can backtrack over unbounded input (a run of spaces, a long
// paragraph of flowed lines, a long quote depth), so the admission gate (admit.js) plus the worker backstop bound the cost.
// The pure functions run on the main thread (worker size 0) or in a worker (worker.js).

import { admit } from './admit.js';
import { hashDocument } from './hash.js';
import { replyPath } from './layout.js';

/** The stripper version string; its slug names the committed file. */
const STRIPPER = 'mailproof-quote/1';

/** @typedef {'attribution' | 'forward-marker' | 'outlook-original' | 'outlook-header' | 'quote-run'} BoundaryKind */
/**
 * @typedef {Object} Stripped
 * @property {'text/plain' | 'html-only'} source
 * @property {string} text  The new text; '' for html-only.
 * @property {string} text_sha256  `sha256:<hex>` of the UTF-8 bytes of `text`.
 * @property {number} text_bytes
 * @property {'found' | 'not-found' | 'inline'} quote
 * @property {boolean} trailing  Unquoted text follows the quoted part and was not returned.
 * @property {BoundaryKind | null} boundary
 */
/** @typedef {{ ok: true, stripped: Stripped } | { ok: false, limit: string }} Extracted */

/** The reply-text path for a stripper version (the `/` of the version string becomes `-`): see `replyPath` in layout.js. */
const replyTextPath = (/** @type {string} */ id, stripper = STRIPPER) => replyPath(id, stripper.replace('/', '-'));

// ---- minimal header / MIME parsing (the message is a Latin-1 string: one char per byte) ------------------------
/** @typedef {{ headers: Map<string, string[]>, body: string }} Msg */

/**
 * @param {string} s
 * @returns {Msg}
 */
function parseMessage(s) {
  const a = s.indexOf('\r\n\r\n'), b = s.indexOf('\n\n');
  let end, skip;
  if (a >= 0 && (b < 0 || a < b)) { end = a; skip = 4; } else if (b >= 0) { end = b; skip = 2; } else { end = s.length; skip = 0; }
  /** @type {Map<string, string[]>} */
  const headers = new Map();
  const unfolded = s.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    let list = headers.get(k);
    if (!list) headers.set(k, (list = []));
    list.push(line.slice(i + 1).trim());
  }
  return { headers, body: s.slice(end + skip) };
}
const h1 = (/** @type {Msg} */ m, /** @type {string} */ k) => (m.headers.get(k) ?? [])[0] ?? '';

/**
 * @param {string} v
 * @returns {{ type: string, params: Record<string, string> }}
 */
function parseParams(v) {
  const parts = v.split(';');
  const type = (parts.shift() ?? '').trim().toLowerCase();
  /** @type {Record<string, string>} */
  const params = {};
  for (const p of parts) {
    const m = /^\s*([^=\s]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)\s*$/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2].trim();
  }
  return { type, params };
}

/**
 * The pieces between the delimiter lines of a multipart body.
 * @param {string} s
 * @param {string} boundary
 * @returns {string[]}
 */
function splitMultipart(s, boundary) {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|\\r?\\n)--' + esc + '(--)?[ \\t]*(?:\\r?\\n|$)', 'g');
  /** @type {string[]} */
  const out = [];
  let m, last = -1;
  while ((m = re.exec(s))) {
    if (last >= 0) out.push(s.slice(last, m.index));
    if (m[1]) { last = -1; break; }
    last = m.index + m[0].length;
  }
  if (last >= 0) out.push(s.slice(last));
  return out;
}

/**
 * First leaf of media type `type`, depth first; not inside message/rfc822, not an attachment.
 * @param {Msg} msg
 * @param {string} type  Lower case, e.g. `text/plain`.
 * @returns {{ msg: Msg, ct: { type: string, params: Record<string, string> } } | null}
 */
function findPart(msg, type) {
  const ct = parseParams(h1(msg, 'content-type') || 'text/plain; charset=us-ascii');
  const disp = h1(msg, 'content-disposition').toLowerCase();
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    for (const child of splitMultipart(msg.body, ct.params.boundary)) {
      const r = findPart(parseMessage(child), type);
      if (r) return r;
    }
    return null;
  }
  if (ct.type === type && !disp.startsWith('attachment')) return { msg, ct };
  return null;
}

/** First text/plain leaf (the stripper's part). @param {Msg} msg */
const findTextPart = (msg) => findPart(msg, 'text/plain');

// ---- transfer + charset decoding ---------------------------------------------------------------------------
const CR = 13, LF = 10, SP = 32, TAB = 9, EQ = 0x3d;
const hexVal = (/** @type {number} */ c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

/**
 * Quoted-printable, two linear passes: (1) drop spaces/tabs directly before a line break and remove soft breaks
 * (`=` + optional blanks + line break), (2) `=XX` to a byte; any other `=` stays.
 * @param {string} s  Latin-1 text.
 * @returns {Buffer}
 */
function decodeQP(s) {
  const n = s.length;
  const t = Buffer.allocUnsafe(n);
  let o = 0;
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    if (c === SP || c === TAB || c === EQ) {
      let j = c === EQ ? i + 1 : i;
      while (j < n && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
      const nl = j < n && (s.charCodeAt(j) === LF || (s.charCodeAt(j) === CR && s.charCodeAt(j + 1) === LF));
      if (nl) {
        // blanks before a line break are dropped; an `=` before them (a soft break) takes the break with it
        if (c === EQ) i = s.charCodeAt(j) === CR ? j + 2 : j + 1;
        else i = j;
        continue;
      }
      // not before a line break: the blanks (or the `=`) stay; the run is copied as is
      if (c === EQ) { t[o++] = EQ; i++; } else { for (; i < j; i++) t[o++] = s.charCodeAt(i); }
      continue;
    }
    t[o++] = c & 0xff;
    i++;
  }
  const out = Buffer.allocUnsafe(o);
  let p = 0;
  for (let i = 0; i < o; i++) {
    const c = t[i];
    if (c === EQ && i + 2 < o && hexVal(t[i + 1]) >= 0 && hexVal(t[i + 2]) >= 0) { out[p++] = hexVal(t[i + 1]) * 16 + hexVal(t[i + 2]); i += 2; }
    else out[p++] = c;
  }
  return out.subarray(0, p);
}

const B64 = new Int8Array(256).fill(-1);
for (const [i, ch] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) B64[ch.charCodeAt(0)] = i;
/**
 * @param {string} s  Latin-1 text.
 * @returns {Buffer}
 */
function decodeB64(s) {
  const out = Buffer.allocUnsafe(Math.ceil((s.length * 3) / 4) + 3);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64[s.charCodeAt(i)];   // the text is Latin-1, so the code is below 256
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; acc &= (1 << bits) - 1; }
  }
  return out.subarray(0, o);
}

/** WHATWG index-windows-1252 for bytes 0x80-0x9F; the five unmapped bytes (81 8D 8F 90 9D) map to the C1 control of the same value. */
const WINDOWS_1252_C1 = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

/**
 * windows-1252 decoded here, not by TextDecoder, which differs across Node versions for 0x80-0x9F.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeWindows1252(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    parts.push(String.fromCharCode(...Array.from(chunk, (b) => (b >= 0x80 && b <= 0x9f ? WINDOWS_1252_C1.charCodeAt(b - 0x80) : b))));
  }
  return parts.join('');
}

/**
 * @param {{ msg: Msg, ct: { type: string, params: Record<string, string> } }} part
 * @returns {{ text: string, flowed: boolean, delsp: boolean }}
 */
function decodePart(part) {
  const cte = h1(part.msg, 'content-transfer-encoding').toLowerCase().trim() || '7bit';
  const body = part.msg.body;
  const bytes = cte === 'quoted-printable' ? decodeQP(body) : cte === 'base64' ? decodeB64(body) : Buffer.from(body, 'latin1');
  const charset = (part.ct.params.charset || 'us-ascii').toLowerCase();
  let text;
  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    text = decoder.encoding === 'windows-1252' ? decodeWindows1252(bytes)
      : decoder.encoding === 'gbk' ? new TextDecoder('gb18030', { fatal: false }).decode(bytes)
      : decoder.decode(bytes);
  } catch { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  return { text, flowed: (part.ct.params.format || '').toLowerCase() === 'flowed', delsp: (part.ct.params.delsp || '').toLowerCase() === 'yes' };
}

// ---- lines ---------------------------------------------------------------------------------------------------
/** Number of leading `>`. */
function depthOf(/** @type {string} */ l) {
  let d = 0;
  while (d < l.length && l.charCodeAt(d) === 0x3e) d++;
  return d;
}

/**
 * RFC 3676 unflow (quote-depth aware): a line ending in a space continues onto the next line of the same depth.
 * Pieces are collected and joined once, so a long paragraph costs its length, not its length squared.
 * @param {string[]} lines
 * @param {boolean} delsp
 * @returns {string[]}
 */
function unflow(lines, delsp) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const d = depthOf(lines[i]);
    /** @type {string[]} */
    const parts = [];   // no empty piece is kept, so the last piece holds the last char
    let len = 0;
    const add = (/** @type {string} */ x) => { if (x !== '') { parts.push(x); len += x.length; } };
    add(lines[i]);
    while (parts.length && parts[parts.length - 1].endsWith(' ')
      && !(len === 3 && parts.join('') === '-- ')
      && i + 1 < lines.length && depthOf(lines[i + 1]) === d) {
      const nxt = lines[++i].replace(/^>+ ?/, '');
      if (delsp) {   // drop the last char of what is joined so far
        const last = parts[parts.length - 1];
        len--;
        if (last.length === 1) parts.pop(); else parts[parts.length - 1] = last.slice(0, -1);
      }
      add(nxt);
    }
    out.push(parts.length === 1 ? parts[0] : parts.join(''));
  }
  return out;
}

// ---- boundary detection --------------------------------------------------------------------------------------
const ATT_START = /^\s*(on|op|am|le|el|il|em|den|på|dne|w dniu)\b/i;
const ATT_END_TAIL = /(wrote|schreef|schrieb|a écrit|a ecrit|escribió|escribio|ha scritto|escreveu|skrev|napisał|napisala)$/i;
const ATT_VERB_MAX = 10;   // the longest listed verb ("ha scritto")
/** Does `s`, trimmed, end in a listed verb, optionally followed by white space, one ':' and white space? Linear: only the last few characters reach a regex. */
export function endsAttribution(/** @type {string} */ s) {
  let t = s.trimEnd();
  if (t.endsWith(':')) t = t.slice(0, -1).trimEnd();
  return ATT_END_TAIL.test(t.slice(-ATT_VERB_MAX));
}
// Name-after-verb form (`Op vr 7 nov 2026 om 10:00 schreef Amr <a@example.com>:`): an opener, a listed verb anywhere, a signal, a final colon.
const ATT_VERB = /(?<![\p{L}])(wrote|schreef|schrieb|a écrit|a ecrit|escribió|escribio|ha scritto|escreveu|skrev|napisał|napisala)(?![\p{L}])/iu;
// Language-independent signal: a 4-digit year, an hh:mm time or an '@'.
const SIGNAL = /\d{4}|\d{1,2}:\d{2}|@/;
const LOOKBACK_MAX = 400;   // an attribution line is never longer than this
const OUT_FROM = /^\s*(from|van|von|de|da|från)\s*:/i;
const OUT_SENT = /^\s*(sent|verzonden|gesendet|envoyé|envoye|enviado|date|datum)\s*:/i;
const FWD = /^\s*(-{3,}\s*(forwarded message|doorgestuurd bericht|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*-{3,}|begin forwarded message\s*:|_{3,}\s*forwarded message\s*_{3,})\s*$/i;
const ORIGINAL = /^\s*-{3,}\s*original message\s*-{3,}/i;
const RULE = /^\s*[_\-=]{10,}\s*$/;

/** Name-after-verb form over at most 2 joined lines (acc is at most 400 chars here). */
function nameAfterVerb(/** @type {string} */ acc, /** @type {number} */ n) {
  if (n > 2) return false;
  const t = acc.trim();
  return t.endsWith(':') && SIGNAL.test(t) && ATT_VERB.test(t);
}
/**
 * Lines in an attribution that starts at line `i` (0 when none). It spans up to 4 lines; lines 1 to 3 are tested only
 * while the joined text is at most 400 characters, and the 4-line test has no length cap (it is linear, see endsAttribution).
 */
function attributionAt(/** @type {string[]} */ lines, /** @type {number} */ i) {
  if (!ATT_START.test(lines[i])) return 0;
  let acc = lines[i];
  for (let n = 1; n <= 3; n++) {
    if (acc.length > 400) return 0;
    if (nameAfterVerb(acc, n) || endsAttribution(acc)) return n;
    if (i + n >= lines.length || lines[i + n].trim() === '') return 0;
    acc += ' ' + lines[i + n].trim();
  }
  return endsAttribution(acc) ? 4 : 0;
}
/** Is `l` a short line that ends in a colon (spaces after it allowed)? */
function endsColon(/** @type {string} */ l) { return l.length <= LOOKBACK_MAX && l.trimEnd().endsWith(':'); }
/** Does this first line of a 2-line block read as the start of a wrapped attribution? */
function isWrapStart(/** @type {string} */ l) {
  if (l.trim() === '' || l.length > LOOKBACK_MAX) return false;
  const t = l.trimEnd();
  if (t.lastIndexOf('<') > t.lastIndexOf('>')) return true;   // an address opened and not closed
  return SIGNAL.test(t) && !/[.!?]$/.test(t);                  // a date/time/address that does not end a sentence
}
/**
 * Language-independent attribution above a `>` run that starts at line `q`: up to one blank line, then a block of
 * 1 or 2 adjacent non-blank lines whose last line ends in ":" and itself carries a signal; the first line of a 2-line
 * block is part of it only when it is a wrap start. Returns the block's first line, or -1.
 */
function attributionAbove(/** @type {string[]} */ lines, /** @type {number} */ q) {
  let j = q - 1;
  if (j >= 0 && lines[j].trim() === '') j--;
  if (j < 0 || lines[j].trim() === '' || !endsColon(lines[j]) || !SIGNAL.test(lines[j])) return -1;
  if (j >= 1 && isWrapStart(lines[j - 1])) return j - 1;
  return j;
}
function outlookAt(/** @type {string[]} */ lines, /** @type {number} */ i) {
  if (!OUT_FROM.test(lines[i])) return false;
  for (let n = 1; n <= 4 && i + n < lines.length; n++) if (OUT_SENT.test(lines[i + n])) return true;
  return false;
}

/**
 * The first boundary: `start` = first line of the quote region, `end` = first line after the attribution or header
 * block, or null.
 * @param {string[]} lines
 * @returns {{ start: number, end: number, kind: BoundaryKind } | null}
 */
function findBoundary(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const a = attributionAt(lines, i);
    if (a) return { start: i, end: i + a, kind: 'attribution' };
    if (FWD.test(l)) return { start: i, end: i + 1, kind: 'forward-marker' };
    if (ORIGINAL.test(l)) return { start: i, end: i + 1, kind: 'outlook-original' };
    if (outlookAt(lines, i)) {
      let s = i;
      if (i > 0 && RULE.test(lines[i - 1])) s = i - 1;           // the rule line Outlook draws above its header block
      let e = i; while (e < lines.length && lines[e].trim() !== '') e++;
      return { start: s, end: e, kind: 'outlook-header' };
    }
    if (l.startsWith('>')) {
      const s = attributionAbove(lines, i);
      return s >= 0 ? { start: s, end: i, kind: 'attribution' } : { start: i, end: i, kind: 'quote-run' };
    }
  }
  return null;
}

/** Inline: after the boundary region, a non-empty unquoted line followed later by a `>` line. */
function isInline(/** @type {string[]} */ lines, /** @type {{ end: number }} */ b) {
  let seenUnquoted = false;
  for (let i = b.end; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.startsWith('>')) { if (seenUnquoted) return true; } else seenUnquoted = true;
  }
  return false;
}

/** Is there a non-empty unquoted line after the last `>` line? (False when there is no `>` line at all.) */
function textAfterLastQuoteLine(/** @type {string[]} */ lines) {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('>')) { last = i; break; }
  if (last < 0) return false;
  for (let i = last + 1; i < lines.length; i++) if (lines[i].trim() !== '') return true;
  return false;
}

/**
 * @param {string} text
 * @returns {{ text_sha256: string, text_bytes: number }}
 */
function fingerprint(text) {
  const bytes = Buffer.from(text, 'utf8');
  return { text_sha256: hashDocument(bytes), text_bytes: bytes.length };
}

/**
 * The stripper `mailproof-quote/1` (SPEC B6.3, B6.4). Pure; never throws on message content.
 * @param {Buffer} raw
 * @returns {Stripped}
 */
function stripReplyText(raw) {
  const part = findTextPart(parseMessage(raw.toString('latin1')));
  if (!part) return { source: 'html-only', text: '', ...fingerprint(''), quote: 'not-found', trailing: false, boundary: null };
  const d = decodePart(part);
  let lines = d.text.replace(/\r\n?/g, '\n').split('\n');
  if (d.flowed) lines = unflow(lines, d.delsp);
  const b = findBoundary(lines);
  const text = (b ? lines.slice(0, b.start) : lines).join('\n').trimEnd();   // trimEnd and \s are the same character set
  const quote = !b ? 'not-found' : isInline(lines, b) ? 'inline' : 'found';
  return {
    source: 'text/plain', text, ...fingerprint(text), quote,
    trailing: quote === 'found' && textAfterLastQuoteLine(lines),
    boundary: b ? b.kind : null,
  };
}

/**
 * Gate, then strip: what a worker (or the in-process path) runs for `replyText`. A message over a gate limit is not
 * read by the stripper.
 * @param {Buffer} raw
 * @returns {Extracted}
 */
function extractReplyText(raw) {
  const gate = admit(raw);
  if (!gate.ok) return { ok: false, limit: /** @type {string} */ (gate.limit) };
  return { ok: true, stripped: stripReplyText(raw) };
}

/**
 * The committed reply-text record (SPEC B6.2): fingerprints and flags, never the text, the body or the subject.
 * @param {{ id: string, stripped: Stripped, body_status: string, extracted_at: string }} a
 */
function replyTextRecord({ id, stripped: s, body_status, extracted_at }) {
  return {
    v: 2, kind: 'reply-text', record_id: id,
    text_sha256: s.text_sha256, text_bytes: s.text_bytes,
    stripper: STRIPPER, quote: s.quote, trailing: s.trailing, source: s.source, boundary: s.boundary,
    body_status, extracted_at,
  };
}

export { STRIPPER, replyTextPath, stripReplyText, extractReplyText, replyTextRecord, decodeWindows1252, parseMessage, findPart, decodePart, unflow };
