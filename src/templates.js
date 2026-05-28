// Default email surface — ONE home for the neutral, brand-free subject + body
// of every occasion the kernel emits. This mirrors the organisation gitdone
// arrived at (its `email-bodies.js`, keyed by occasion) but stays GENERIC:
// no product tag, no host names, no verify-CLI hints — just clear copy a
// consumer can ship as-is or replace.
//
// Boundary (PRD §8.6): the OCCASION + this neutral default are mechanism; the
// branded prose is policy, overridden per occasion via composeNotification(ctx)
// keyed by `kind`. Producers (ingest / create / sweep / proof-anchor) spread
// renderDefault(kind, ctx) straight into deliver(); the body hook still wins.
//
// Pure: no I/O, no deps. Every `ctx` carries `event` + `eventId`; richer kinds
// also pass `step` / `snapshot` / `failed` / `signatureCount` / `countedCommits`
// / `daysIdle` / `daysOver` / `blockHeight` — the same shape the body hook sees.

'use strict';

function titleOf(ctx) {
  return (ctx && ctx.event && ctx.event.title) || (ctx && ctx.eventId) || 'your event';
}

// `— "step name"` when the occasion is about a named workflow step, else empty.
function stepClause(ctx) {
  const s = ctx && ctx.step;
  return s && s.name ? ` — "${s.name}"` : '';
}

// The tamper-evident-log guarantee is a KERNEL property (mailproof IS the git
// ledger), so it's brand-free and safe in a default; it names no product.
const LEDGER_NOTE = "Your reply is verified and recorded in the event's tamper-evident log.";

// Render the stats snapshot as a plain ASCII dump — checkbox step list for
// workflow, signature tally + signer list for crypto. Lifted verbatim from
// ingest.js so the default `stats` body has one definition.
function statsBody(s = {}) {
  const lines = [];
  lines.push(`Event: ${s.title || s.eventId}`);
  lines.push(`ID: ${s.eventId}`);
  lines.push(`Type: ${s.type}`);
  lines.push(`Status: ${s.status}`);
  if (s.completed_at) lines.push(`Completed: ${s.completed_at}`);
  if (s.archived_at) lines.push(`Archived:  ${s.archived_at}`);
  if (s.type === 'workflow') {
    lines.push('');
    lines.push('Steps:');
    for (const step of (s.steps || [])) {
      const tick = step.status === 'complete' ? '[x]' : '[ ]';
      const deps = step.depends_on && step.depends_on.length
        ? ` (after: ${step.depends_on.join(', ')})` : '';
      const ts = step.completed_at ? ` · ${step.completed_at}` : '';
      const name = step.name ? ` — ${step.name}` : '';
      lines.push(`  ${tick} ${step.id}${name} → ${step.participant || '?'}${deps}${ts}`);
    }
  } else if (s.type === 'crypto') {
    lines.push(`Signatures: ${s.signatureCount} / ${s.threshold}`);
    if ((s.signers || []).length) {
      lines.push('');
      lines.push('Signers:');
      for (const sig of s.signers) lines.push(`  - ${sig}`);
    }
  }
  return lines.join('\n');
}

