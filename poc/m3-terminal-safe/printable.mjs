// Candidate helper for CLI text output (POC; pure, stdlib, no imports). Makes every code point that a terminal could
// act on, or that hides or reorders text, VISIBLE as an escape instead of dropping it. The result contains no C0/C1
// control, no bidi control, no line/paragraph separator, no invisible format character, no lone surrogate.
//
//   \n \r \t         the three C0 controls people expect to read as such
//   \xNN             other C0, DEL, C1, soft hyphen (U+00AD)
//   \uNNNN           other BMP code points in the set (bidi, zero-width, separators, fillers, lone surrogates ...)
//   \u{NNNNN}        astral code points in the set (tag characters, supplementary variation selectors)
//   \\               a literal backslash, so every escape in the output is one the helper made (unambiguous)
//
// ZWJ (U+200D) and ZWNJ (U+200C) are kept only between two non-ASCII characters (emoji sequences, Persian/Arabic and
// Indic text); next to ASCII, or at an end, they are escaped (that is where they hide inside an address or id).

// One alternation; the set is built from ranges so each class stays reviewable. `u` flag: [\ud800-\udfff] matches a
// LONE surrogate only (a valid pair is one code point).
const RANGES = [
  '\\u0000-\\u001f', '\\u007f-\\u009f', // C0, DEL, C1 (0x9B is CSI on some terminals)
  '\\u00ad',                           // soft hyphen: invisible
  '\\u034f',                           // combining grapheme joiner: invisible
  '\\u061c', '\\u200e\\u200f', '\\u202a-\\u202e', '\\u2066-\\u2069', // bidi: ALM, LRM/RLM, LRE..RLO, LRI..PDI
  '\\u115f\\u1160\\u3164\\uffa0',      // Hangul fillers: render as blanks
  '\\u17b4\\u17b5\\u180e',             // Khmer inherent vowels, Mongolian vowel separator: invisible
  '\\u200b-\\u200d',                   // ZWSP, ZWNJ, ZWJ (ZWNJ/ZWJ conditional, see keepJoiner)
  '\\u2028\\u2029',                    // line / paragraph separator
  '\\u2060-\\u206f',                   // word joiner, invisible operators, deprecated format controls
  '\\ufe00-\\ufe0d',                   // variation selectors 1-14 (FE0E/FE0F, text/emoji presentation, are kept)
  '\\ufeff',                           // BOM / ZWNBSP
  '\\ufdd0-\\ufdef', '\\ufff9-\\uffff', // noncharacters, interlinear annotation, object replacement, FFFE/FFFF
  '\\ud800-\\udfff',                   // lone surrogates
  '\\u{e0000}-\\u{e007f}',             // tag characters (invisible text smuggling)
  '\\u{e0100}-\\u{e01ef}',             // variation selectors supplement
];
const MARKER = '\\\\';   // regex source for one literal backslash (the escape marker)
const DANGER = new RegExp(`[${MARKER}${RANGES.join('')}]`, 'gu');

const SHORT = { 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t', 0x5c: '\\\\' };
const hex = (n, w) => n.toString(16).padStart(w, '0');
const esc = (cp) => SHORT[cp] ?? (cp < 0x100 ? `\\x${hex(cp, 2)}` : cp < 0x10000 ? `\\u${hex(cp, 4)}` : `\\u{${hex(cp, 1)}}`);
const NONASCII = /[^\u0000-\u007f]/;

/**
 * @param {unknown} v  Any mail- or server-derived value (non-strings are String()ed; null/undefined give '').
 * @param {{ keepNewline?: boolean, max?: number }} [o]  keepNewline: leave "\n" alone (multi-line blocks);
 *   max: cut to this many code points first, then add "...(+N)" (N = dropped code points).
 * @returns {string}
 */
export function printable(v, o = {}) {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
  let tail = '';
  if (o.max !== undefined && s.length > o.max) {
    const cps = Array.from(s);
    if (cps.length > o.max) { s = cps.slice(0, o.max).join(''); tail = `...(+${cps.length - o.max})`; }
  }
  const out = s.replace(DANGER, (m, offset) => {
    const cp = /** @type {number} */ (m.codePointAt(0));
    if (cp === 0x0a && o.keepNewline) return m;
    if ((cp === 0x200c || cp === 0x200d)
      && offset > 0 && NONASCII.test(s[offset - 1]) && offset + 1 < s.length && NONASCII.test(s[offset + 1])) return m;
    return esc(cp);
  });
  return out + tail;
}

/** The code points printable() would escape in `s`, as U+XXXX (for counting what a field contained). */
export function dangerousIn(s) {
  const found = [];
  s.replace(DANGER, (m, offset) => {
    const cp = /** @type {number} */ (m.codePointAt(0));
    if ((cp === 0x200c || cp === 0x200d) && offset > 0 && NONASCII.test(s[offset - 1]) && offset + 1 < s.length && NONASCII.test(s[offset + 1])) return m;
    found.push(cp === 0x5c ? 'backslash' : `U+${hex(cp, 4).toUpperCase()}`);
    return m;
  });
  return found;
}

/** The set the output must NOT contain (for assertions): everything printable() escapes except the backslash marker. */
export const FORBIDDEN_AFTER = new RegExp(`[${RANGES.join('')}]`, 'u');
