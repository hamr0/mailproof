// Who a record names and what it links to, read from the record ALONE (SPEC B5, B8). Pure: no I/O, no DNS, and never
// the content store (it may be off, expired or forgotten). Used by the trail index (index-db.js) and by the trust
// profile (profile.js), so there is one reading of "the signed From" and one of "the link".
//
// What a record carries of these headers: a signed record holds the exact header lines each DKIM signature covers
// (`signatures[].signed_headers`), so From/To/Cc/Reply-To/In-Reply-To/References are visible only when some signature
// lists them in `h=`. A record captured since M3 also carries `addresses` (every From/To/Cc/Reply-To address, signed or
// not, each marked); an older or unsigned one holds `message.from` and the parsed `in_reply_to`/`references`, nothing else.

import { INDEX_MAX_PARTICIPANTS, INDEX_MAX_ADDRESS, INDEX_MAX_LINKS } from './limits.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {'from' | 'to' | 'cc' | 'reply-to'} Role */
/** @typedef {{ address: string, raw: string, role: Role, signed: boolean }} Participant */
/** @typedef {'signed' | 'unsigned' | 'none'} LinkStrength */
/** @typedef {{ mid: string, via: 'in-reply-to' | 'references', strength: 'signed' | 'unsigned' }} LinkRow */

/** @type {Readonly<Record<string, Role>>} */
const ROLE_OF = Object.freeze({ from: 'from', to: 'to', cc: 'cc', 'reply-to': 'reply-to' });
const ROLES = /** @type {readonly Role[]} */ (Object.freeze(['from', 'to', 'cc', 'reply-to']));
const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;
const MID_RE = /<[^<>\s]+>/g;

/**
 * The addresses of an address-list header value, as written. One linear pass: quoted strings, comments and group
 * names are skipped, so `"bob@evil.example" <bob@real.example>` is `bob@real.example` only. A segment with no
 * `name@domain` form yields nothing.
 * @param {string} value  Header value, folds removed.
 * @returns {string[]}
 */
function parseAddresses(value) {
  /** @type {string[]} */
  const out = [];
  let quote = false;
  let comment = 0;
  let angle = false;
  let bare = '';
  /** @type {string | null} */
  let inAngle = null;
  let cur = '';
  const flush = () => {
    let cand = (inAngle !== null ? inAngle : bare).trim();
    const c = cand.lastIndexOf(':'); // obsolete source route `<@a,@b:user@host>`
    if (c !== -1) cand = cand.slice(c + 1);
    if (cand.length <= INDEX_MAX_ADDRESS && ADDR_RE.test(cand)) out.push(cand);
    bare = ''; inAngle = null; cur = '';
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === '"') quote = false;
      continue;
    }
    if (comment) {
      if (ch === '\\') i++;
      else if (ch === '(') comment++;
      else if (ch === ')') comment--;
      continue;
    }
    if (ch === '"') { quote = true; continue; }
    if (ch === '(') { comment = 1; continue; }
    if (angle) {
      if (ch === '>') { angle = false; inAngle = cur; cur = ''; } else cur += ch;
      continue;
    }
    if (ch === '<') { angle = true; cur = ''; continue; }
    if (ch === ',' || ch === ';') { flush(); continue; }
    if (ch === ':' && inAngle === null) { bare = ''; continue; } // a group name: `Team: a@x, b@y;`
    bare += ch;
  }
  flush();
  return out;
}

/**
 * The header lines of one stored signature: lower-cased name and unfolded value.
 * @param {unknown} sig
 * @returns {Array<{ name: string, value: string }>}
 */
function linesOf(sig) {
  /** @type {Array<{ name: string, value: string }>} */
  const out = [];
  const list = sig && typeof sig === 'object' && Array.isArray(/** @type {any} */ (sig).signed_headers) ? /** @type {any} */ (sig).signed_headers : [];
  for (const l of list) {
    if (typeof l !== 'string') continue;
    const line = Buffer.from(l, 'base64').toString('binary');
    const c = line.indexOf(':');
    if (c < 1) continue;
    out.push({ name: line.slice(0, c).replace(/[ \t]+$/, '').toLowerCase(), value: line.slice(c + 1).replace(/\r?\n(?=[ \t])/g, '').replace(/\r?\n$/, '') });
  }
  return out;
}

/** @param {MpRecord} rec @returns {unknown[]} */
const sigsOf = (rec) => (rec && Array.isArray(rec.signatures) ? rec.signatures : []);

/**
 * The addresses on the From line(s) that signature(s) `only` (default: all) cover, as written.
 * @param {MpRecord} rec
 * @param {Iterable<number>} [only]  Signature indexes to read.
 * @returns {string[]}
 */
function signedFromAddresses(rec, only) {
  const idx = only ? new Set(only) : null;
  /** @type {string[]} */
  const out = [];
  sigsOf(rec).forEach((sig, i) => {
    if (idx && !idx.has(i)) return;
    for (const l of linesOf(sig)) if (l.name === 'from') out.push(...parseAddresses(l.value));
  });
  return out;
}

