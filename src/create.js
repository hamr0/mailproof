// mailproof — the composition root. create({ ... }) wires the four pillars
// (verify · sequence · git ledger · email triggers) into one bound instance, so
// a consumer configures dataDir/domain/transport ONCE and gets back the
// high-level surface. Config is injected here and nowhere else (decisions log,
// "Config injection by bound per-pillar factories"): every pillar factory
// closes over the same dataDir, and this module is the single place that holds
// it. See docs/02-design/DESIGN.md for the planned API.
//
// m7b-3 lands this in two commits. Commit A (this) composes the pillars and
// exposes the create/read/verify surface. Commit B adds ingest() — the inbound
// verify→route→commit→advance→trigger pipeline — to the returned object, closing
// over the same pillars + outbound config.

'use strict';

const { createEventStore } = require('./event-store');
const { createGitrepo } = require('./gitrepo');
const { createOts } = require('./ots');
const { createNotary } = require('./notary');
const { createVerifier } = require('./verifier');
const { createNotifier } = require('./notify');
const { createIngest } = require('./ingest');
const { createSweep } = require('./sweep');
const completion = require('./completion');
const crypto = require('./crypto');
const { parseMessage, authenticateMessage, summariseAuth } = require('./parse');
const { classifyTrust } = require('./classifier');
const { fetchDkimKey, pickSignatureToArchive } = require('./dkim-archive');
const { parseEventTag, parseAttestTag } = require('./router');
const { preFilter, extractHeaderBlock } = require('./prefilter');
const {
  sendmail, buildRawMessage, newMessageId, sanitizeSubject,
} = require('./outbound');

// Compose a bound mailproof instance.
//   dataDir     — root for {dataDir}/events/*.json + the per-event git repos
//                 (required).
//   domain      — the operator's own domain, used to build outbound Message-Ids
//                 and plus-tags. Required: a coordination kernel must know the
//                 address space it speaks for, and validating it here fails loud
//                 at composition rather than on the first inbound reply.
//   sendmailBin — path to the sendmail(8) binary the trigger pillar submits to
//                 (optional; absent ⇒ sends report {ok:false}, never throw).
//   otsBin      — path to the `ots` binary for optional OpenTimestamps anchoring
//                 (optional; absent ⇒ the ledger commits without OTS proofs).
//   mtaHostname — this MTA's hostname, passed to mailauth as the receiving `mta`
//                 for the Authentication-Results it builds (optional).
//   resolver    — a custom DNS resolver for mailauth (optional). Production uses
//                 the system resolver (absent); tests inject an offline stub and
//                 the future verify+ endpoint re-checks against an archived key.
//   composeNotification(ctx) → body — optional hook for the body of the neutral
//                 notifications ingest()/sweep() trigger (branding is a NO-GO
//                 §8.6, so the body needs a consumer seam; keyed by `kind`).
//                 Neutral default if omitted.
//   overdueDays — sweep(): idle days past an active event's reference clock
//                 before the `overdue` nudge fires (optional; default 14).
//   archiveDays — sweep(): idle days before an active event auto-archives and
//                 emits the `archived` occasion (optional; default 45).
function create({
  dataDir, domain, sendmailBin, otsBin, mtaHostname, resolver, composeNotification,
  overdueDays, archiveDays,
} = {}) {
  if (!dataDir) throw new Error('create: dataDir required');
  if (!domain) throw new Error('create: domain required');

  // OTS is opt-in: only stand up the stamper when a binary is configured, and
  // thread it into the gitrepo so commits anchor as they are written. The
  // binary is spawned lazily (on the first commit), so a bad path here doesn't
  // fail composition — it surfaces as a per-commit best-effort error.
  const ots = otsBin ? createOts({ otsBin }) : null;
  const gitrepo = createGitrepo({ dataDir, ots });
  const eventStore = createEventStore({ dataDir });
  const notary = createNotary({ gitrepo, eventStore });
  // Offline durable-verify: matches a forwarded email/doc to a commit and
  // re-checks DKIM against the archived key (m7c-2). Uses the same injected
  // resolver as the base for the DKIM re-check.
  const verifier = createVerifier({ gitrepo, eventStore, resolver });

  // The shared trigger seam (m7d): one notifier turns every kernel-derived
  // occasion into an outbound neutral email, with composeNotification as the
  // single body hook. ingest() and sweep() both fire through its deliver().
  const { deliver } = createNotifier({
    buildRawMessage, sendmail, newMessageId, sanitizeSubject,
    domain, sendmailBin, composeNotification,
  });

  // The inbound pipeline, closing over the bound pillars + decoders + engines.
  const ingest = createIngest({
    eventStore,
    gitrepo,
    workflowEngine: completion,
    cryptoEngine: crypto,
    parseMessage,
    authenticateMessage,
    summariseAuth,
    classifyTrust,
    fetchDkimKey,
    pickSignatureToArchive,
    parseEventTag,
    parseAttestTag,
    preFilter,
    extractHeaderBlock,
    deliver,
    domain,
    mtaHostname,
    resolver,
  });

  // The time-driven pipeline (m7d-1): a consumer-scheduled scan that emits the
  // overdue + archived occasions through the same deliver(). Thresholds are
  // injected here (defaults 14/45 days).
  const { sweep } = createSweep({
    eventStore, gitrepo, deliver, domain, overdueDays, archiveDays,
  });

  return {
    // Inbound — verify→route→commit→advance pipeline (accept-with-flag)
    ingest,
    // Time-driven — overdue nudge + auto-archive occasions (m7d-1)
    sweep,
    // Sequence — create / activate / edit events (both modes; routed by `type`)
    createEvent: eventStore.createEvent,
    activateEvent: eventStore.activateEvent,
    editEvent: eventStore.editEvent,
    // Read model — event JSON + the per-event commit ledger
    loadEvent: eventStore.loadEvent,
    listCommits: gitrepo.listCommits,
    loadCommit: gitrepo.loadCommit,
    // Verify — document notary (PRD §4.1)
    verifyDocument: notary.verifyDocument,
    hashDocument: notary.hashDocument,
    // Verify — offline durable verification: match a forwarded email/doc to a
    // commit + re-verify DKIM against the archived key (m7c-2).
    verify: verifier.verify,
    // Verify — re-evaluate a contested commit + upgrade trust on a DKIM pass,
    // persisting an immutable reverify record (m7c-3).
    reverify: verifier.reverify,
  };
}

module.exports = { create };
