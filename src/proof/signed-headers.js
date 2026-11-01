// Header-block mechanics shared by record building and the offline re-check:
// split a message into raw header rows + body, read DKIM tag lists, and pick
// the header lines a signature actually covers (RFC 6376 section 5.4.2).
//
// Header rows are kept as BINARY strings (one char per byte) so the exact bytes
// the sender signed survive a round trip; folds are preserved.

import { MAX_H_NAMES } from './limits.js';

/**
 * @typedef {Object} HeaderRow
 * @property {string} name  Lower-cased field name.
 * @property {string} raw   The header line as received (binary string, folds kept).
 */

/**
 * Split raw message bytes into header rows and the body bytes. Pure.
 * @param {Buffer | string} input
 * @returns {{ rows: HeaderRow[], body: Buffer }}
 */
function splitMessage(input) {
  const s = (Buffer.isBuffer(input) ? input : Buffer.from(String(input))).toString('binary');
  // The header block ends at the first empty line. An empty FIRST line is that line: the message has no
  // headers and everything after it is body (mailsplit and mailauth read it so; the pattern for two
  // line breaks in a row would read on into the body and take its lines for headers).
  const m = /^\r?\n/.exec(s) || /\r?\n\r?\n/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index + m[0].length) : '';
  /** @type {string[]} */
  const lines = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += '\r\n' + line;
    else lines.push(line);
  }
  const rows = lines
    .filter((r) => r.indexOf(':') > 0)
    .map((r) => {
      // The name ends at the colon, minus blanks before it: space and tab only, like mailauth's header
      // parser. (String.trim() also strips NBSP and friends, which would make "DKIM-Signature\xA0:" a
      // signature here that neither mailauth nor the admission gate counts.)
      let end = r.indexOf(':');
      while (end > 0 && (r[end - 1] === ' ' || r[end - 1] === '\t')) end--;
      return { name: r.slice(0, end).toLowerCase(), raw: r };
    });
  return { rows, body: Buffer.from(body, 'binary') };
}

/**
 * Parse a DKIM-style tag list (`d=..; s=..`) out of a raw header line. Keys are
 * lower-cased, whitespace inside values collapsed. Pure.
 * @param {string} raw  A header line including its `Name:` prefix.
 * @returns {Record<string, string>}
 */
function parseTags(raw) {
  const v = raw.slice(raw.indexOf(':') + 1);
  /** @type {Record<string, string>} */
  const t = {};
  for (const seg of v.split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    t[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).replace(/\s+/g, ' ').trim();
  }
  return t;
}

/**
 * Split a `c=` value into header / body canonicalization (default simple/simple).
 * @param {string | undefined} c
 * @returns {{ h: string, b: string }}
 */
function canonPair(c) {
  const p = (c || 'simple/simple').split('/');
  return { h: (p[0] || 'simple').toLowerCase(), b: (p[1] || 'simple').toLowerCase() };
}

/**
 * The header names an `h=` value lists: lower-cased, trimmed, empty entries dropped. The one
 * definition of "how many names": `selectSigned` and the `MAX_H_NAMES` check both use it.
 * @param {string} h  The `h=` tag value.
 * @returns {string[]}
 */
function signedNames(h) {
  return h.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/**
 * The header lines a signature covers, in hashing order: each `h=` name takes
 * the next unused instance counting from the bottom; a name with no remaining
 * instance is oversigned and adds nothing. Pure.
 * @param {HeaderRow[]} rows
 * @param {string} h  The `h=` tag value.
 * @returns {string[]}  Raw header lines (binary strings).
 */
function selectSigned(rows, h) {
  // Row indices per name, built once, so the work is rows + names rather than rows x names.
  /** @type {Map<string, number[]>} */
  const byName = new Map();
  rows.forEach((r, i) => {
    const l = byName.get(r.name);
    if (l) l.push(i); else byName.set(r.name, [i]);
  });
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {string[]} */
  const out = [];
  for (const nm of signedNames(h)) {
    const idxs = byName.get(nm);
    if (!idxs) continue;
    const n = used.get(nm) || 0;
    if (n < idxs.length) {
      out.push(rows[idxs[idxs.length - 1 - n]].raw);
      used.set(nm, n + 1);
    }
  }
  return out;
}

/**
 * `why` of the offline re-check for a signature whose `h=` lists more than `MAX_H_NAMES` names. `record()` never
 * produces one (the gate refuses the message), but a stored or hand-made record can carry one, and the re-check
 * must not canonicalise it.
 */
const H_TOO_LONG = 'h= too long';

/**
 * Does this DKIM-Signature header line list more than `MAX_H_NAMES` names in `h=`?
 * @param {string} raw  The header line (binary string).
 * @returns {boolean}
 */
function hTooLong(raw) {
  return signedNames(parseTags(raw).h || '').length > MAX_H_NAMES;
}

export { splitMessage, parseTags, canonPair, selectSigned, signedNames, hTooLong, H_TOO_LONG };