/**
 * Add `raw` under `role` to `seen` (one row per role and lower-cased address; `signed` is sticky), up to the cap.
 * @param {Map<string, Participant>} seen
 * @param {Role} role
 * @param {string} raw
 * @param {boolean} signed
 */
function put(seen, role, raw, signed) {
  const address = raw.toLowerCase();
  const k = `${role}\0${address}`;
  const p = seen.get(k);
  if (p) { if (signed) p.signed = true; return; }
  if (seen.size < INDEX_MAX_PARTICIPANTS) seen.set(k, { address, raw, role, signed });
}

/**
 * The `role\0address` keys that some signature of the record covers (the one definition of `signed`).
 * @param {unknown[]} sigs
 * @returns {Set<string>}
 */
function signedKeys(sigs) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const sig of sigs) {
    for (const l of linesOf(sig)) {
      const role = ROLE_OF[l.name];
      if (role) for (const a of parseAddresses(l.value)) out.add(`${role}\0${a.toLowerCase()}`);
    }
  }
  return out;
}

/**
 * Which addresses a signature covers, by how far that signature can be trusted: `signed` when a signature in `passing`
 * (verifies and aligns, `verifyRecord(...).passing`) covers a line that names it, `failing` when only signatures that do not
 * verify cover it. An address in neither map entry is not covered at all. The record's own `addresses[].signed` is the weaker
 * "some signature covers it" (SPEC B1); a display that says "signed" must use this.
 * @param {MpRecord} rec
 * @param {Iterable<number>} passing  Signature indexes that verify and align.
 * @returns {Map<string, 'signed' | 'failing'>}  Keyed `role\0address` (lower case).
 */
function addressCoverage(rec, passing) {
  const ok = new Set(passing);
  const sigs = sigsOf(rec);
  const out = /** @type {Map<string, 'signed' | 'failing'>} */ (new Map());
  for (const k of signedKeys(sigs)) out.set(k, 'failing');
  for (const k of signedKeys(sigs.filter((_, i) => ok.has(i)))) out.set(k, 'signed');
  return out;
}

/**
 * The record's `addresses` field (SPEC B1), collected at capture from the parsed header block: every address on a
 * From, To, Cc or Reply-To line, signed or not, each marked `signed` when some signature of the record covers a
 * line that names it. Header order; one row per role and address; at most INDEX_MAX_PARTICIPANTS rows. Never throws.
 * @param {Array<{ name: string, raw: string }>} rows  Header rows (`splitMessage`).
 * @param {unknown[]} signatures  The record's `signatures`.
 * @returns {Participant[]}
 */
function addressesOf(rows, signatures) {
  /** @type {Map<string, Participant>} */
  const seen = new Map();
  try {
    const covered = signedKeys(Array.isArray(signatures) ? signatures : []);
    for (const r of rows) {
      const role = ROLE_OF[r.name];
      if (!role) continue;
      const value = r.raw.slice(r.raw.indexOf(':') + 1).replace(/\r?\n(?=[ \t])/g, '').replace(/\r?\n$/, '');
      for (const a of parseAddresses(value)) put(seen, role, a, covered.has(`${role}\0${a.toLowerCase()}`));
    }
  } catch { /* no addresses */ }
  return [...seen.values()].map(({ role, address, raw, signed }) => ({ role, address, raw, signed }));
}

/**
 * Every address a record names, with its role and whether a DKIM signature covers that header. Addresses are
 * lower-cased (`address`) with the form as written kept (`raw`); one row per role and address. A record that has the
 * `addresses` field (captured since M3) is read from it; an older one is derived from the header lines its
 * signatures cover plus the `message.from` of an unsigned record. Capped at INDEX_MAX_PARTICIPANTS rows. Never throws.
 * @param {MpRecord} rec
 * @returns {Participant[]}
 */
function participantsOf(rec) {
  /** @type {Map<string, Participant>} */
  const seen = new Map();
  try {
    if (Array.isArray(rec.addresses)) {
      for (const a of rec.addresses) {
        if (!a || typeof a.raw !== 'string' || typeof a.role !== 'string' || !ROLES.includes(/** @type {Role} */ (a.role))) continue;
        if (a.raw.length > INDEX_MAX_ADDRESS) continue;
        put(seen, /** @type {Role} */ (a.role), a.raw, a.signed === true);
      }
      return [...seen.values()];
    }
    for (const sig of sigsOf(rec)) {
      for (const l of linesOf(sig)) {
        const role = ROLE_OF[l.name];
        if (role) for (const a of parseAddresses(l.value)) put(seen, role, a, true);
      }
    }
    const from = rec?.message?.from;
    if (typeof from === 'string' && from.length <= INDEX_MAX_ADDRESS && ADDR_RE.test(from)) put(seen, 'from', from, false);
  } catch { /* a malformed record has no participants */ }
  return [...seen.values()];
}

