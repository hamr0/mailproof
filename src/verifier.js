// Verify pillar — the offline durable-verification half (m7c-2). Answers "does
// this email/document correspond to a committed record, and does its DKIM
// signature still hold against the key we ARCHIVED at receive time?" — the
// portable proof that survives the signer rotating their DNS key. This is the
// mechanism behind a consumer's verify+ / reverify endpoints; rendering a report
// email is the consumer's job (a body, not a mechanism — §8.6).
//
// LIFTED FROM gitdone's verify.js/reverify.js, trimmed to the two kernel
// primitives (findMatch + reverifyDkim) + a thin composer. Report FORMATTING
// (the plain-text body sent back to a forwarder) stays policy.

'use strict';

const { authenticate } = require('mailauth');
const { hashDocument } = require('./notary');

// Match candidate bytes against an event's commits. Cascade: whole-email
// (raw_sha256) → Message-ID (salted, when the caller supplies the hash) → any
// committed attachment. Pure. Hashes use the notary's `sha256:`-tagged format —
// the same one the ledger stored, so one fingerprint format end to end.
function findMatch(candidateBytes, commits, { messageIdHash = null } = {}) {
  const hash = hashDocument(candidateBytes);
  const byRaw = commits.find((c) => c && c.raw_sha256 === hash);
  if (byRaw) return { matchType: 'raw_email', hash, commit: byRaw };
  if (messageIdHash) {
    const byMid = commits.find((c) => c && c.message_id_hash === messageIdHash);
    if (byMid) return { matchType: 'message_id', hash, commit: byMid, messageIdHash };
  }
  for (const c of commits) {
    const a = (c && c.attachments || []).find((att) => att && att.sha256 === hash);
    if (a) return { matchType: 'attachment', hash, commit: c, attachment: a };
  }
  return { matchType: 'none', hash, messageIdHash };
}

// Re-run DKIM on rawEmail against an ARCHIVED public key (PEM). A resolver
// serves the archived key for the expected selector/domain; every other lookup
// delegates to baseResolver (default: real DNS). DMARC/SPF verdicts are
// irrelevant here — we read the DKIM signature result directly, so passing a
// failing baseResolver (offline) still lets the archived-key check run. Never
// throws; returns { ok, result?, reason?, signatures_found }.
async function reverifyDkim(rawEmail, archivedPem, expectedDomain, expectedSelector, { baseResolver = null } = {}) {
  if (!archivedPem || !expectedDomain || !expectedSelector) {
    return { ok: false, reason: 'missing archived key or signer context' };
  }
  const pemBody = archivedPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const txtRecord = `v=DKIM1; k=rsa; p=${pemBody}`;
  const wantName = `${expectedSelector}._domainkey.${expectedDomain}`;
  const resolver = async (name, type) => {
    if ((type || 'TXT').toUpperCase() === 'TXT' && name === wantName) return [[txtRecord]];
    if (baseResolver) return baseResolver(name, type);
    return require('node:dns').promises.resolve(name, type);
  };
  try {
    const auth = await authenticate(rawEmail, { trustReceived: false, resolver });
    const sigs = (auth.dkim && auth.dkim.results) || [];
    const signatures_found = sigs.map((r) => ({
      domain: r.signingDomain || null,
      selector: r.selector || null,
      result: r.status && r.status.result,
    }));
    const sig = sigs.find((r) => r.signingDomain === expectedDomain && r.selector === expectedSelector);
    if (!sig) {
      return {
        ok: false,
        reason: sigs.length === 0
          ? 'no DKIM-Signature in candidate'
          : `no sig matched ${expectedDomain}/${expectedSelector}`,
        signatures_found,
      };
    }
    const passed = sig.status && sig.status.result === 'pass';
    return { ok: !!passed, result: sig.status && sig.status.result, signatures_found };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

// Compose the verifier over the bound ledger. `resolver` is the default base
// resolver for the DKIM re-check (create() threads its own; tests inject an
// offline one so the archived key is the ONLY way the signature can verify).
function createVerifier({ gitrepo, eventStore, resolver: defaultResolver = null } = {}) {
  const { listCommits, loadDkimPem, saltedMessageIdHash } = gitrepo;
  const { loadEvent } = eventStore;

  // Verify candidate bytes (the original raw email, or a document) against an
  // event's ledger. Returns a structured result; never throws. When the match
  // is a whole-email/Message-ID hit, also re-verifies DKIM against the archived
  // key — the offline-durable proof.
  async function verify(eventId, candidateBytes, { messageId = null, resolver = defaultResolver } = {}) {
    const buf = Buffer.isBuffer(candidateBytes) ? candidateBytes : Buffer.from(String(candidateBytes || ''));
    const commits = await listCommits(eventId);
    if (commits.length === 0) return { eventId, matched: false, reason: 'no_commits' };
    const event = await loadEvent(eventId);
    const salt = (event && event.salt) || null;
    const messageIdHash = messageId ? saltedMessageIdHash(messageId, salt) : null;

    const m = findMatch(buf, commits, { messageIdHash });
    const result = {
      eventId,
      matched: m.matchType !== 'none',
      matchType: m.matchType,
      hash: m.hash,
      sequence: m.commit ? m.commit.sequence : null,
      counted: m.commit ? !!m.commit.counted : null,
      trustLevel: m.commit ? m.commit.trust_level : null,
      senderDomain: m.commit ? m.commit.sender_domain : null,
    };

    if ((m.matchType === 'raw_email' || m.matchType === 'message_id') && m.commit) {
      const sig = (m.commit.dkim && m.commit.dkim.signatures && m.commit.dkim.signatures[0]) || null;
      const pem = await loadDkimPem(eventId, m.commit.dkim_key_file);
      if (sig && pem && sig.result === 'pass') {
        result.dkim_reverify = await reverifyDkim(buf, pem, sig.domain, sig.selector, { baseResolver: resolver });
      } else {
        result.dkim_reverify = { ok: false, reason: 'no archived key or signature was not pass' };
      }
    }
    return result;
  }

  return { verify, findMatch, reverifyDkim };
}

module.exports = { createVerifier, findMatch, reverifyDkim };
