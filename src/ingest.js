// Inbound pipeline — the orchestration capstone (m7b-3 Commit B: the CORE; the
// trigger/send layer is Commit C). This is mailproof's answer to gitdone's
// receive.js main(), which is app glue and NOT lifted — ingest() composes the
// already-lifted pillars into the one path every inbound reply takes:
//
//   prefilter (humans only) → decode (parse + authenticate) → classify trust →
//   route by plus-tag (event+ → workflow, attest+ → crypto sign-off) →
//   load event → match sender → commit the reply ALWAYS (accept-with-flag) →
//   run the sequencing engine → persist (master JSON + repo mirror) →
//   write the completion commit if the event just completed → return a summary.
//
// Accept-with-flag (PRD, SPEC §4): a reply that resolves to a known event is
// ALWAYS committed to the ledger as an audit record, even when it doesn't
// count. `counted` + `count_reason` (computed from the engine's own decision)
// record whether it advanced state. Routing/trust/participant checks gate the
// TRANSITION, never the commit. Mail that fails the humans-only prefilter, or
// carries no event tag, or names an unknown event, is not committed (there is
// no event to commit it to) and comes back `routed:false`.
//
// Concurrency: the per-event mutex is in-process and non-reentrant, and
// gitrepo.commitReply allocates its sequence by reading the commits dir — so
// two replies to one event must be serialised. ingest() therefore holds
// withEventMutex(eventId) ONCE around load→commit→advance→persist→complete, and
// uses only non-mutex primitives inside it (eventStore.writeEventAtomic, the
// gitrepo writers, the pure engines). DNS-bound work (authenticate) and the
// trigger sends (Commit C) stay OUTSIDE the lock.

'use strict';

const { withEventMutex } = require('./event-mutex');

// Scan at most this many leading bytes for the humans-only prefilter. Headers
// live at the top of the message; this caps work on a hostile multi-megabyte
// body without parsing it.
const MAX_HEADER_BYTES = 64 * 1024;