/**
 * Does any signature that is in `passing` cover an In-Reply-To / References line? (Cheap pre-check: lets the
 * index skip the DKIM re-check for the many records with no signed threading header.)
 * @param {MpRecord} rec
 * @returns {boolean}
 */
function hasSignedThreading(rec) {
  try { return sigsOf(rec).some((s) => linesOf(s).some((l) => l.name === 'in-reply-to' || l.name === 'references')); } catch { return false; }
}

/**
 * The message ids a record points at (its parents) and how strongly each link is signed. `signed`: the id is in an
 * In-Reply-To / References line that a signature covers, and that signature is in `passing` (it verifies offline,
 * aligned with the From domain: `verifyRecord(...).passing`). `unsigned`: the id is present but no such line covers
 * it. An id present under both headers is one row: the stronger strength, `in-reply-to` first. In-Reply-To comes
 * first in the order, then References oldest-first; at most INDEX_MAX_LINKS (the last References ids are kept).
 * @param {MpRecord} rec
 * @param {Iterable<number>} passing  Indexes of the signatures that verify and align.
 * @returns {LinkRow[]}
 */
function linksOf(rec, passing) {
  try {
    const ok = new Set(passing);
    /** @type {{ irt: Set<string>, ref: Set<string> }} */
    const signed = { irt: new Set(), ref: new Set() };
    sigsOf(rec).forEach((sig, i) => {
      if (!ok.has(i)) return;
      for (const l of linesOf(sig)) {
        const into = l.name === 'in-reply-to' ? signed.irt : l.name === 'references' ? signed.ref : null;
        if (into) for (const m of l.value.match(MID_RE) ?? []) into.add(m);
      }
    });
    const m = rec?.message ?? {};
    /** @type {Map<string, LinkRow>} */
    const rows = new Map();
    const put = (/** @type {unknown} */ mid, /** @type {'in-reply-to' | 'references'} */ via, /** @type {Set<string>} */ proof) => {
      if (typeof mid !== 'string' || !mid || mid === m.message_id) return;
      const strength = proof.has(mid) ? 'signed' : 'unsigned';
      const old = rows.get(mid);
      if (!old) rows.set(mid, { mid, via, strength });
      else if (old.strength === 'unsigned' && strength === 'signed') rows.set(mid, { mid, via, strength });
    };
    put(m.in_reply_to, 'in-reply-to', signed.irt);
    const refs = Array.isArray(m.references) ? m.references.slice(-INDEX_MAX_LINKS) : [];
    for (const r of refs) put(r, 'references', signed.ref);
    return [...rows.values()].slice(0, INDEX_MAX_LINKS);
  } catch { return []; }
}

/**
 * The strongest link a record has to a parent: `signed` over `unsigned` over `none`. With `parent` (a Message-ID),
 * only the link to that id counts.
 * @param {LinkRow[]} links  `linksOf(...)`.
 * @param {string} [parent]
 * @returns {LinkStrength}
 */
function strongest(links, parent) {
  let best = /** @type {LinkStrength} */ ('none');
  for (const l of links) {
    if (parent !== undefined && l.mid !== parent) continue;
    if (l.strength === 'signed') return 'signed';
    best = 'unsigned';
  }
  return best;
}

/**
 * The Message-IDs a record DIRECTLY answers: its In-Reply-To, and the LAST entry of its References (the parent by
 * RFC 5322). Earlier References entries are ancestors, not parents. Never throws.
 * @param {MpRecord} rec
 * @returns {Set<string>}
 */
function directParents(rec) {
  /** @type {Set<string>} */
  const out = new Set();
  try {
    const m = rec?.message ?? {};
    if (typeof m.in_reply_to === 'string' && m.in_reply_to) out.add(m.in_reply_to);
    const refs = Array.isArray(m.references) ? m.references : [];
    const last = refs[refs.length - 1];
    if (typeof last === 'string' && last) out.add(last);
  } catch { /* none */ }
  return out;
}

/**
 * The first value (folds removed, as written, a Latin-1 string of the raw bytes) of header `name` (lower case) on a
 * line a signature covers; `only` limits it to those signature indexes (default: all). Null when none covers it.
 * @param {MpRecord} rec @param {string} name @param {Iterable<number>} [only]
 * @returns {string | null}
 */
function signedHeaderValue(rec, name, only) {
  const idx = only ? new Set(only) : null;
  let out = /** @type {string | null} */ (null);
  try {
    sigsOf(rec).forEach((sig, i) => {
      if (out !== null || (idx && !idx.has(i))) return;
      for (const l of linesOf(sig)) if (l.name === name) { out = l.value.trim(); return; }
    });
  } catch { return null; }
  return out;
}

export { addressCoverage, directParents, signedHeaderValue, ROLES, parseAddresses, signedFromAddresses, addressesOf, participantsOf, hasSignedThreading, linksOf, strongest };
