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
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag, parseInitiatorCommand,
} = require('./router');
const { preFilter, extractHeaderBlock, rawHeader } = require('./prefilter');
const { parseEnvelope } = require('./envelope');
const {
  sendmail, buildRawMessage, sanitizeSubject, newMessageId, rfc5322Date, withSignature,
} = require('./outbound');

module.exports = {
  // Verify
  classifyTrust,
  TRUST_LEVELS,
  // Sequence — address routing
  parseAddress,
  parseEventTag,
  parseVerifyTag,
  parseReverifyTag,
  parseInitiatorCommand,
  // Inbound — preprocessing
  preFilter,
  extractHeaderBlock,
  rawHeader,
  parseEnvelope,
  // Email triggers — outbound
  sendmail,
  buildRawMessage,
  sanitizeSubject,
  newMessageId,
  rfc5322Date,
  withSignature,
};
