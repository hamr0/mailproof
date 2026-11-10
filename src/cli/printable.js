// Terminal-safe text for the CLI (SPEC B11 output, finding F28). Mail- and server-derived strings are untrusted: a sender
// can put cursor moves, an OSC title, a C1 CSI, a bidi override or zero-width characters in a header. printable() makes
// every code point a terminal could act on, or that hides or reorders text, VISIBLE as an escape instead of dropping it.
//
//   \n \r \t         the three C0 controls people expect to read as such
//   \xNN             other C0, DEL, C1, soft hyphen (U+00AD)
//   \uNNNN           other BMP code points in the set (bidi, zero-width, separators, fillers, lone surrogates, ...)
//   \u{NNNNN}        astral code points in the set (tag characters, supplementary variation selectors)
//   \\               a literal backslash, so every escape in the output is one this function made
//
// ZWJ (U+200D) and ZWNJ (U+200C) are kept only between two non-ASCII characters (emoji, Persian, Indic text); next to
// ASCII, or at an end, they are escaped (that is where they hide inside an address or an id).
//
// Cost: one linear pass over the UTF-16 units, no regular expression, and the SAME string comes back (no allocation)
// when nothing needs escaping, which is the normal case.

/**
 * Whether the code unit `c` (not a surrogate) must be escaped. `0x5c` (backslash) is handled by the caller.
 * @param {number} c
 * @returns {boolean}
 */
function danger(c) {
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;       // C0, DEL, C1
  if (c < 0xad) return false;
  if (c < 0x2000) {
    return c === 0xad || c === 0x34f || c === 0x61c || c === 0x115f || c === 0x1160 || c === 0x17b4 || c === 0x17b5 || c === 0x180e;
  }
  if (c < 0x3000) {
    return (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f);
  }
  if (c === 0x3164) return true;
  if (c < 0xd800) return false;
  if (c >= 0xe000 && c < 0xfe00) return (c >= 0xfdd0 && c <= 0xfdef);
  return (c >= 0xfe00 && c <= 0xfe0d) || c === 0xfeff || c === 0xffa0 || c >= 0xfff9;
}

/** @param {number} cp An astral code point. @returns {boolean} */
const astralDanger = (cp) => (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef);

/** A neighbour that makes a ZWJ/ZWNJ legitimate: non-ASCII and not itself a joiner (a run of joiners is hidden text). @param {number} c @returns {boolean} */
const letterLike = (c) => c >= 0x80 && c !== 0x200c && c !== 0x200d;

const SHORT = new Map([[0x0a, '\\n'], [0x0d, '\\r'], [0x09, '\\t'], [0x5c, '\\\\']]);
/** @param {number} n @param {number} w @returns {string} */
const hex = (n, w) => n.toString(16).padStart(w, '0');
/** @param {number} cp @returns {string} */
const esc = (cp) => SHORT.get(cp) ?? (cp < 0x100 ? `\\x${hex(cp, 2)}` : cp < 0x10000 ? `\\u${hex(cp, 4)}` : `\\u{${hex(cp, 1)}}`);

/**
 * The index just past the code point at `i`, and whether it is a valid surrogate pair.
 * @param {string} s @param {number} i
 * @returns {boolean} true when s[i], s[i+1] are a high then a low surrogate
 */
const pairAt = (s, i) => {
  const h = s.charCodeAt(i);
  if (h < 0xd800 || h > 0xdbff || i + 1 >= s.length) return false;
  const l = s.charCodeAt(i + 1);
  return l >= 0xdc00 && l <= 0xdfff;
};

/**
 * @typedef {Object} PrintableOptions
 * @property {boolean} [keepNewline]  Leave "\n" alone (multi-line blocks); every other control is still escaped.
 * @property {boolean} [keepBackslash]  Leave "\" alone: for the output backstop, which sees text a field-level call already escaped (escaping twice would double every backslash).
 * @property {number} [max]  Cut to this many code points first, then add "...(+N)" (N = dropped code points).
 */

/**
 * @param {unknown} v  Any mail- or server-derived value (non-strings are String()ed; null/undefined give '').
 * @param {PrintableOptions} [o]
 * @returns {string}  The input itself (same string) when nothing needed escaping.
 */
export function printable(v, o = {}) {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
  let tail = '';
  if (o.max !== undefined && s.length > o.max) {
    let i = 0;
    let n = 0;
    while (i < s.length && n < o.max) { i += pairAt(s, i) ? 2 : 1; n++; }
    if (i < s.length) {
      let rest = 0;
      for (let j = i; j < s.length; j += pairAt(s, j) ? 2 : 1) rest++;
      tail = `...(+${rest})`;
      s = s.slice(0, i);
    }
  }
  const len = s.length;
  const nl = o.keepNewline === true;
  const bs = o.keepBackslash === true;
  // fast path: scan only
  let i = 0;
  for (; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) { if (c === 0x5c && !bs) break; continue; }
    if (c === 0x0a && nl) continue;
    if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && pairAt(s, i)) {
        if (c === 0xdb40 && astralDanger(((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00) + 0x10000)) break;
        i++;
        continue;
      }
      break;   // lone surrogate
    }
    if (danger(c)) break;
  }
  if (i === len) return tail ? s + tail : s;
  // slow path: copy the clean prefix, then escape
  let out = s.slice(0, i);
  let from = i;
  for (; i < len; i++) {
    const c = s.charCodeAt(i);
    let cp = c;
    let w = 1;
    let bad;
    if (c >= 0x20 && c < 0x7f) bad = c === 0x5c && !bs;
    else if (c === 0x0a && nl) bad = false;
    else if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && pairAt(s, i)) {
        cp = ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00) + 0x10000;
        w = 2;
        bad = astralDanger(cp);
      } else bad = true;
    } else if (c === 0x200c || c === 0x200d) {
      bad = !(i > 0 && letterLike(s.charCodeAt(i - 1)) && i + 1 < len && letterLike(s.charCodeAt(i + 1)));
    } else bad = danger(c);
    if (bad) { out += s.slice(from, i) + esc(cp); from = i + w; }
    i += w - 1;
  }
  return out + s.slice(from) + tail;
}
