// Which copy of a message is this record? (SPEC Part B1, `message_key` + `copy`.)
// A message reaches you by several routes (direct, via a mailing list, forwarded);
// each distinct byte string is its own record, and `message_key` groups the copies
// of one signed message. Evidence is domains and flags only, never text.

import crypto from 'node:crypto';
import { parseTags } from './signed-headers.js';
import { relayEvidence } from './relay.js';

/** @typedef {import('./types.js').MessageCopy} MessageCopy */
/** @typedef {import('./types.js').AttachedOriginal} AttachedOriginal */
/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

/** At most this many inner (message/rfc822) messages are examined, one level deep. */
const MAX_INNER = 10;

/**
 * Forward subject prefixes: Fwd / Fw (English), WG (German), TR (French), RV (Spanish).
 * Deliberately small; `Re:` is a reply, not a forward.
 */
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv)\s*:/i;

/** @param {string} s */
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Key shared by every copy of one signed message: today's `b=` rule (the first
 * DKIM-Signature's raw `b=`). Unsigned mail: its Message-ID (hashed), else null.
 * @param {HeaderRow[]} rows
 * @returns {string | null}  32 hex, or null
 */
function messageKeyOf(rows) {
  const sig = rows.find((r) => r.name === 'dkim-signature');
  if (sig) return sha256hex('mp2\n' + (parseTags(sig.raw).b || '').replace(/\s+/g, '')).slice(0, 32);
  const mid = rows.find((r) => r.name === 'message-id');
  const norm = mid ? mid.raw.slice(mid.raw.indexOf(':') + 1).trim().replace(/^<|>$/g, '').trim().toLowerCase() : '';
  return norm ? sha256hex('mp2\nmid\n' + norm).slice(0, 32) : null;
}

/**
 * Classify this copy. Precedence: forward by Subject prefix, digest (List-Id or a
 * multipart/digest part, AND message/rfc822 parts), forward by message/rfc822 part,
 * relayed, direct (signed, no relay evidence), else unknown.
 * @param {{ rows: HeaderRow[], subject: string | null, signed: boolean, attached: AttachedOriginal[], capped: boolean, multipartDigest?: boolean }} x
 * @returns {MessageCopy}
 */
function classifyCopy({ rows, subject, signed, attached, capped, multipartDigest = false }) {
  const relay = relayEvidence(rows);
  const relayed = relay.arc_sealers.length > 0 || relay.list_id_domain !== null;
  /** @type {Record<string, any>} */
  const evidence = {};
  if (relayed) { evidence.arc_sealers = relay.arc_sealers; evidence.list_id_domain = relay.list_id_domain; }
  const prefix = !!subject && FORWARD_SUBJECT.test(subject);
  const digest = !prefix && attached.length > 0 && (relay.list_id_domain !== null || multipartDigest);
  if (prefix || attached.length) {
    if (prefix) evidence.subject_prefix = true;
    if (attached.length) evidence.attached_original = attached;
    if (capped) evidence.capped = true;
    return { kind: digest ? 'digest' : 'forward', evidence };
  }
  if (relayed) return { kind: 'relayed', evidence };
  return { kind: signed ? 'direct' : 'unknown', evidence: {} };
}

export { messageKeyOf, classifyCopy, MAX_INNER };
