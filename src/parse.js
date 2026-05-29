// Inbound decoding — turn raw RFC-822 bytes into mailproof's structured inputs.
//
// Two steps the orchestrator runs on every inbound message (gitdone does both
// in `receive.js`, which is NOT lifted — these are the primitives it composed):
//
//   authenticateMessage(raw, envelope, opts) → the mailauth result, which
//     classifyTrust() (the verify pillar, m1) maps to a trust level.
//   parseMessage(raw) → { from, messageId, attachments, rawSha256 }, the
//     fields the router/ledger/engines need. Deterministic (no network).
//
// These are the only two places mailproof touches `mailauth` / `mailparser`
// (the project's two external deps — DKIM/DMARC/ARC and untrusted-MIME parsing
// are security-critical, so a vetted library is required, never hand-rolled).
// Attachment + raw hashes go through the notary's `hashDocument` so every
// fingerprint mailproof writes uses ONE format (the notary "capture" half).


import { authenticate } from 'mailauth';
import mailparserPkg from 'mailparser';
import { hashDocument } from './notary.js';

/**
 * The subset of mailparser's `ParsedMail` the kernel reads. mailparser ships no
 * type declarations, so this local shape pins exactly the fields used here
 * (the `simpleParser` import is typed against it below).
 * @typedef {Object} ParsedMail
 * @property {{ value?: Array<{ address?: string, name?: string }> } | null} [from]
 * @property {string | null} [messageId]
 * @property {Array<{ filename?: string, size?: number, content?: Buffer }>} [attachments]
 */
// mailparser ships no type declarations. The JSDoc cast supplies the real shape
// (the fields the kernel reads — see ParsedMail) instead of an implicit `any`,
// with no `@ts-ignore`.
const { simpleParser } = /** @type {{ simpleParser: (source: Buffer | string) => Promise<ParsedMail> }} */ (
  mailparserPkg
);

// Authenticate an inbound message. Pins `trustReceived: false` — mailproof
// never trusts pre-existing `Received`/`Authentication-Results` headers, only
// its own check against the envelope (forged headers are the obvious attack).
// `envelope` is the m3 parseEnvelope shape; `mtaHostname`/`resolver` are
// injected config (no env singleton). `resolver` lets tests run offline and the
// future verify+@ endpoint re-check against an archived key.
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {import('./types.js').ParsedMessage} ParsedMessage */
/** @typedef {import('./types.js').AuthSummary} AuthSummary */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */

/**
 * Authenticate an inbound message via mailauth (DKIM/DMARC/ARC/SPF). Pins
 * `trustReceived:false`. Config is injected (no env singleton).
 * @param {Buffer | string} raw
 * @param {Envelope} [envelope]
 * @param {{ mtaHostname?: string | null, resolver?: any }} [opts]
 * @returns {Promise<MailauthResult>}
 */
function authenticateMessage(raw, envelope = {}, { mtaHostname = null, resolver = null } = {}) {
  return authenticate(raw, {
    trustReceived: false,
    ip: envelope.clientIp || undefined,
    helo: envelope.clientHelo || undefined,
    sender: envelope.sender || undefined,
    mta: mtaHostname || undefined,
    resolver: resolver || undefined,
  });
}

// Parse an inbound message into the structured shape the kernel consumes.
// `attachments[].sha256` is the notary fingerprint of the part's bytes — this
// IS the notary capture half (mandatory auto-hash of every inbound attachment).
/**
 * Parse raw bytes into the structured shape the kernel consumes. Attachment
 * bytes are hashed (notary capture) then dropped. Deterministic, no network.
 * @param {Buffer | string} raw
 * @returns {Promise<ParsedMessage>}
 */
async function parseMessage(raw) {
  const parsed = await simpleParser(raw);
  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || null,
    size: a.size || (a.content && a.content.length) || 0,
    sha256: a.content ? hashDocument(a.content) : null,
  }));
  return {
    from: { address: from.address || null, name: from.name || null },
    messageId: parsed.messageId || null,
    attachments,
    rawSha256: hashDocument(raw),
  };
}

// Extract verification candidates from a forwarded message — the raw bytes of
// every attachment part (the forwarded original .eml / document) plus the
// message-id. Used ONLY by the transient verify+/reverify+ read path: the
// content is hashed against the ledger and discarded, never persisted. (SPEC §6
// "no plaintext at rest" governs the LEDGER; a read-time match is not at rest.)
// parseMessage deliberately strips attachment content, so this is the one seam
// that recovers it — kept here so all MIME decoding stays in one module.
/**
 * Recover the raw bytes of every attachment part (+ the message-id) from a
 * forwarded message. Transient read-path only — never persisted (SPEC §6).
 * @param {Buffer | string} raw
 * @returns {Promise<{ messageId: string | null, candidates: Buffer[] }>}
 */
async function extractVerifyCandidates(raw) {
  const parsed = await simpleParser(raw);
  const candidates = (parsed.attachments || [])
    .map((a) => a.content)
    .filter(/** @returns {c is Buffer} */ (c) => Buffer.isBuffer(c) && c.length > 0);
  return { messageId: parsed.messageId || null, candidates };
}

// Reduce a mailauth result to the compact auth summaries the ledger records on
// each commit (SPEC §4): the DKIM signatures (result/domain/selector/aligned),
// and the SPF/DMARC/ARC verdicts. Pure — interprets the auth object, no I/O.
// `classifyTrust` (m1) collapses the same object to ONE trust level; this keeps
// the detail an auditor needs alongside it.
/**
 * Reduce a mailauth result to the compact auth summaries the ledger records
 * (SPEC §4). Pure — interprets the auth object, no I/O.
 * @param {MailauthResult} auth
 * @returns {AuthSummary}
 */
function summariseAuth(auth) {
  /** @type {Array<{ status?: { result?: string, comment?: string, aligned?: boolean }, signingDomain?: string, selector?: string, algo?: string, info?: string }>} */
  const dkimResults = (auth && auth.dkim && auth.dkim.results) || [];
  const dkim = dkimResults.length === 0 ? { result: 'none' } : {
    signatures: dkimResults.map((r) => ({
      result: r.status && r.status.result,
      comment: (r.status && r.status.comment) || null,
      domain: r.signingDomain || null,
      selector: r.selector || null,
      aligned: (r.status && r.status.aligned) || null,
      algorithm: r.algo || null,
      info: r.info || null,
    })),
  };
  const spf = auth && auth.spf ? { result: auth.spf.status && auth.spf.status.result } : null;
  const dmarc = auth && auth.dmarc ? { result: auth.dmarc.status && auth.dmarc.status.result } : null;
  const arc = auth && auth.arc ? {
    result: auth.arc.status && auth.arc.status.result,
    comment: (auth.arc.status && auth.arc.status.comment) || null,
    // ARC chain depth = the highest ARC instance number (i=N for the last
    // seal); mailauth exposes it as `arc.i` (0 when no chain exists).
    chain_length: (auth.arc.i && Number.isFinite(auth.arc.i)) ? auth.arc.i : 0,
  } : null;
  return { dkim, spf, dmarc, arc };
}

export { authenticateMessage, parseMessage, summariseAuth, extractVerifyCandidates };
