// Header-block mechanics shared by record building and the offline re-check:
// split a message into raw header rows + body, read DKIM tag lists, and pick
// the header lines a signature actually covers (RFC 6376 section 5.4.2).
//
// Header rows are kept as BINARY strings (one char per byte) so the exact bytes
// the sender signed survive a round trip; folds are preserved.

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
  const m = /\r?\n\r?\n/.exec(s);
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
    .map((r) => ({ name: r.slice(0, r.indexOf(':')).trim().toLowerCase(), raw: r }));
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
 * The header lines a signature covers, in hashing order: each `h=` name takes
 * the next unused instance counting from the bottom; a name with no remaining
 * instance is oversigned and adds nothing. Pure.
 * @param {HeaderRow[]} rows
 * @param {string} h  The `h=` tag value.
 * @returns {string[]}  Raw header lines (binary strings).
 */
function selectSigned(rows, h) {
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {string[]} */
  const out = [];
  for (const nm of h.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const idxs = rows.map((r, i) => (r.name === nm ? i : -1)).filter((i) => i >= 0);
    const n = used.get(nm) || 0;
    if (n < idxs.length) {
      out.push(rows[idxs[idxs.length - 1 - n]].raw);
      used.set(nm, n + 1);
    }
  }
  return out;
}

export { splitMessage, parseTags, canonPair, selectSigned };
