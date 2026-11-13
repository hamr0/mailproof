// The one place for terminal styling (SPEC B11.7a): colour, symbols, hyperlinks, relative times, width. No dependency: ANSI by hand.
//
// Rules, each enforced here or by a test:
//   - Colour is on only for a terminal (stream isTTY), with NO_COLOR unset and TERM not "dumb"; FORCE_COLOR turns it on for a pipe (tests, CI
//     logs). NO_COLOR wins over FORCE_COLOR. With colour off every helper returns its text unchanged, so a pipe and a terminal show the SAME words.
//   - Colour never carries meaning alone: a coloured verdict always has a symbol or a word beside it (the callers build `symbol + word`).
//   - Escape first, style after: mail-derived text goes through printable() BEFORE any helper here sees it. `allowStyle()` is the output
//     backstop that keeps the sequences this module makes (SGR colour codes, and OSC 8 links carrying this process's random nonce) and
//     escapes every other control character, so an email cannot plant a link or a cursor move even where a field was forgotten.
//   - Everything comes from the injected `env` and stream facts, never from process.*, so a test is deterministic.

import crypto from 'node:crypto';
import { printable } from '../proof/printable.js';

const ESC = '\x1b';
const NONCE = crypto.randomBytes(6).toString('hex');

/** @param {string | undefined} v @returns {boolean} A variable that is set and not empty. */
const set = (v) => v !== undefined && v !== '';

/**
 * Whether the locale says UTF-8 (LC_ALL, then LC_CTYPE, then LANG: the first one that is set decides).
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isUtf8(env) {
  const v = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(set);
  return v !== undefined && /utf-?8/i.test(v);
}

/**
 * @typedef {Object} StyleInput
 * @property {Record<string, string | undefined>} [env]
 * @property {boolean} [isTTY]  The stream the text goes to is a terminal.
 * @property {number} [columns]  That stream's width, when it has one.
 */

/**
 * @param {StyleInput} [input]
 */
export function makeStyle({ env = {}, isTTY = false, columns } = {}) {
  const forced = set(env.FORCE_COLOR) && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  const on = !set(env.NO_COLOR) && (forced || (isTTY && env.TERM !== 'dumb'));
  const links = on && !set(env.MAILPROOF_NO_LINKS);
  const utf8 = isUtf8(env);
  const width = Number.isFinite(columns) && /** @type {number} */ (columns) > 0 ? Math.floor(/** @type {number} */ (columns)) : 80;

  /** @param {string} codes @returns {(s: string) => string} */
  const sgr = (codes) => (s) => (on && s !== '' ? `${ESC}[${codes}m${s}${ESC}[0m` : s);
  const ellipsis = utf8 ? '…' : '...';

  return {
    on, links, utf8, width,
    bold: sgr('1'), dim: sgr('2'), green: sgr('32'), yellow: sgr('33'), red: sgr('31'), cyan: sgr('36'),
    /** A selectable key or choice token (a menu number or letter, `y`, a default value, an example input): bold green, the ONE colour for all of them. */
    key: sgr('1;32'),
    /** Text with `{token}` marks: each token is a key, the braces are dropped (and with colour off the text is the same without them). The text is our own constant; escape mail-derived text before it gets here. @param {string} s @returns {string} */
    choices: (s) => s.replace(/\{([^{}]*)\}/g, (_, t) => sgr('1;32')(t)),
    inverse: sgr('7'),
    /** A reversed badge in a colour, `badge('green', '✓ VERIFIED')`; plain text otherwise. @param {'green' | 'red' | 'yellow'} colour @param {string} s */
    badge: (colour, s) => (on ? `${ESC}[7;${{ green: 32, red: 31, yellow: 33 }[colour]}m${s}${ESC}[0m` : s),
    /** The symbols: a check, a warning, a cross and a separator dot; plain ASCII words when the locale is not UTF-8. */
    sym: utf8 ? { ok: '✓', warn: '!', bad: '✗', dot: '·', dash: '–' } : { ok: 'ok', warn: '!', bad: 'x', dot: '-', dash: '-' },
    /** A dim horizontal rule, at most 64 wide. @returns {string} */
    rule: () => sgr('2')((utf8 ? '─' : '-').repeat(Math.min(width, 64))),
    /**
     * A clickable link (OSC 8) when links are on, the plain text otherwise. `url` is built by the caller from trusted parts and is
     * reduced here to printable ASCII, so it can never end the sequence early.
     * @param {string} text @param {string} url
     */
    link: (text, url) => (links && text !== '' ? `${ESC}]8;id=${NONCE};${url.replace(/[^\x21-\x7e]/g, '')}${ESC}\\${text}${ESC}]8;;${ESC}\\` : text),
    /**
     * Cut to `n` code points; the last one becomes an ellipsis. The text must already be escaped and unstyled.
     * @param {string} text @param {number} n @returns {string}
     */
    fit(text, n) {
      const cps = [...text];
      if (cps.length <= n) return text;
      if (n <= ellipsis.length) return cps.slice(0, Math.max(0, n)).join('');
      return cps.slice(0, n - ellipsis.length).join('') + ellipsis;
    },
  };
}