// Map an occasion `kind` (+ its ctx) to a neutral { subject, defaultBody }.
// Returned keys spread directly into deliver({ ... }).
function renderDefault(kind, ctx = {}) {
  const title = titleOf(ctx);
  const step = stepClause(ctx);

  switch (kind) {
    case 'activation': {
      if (ctx.mode === 'crypto') {
        return ctx.reminder
          ? {
            subject: `Reminder — signature requested: ${title}`,
            defaultBody: `A reminder: your signature is still requested on "${title}".\n\nReply to this email to sign.`,
          }
          : {
            subject: `Signature requested: ${title}`,
            defaultBody: `Your signature is requested on "${title}".\n\nReply to this email to sign. ${LEDGER_NOTE}`,
          };
      }
      return ctx.reminder
        ? {
          subject: `Reminder — action needed: ${title}`,
          defaultBody: `A reminder: a step in "${title}"${step} is still waiting for you.\n\nReply to this email to confirm your part.`,
        }
        : {
          subject: `Action needed: ${title}`,
          defaultBody: `A step is ready for you in "${title}"${step}.\n\nReply to this email to confirm your part. ${LEDGER_NOTE}`,
        };
    }

    case 'advance':
      return ctx.reminder
        ? {
          subject: `Reminder — action needed: ${title}`,
          defaultBody: `A reminder: a step in "${title}"${step} is still waiting for you.\n\nReply to this email to confirm your part.`,
        }
        : {
          subject: `Action needed: ${title}`,
          defaultBody: `A step is now ready for you in "${title}"${step}.\n\nReply to this email to confirm your part. ${LEDGER_NOTE}`,
        };

    case 'reassigned':
      return {
        subject: `Action needed: ${title}`,
        defaultBody: `A step in "${title}"${step} has been assigned to you.\n\nReply to this email to confirm your part. ${LEDGER_NOTE}`,
      };

    case 'stats':
      return { subject: `Status: ${title}`, defaultBody: statsBody(ctx.snapshot || {}) };

    case 'bounce': {
      const failed = Array.isArray(ctx.failed) ? ctx.failed : [];
      const recips = failed.map((f) => f.finalRecipient || f.originalRecipient).filter(Boolean);
      const who = recips.length ? ` to ${recips.join(', ')}` : '';
      const why = failed[0] && failed[0].diagnostic ? `\n\nThe mail server said: ${failed[0].diagnostic}` : '';
      return {
        subject: `Delivery problem: ${title}`,
        defaultBody: `A notification for "${title}" could not be delivered${who}.${why}\n\nCheck the address, then reply to resend or update it and try again.`,
      };
    }

    case 'ack': {
      const n = ctx.signatureCount;
      const tail = Number.isFinite(n) ? `\n\nSignatures recorded so far: ${n}.` : '';
      return {
        subject: `Recorded: ${title}`,
        defaultBody: `Your verified reply to "${title}" has been recorded in the event's tamper-evident log.${tail}\n\nNothing further is needed from you.`,
      };
    }

    case 'completion': {
      const n = ctx.countedCommits;
      const tally = Number.isFinite(n) ? ` (${n} recorded ${n === 1 ? 'reply' : 'replies'})` : '';
      return {
        subject: `Complete: ${title}`,
        defaultBody: `"${title}" is now complete.\n\nThe full audit trail is preserved as a tamper-evident log${tally} and stays verifiable offline.`,
      };
    }

    case 'archived':
      return {
        subject: `Archived: ${title}`,
        defaultBody: `"${title}" was automatically archived after ${ctx.daysIdle} days with no activity.\n\nReply to this email to reopen it.`,
      };

    case 'overdue':
      return {
        subject: `Still pending: ${title}`,
        defaultBody: `"${title}" still has steps pending after ${ctx.daysOver} days.\n\nReply to send a reminder, or leave it to keep waiting.`,
      };

    case 'proof_anchored': {
      const block = ctx.blockHeight;
      const where = block ? ` (block ${block})` : '';
      return {
        subject: `Proof anchored: ${title}`,
        defaultBody: `The Bitcoin attestation for "${title}" has been folded into the ledger${where}.\n\nEach commit's proof is now offline-verifiable.`,
      };
    }

    case 'verify_report': {
      const rep = ctx.report || {};
      if (!rep.matched) {
        const reason = rep.reason === 'no_commits'
          ? 'this event has no committed replies yet'
          : 'the forwarded message did not match any committed reply';
        return {
          subject: `Verification report: ${title} — no match`,
          defaultBody: `We checked the message you forwarded against the ledger for "${title}".\n\nResult: NO MATCH — ${reason}.`,
        };
      }
      const dkim = rep.dkim_reverify;
      const dkimLine = dkim
        ? `\nDKIM re-verify (against the archived key): ${dkim.ok ? 'PASS' : `FAIL${dkim.reason ? ` (${dkim.reason})` : ''}`}`
        : '';
      return {
        subject: `Verification report: ${title} — match (commit ${rep.sequence})`,
        defaultBody: `We checked the message you forwarded against the ledger for "${title}".\n\n`
          + `Result: MATCH (${rep.matchType}) at commit ${rep.sequence}.\n`
          + `Counted toward the event: ${rep.counted ? 'yes' : 'no'}\n`
          + `Trust level at reception: ${rep.trustLevel || 'unknown'}${dkimLine}\n\n`
          + `The match is against the event's tamper-evident log; the proof holds offline.`,
      };
    }

    case 'reverify_report': {
      const rep = ctx.report || {};
      const seq = ctx.commitSequence;
      if (!rep.found) {
        return {
          subject: `Re-verification report: ${title} — commit ${seq} not found`,
          defaultBody: `We could not re-verify commit ${seq} on "${title}": ${rep.reason || 'no such commit'}.`,
        };
      }
      const dkim = rep.dkim_reverify;
      const dkimLine = dkim
        ? `\nDKIM re-verify: ${dkim.ok ? 'PASS' : `FAIL${dkim.reason ? ` (${dkim.reason})` : ''}`}`
        : '';
      return {
        subject: `Re-verification report: ${title} — commit ${seq}${rep.upgraded ? ' (upgraded)' : ''}`,
        defaultBody: `We re-checked commit ${seq} on "${title}" against its archived DKIM key.\n\n`
          + `Trust level: ${rep.trust_level_before} → ${rep.trust_level_after}`
          + `${rep.upgraded ? ' (upgraded)' : ' (unchanged)'}${dkimLine}\n\n`
          + `This re-verification is recorded as an immutable entry in the event's log; the original commit is never rewritten.`,
      };
    }

    default:
      return { subject: title, defaultBody: `Update on "${title}".` };
  }
}

module.exports = { renderDefault, statsBody };
