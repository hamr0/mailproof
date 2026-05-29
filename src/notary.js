// Document notary — PRD §4.1. "Hash a document on the way in; verify it later."
//
// NET-NEW mailproof primitive (not a gitdone lift — gitdone has only
// manifest-matching strict signing, which stays policy, PRD §8.3). Two pieces:
//
//   hashDocument(bytes)               → the canonical SHA-256 of a file's bytes.
//                                       ONE source of truth for the format: m7's
//                                       parser hashes inbound attachments through
//                                       this same function, so verifyDocument can
//                                       match what was committed.
//   verifyDocument(eventId, bytes, …) → read-only lookup over the event's ledger.
//
// The framing is a proof-of-participation RECEIPT, not a secret/password: the
// DKIM-verified sender is the trust factor; a matching document only adds
// tamper-evident binding ("this verified sender submitted exactly this file,
// on this date"). See PRD §4.1 and the decisions log.
//
// SCOPE NOTE: this is the *verify* half. Mandatory auto-hashing of inbound
// attachments is the *capture* half — it needs the parsed attachment bytes,
// which only exist at the mailparser/parse layer (m7), so the parser will call
// hashDocument() to populate `commit.attachments[].sha256`. This module reads
// those hashes; it does not produce them at commit time.


import crypto from 'node:crypto';

// Canonical document fingerprint: `sha256:`-prefixed lowercase hex of the raw
// bytes. Accepts a Buffer, Uint8Array, or string (utf8). The prefix matches the
// ledger convention for the hashes gitrepo controls (`sender_hash`,
// `message_id_hash`) and the existing attachment/`raw_sha256` fixtures, so m7's
// parser stores a consistent value; verifyDocument still normalises either form
// when comparing, so a populator that emitted bare hex can't trip the match.
/**
 * Canonical document fingerprint: `sha256:`-prefixed lowercase hex. Accepts a
 * Buffer, Uint8Array, or utf8 string. Pure.
 * @param {Buffer | Uint8Array | string} bytes
 * @returns {string}
 */
function hashDocument(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * @param {string | null | undefined} h
 * @returns {string}
 */
function normHash(h) {
  return typeof h === 'string' ? h.replace(/^sha256:/i, '').toLowerCase() : '';
}

/**
 * Compose the document notary over a bound gitrepo + event store (PRD §4.1).
 * @param {{ gitrepo?: any, eventStore?: any }} [deps]
 * @returns {{ hashDocument: typeof hashDocument, verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: { email?: string }) => Promise<{ found: boolean, matches: Array<Record<string, any>> }> }}
 */
function createNotary({ gitrepo, eventStore } = {}) {
  if (!gitrepo || !eventStore) {
    throw new Error('createNotary: { gitrepo, eventStore } required');
  }

  // Verify a document against an event's tamper-evident ledger. Re-hashes
  // `docBytes`, scans every committed reply (counted or not — accept-with-flag),
  // and returns each commit whose attachments include that hash. When `email`
  // is supplied, `sender_match` flags whether that verified sender is the one
  // who submitted it (the second layer); without it, `sender_match` is null.
  //
  //   → { found, matches: [{ sequence, received_at, trust_level, counted,
  //                          sender_domain, sender_match, filename }] }
  /**
   * Verify a document against an event's ledger (PRD §4.1). Re-hashes the bytes
   * and returns each commit whose attachments include that hash.
   * @param {string} eventId
   * @param {Buffer | Uint8Array | string} docBytes
   * @param {{ email?: string }} [opts]
   * @returns {Promise<{ found: boolean, matches: Array<Record<string, any>> }>}
   */
  async function verifyDocument(eventId, docBytes, { email } = {}) {
    const target = normHash(hashDocument(docBytes));
    const event = await eventStore.loadEvent(eventId);
    if (!event) return { found: false, matches: [] };

    // Salted so the comparison runs against the same encoding the ledger stored
    // (gitrepo.saltedSenderHash); salt is per-event and public.
    const emailHash = email ? gitrepo.saltedSenderHash(email, event.salt) : null;

    const commits = await gitrepo.listCommits(eventId);
    const matches = [];
    for (const c of commits) {
      /** @type {import('./types.js').Attachment[]} */
      const atts = Array.isArray(c.attachments) ? c.attachments : [];
      const hit = atts.find((a) => a && normHash(a.sha256) === target);
      if (!hit) continue;
      matches.push({
        sequence: c.sequence,
        received_at: c.received_at,
        trust_level: c.trust_level,
        counted: c.counted == null ? null : c.counted,
        sender_domain: c.sender_domain == null ? null : c.sender_domain,
        sender_match: emailHash ? c.sender_hash === emailHash : null,
        filename: hit.filename == null ? null : hit.filename,
      });
    }
    return { found: matches.length > 0, matches };
  }

  return { hashDocument, verifyDocument };
}

export { createNotary, hashDocument };
