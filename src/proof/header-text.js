// Header text for `replyFacts` (SPEC B10): the claimed Date and Subject of a raw email, and RFC 2047 encoded-word
// decoding. Stdlib only, linear in the input, never throws. The header block of a stored raw email was admitted at
// capture (admit.js bounds its size and line lengths), and only that block is read here, never the body.

import { decodeWindows1252 } from './reply-text.js';

const WORD_RE = /=\?([^?\s]{1,64})\?([bBqQ])\?([^?\s]{0,2048})\?=/g;

/** @param {Uint8Array} bytes @param {string} charset @returns {string | null} null when the charset is unknown. */
function decodeCharset(bytes, charset) {
  try {
    const d = new TextDecoder(charset.split('*')[0].toLowerCase(), { fatal: false });
    if (d.encoding === 'windows-1252') return decodeWindows1252(bytes);
    if (d.encoding === 'gbk') return new TextDecoder('gb18030', { fatal: false }).decode(bytes);
    return d.decode(bytes);
  } catch { return null; }
}

/**
 * Decode the RFC 2047 encoded words (`=?utf-8?B?...?=`, `=?iso-8859-1?Q?...?=`) of a header value. Whitespace between
 * two adjacent encoded words is dropped (RFC 2047 6.2); an encoded word with an unknown charset or bad payload stays as written.
 * @param {string} value  Already a JS string (see `headerText`).
 * @returns {string}
 */
function decodeWords(value) {
  let out = '';
  let last = 0;
  let prevWord = false;
  for (const m of value.matchAll(WORD_RE)) {
    const gap = value.slice(last, m.index);
    let text = null;
    try {
      const payload = m[2].toLowerCase() === 'b'
        ? Buffer.from(m[3], 'base64')
        : Buffer.from(m[3].replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      text = decodeCharset(payload, m[1]);
    } catch { text = null; }
    if (text === null) { out += gap + m[0]; prevWord = false; }
    else { out += (prevWord && /^[ \t\r\n]*$/.test(gap) ? '' : gap) + text; prevWord = true; }
    last = (m.index ?? 0) + m[0].length;
  }
  return out + value.slice(last);
}

/**
 * Raw header bytes (a Latin-1 string of the bytes) to text: UTF-8 when valid (a sender may write 8-bit headers),
 * then encoded words decoded.
 * @param {string} latin1
 * @returns {string}
 */
function headerText(latin1) {
  const s = /[\x80-\xff]/.test(latin1) ? new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(latin1, 'latin1')) : latin1;
  return decodeWords(s);
}

/**
 * The first header `name` (lower case) of a raw email's header block, unfolded and trimmed, as a Latin-1 string; null
 * when there is none. Reads only up to the blank line that ends the header block.
 * @param {Buffer} raw
 * @param {string} name
 * @returns {string | null}
 */
function claimedHeader(raw, name) {
  const s = raw.toString('latin1');
  const a = s.indexOf('\r\n\r\n'), b = s.indexOf('\n\n');
  const end = a >= 0 && (b < 0 || a < b) ? a : b >= 0 ? b : s.length;
  const lines = s.slice(0, end).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c > 0 && line.slice(0, c).trim().toLowerCase() === name) return line.slice(c + 1).trim();
  }
  return null;
}

/**
 * The decoded Subject of the front of a raw email, as the sender wrote it (a claim). Null when there is none or when `head` was
 * cut before the end of the header block (a partial header is never read).
 * @param {Buffer} head  The first bytes of a raw email.
 * @param {boolean} cut  True when `head` is only a prefix of the email.
 * @returns {string | null}
 */
function claimedSubject(head, cut) {
  const s = head.toString('latin1');
  if (cut && !/\r?\n\r?\n/.test(s)) return null;
  const v = claimedHeader(head, 'subject');
  return v === null ? null : headerText(v);
}

export { decodeWords, headerText, claimedHeader, claimedSubject };
