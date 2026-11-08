// mailproof-quote/1 candidate stripper. POC, never shipped. Stdlib only, no mailparser: the result depends on
// the raw bytes and this file alone. Exports: parseMessage, findTextPart, decodePart, strip, classify.
import { createHash } from 'node:crypto';

export const STRIPPER = 'mailproof-quote/1';

// ---- minimal header / MIME parsing (hand-written) ------------------------------------------------------------
export function parseMessage(buf) {
  const s = buf.toString('latin1');
  const a = s.indexOf('\r\n\r\n'), b = s.indexOf('\n\n');
  let end, skip;
  if (a >= 0 && (b < 0 || a < b)) { end = a; skip = 4; } else if (b >= 0) { end = b; skip = 2; } else { end = s.length; skip = 0; }
  const headers = new Map();
  const unfolded = s.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    (headers.get(k) ?? headers.set(k, []).get(k)).push(line.slice(i + 1).trim());
  }
  return { headers, body: Buffer.from(s.slice(end + skip), 'latin1') };
}
export const h1 = (m, k) => (m.headers.get(k) ?? [])[0] ?? '';

export function parseParams(v) {
  const parts = v.split(';');
  const type = parts.shift().trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const m = /^\s*([^=\s]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)\s*$/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2].trim();
  }
  return { type, params };
}

// First text/plain leaf (depth first, not inside message/rfc822, not an attachment). Also reports text/html seen.
export function findTextPart(msg, seen = { html: false, parts: 0 }) {
  const ct = parseParams(h1(msg, 'content-type') || 'text/plain; charset=us-ascii');
  const disp = h1(msg, 'content-disposition').toLowerCase();
  seen.parts++;
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    for (const child of splitMultipart(msg.body, ct.params.boundary)) {
      const r = findTextPart(parseMessage(child), seen);
      if (r.part) return r;
    }
    return { part: null, seen };
  }
  if (ct.type === 'text/html' && !disp.startsWith('attachment')) seen.html = true;
  if (ct.type === 'text/plain' && !disp.startsWith('attachment')) return { part: { msg, ct }, seen };
  return { part: null, seen };
}

export function splitMultipart(body, boundary) {
  const s = body.toString('latin1');
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|\\r?\\n)--' + esc + '(--)?[ \\t]*(?:\\r?\\n|$)', 'g');
  const out = [];
  let m, last = -1;
  while ((m = re.exec(s))) {
    if (last >= 0) out.push(Buffer.from(s.slice(last, m.index), 'latin1'));
    if (m[1]) { last = -1; break; }
    last = m.index + m[0].length;
  }
  if (last >= 0) out.push(Buffer.from(s.slice(last), 'latin1'));
  return out;
}

// Direct message/rfc822 children of a (digest) message, at any multipart depth.
export function rfc822Parts(msg, acc = []) {
  const ct = parseParams(h1(msg, 'content-type') || 'text/plain');
  if (ct.type === 'message/rfc822') { acc.push(msg.body); return acc; }
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    for (const c of splitMultipart(msg.body, ct.params.boundary)) {
      const child = parseMessage(c);
      const cct = parseParams(h1(child, 'content-type') || (ct.type === 'multipart/digest' ? 'message/rfc822' : 'text/plain'));
      if (cct.type === 'message/rfc822') acc.push(child.body); else rfc822Parts(child, acc);
    }
  }
  return acc;
}

