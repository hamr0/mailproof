// Address-first targets for `show` and `verify` (SPEC B11.5a): one resolver by the SHAPE of the argument, shared by the
// subcommands and the menu, and the helpers both commands use to turn a target into records. Library calls only
// (`list`, `copies`, `get`); "an email names this address" is the library's one definition (`list({ with })`, SPEC B8).

import { UsageError } from './errors.js';
import { parseAddress } from './parse.js';
import { participantsOf, signedHeaderValue } from '../proof/participants.js';
import { asText } from '../proof/bundle-readme.js';

/** @typedef {import('../proof/types.js').MpRecord} MpRecord */
/** @typedef {{ kind: 'id', value: string } | { kind: 'address', value: string } | { kind: 'message-id', value: string }} Target */

export const TARGET_FORMS = 'an address (b@example.com), a Message-ID in angle brackets (<abc@mail.example>), or a record id (8 to 32 hex characters)';
export const ID_HINT = 'ids are positional: mailproof show ea1fda2a (8+ characters), or use an address: mailproof show b@example.com';

/**
 * Classify a `show`/`verify` argument by shape: `<...>` is a Message-ID, anything with `@` an exact address, 8 to 32 hex
 * characters a record id. Anything else is a usage error that names the three forms.
 * @param {string} s
 * @returns {Target}
 */
export function classifyTarget(s) {
  const t = s.trim();
  if (t.startsWith('<')) {
    if (t.length < 3 || !t.endsWith('>') || /[\s<>]/.test(t.slice(1, -1))) throw new UsageError(`"${s}" is not a Message-ID: write it with angle brackets and no spaces, like <abc@mail.example>`);
    return { kind: 'message-id', value: t };
  }
  if (t.startsWith('-')) throw new UsageError(`"${s}" looks like a flag. ${ID_HINT}`);
  if (t.includes('@')) return { kind: 'address', value: parseAddress(t, 'target').toLowerCase() };
  const low = t.toLowerCase();
  if (/^[0-9a-f]{8,32}$/.test(low)) return { kind: 'id', value: low };
  if (/^[0-9a-f]{1,7}$/.test(low)) throw new UsageError(`"${s}" is too short for a record id (8 or more hex characters). ${ID_HINT}`);
  throw new UsageError(`"${s}" is not something mailproof can look up. Give ${TARGET_FORMS}.`);
}

/**
 * The records an address or Message-ID target names, newest capture first.
 * @param {import('../index.js').Mailproof} mp
 * @param {Target} t  Not an id.
 * @param {{ after?: Date, before?: Date, limit: number }} o  `limit` 0 = all.
 * @returns {Promise<{ records: MpRecord[], total: number }>}  `total` counts every match, `records` the newest `limit` of them.
 */
export async function targetRecords(mp, t, o) {
  const range = { ...(o.after ? { after: o.after } : {}), ...(o.before ? { before: o.before } : {}) };
  /** @type {string[]} */
  let ids;
  if (t.kind === 'address') {
    ids = (await mp.list({ with: t.value, ...range })).map((r) => r.id);
  } else {
    const all = await mp.list(range);
    const keep = new Set(all.filter((r) => r.message_id === t.value).map((r) => r.id));
    const [any] = keep;
    if (any) for (const c of (await mp.copies(any)).copies) keep.add(c.id);
    ids = all.filter((r) => keep.has(r.id)).map((r) => r.id);
  }
  const pick = o.limit > 0 ? ids.slice(0, o.limit) : ids;
  /** @type {MpRecord[]} */
  const records = [];
  for (let i = 0; i < pick.length; i += 25) {
    const got = await Promise.all(pick.slice(i, i + 25).map((id) => mp.get(id)));
    for (const r of got) if (r) records.push(r);
  }
  return { records, total: ids.length };
}

/**
 * What a text line needs from one record: the other party (From of a received email, first To of a sent one), the signed
 * subject (an unsigned record keeps no subject: SPEC B1), attachments, trust. Never throws on a malformed record.
 * @param {MpRecord} rec
 * @returns {{ id: string, captured: string, direction: string, live: string, portable: string, other: string | null, subject: string | null, body: string, attachments: number }}
 */
export function factsOfRecord(rec) {
  const parts = participantsOf(rec);
  const first = (/** @type {string} */ role) => parts.find((p) => p.role === role)?.address ?? null;
  const other = rec.direction === 'out' ? (first('to') ?? first('cc')) : first('from');
  const subject = signedHeaderValue(rec, 'subject');
  return {
    id: rec.id, captured: rec.captured, direction: rec.direction,
    live: rec.verdicts?.live?.trust ?? '-', portable: rec.verdicts?.portable?.trust ?? '-',
    other, subject: subject === null ? null : asText(subject),
    body: rec.body_status ?? '-', attachments: Array.isArray(rec.attachments) ? rec.attachments.length : 0,
  };
}

/** @param {string} iso @returns {string} `2026-11-01T08:00Z`. */
export const minute = (iso) => `${iso.slice(0, 16)}Z`;