/** @typedef {ReturnType<typeof makeStyle>} Style */

/**
 * The style of one stream of a Ctx.
 * @param {{ env: Record<string, string | undefined>, stdout: { isTTY?: boolean, columns?: number }, stderr: { isTTY?: boolean, columns?: number } }} ctx
 * @param {'stdout' | 'stderr'} [stream]
 * @returns {Style}
 */
export function styleOf(ctx, stream = 'stdout') {
  const s = ctx[stream];
  return makeStyle({ env: ctx.env, isTTY: s.isTTY === true, ...(typeof s.columns === 'number' ? { columns: s.columns } : {}) });
}

/** A `file://` URL for an absolute path (percent-encoded; the caller passes only paths it knows). @param {string} p @returns {string} */
export const fileUrl = (p) => `file://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`;

const KEEP = new RegExp(`${ESC}\\[[0-9;]*m|${ESC}\\]8;id=${NONCE};[\\x21-\\x7e]*${ESC}\\\\|${ESC}\\]8;;${ESC}\\\\`, 'g');

/**
 * The output backstop for a stream with styling on: escape every control character (printable(), F28) except the sequences this module
 * makes (SGR colour codes; OSC 8 links with this process's nonce; the link end). Text with no ESC takes the plain path.
 * @param {string} s
 * @returns {string}
 */
export function allowStyle(s) {
  if (!s.includes(ESC)) return printable(s, { keepNewline: true, keepBackslash: true });
  let out = '';
  let at = 0;
  for (const m of s.matchAll(KEEP)) {
    const i = /** @type {number} */ (m.index);
    out += printable(s.slice(at, i), { keepNewline: true, keepBackslash: true }) + m[0];
    at = i + m[0].length;
  }
  return out + printable(s.slice(at), { keepNewline: true, keepBackslash: true });
}

/**
 * Remove the sequences this module makes (for a test, a width count or a comparison). Not a general ANSI stripper.
 * @param {string} s @returns {string}
 */
export const stripStyle = (s) => s.replace(KEEP, '');

/**
 * Relative time: `2 h ago`, `in 4 h`, `just now`.
 * @param {Date | string | number | null | undefined} time
 * @param {Date | number} now
 * @returns {string}  '' when `time` is not a date.
 */
export function rel(time, now) {
  const t = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : NaN;
  const n = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';
  const d = t - n;
  const s = Math.abs(d) / 1000;
  if (s < 45) return d > 0 ? 'in a moment' : 'just now';
  const [v, unit] = s < 3600 ? [Math.round(s / 60), 'min'] : s < 129600 ? [Math.round(s / 3600), 'h'] : s < 86400 * 60 ? [Math.round(s / 86400), 'd'] : s < 86400 * 730 ? [Math.round(s / (86400 * 30)), 'mo'] : [Math.round(s / (86400 * 365)), 'y'];
  return d > 0 ? `in ${v} ${unit}` : `${v} ${unit} ago`;
}