// ---- transfer + charset decoding (hand-written) --------------------------------------------------------------
function decodeQP(latin) {
  const t = latin.replace(/[ \t]+(?=\r?\n)/g, '').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out.push(c & 0xff);
  }
  return Buffer.from(out);
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeB64(latin) {
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of latin) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}
export function decodePart(part) {
  const cte = h1(part.msg, 'content-transfer-encoding').toLowerCase().trim() || '7bit';
  const lat = part.msg.body.toString('latin1');
  const bytes = cte === 'quoted-printable' ? decodeQP(lat) : cte === 'base64' ? decodeB64(lat) : part.msg.body;
  const charset = (part.ct.params.charset || 'us-ascii').toLowerCase();
  let text, unsupported = false;
  try { text = new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { unsupported = true; text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  return { text, cte, charset, unsupported, flowed: (part.ct.params.format || '').toLowerCase() === 'flowed', delsp: (part.ct.params.delsp || '').toLowerCase() === 'yes' };
}

// RFC 3676 unflow (quote-depth aware): a line ending in a space continues onto the next line of the same depth.
export function unflow(lines, delsp) {
  const out = [];
  const depth = (l) => { const m = /^(>*)/.exec(l); return m[1].length; };
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const d = depth(l);
    while (/ $/.test(l) && !/^-- $/.test(l) && i + 1 < lines.length && depth(lines[i + 1]) === d) {
      const nxt = lines[++i].replace(/^>+ ?/, '');
      l = (delsp ? l.slice(0, -1) : l) + nxt;
    }
    out.push(l);
  }
  return out;
}

export function normalize(text, flowed, delsp) {
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (flowed) lines = unflow(lines, delsp);
  return lines;
}

// ---- boundary detection --------------------------------------------------------------------------------------
const ATT_START = /^\s*(on|op|am|le|el|il|em|den|på|dne|w dniu)\b/i;
const ATT_END_TAIL = /(wrote|schreef|schrieb|a écrit|a ecrit|escribió|escribio|ha scritto|escreveu|skrev|napisał|napisala)$/i;
const ATT_VERB_MAX = 10;   // the longest listed verb ("ha scritto")
/** Does `s`, trimmed, end in a listed verb, optionally followed by white space, one ':' and white space? Linear: only the last few characters reach a regex. */
function endsAttribution(s) {
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
const RULE = /^\s*[_\-=]{10,}\s*$/;

/** Name-after-verb form over at most 2 joined lines (acc is at most 400 chars here). */
function nameAfterVerb(acc, n) {
  if (n > 2) return false;
  const t = acc.trim();
  return t.endsWith(':') && SIGNAL.test(t) && ATT_VERB.test(t);
}
function attributionAt(lines, i) {
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
function endsColon(l) { return l.length <= LOOKBACK_MAX && l.trimEnd().endsWith(':'); }
/** Does this first line of a 2-line block read as the start of a wrapped attribution? */
function isWrapStart(l) {
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
function attributionAbove(lines, q) {
  let j = q - 1;
  if (j >= 0 && lines[j].trim() === '') j--;
  if (j < 0 || lines[j].trim() === '' || !endsColon(lines[j]) || !SIGNAL.test(lines[j])) return -1;
  if (j >= 1 && isWrapStart(lines[j - 1])) return j - 1;
  return j;
}
function outlookAt(lines, i) {
  if (!OUT_FROM.test(lines[i])) return false;
  for (let n = 1; n <= 4 && i + n < lines.length; n++) if (OUT_SENT.test(lines[i + n])) return true;
  return false;
}

// Returns { start, end, kind } of the first boundary (start = first line of the quote region; end = first line
// after the attribution / header block), or null.
export function findBoundary(lines, { detectors = true } = {}) {
  if (!detectors) return null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const a = attributionAt(lines, i);
    if (a) return { start: i, end: i + a, kind: 'attribution' };
    if (FWD.test(l)) return { start: i, end: i + 1, kind: 'forward-marker' };
    if (/^\s*-{3,}\s*original message\s*-{3,}/i.test(l)) return { start: i, end: i + 1, kind: 'outlook-original' };
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

// Inline: after the boundary region, a non-empty unquoted line followed later by a '>' line.
function isInline(lines, b) {
  let seenUnquoted = false;
  for (let i = b.end; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.startsWith('>')) { if (seenUnquoted) return true; } else seenUnquoted = true;
  }
  return false;
}
// Non-empty unquoted lines after the LAST '>' line (a signature below the quote, or bottom-posted text).
// `trailing` (below) is true when there are any and the reply is not inline; the text is still cut at the first boundary.
function afterQuoteLines(lines) {
  let last = -1;
  lines.forEach((l, i) => { if (l.startsWith('>')) last = i; });
  if (last < 0) return 0;
  return lines.slice(last + 1).filter((l) => l.trim() !== '').length;
}

export function strip(raw, opts = {}) {
  const msg = parseMessage(raw);
  const { part, seen } = findTextPart(msg);
  if (!part) return { stripper: STRIPPER, source: 'html-only', html: seen.html, text: null, quote: null, trailing: false, boundary: null };
  const d = decodePart(part);
  const lines = normalize(d.text, d.flowed, d.delsp);
  const b = findBoundary(lines, opts);
  const pre = b ? lines.slice(0, b.start) : lines;
  const text = pre.join('\n').replace(/\s+$/, '');
  const quote = !b ? 'not-found' : isInline(lines, b) ? 'inline' : 'found';
  const bytes = Buffer.from(text, 'utf8');
  return {
    stripper: STRIPPER, source: 'text/plain', text,
    text_sha256: createHash('sha256').update(bytes).digest('hex'), text_bytes: bytes.length,
    quote, trailing: quote === 'found' && afterQuoteLines(lines) > 0, boundary: b ? b.kind : null,
    charset: d.charset, cte: d.cte, flowed: d.flowed, unsupported_charset: d.unsupported,
    body: lines.join('\n'), after_quote_lines: afterQuoteLines(lines),
    gt_lines: lines.filter((l) => l.startsWith('>')).length,
  };
}

// ---- reply filter and client family --------------------------------------------------------------------------
function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, t) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? decodeB64(t) : decodeQP(t.replace(/_/g, ' '));
      return new TextDecoder(cs).decode(bytes);
    } catch { return ''; }
  });
}
export function isReplyOrForward(msg) {
  if (h1(msg, 'in-reply-to') || h1(msg, 'references')) return true;
  return /^\s*(re|fwd?|aw|wg|tr|rv)\s*:/i.test(decodeWords(h1(msg, 'subject')));
}
export function isDigestish(msg) {
  const ct = parseParams(h1(msg, 'content-type') || 'text/plain').type;
  return ct === 'multipart/digest' || /\bdigest\b/i.test(decodeWords(h1(msg, 'subject')));
}
export function classify(msg) {
  const ua = (h1(msg, 'user-agent') + ' ' + h1(msg, 'x-mailer')).toLowerCase();
  const mid = h1(msg, 'message-id');
  if (/foxmail|tencent/.test(ua) || h1(msg, 'x-qq-mid') || /tencent_/i.test(mid)) return 'Foxmail';
  if (/thunderbird/.test(ua)) return 'Thunderbird';
  if (/apple mail|iphone mail|ipad mail|mac os x mail/.test(ua) || /^<[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}@/.test(mid)) return 'Apple Mail';
  if (/outlook|exchange/.test(ua) || msg.headers.has('thread-index') || msg.headers.has('x-ms-has-attach') || msg.headers.has('x-ms-exchange-organization-authas') || /\.prod\.outlook\.com>|@[a-z0-9]+\.[a-z]+\.prod\.outlook/i.test(mid)) return 'Outlook/Exchange';
  if (/^<CA[\w+=-]{20,}@mail\.gmail\.com>$/.test(mid) || /gmail/.test(ua)) return 'Gmail';
  return 'unknown';
}
