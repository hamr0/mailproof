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


import { createEventStore } from './event-store.js';
import { createGitrepo } from './gitrepo.js';
import { createOts } from './ots.js';
import { createNotary } from './notary.js';
import { createVerifier } from './verifier.js';
import { createNotifier } from './notify.js';
import { renderDefault } from './templates.js';
import { createIngest } from './ingest.js';
import { createSweep } from './sweep.js';
import { createProofAnchor } from './proof-anchor.js';
import * as completion from './completion.js';
import * as crypto from './crypto.js';
import { parseMessage, authenticateMessage, summariseAuth, extractVerifyCandidates } from './parse.js';
import { classifyTrust } from './classifier.js';
import { fetchDkimKey, pickSignatureToArchive } from './dkim-archive.js';
import { parseEventTag, parseAttestTag, parseInitiatorCommand, parseVerifyTag, parseReverifyTag } from './router.js';
import { preFilter, extractHeaderBlock } from './prefilter.js';
import { isDeliveryStatusReport, extractDsn, permanentFailures } from './dsn.js';
import {
  sendmail, buildRawMessage, newMessageId, sanitizeSubject,
} from './outbound.js';

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
/** @typedef {import('./types.js').MailproofEvent} MailproofEvent */

/**
 * Compose a bound mailproof instance — wires the four pillars over one dataDir.
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]     Root for events/*.json + per-event repos (REQUIRED at runtime).
 * @param {string} [opts.domain]      Operator domain for Message-Ids + plus-tags (REQUIRED at runtime).
 * @param {string} [opts.sendmailBin] Path to sendmail(8); absent ⇒ sends report {ok:false}.
 * @param {string} [opts.otsBin]      Path to the `ots` binary for OpenTimestamps.
 * @param {string} [opts.mtaHostname] This MTA's hostname for mailauth.
 * @param {any} [opts.resolver]       Custom DNS resolver for mailauth (tests inject offline).
 * @param {(ctx: Record<string, any>) => string | null | undefined} [opts.composeNotification] Body hook (§8.6).
 * @param {number} [opts.overdueDays] sweep(): idle days before the overdue nudge (default 14).
 * @param {number} [opts.archiveDays] sweep(): idle days before auto-archive (default 45).
 * @returns {{
 *   ingest: (raw: Buffer | string, envelope?: import('./types.js').Envelope) => Promise<Record<string, any>>,
 *   sweep: (opts?: { now?: number }) => Promise<Record<string, any>>,
 *   upgradeProofs: ((opts?: { now?: string }) => Promise<Record<string, any>>) | undefined,
 *   createEvent: (partialEvent: Partial<MailproofEvent> & Record<string, any>) => Promise<MailproofEvent>,
 *   activateEvent: (eventId: string, opts?: { now?: string }) => Promise<Record<string, any>>,
 *   editEvent: (eventId: string, patch: any, opts?: any) => Promise<Record<string, any>>,
 *   reopenEvent: (eventId: string, opts?: { reason?: string | null, retractSignatures?: string[], now?: string, organiserHandle?: string | null }) => Promise<Record<string, any>>,
 *   completeEvent: (eventId: string, opts?: { reason?: string | null, completedAt?: string | null, now?: string }) => Promise<Record<string, any>>,
 *   loadEvent: (eventId: string) => Promise<MailproofEvent | null>,
 *   listCommits: (eventId: string) => Promise<Record<string, any>[]>,
 *   loadCommit: (eventId: string, sequence: number) => Promise<Record<string, any> | null>,
 *   loadCompletion: (eventId: string) => Promise<Record<string, any> | null>,
 *   verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: { email?: string }) => Promise<Record<string, any>>,
 *   hashDocument: (bytes: Buffer | Uint8Array | string) => string,
 *   verify: (eventId: string, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>,
 *   reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>,
 * }}
 */
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
    extractVerifyCandidates,
    authenticateMessage,
    summariseAuth,
    classifyTrust,
    fetchDkimKey,
    pickSignatureToArchive,
    parseEventTag,
    parseAttestTag,
    parseInitiatorCommand,
    parseVerifyTag,
    parseReverifyTag,
    verify: verifier.verify,
    reverify: verifier.reverify,
    preFilter,
    extractHeaderBlock,
    isDeliveryStatusReport,
    extractDsn,
    permanentFailures,
    deliver,
    domain,
    mtaHostname,
    resolver,
  });

  // The time-driven pipeline (m7d-1): a consumer-scheduled scan that emits the
  // overdue + archived occasions through the same deliver(). Thresholds are
  // injected here (defaults 14/45 days).
  const { sweep } = createSweep({
    eventStore,
    gitrepo: { syncEventJson: gitrepo.syncEventJson },
    deliver, domain, overdueDays, archiveDays,
  });

  // The proof-anchor pass (m7d-4): walks every event repo, drives ots.upgrade
  // across its pending .ots proofs, records anchored state into the ledger, and
  // emits the `proof_anchored` occasion when the event newly crosses fully-
  // anchored. Only stood up when otsBin is configured (no ots → no proofs to
  // anchor → upgradeProofs is undefined on the surface).
  const upgradeProofs = ots
    ? createProofAnchor({ eventStore, gitrepo, ots, deliver, domain }).upgradeProofs
    : undefined;

  // Organiser-action occasions (m7d-2). The store's activate/edit stay pure; the
  // bound versions below run the transition, then emit the resulting occasions
  // through the same deliver(). Both append `notified` to the store's return.

  // Ping every initially-eligible participant (workflow) / listed signer
  // (crypto) that an activated event is waiting on. (Open crypto events have no
  // roster — the initiator distributes the attest+ link themselves.)
  /**
   * @param {MailproofEvent} ev
   * @returns {Promise<import('./types.js').DeliverResult[]>}
   */
  async function notifyActivation(ev) {
    const out = [];
    const eventId = ev.id;
    if (ev.type === 'crypto') {
      for (const signer of (Array.isArray(ev.signers) ? ev.signers : [])) {
        const ctx = { mode: 'crypto', eventId, event: ev };
        const r = await deliver({
          kind: 'activation', to: signer,
          replyAddress: `attest+${eventId}@${domain}`,
          ...renderDefault('activation', ctx), ctx,
        });
        if (r) out.push(r);
      }
    } else {
      for (const step of completion.eligibleSteps(ev)) {
        if (!step.participant) continue;
        const ctx = { mode: 'workflow', eventId, event: ev, step };
        const r = await deliver({
          kind: 'activation', to: step.participant,
          replyAddress: `event+${eventId}-${step.id}@${domain}`,
          ...renderDefault('activation', ctx), ctx,
        });
        if (r) out.push(r);
      }
    }
    return out;
  }

  // Activate, then — only on the FIRST transition — fire the activation kickoff.
  /**
   * @param {string} eventId
   * @param {{ now?: string }} [opts]
   */
  async function activateEvent(eventId, opts) {
    const res = await eventStore.activateEvent(eventId, opts);
    const notified = res.alreadyActive ? [] : await notifyActivation(res.event);
    return { ...res, notified };
  }

  // Edit, then re-notify only a participant reassigned ONTO a currently-eligible
  // step of an ACTIVATED event: a blocked step's new owner is pinged later via
  // `advance` when it becomes eligible, and a pending event's replies wouldn't
  // count yet, so neither warrants a kickoff here.
  /**
   * @param {string} eventId
   * @param {{ title?: string, steps?: Array<Partial<import('./types.js').Step> & { id: string }> }} patch
   * @param {{ now?: string, organiserHandle?: string | null }} [opts]
   */
  async function editEvent(eventId, patch, opts) {
    const res = await eventStore.editEvent(eventId, patch, opts);
    const notified = [];
    const ev = res.event;
    if (ev && ev.activated_at && ev.type === 'workflow') {
      const eligibleIds = new Set(completion.eligibleSteps(ev).map((s) => s.id));
      for (const c of res.changes) {
        if (c.field !== 'participant' || !c.to || !eligibleIds.has(c.step_id)) continue;
        const step = eventStore.findStep(ev, c.step_id);
        const ctx = { mode: 'workflow', eventId, event: ev, step };
        const r = await deliver({
          kind: 'reassigned', to: c.to,
          replyAddress: `event+${eventId}-${c.step_id}@${domain}`,
          ...renderDefault('reassigned', ctx), ctx,
        });
        if (r) notified.push(r);
      }
    }
    return { ...res, notified };
  }

  return {
    // Inbound — verify→route→commit→advance pipeline (accept-with-flag)
    ingest,
    // Time-driven — overdue nudge + auto-archive occasions (m7d-1)
    sweep,
    // Time-driven — OTS proof anchoring + the `proof_anchored` occasion
    // (m7d-4). Present only when otsBin is configured; undefined otherwise.
    upgradeProofs,
    // Sequence — create / activate / edit events (both modes; routed by `type`).
    // activate/edit emit the activation + reassigned occasions (m7d-2).
    createEvent: eventStore.createEvent,
    activateEvent,
    editEvent,
    // Sequence — reopen a completed event (the neutral lifecycle primitive that
    // consumer policies like revoke build on: flips complete→open, optionally
    // retracts counted signatures, appends an `event_reopen` audit commit).
    reopenEvent: eventStore.reopenEvent,
    // Sequence — complete an event by consumer policy (mirror of reopenEvent;
    // the seam a consumer that owns its completion semantics needs, e.g.
    // strict-signing attestation). Writes the canonical completion record.
    completeEvent: eventStore.completeEvent,
    // Read model — event JSON + the per-event commit ledger
    loadEvent: eventStore.loadEvent,
    listCommits: gitrepo.listCommits,
    loadCommit: gitrepo.loadCommit,
    // Read model — the canonical completion record (commits/completion.json),
    // or null if the event hasn't completed. The one non-numbered ledger record.
    loadCompletion: gitrepo.loadCompletion,
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

export { create };
