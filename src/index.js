// mailproof — public entry point.
//
// Email-native multi-party coordination kernel: verify an inbound reply,
// sequence it through a workflow, commit it to a tamper-evident git ledger,
// and trigger the next email. See docs/02-design/DESIGN.md for the planned
// surface and docs/02-design/SPEC.md for the wire formats.
//
// P1 lifts the modules one at a time; this file re-exports each as it lands.
// The high-level create({ ... }) factory arrives once the pillars compose.

'use strict';

const { classifyTrust, TRUST_LEVELS } = require('./classifier');
const {
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag, parseAttestTag, parseInitiatorCommand,
} = require('./router');
const { preFilter, extractHeaderBlock, rawHeader } = require('./prefilter');
const { parseEnvelope } = require('./envelope');
const { authenticateMessage, parseMessage } = require('./parse');
const {
  sendmail, buildRawMessage, sanitizeSubject, newMessageId, rfc5322Date, withSignature,
} = require('./outbound');
const { createEventStore } = require('./event-store');
const { withEventMutex } = require('./event-mutex');
const { createGitrepo } = require('./gitrepo');
const { createOts } = require('./ots');
const {
  shouldCount, applyReply, isComplete, firstPendingStep,
  stepDepsMet, eligibleSteps, meetsTrust, COUNT_REASONS,
} = require('./completion');
const {
  shouldCount: shouldCountSignoff,
  applyReply: applySignoff,
  signatures,
  CRYPTO_REASONS,
} = require('./crypto');
const { createNotary, hashDocument } = require('./notary');
const { create } = require('./create');

module.exports = {
  // Composition root — wires the four pillars into one bound instance (m7b-3)
  create,
  // Verify
  classifyTrust,
  TRUST_LEVELS,
  // Sequence — address routing
  parseAddress,
  parseEventTag,
  parseVerifyTag,
  parseReverifyTag,
  parseAttestTag,
  parseInitiatorCommand,
  // Inbound — preprocessing
  preFilter,
  extractHeaderBlock,
  rawHeader,
  parseEnvelope,
  // Inbound — decoding (mailauth authenticate + mailparser parse; m7a)
  authenticateMessage,
  parseMessage,
  // Email triggers — outbound
  sendmail,
  buildRawMessage,
  sanitizeSubject,
  newMessageId,
  rfc5322Date,
  withSignature,
  // Git ledger — storage (factory-bound to dataDir)
  createEventStore,
  withEventMutex,
  createGitrepo,
  // Git ledger — optional OTS anchoring (factory-bound to otsBin)
  createOts,
  // Sequence — workflow completion engine (pure transitions)
  shouldCount,
  applyReply,
  isComplete,
  firstPendingStep,
  stepDepsMet,
  eligibleSteps,
  meetsTrust,
  COUNT_REASONS,
  // Sequence — crypto sign-off engine (PRD §4.2; the second coordination mode)
  shouldCountSignoff,
  applySignoff,
  signatures,
  CRYPTO_REASONS,
  // Verify — document notary (PRD §4.1; factory composes gitrepo + eventStore)
  createNotary,
  hashDocument,
};
