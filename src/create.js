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
const { createIngest } = require('./ingest');
const completion = require('./completion');
const crypto = require('./crypto');
const { parseMessage, authenticateMessage } = require('./parse');
const { classifyTrust } = require('./classifier');
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
//                 notifications ingest() triggers (branding is a NO-GO §8.6, so
//                 the body needs a consumer seam). Neutral default if omitted.
function create({
  dataDir, domain, sendmailBin, otsBin, mtaHostname, resolver, composeNotification,
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

  // The inbound pipeline, closing over the bound pillars + decoders + engines.
  const ingest = createIngest({
    eventStore,
    gitrepo,
    workflowEngine: completion,
    cryptoEngine: crypto,
    parseMessage,
    authenticateMessage,
    classifyTrust,
    parseEventTag,
    parseAttestTag,
    preFilter,
    extractHeaderBlock,
    buildRawMessage,
    sendmail,
    newMessageId,
    sanitizeSubject,
    domain,
    sendmailBin,
    composeNotification,
    mtaHostname,
    resolver,
  });

  return {
    // Inbound — verify→route→commit→advance pipeline (accept-with-flag)
    ingest,
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
  };
}

module.exports = { create };
