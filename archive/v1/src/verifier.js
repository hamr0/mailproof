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


import dns from 'node:dns';
import { authenticate } from 'mailauth';
import { hashDocument } from './notary.js';

// Match candidate bytes against an event's commits. Cascade: whole-email
// (raw_sha256) → Message-ID (salted, when the caller supplies the hash) → any
// committed attachment. Pure. Hashes use the notary's `sha256:`-tagged format —
// the same one the ledger stored, so one fingerprint format end to end.
/** @typedef {import('./types.js').Commit} Commit */
/** @typedef {import('./types.js').TrustLevel} TrustLevel */

/**
 * Match candidate bytes against an event's commits (raw → message-id → any
 * attachment). Pure.
 * @param {Buffer} candidateBytes
 * @param {Commit[]} commits
 * @param {{ messageIdHash?: string | null }} [opts]
 * @returns {{ matchType: 'raw_email' | 'message_id' | 'attachment' | 'none', hash: string, commit?: Commit, attachment?: Record<string, any>, messageIdHash?: string | null }}
 */
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
/**
 * Re-run DKIM on `rawEmail` against an ARCHIVED PEM key. Never throws.
 * @param {Buffer | string} rawEmail
 * @param {string | null} archivedPem
 * @param {string} expectedDomain
 * @param {string} expectedSelector
 * @param {{ baseResolver?: any }} [opts]
 * @returns {Promise<{ ok: boolean, result?: string, reason?: string, signatures_found?: Array<Record<string, any>> }>}
 */
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
  /**
   * @param {string} name
   * @param {string} [type]
   * @returns {Promise<any>}
   */
  const resolver = async (name, type) => {
    if ((type || 'TXT').toUpperCase() === 'TXT' && name === wantName) return [[txtRecord]];
    if (baseResolver) return baseResolver(name, type);
    return type
      ? dns.promises.resolve(name, type)
      : dns.promises.resolve(name);
  };
  try {
    const auth = await authenticate(rawEmail, { trustReceived: false, resolver });
    /** @type {Array<Record<string, any>>} */
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
    return { ok: false, reason: (err instanceof Error ? err.message : null) || String(err) };
  }
}

// Trust-upgrade policy for a contested commit (pure). A commit recorded below
// `verified` at reception whose DKIM re-verifies against the archived key is
// upgraded to `verified`; an already-verified commit records the attempt but
// doesn't upgrade. (mailproof's four levels — classifier.js.)
/**
 * Trust-upgrade policy for a contested commit (pure).
 * @param {string} currentLevel
 * @returns {{ upgradeTo: TrustLevel | null, reason: string | null }}
 */
function resolveUpgrade(currentLevel) {
  if (currentLevel === 'verified') return { upgradeTo: null, reason: 'already verified' };
  if (['unverified', 'authorized', 'forwarded'].includes(currentLevel)) {
    return { upgradeTo: 'verified', reason: null };
  }
  return { upgradeTo: null, reason: `unknown source trust level: ${currentLevel}` };
}

// Find the signing domain/selector in a commit's DKIM summary (pure). Prefer the
// signature that passed at reception; else any with domain+selector (reverify is
// exactly about the cases that didn't pass/align then).
/**
 * Find the signing domain/selector in a commit's DKIM summary. Pure.
 * @param {Record<string, any>} commit
 * @returns {Record<string, any> | null}
 */
function pickSigner(commit) {
  /** @type {Array<Record<string, any>>} */
  const sigs = (commit && commit.dkim && commit.dkim.signatures) || [];
  return (
    sigs.find((s) => s && s.result === 'pass' && s.domain && s.selector)
    || sigs.find((s) => s && s.domain && s.selector)
    || null
  );
}

// Compose the verifier over the bound ledger. `resolver` is the default base
// resolver for the DKIM re-check (create() threads its own; tests inject an
// offline one so the archived key is the ONLY way the signature can verify).
/**
 * Compose the offline durable-verifier over the bound ledger + store.
 * @param {{ gitrepo?: any, eventStore?: any, resolver?: any }} [deps]
 * @returns {{
 *   verify: (eventId: string, candidateBytes: Buffer | string, opts?: { messageId?: string | null, resolver?: any }) => Promise<Record<string, any>>,
 *   reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: { resolver?: any, now?: string }) => Promise<Record<string, any>>,
 *   findMatch: typeof findMatch,
 *   reverifyDkim: typeof reverifyDkim,
 *   resolveUpgrade: typeof resolveUpgrade,
 *   pickSigner: typeof pickSigner,
 * }}
 */
