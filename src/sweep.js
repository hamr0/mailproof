// Lifecycle sweep — the time-driven half of the trigger pillar (m7d-1). ingest()
// emits the occasions a single inbound reply causes; sweep() emits the ones that
// fall out of the passage of TIME against an event's state. A consumer runs it
// on a timer (hourly/daily — the schedule is the consumer's, not the kernel's),
// and mailproof derives + emits two occasions, both through the shared notifier:
//
//   overdue  — an active event idle past `overdueDays` past its reference clock.
//              ONE neutral nudge to the initiator (idempotent via
//              event.nudged_overdue_at). Pure bookkeeping — not mirrored to the
//              per-event repo.
//   archived — an active event idle past `archiveDays`. A STATE TRANSITION
//              (event.archived_at + archive_reason) persisted + mirrored to the
//              ledger, plus a neutral notice to the initiator.
//
// Reference clock = max(deadline over pending steps) when any pending step has a
// deadline, else activated_at — so a deadline-less event still ages out, counted
// from when it went live, not from when it was drafted.
//
// LIFTED FROM gitdone/app/src/sweep.js, trimmed to the kernel boundary
// (decisions-log 2026-05-27, occasions-are-kernel): the config singleton becomes
// injected `overdueDays`/`archiveDays`; the side effect (sending) goes through
// the shared `deliver` seam instead of a bespoke binary; the pending-activation
// passes (TTL delete + about-to-expire reminder) are DEFERRED to m7d-2
// (activation lifecycle). Predicates re-anchored to mailproof's shape:
// `type==='workflow'` (gitdone 'event'), `status==='complete'` (gitdone's nested
// `completion.status`).
//
// Divergence from gitdone (simpler, justified): gitdone runs the overdue and
// archive passes independently, so a never-seen event already past `archiveDays`
// gets BOTH a nudge and an archive in one tick. We process per-event with
// archive taking precedence — there is no point nudging an event we are
// archiving in the same tick. Same steady-state behaviour; one fewer wasted email.
//
// Nothing here is destructive to the audit trail — only event.json + bookkeeping
// change; git repos and OTS proofs are never touched ("proofs outlive the
// service" applies to the evidence, not the dashboard record).

'use strict';

const { withEventMutex } = require('./event-mutex');
const { isComplete } = require('./event-store');
const { renderDefault } = require('./templates');

const MS_PER_DAY = 86400 * 1000;

// The reference clock (ms) for overdue/archive decisions. PURE. Returns null if
// the event has no meaningful clock yet (never activated).
function referenceClockMs(event) {
  if (!event || !event.activated_at) return null;
  if (event.type === 'workflow' && Array.isArray(event.steps)) {
    const pendingDeadlines = event.steps
      .filter((s) => s && s.status !== 'complete' && s.deadline)
      .map((s) => new Date(s.deadline).getTime())
      .filter((n) => Number.isFinite(n));
    if (pendingDeadlines.length > 0) return Math.max(...pendingDeadlines);
  }
  const activated = new Date(event.activated_at).getTime();
  return Number.isFinite(activated) ? activated : null;
}

// Is the event in the cohort sweep acts on: activated, not archived, not
// complete? PURE.
function isActive(event) {
  if (!event) return false;
  if (!event.activated_at) return false;
  if (event.archived_at) return false;
  if (isComplete(event)) return false;
  return true;
}

// Compose the sweep over the bound store/ledger + the shared notifier.
//   overdueDays — idle days past the reference clock before the overdue nudge
//                 (default 14, matching gitdone's overdueNudgeDays).
//   archiveDays — idle days before auto-archive (default 45, gitdone's archiveDays).
function createSweep({
  eventStore, gitrepo, deliver, domain = null, overdueDays = 14, archiveDays = 45,
} = {}) {
  const { loadEvent, listEventIds, writeEventAtomic } = eventStore;
  const { syncEventJson } = gitrepo;

  // The plus-tagged reply From for a sweep notice, so the initiator's reply
  // routes back to the event (workflow → event+, crypto → attest+).
  function replyBaseFor(event, eventId) {
    const base = event && event.type === 'crypto' ? `attest+${eventId}` : `event+${eventId}`;
    return `${base}@${domain}`;
  }

  // Scan every event once; derive + emit overdue/archived. `now` is injectable
  // (ms) for deterministic tests. Returns a structured summary; never throws on
  // a single event (a load/transition failure is skipped, not fatal to the run).
  async function sweep({ now = Date.now() } = {}) {
    const overdue = [];
    const archived = [];
    const notified = [];

    for (const id of await listEventIds()) {
      const ev = await loadEvent(id);
      if (!isActive(ev)) continue;
      const clock = referenceClockMs(ev);
      if (clock == null) continue;
      const daysOver = (now - clock) / MS_PER_DAY;
      const stamp = new Date(now).toISOString();

      // --- archive (precedence over overdue) ---
      if (daysOver >= archiveDays) {
        // Transition under the per-event lock; re-load + re-check inside it so a
        // concurrent reply/edit/completion can't be clobbered (the engines and
        // ingest take the same lock; writeEventAtomic is unguarded by contract).
        const result = await withEventMutex(id, async () => {
          const cur = await loadEvent(id);
          if (!isActive(cur)) return null; // raced: archived/completed since the scan
          const reclock = referenceClockMs(cur);
          if (reclock == null || (now - reclock) / MS_PER_DAY < archiveDays) return null;
          const next = { ...cur, archived_at: stamp, archive_reason: 'auto_stale' };
          await writeEventAtomic(id, next);
          // Mirror the transition into the per-event repo (best-effort: a sync
          // failure — e.g. an event with no repo yet — must not undo the master
          // write, matching ingest's posture).
          try { await syncEventJson(id, next, 'event archived: auto_stale'); }
          catch { /* repo mirror best-effort */ }
          return next;
        });
        if (!result) continue;
        const daysIdle = Math.floor(daysOver);
        archived.push({ eventId: id, daysIdle });
        if (result.initiator) {
          const ctx = { eventId: id, event: result, daysIdle };
          const r = await deliver({
            kind: 'archived',
            to: result.initiator,
            replyAddress: replyBaseFor(result, id),
            ...renderDefault('archived', ctx), ctx,
          });
          if (r) notified.push(r);
        }
        continue;
      }

      // --- overdue nudge (once) ---
      if (daysOver >= overdueDays && !ev.nudged_overdue_at) {
        const result = await withEventMutex(id, async () => {
          const cur = await loadEvent(id);
          if (!isActive(cur) || cur.nudged_overdue_at) return null; // raced
          const next = { ...cur, nudged_overdue_at: stamp };
          await writeEventAtomic(id, next); // bookkeeping only — no repo mirror
          return next;
        });
        if (!result) continue;
        const daysOverInt = Math.floor(daysOver);
        overdue.push({ eventId: id, daysOver: daysOverInt });
        if (result.initiator) {
          const ctx = { eventId: id, event: result, daysOver: daysOverInt };
          const r = await deliver({
            kind: 'overdue',
            to: result.initiator,
            replyAddress: replyBaseFor(result, id),
            ...renderDefault('overdue', ctx), ctx,
          });
          if (r) notified.push(r);
        }
      }
    }

    return { overdue, archived, notified };
  }

  return { sweep };
}

module.exports = { createSweep, referenceClockMs, isActive };
