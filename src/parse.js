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

'use strict';

const { authenticate } = require('mailauth');
const { simpleParser } = require('mailparser');
const { hashDocument } = require('./notary');

// Authenticate an inbound message. Pins `trustReceived: false` — mailproof
// never trusts pre-existing `Received`/`Authentication-Results` headers, only
// its own check against the envelope (forged headers are the obvious attack).
// `envelope` is the m3 parseEnvelope shape; `mtaHostname`/`resolver` are
// injected config (no env singleton). `resolver` lets tests run offline and the
// future verify+@ endpoint re-check against an archived key.
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

module.exports = { authenticateMessage, parseMessage };