// Compose the inbound pipeline over already-bound pillars. create() passes the
// store/ledger/engines/decoders + auth config; ingest closes over them.
function createIngest({
  eventStore,        // { loadEvent, findStep, senderMatchesStep, writeEventAtomic }
  gitrepo,           // { commitReply, commitCompletion, syncEventJson, saltedSenderHash }
  workflowEngine,    // completion.js  { shouldCount, applyReply, eligibleSteps }
  cryptoEngine,      // crypto.js      { shouldCount, applyReply }
  parseMessage,      // parse.js
  authenticateMessage,
  summariseAuth,
  classifyTrust,     // classifier.js
  fetchDkimKey,      // dkim-archive.js — durable offline-verify half
  pickSignatureToArchive,
  parseEventTag,     // router.js
  parseAttestTag,
  preFilter,         // prefilter.js
  extractHeaderBlock,
  // Inbound bounce (DSN) parser (dsn.js, m7d-3) — pure.
  isDeliveryStatusReport,
  extractDsn,
  permanentFailures,
  // Trigger pillar: the shared neutral-notification seam (notify.js). ingest
  // emits advance / ack / completion through the same deliver() that sweep and
  // the other m7d occasions use; composeNotification lives inside it.
  deliver,
  domain = null,
  mtaHostname = null,
  resolver = null,
} = {}) {
  const { loadEvent, findStep, senderMatchesStep, writeEventAtomic, recordStepSendErrors } = eventStore;
  const { commitReply, commitCompletion, syncEventJson, saltedSenderHash } = gitrepo;

  // The plus-tagged reply From for an event (workflow → event+, crypto → attest+).
  const replyBaseFor = (event, eventId) =>
    `${event && event.type === 'crypto' ? 'attest' : 'event'}+${eventId}@${domain}`;

  // Handle an inbound delivery-status report (a bounce). Routed by the plus-tag
  // the bounce was delivered to (= our outbound return path), which names the
  // event/step. A bounce is operational, NOT a participant reply: it is never
  // committed to the ledger. We record the per-step send error and emit the
  // `bounce` occasion to the initiator. Never throws.
  async function handleBounce(buf, envelope) {
    const eventTag = parseEventTag(envelope.recipient);
    const attestTag = eventTag ? null : parseAttestTag(envelope.recipient);
    const eventId = eventTag ? eventTag.eventId : (attestTag ? attestTag.eventId : null);
    const stepId = eventTag ? eventTag.stepId : null;
    if (!eventId) return { routed: false, bounce: true, reason: 'no_event_tag' };
    const event = await loadEvent(eventId);
    if (!event) return { routed: false, bounce: true, reason: 'unknown_event', eventId };

    const dsn = extractDsn(buf) || { recipients: [] };
    const failed = permanentFailures(dsn);
    const failedRecipients = failed.map((f) => f.finalRecipient || f.originalRecipient).filter(Boolean);

    // Record the failure on the workflow step (crypto has no steps). Best-effort.
    if (stepId && failed.length) {
      const top = failed[0];
      try {
        await recordStepSendErrors(eventId, {
          [stepId]: {
            reason: top.diagnostic || top.status || 'delivery failed',
            code: top.status || null,
            at: new Date().toISOString(),
          },
        });
      } catch { /* error-flag persistence is best-effort */ }
    }

    const notified = [];
    if (failed.length && event.initiator) {
      const title = event.title || eventId;
      const who = failedRecipients.length ? ` to ${failedRecipients.join(', ')}` : '';
      const why = failed[0] && failed[0].diagnostic ? ` The mail server said: ${failed[0].diagnostic}` : '';
      const r = await deliver({
        kind: 'bounce',
        to: event.initiator,
        replyAddress: replyBaseFor(event, eventId),
        subject: `Delivery problem: ${title}`,
        defaultBody: `A notification for "${title}" could not be delivered${who}.${why}`,
        ctx: { mode: event.type === 'crypto' ? 'crypto' : 'workflow', eventId, event, stepId, failed },
      });
      if (r) notified.push(r);
    }
    return { routed: false, bounce: true, eventId, stepId, failedRecipients, notified };
  }

  // raw: RFC-822 bytes (Buffer). envelope: the parseEnvelope shape
  // ({ sender, recipient, clientIp, clientHelo }). Returns a result summary
  // (see the file header for accept-with-flag semantics).
  async function ingest(raw, envelope = {}) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''));
    const headerBlock = extractHeaderBlock(buf, MAX_HEADER_BYTES);

    // 0. Delivery-status (bounce) detection — BEFORE the humans-only prefilter,
    //    which would otherwise reject this machine-generated report. A bounce is
    //    an operational signal, not a participant reply (see handleBounce).
    if (isDeliveryStatusReport(headerBlock)) return handleBounce(buf, envelope);

    const parsed = await parseMessage(buf);

    // 1. Humans-only prefilter — drop auto-responders / lists / bulk / system
    //    senders BEFORE any crypto or ledger work. Not committed (no event).
    const filter = preFilter(headerBlock, parsed.from.address);
    if (filter.rejected) {
      return { routed: false, rejected: true, reason: filter.reason };
    }

    // 2. Route by plus-tag. event+{id}-{step}@ → workflow; attest+{id}@ → crypto.
    const eventTag = parseEventTag(envelope.recipient);
    const attestTag = eventTag ? null : parseAttestTag(envelope.recipient);
    const mode = eventTag ? 'workflow' : (attestTag ? 'crypto' : null);
    if (!mode) return { routed: false, reason: 'no_event_tag' };
    const eventId = eventTag ? eventTag.eventId : attestTag.eventId;
    const stepId = eventTag ? eventTag.stepId : null;

    // 3. Existence check before doing DNS work — an unknown event is not
    //    committed (accept-with-flag applies only to known events).
    if (!(await loadEvent(eventId))) {
      return { routed: false, reason: 'unknown_event', eventId };
    }

    // 4. Authenticate (DNS-bound — kept outside the per-event lock) → trust +
    //    the auth summaries the ledger records, plus a durable archive of the
    //    signer's DKIM public key so the commit re-verifies offline after the
    //    signer rotates DNS (verify+/reverify, m7c). Best-effort: a failed
    //    archive is recorded on the commit, never fatal.
    const auth = await authenticateMessage(buf, envelope, { mtaHostname, resolver });
    const trustLevel = classifyTrust(auth);
    const authSummary = summariseAuth(auth);
    let dkimArchive = null;
    const sigToArchive = pickSignatureToArchive(auth);
    if (sigToArchive && sigToArchive.signingDomain && sigToArchive.selector) {
      dkimArchive = await fetchDkimKey(
        sigToArchive.signingDomain,
        sigToArchive.selector,
        resolver ? { resolver } : {},
      );
    }
    const receivedAt = new Date().toISOString();

    // Plaintext sender, lowercased for matching + hashing. Never persisted as
    // plaintext (SPEC §6); the ledger keeps only its salted hash. One source of
    // truth — this same normalised value feeds both the commit metadata's
    // sender_hash (via commitReply ctx) and the engine dedup key.
    const sender = String(envelope.sender || parsed.from.address || '').toLowerCase();
    const hasAttachment = parsed.attachments.length > 0;

    // 5–8. Serialise the whole reply against concurrent replies to this event.
    const outcome = await withEventMutex(eventId, async () => {
      const event = await loadEvent(eventId); // authoritative, under the lock
      if (!event) return { gone: true };

      const senderHash = saltedSenderHash(sender, event.salt);
      const senderDomain = sender.includes('@') ? sender.split('@')[1] : null;

      // Match: workflow resolves participant_match against the step; crypto
      // resolves signer_match + is_initiator. The engines are pure and read
      // these precomputed booleans (the orchestrator owns identity resolution).
      let participantMatch = null;
      let engine;
      let commitInput;
      if (mode === 'workflow') {
        const step = findStep(event, stepId);
        participantMatch = step ? senderMatchesStep(sender, step) : false;
        engine = workflowEngine;
        commitInput = {
          step_id: stepId,
          participant_match: participantMatch,
          trust_level: trustLevel,
          has_attachment: hasAttachment,
        };
      } else {
        const signers = Array.isArray(event.signers) ? event.signers : [];
        const signerMatch = !!event.open || signers.includes(sender);
        const isInitiator = !!event.initiator
          && sender === String(event.initiator).toLowerCase();
        engine = cryptoEngine;
        commitInput = {
          trust_level: trustLevel,
          is_initiator: isInitiator,
          signer_match: signerMatch,
          sender_hash: senderHash,
          attachments: parsed.attachments,
        };
      }

      // The count decision — computed before the commit so the commit records
      // counted/count_reason. shouldCount ignores `sequence`, so this is the
      // same verdict applyReply re-derives below.
      const decision = engine.shouldCount(event, commitInput);
      const counted = decision.count;
      const countReason = counted ? null : decision.reason;

      // 6. Commit the reply ALWAYS (accept-with-flag).
      const commit = await commitReply(eventId, event, {
        eventId,
        stepId,
        receivedAt,
        envelope: {
          sender,
          client_ip: envelope.clientIp || null,
          client_helo: envelope.clientHelo || null,
        },
        from: parsed.from.address,
        trustLevel,
        participantMatch,
        messageId: parsed.messageId,
        attachments: parsed.attachments,
        counted,
        count_reason: countReason,
        dkim: authSummary.dkim,
        spf: authSummary.spf,
        dmarc: authSummary.dmarc,
        arc: authSummary.arc,
        dkimArchive,
        rawSha256: parsed.rawSha256,
        rawSize: buf.length,
      });

      // 7. Advance. applyReply re-checks shouldCount and only transitions when
      //    it counts; on a transition we persist the master JSON + repo mirror.
      const applyInput = { ...commitInput, sequence: commit.sequence };
      if (mode === 'crypto') {
        applyInput.sender_domain = senderDomain;
        applyInput.received_at = receivedAt;
      }
      const applied = engine.applyReply(event, applyInput, { now: receivedAt });

      let completedStep = null;
      let signatureCount = mode === 'crypto'
        ? (Array.isArray(event.signatures) ? event.signatures.length : 0)
        : null;
      let eventComplete = false;

      if (applied.applied) {
        await writeEventAtomic(eventId, applied.event);
        const seqStr = String(commit.sequence).padStart(3, '0');
        // Mirror the post-reply state into the repo so the proof artifact and
        // the master JSON agree. Best-effort: a sync failure must not undo the
        // counted reply that is already committed + persisted.
        try { await syncEventJson(eventId, applied.event, `reply ${seqStr} counted`); }
        catch { /* repo mirror is best-effort */ }

        eventComplete = !!applied.completedEvent;
        if (mode === 'workflow') completedStep = applied.completedStep || null;
        else signatureCount = applied.signatureCount;

        // 8. One-shot completion commit on the edge the event newly completes.
        //    commitCompletion is itself idempotent (m7b-1).
        if (eventComplete) {
          const summary = mode === 'workflow'
            ? { steps_completed: applied.event.steps.length }
            : { threshold: applied.event.threshold || 1, signatures: signatureCount };
          try {
            await commitCompletion(eventId, applied.event, {
              completedAt: receivedAt,
              triggeringSequence: commit.sequence,
              summary,
            });
          } catch { /* completion commit best-effort; event.json already complete */ }
        }
      }

      return {
        committedSeq: commit.sequence,
        counted,
        count_reason: countReason,
        completedStep,
        signatureCount,
        eventComplete,
        // Post-transition state, for building triggers OUTSIDE the lock.
        postEvent: applied.applied ? applied.event : event,
      };
    });

    if (outcome.gone) return { routed: false, reason: 'unknown_event', eventId };

    // 9. Triggers (sent OUTSIDE the lock). Only a COUNTED reply advances the
    //    chain: workflow pings the participant(s) of every step that just
    //    became eligible; crypto acks the verified signer. On the completing
    //    edge, both notify the initiator. Non-counting replies send nothing.
    const notified = [];
    if (outcome.counted) {
      const ev = outcome.postEvent;
      const title = (ev && ev.title) || eventId;

      if (mode === 'workflow' && outcome.completedStep && !outcome.eventComplete) {
        const newlyEligible = workflowEngine.eligibleSteps(ev).filter(
          (s) => s && s.participant && (s.dependsOn || []).includes(outcome.completedStep)
        );
        for (const step of newlyEligible) {
          const r = await deliver({
            kind: 'advance',
            to: step.participant,
            replyAddress: `event+${eventId}-${step.id}@${domain}`,
            subject: `Action needed: ${title}`,
            defaultBody: `A step is ready for you in "${title}". Reply to this email to confirm your part.`,
            ctx: { mode, eventId, event: ev, step },
          });
          if (r) notified.push(r);
        }
      } else if (mode === 'crypto') {
        const r = await deliver({
          kind: 'ack',
          to: sender,
          replyAddress: `attest+${eventId}@${domain}`,
          subject: `Recorded: ${title}`,
          defaultBody: `Your verified reply to "${title}" has been recorded.`,
          ctx: { mode, eventId, event: ev, signatureCount: outcome.signatureCount },
        });
        if (r) notified.push(r);
      }

      if (outcome.eventComplete && ev && ev.initiator) {
        const base = mode === 'workflow' ? `event+${eventId}` : `attest+${eventId}`;
        const r = await deliver({
          kind: 'completion',
          to: ev.initiator,
          replyAddress: `${base}@${domain}`,
          subject: `Complete: ${title}`,
          defaultBody: `"${title}" is now complete.`,
          ctx: { mode, eventId, event: ev },
        });
        if (r) notified.push(r);
      }
    }

    return {
      routed: true,
      mode,
      eventId,
      trustLevel,
      committedSeq: outcome.committedSeq,
      counted: outcome.counted,
      count_reason: outcome.count_reason,
      completedStep: outcome.completedStep,
      signatureCount: outcome.signatureCount,
      eventComplete: outcome.eventComplete,
      notified,
    };
  }

  return ingest;
}

module.exports = { createIngest };
