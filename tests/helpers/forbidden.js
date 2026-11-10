// TEST-ONLY. The code points terminal-safe CLI text must never contain (F28): C0 (the caller strips the LF it expects),
// DEL, C1, bidi controls, zero-width and blank-rendering format characters, line separators, variation selectors 1-14,
// noncharacters, lone surrogates, tag characters. The backslash is NOT in it (it is the escape marker).
export const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u115f\u1160\u3164\uffa0\u17b4\u17b5\u180e\u200b-\u200d\u2028\u2029\u2060-\u206f\ufe00-\ufe0d\ufeff\ufdd0-\ufdef\ufff9-\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\u{e0000}-\u{e007f}/u;
export const FORBIDDEN_ASTRAL = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
/** @param {string} s @returns {boolean} true when `s` (LF allowed) holds a forbidden code point. */
export const hasForbidden = (s) => { const t = s.replace(/\n/g, ''); return FORBIDDEN.test(t) || FORBIDDEN_ASTRAL.test(t); };
