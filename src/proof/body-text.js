// The text of a stored raw email, for display (SPEC B11.5a `show`): the text/plain part, or a plain-text rendering of the
// text/html part when that is all there is. Reuses the reply-text MIME and charset code (B6) and adds no dependency. This is
// NOT the frozen stripper: nothing is removed, and the result is never hashed or recorded. The input was admitted at capture;
// it is gated again here. Linear in the input, never throws on message content.

import { admit } from './admit.js';
import { parseMessage, findPart, decodePart, unflow } from './reply-text.js';

/** @typedef {{ source: 'text/plain' | 'text/html' | 'none', text: string, limit?: string }} BodyText */

const ENTITIES = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' });
const BLOCK = new Set(['br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol', 'hr', 'pre']);

/** @param {string} s @returns {string} Entities decoded; an unknown one stays as written. */
function decodeEntities(s) {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A plain-text rendering of HTML: tags dropped, script/style/head content dropped, block tags become line breaks, entities
 * decoded. One linear scan (every `<` finds its `>` with one indexOf), no regular expression over unbounded input.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  const low = html.toLowerCase();
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) { out += html.slice(lt); break; }
    let j = lt + 1;
    if (low[j] === '/') j++;
    let k = j;
    while (k < gt && /[a-z0-9]/.test(low[k])) k++;
    const name = low.slice(j, k);
    i = gt + 1;
    if (low.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if ((name === 'script' || name === 'style' || name === 'head') && low[lt + 1] !== '/') {
      const e = low.indexOf(`</${name}`, i);
      const g = e < 0 ? -1 : html.indexOf('>', e);
      i = g < 0 ? n : g + 1;
      continue;
    }
    if (BLOCK.has(name)) out += '\n';
  }
  return decodeEntities(out).replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/**
 * The text of an email: text/plain when there is one (flowed text unflowed), else the text/html part rendered as text.
 * @param {Buffer} raw
 * @returns {BodyText}
 */
export function bodyText(raw) {
  try {
    const gate = admit(raw);
    if (!gate.ok) return { source: 'none', text: '', limit: /** @type {string} */ (gate.limit) };
    const msg = parseMessage(raw.toString('latin1'));
    const plain = findPart(msg, 'text/plain');
    if (plain) {
      const d = decodePart(plain);
      let lines = d.text.replace(/\r\n?/g, '\n').split('\n');
      if (d.flowed) lines = unflow(lines, d.delsp);
      return { source: 'text/plain', text: lines.join('\n').trimEnd() };
    }
    const html = findPart(msg, 'text/html');
    if (html) return { source: 'text/html', text: htmlToText(decodePart(html).text.replace(/\r\n?/g, '\n')) };
  } catch { /* an unreadable message has no text */ }
  return { source: 'none', text: '' };
}