function createVerifier({ gitrepo, eventStore, resolver: defaultResolver = null } = {}) {
  const { listCommits, loadCommit, loadDkimPem, commitReverify, saltedMessageIdHash } = gitrepo;
  const { loadEvent } = eventStore;

  // Verify candidate bytes (the original raw email, or a document) against an
  // event's ledger. Returns a structured result; never throws. When the match
  // is a whole-email/Message-ID hit, also re-verifies DKIM against the archived
  // key — the offline-durable proof.
  /**
   * @param {string} eventId
   * @param {Buffer | string} candidateBytes
   * @param {{ messageId?: string | null, resolver?: any }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async function verify(eventId, candidateBytes, { messageId = null, resolver = defaultResolver } = {}) {
    const buf = Buffer.isBuffer(candidateBytes) ? candidateBytes : Buffer.from(String(candidateBytes || ''));
    const commits = await listCommits(eventId);
    if (commits.length === 0) return { eventId, matched: false, reason: 'no_commits' };
    const event = await loadEvent(eventId);
    const salt = (event && event.salt) || null;
    const messageIdHash = messageId ? saltedMessageIdHash(messageId, salt) : null;

    const m = findMatch(buf, commits, { messageIdHash });
    /** @type {Record<string, any>} */
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
      /** @type {Record<string, any> | null} */
      const dkim = m.commit.dkim || null;
      const sig = (dkim && dkim.signatures && dkim.signatures[0]) || null;
      const pem = await loadDkimPem(eventId, m.commit.dkim_key_file);
      if (sig && pem && sig.result === 'pass') {
        result.dkim_reverify = await reverifyDkim(buf, pem, sig.domain, sig.selector, { baseResolver: resolver });
      } else {
        result.dkim_reverify = { ok: false, reason: 'no archived key or signature was not pass' };
      }
    }
    return result;
  }

  // Re-evaluate a CONTESTED reply commit: the submitter forwards the original
  // raw .eml, we re-run DKIM against that commit's archived key, and on a pass
  // upgrade the recorded trust — persisting an IMMUTABLE reverify record (the
  // original commit is never rewritten). `candidateBytes` is the raw original
  // email. Returns the record; never throws. The reverify+ email route is the
  // consumer's glue (the ack body is policy, §8.6).
  /**
   * @param {string} eventId
   * @param {number} targetSequence
   * @param {Buffer | string} candidateBytes
   * @param {{ resolver?: any, now?: string }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async function reverify(eventId, targetSequence, candidateBytes, { resolver = defaultResolver, now = new Date().toISOString() } = {}) {
    const target = await loadCommit(eventId, targetSequence);
    if (!target) {
      return { found: false, reason: `no commit-${String(targetSequence).padStart(3, '0')}.json in ${eventId}` };
    }
    const buf = Buffer.isBuffer(candidateBytes) ? candidateBytes : Buffer.from(String(candidateBytes || ''));
    const before = target.trust_level || 'unverified';
    const signer = pickSigner(target);
    const pem = target.dkim_key_file ? await loadDkimPem(eventId, target.dkim_key_file) : null;

    let verdict;
    if (!signer) verdict = { ok: false, reason: 'no signing domain/selector in committed DKIM record' };
    else if (!pem) verdict = { ok: false, reason: 'no archived DKIM key for this commit' };
    else verdict = await reverifyDkim(buf, pem, signer.domain, signer.selector, { baseResolver: resolver });

    const policy = resolveUpgrade(before);
    const upgraded = Boolean(verdict.ok && policy.upgradeTo);
    const after = upgraded ? policy.upgradeTo : before;

    const record = {
      trust_level_before: before,
      trust_level_after: after,
      upgraded,
      dkim_reverify: verdict,
      evidence: { raw_sha256: hashDocument(buf), raw_size: buf.length },
    };
    // Persist the immutable upgrade record onto the ledger.
    const event = await loadEvent(eventId);
    const commit = await commitReverify(eventId, event, targetSequence, record, now);

    return {
      found: true,
      eventId,
      targetSequence,
      reverifySequence: commit.sequence,
      upgraded,
      trust_level_before: before,
      trust_level_after: after,
      policy_note: policy.reason,
      dkim_reverify: verdict,
    };
  }

  return { verify, reverify, findMatch, reverifyDkim, resolveUpgrade, pickSigner };
}

export { createVerifier, findMatch, reverifyDkim, resolveUpgrade, pickSigner };
