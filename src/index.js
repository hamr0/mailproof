// mailproof — public entry point.
//
// Email-native multi-party coordination kernel: verify an inbound reply,
// sequence it through a workflow, commit it to a tamper-evident git ledger,
// and trigger the next email. See docs/02-design/DESIGN.md for the planned
// surface and docs/02-design/SPEC.md for the wire formats.
//
// P1 lifts the modules one at a time; this file re-exports each as it lands.
// The high-level create({ ... }) factory arrives once the pillars compose.


import { classifyTrust, TRUST_LEVELS } from './classifier.js';
import {
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag, parseAttestTag, parseInitiatorCommand,
} from './router.js';
import { preFilter, extractHeaderBlock, rawHeader } from './prefilter.js';
import { parseEnvelope } from './envelope.js';
import { authenticateMessage, parseMessage, summariseAuth } from './parse.js';
import {
  fetchDkimKey, pickSignatureToArchive, extractPublicKey, toPem,
} from './dkim-archive.js';
import {
  sendmail, buildRawMessage, sanitizeSubject, newMessageId, rfc5322Date, withSignature,
} from './outbound.js';
import { createEventStore } from './event-store.js';
import { withEventMutex } from './event-mutex.js';
import { createGitrepo, saltedSenderHash } from './gitrepo.js';
import { createOts, parseOtsBlockHeight } from './ots.js';
import {
  shouldCount, applyReply, isComplete, firstPendingStep,
  stepDepsMet, eligibleSteps, meetsTrust, COUNT_REASONS,
} from './completion.js';
import {
  shouldCount as shouldCountSignoff,
  applyReply as applySignoff,
  signatures,
  CRYPTO_REASONS,
} from './crypto.js';
import { createNotary, hashDocument } from './notary.js';
import {
  createVerifier, findMatch, reverifyDkim, resolveUpgrade, pickSigner,
} from './verifier.js';
import { createNotifier } from './notify.js';
import { createSweep, referenceClockMs, isActive } from './sweep.js';
import { createProofAnchor } from './proof-anchor.js';
import {
  isDeliveryStatusReport, extractDsn, permanentFailures, parseDeliveryStatusBody,
} from './dsn.js';
import { create } from './create.js';

export {
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
  summariseAuth,
  // Verify — durable DKIM-key archive (offline re-verify after key rotation; m7c)
  fetchDkimKey,
  pickSignatureToArchive,
  extractPublicKey,
  toPem,
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
  // Git ledger — pure salted-sender hasher (SPEC §0.1), top-level so a consumer
  // can map an attestor email → its stored salted hash without constructing a
  // gitrepo (the durable-manifest / reference-doc fold needs exactly this).
  saltedSenderHash,
  // Git ledger — optional OTS anchoring + Bitcoin-anchor upgrade/read (m7c-4;
  // factory-bound to otsBin). parseOtsBlockHeight is the pure `ots info` parser.
  createOts,
  parseOtsBlockHeight,
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
  // Verify — offline durable verification (m7c-2; DKIM re-check vs archived key)
  // + contested-commit reverify/trust-upgrade (m7c-3)
  createVerifier,
  findMatch,
  reverifyDkim,
  resolveUpgrade,
  pickSigner,
  // Email triggers — the shared neutral-notification seam (m7d; deliver())
  createNotifier,
  // Email triggers — time-driven occasions: overdue nudge + auto-archive (m7d-1)
  createSweep,
  referenceClockMs,
  isActive,
  // Email triggers — OTS proof-anchor pass + the `proof_anchored` occasion (m7d-4)
  createProofAnchor,
  // Email triggers — inbound bounce (DSN) parser → the `bounce` occasion (m7d-3)
  isDeliveryStatusReport,
  extractDsn,
  permanentFailures,
  parseDeliveryStatusBody,
};
