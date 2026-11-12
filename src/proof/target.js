// Targets (SPEC B11.5a, B8.5): ONE resolver by the SHAPE of an argument, shared by the library (`describe`, `verifyWith`) and
// the CLI (`show`, `verify`, the menu), and the helpers that turn a target into records. A target is a record id (8 to 32
// hex characters), a Message-ID in angle brackets, or one exact address. Pure and read-only; never touches the network.

import fs from 'node:fs/promises';
import path from 'node:path';
import { recordPath } from './layout.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {{ kind: 'id', value: string } | { kind: 'address', value: string } | { kind: 'message-id', value: string }} Target */

export const TARGET_FORMS = 'an address (b@example.com), a Message-ID in angle brackets (<abc@mail.example>), or a record id (8 to 32 hex characters)';

const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
const ID_RE = /^[0-9a-f]{8,32}$/;

/** A target the resolver cannot read. `code` is `ERR_TARGET`; `reason` says which shape rule failed (a CLI words its own message from it). */
export class TargetError extends Error {
  /** @param {'message-id' | 'flag' | 'address' | 'short' | 'shape' | 'type'} reason @param {string} message */
  constructor(reason, message) { super(message); this.code = 'ERR_TARGET'; this.reason = reason; }
}

/**
 * Classify a target by shape: `<...>` is a Message-ID, anything with `@` an exact address (lower-cased), 8 to 32 hex characters
 * a record id. Anything else throws a `TargetError` (`err.code === 'ERR_TARGET'`).
 * @param {string | Target} s
 * @returns {Target}
 */
export function classifyTarget(s) {
  if (s !== null && typeof s === 'object' && typeof s.value === 'string' && (s.kind === 'id' || s.kind === 'address' || s.kind === 'message-id')) return classifyTarget(s.value);
  if (typeof s !== 'string') throw new TargetError('type', `a target is a string: ${TARGET_FORMS}`);
  const t = s.trim();
  if (t.startsWith('<')) {
    if (t.length < 3 || !t.endsWith('>') || /[\s<>]/.test(t.slice(1, -1))) throw new TargetError('message-id', `"${s}" is not a Message-ID: write it with angle brackets and no spaces, like <abc@mail.example>`);
    return { kind: 'message-id', value: t };
  }
  if (t.startsWith('-')) throw new TargetError('flag', `"${s}" looks like a flag; give ${TARGET_FORMS}`);
  if (t.includes('@')) {
    if (!ADDRESS_RE.test(t)) throw new TargetError('address', `"${s}" is not an email address (one exact address, like bob@example.org)`);
    return { kind: 'address', value: t.toLowerCase() };
  }
  const low = t.toLowerCase();
  if (ID_RE.test(low)) return { kind: 'id', value: low };
  if (/^[0-9a-f]{1,7}$/.test(low)) throw new TargetError('short', `"${s}" is too short for a record id (8 or more hex characters)`);
  throw new TargetError('shape', `"${s}" is not something mailproof can look up. Give ${TARGET_FORMS}.`);
}

/**
 * Expand a record id prefix (8 to 32 hex) to the full id, by the files of its shard. A full id is returned as is, existing or not.
 * @param {string} root  The trail's working tree.
 * @param {string} s
 * @returns {Promise<{ id: string } | { none: true } | { ambiguous: string[] }>}
 */
export async function resolveRecordId(root, s) {
  const t = s.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(t)) return { id: t };
  const dir = path.join(root, path.dirname(recordPath(t.padEnd(32, '0'))));
  /** @type {string[]} */
  let names = [];
  try { names = await fs.readdir(dir); } catch { /* no such shard */ }
  const hits = names.filter((n) => n.endsWith('.json') && n.startsWith(t)).map((n) => n.slice(0, -5));
  if (hits.length === 0) return { none: true };
  if (hits.length > 1) return { ambiguous: hits };
  return { id: hits[0] };
}

/**
 * The other party of an email: the From of a received one, the first To (else Cc) of a sent one. The one definition, used by
 * `list` rows and by the CLI's one-line views.
 * @param {string} direction
 * @param {Array<{ role: string, address: string }>} addresses  In header order.
 * @returns {string | null}
 */
export function otherParty(direction, addresses) {
  const first = (/** @type {string} */ role) => addresses.find((p) => p.role === role)?.address ?? null;
  return direction === 'out' ? (first('to') ?? first('cc')) : first('from');
}

/**
 * The records an address or Message-ID target names, newest capture first (a record id names itself).
 * @param {{ list: Function, copies: Function, get: Function, root: string }} mp
 * @param {Target} t
 * @param {{ after?: Date | number | string, before?: Date | number | string, limit?: number }} [o]  `limit` 0 or absent = all.
 * @returns {Promise<{ records: MpRecord[], total: number }>}  `total` counts every match, `records` the newest `limit` of them.
 */
export async function targetRecords(mp, t, o = {}) {
  if (t.kind === 'id') {
    const r = await resolveRecordId(mp.root, t.value);
    if (!('id' in r)) {
      if ('ambiguous' in r) throw Object.assign(new Error(`${t.value} is ambiguous: ${r.ambiguous.slice(0, 10).join(', ')}${r.ambiguous.length > 10 ? ', ...' : ''}`), { code: 'ERR_TARGET', reason: 'ambiguous' });
      return { records: [], total: 0 };
    }
    const rec = await mp.get(r.id);
    return { records: rec ? [rec] : [], total: rec ? 1 : 0 };
  }
  const range = { ...(o.after ? { after: o.after } : {}), ...(o.before ? { before: o.before } : {}) };
  /** @type {string[]} */
  let ids;
  if (t.kind === 'address') {
    ids = (await mp.list({ with: t.value, ...range })).map((/** @type {{ id: string }} */ r) => r.id);
  } else {
    /** @type {Array<{ id: string, message_id: string | null }>} */
    const all = await mp.list(range);
    const keep = new Set(all.filter((r) => r.message_id === t.value).map((r) => r.id));
    const [any] = keep;
    if (any) for (const c of (await mp.copies(any)).copies) keep.add(c.id);
    ids = all.filter((r) => keep.has(r.id)).map((r) => r.id);
  }
  const limit = o.limit ?? 0;
  const pick = limit > 0 ? ids.slice(0, limit) : ids;
  /** @type {MpRecord[]} */
  const records = [];
  for (let i = 0; i < pick.length; i += 25) {
    const got = await Promise.all(pick.slice(i, i + 25).map((id) => mp.get(id)));
    for (const r of got) if (r) records.push(r);
  }
  return { records, total: ids.length };
}
