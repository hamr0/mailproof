// Proof-anchor pass (m7d-4) — drives the Bitcoin half of the OTS surface across
// an event's ledger. Pairs with `createOts().upgradeProof` (m7c-4, the per-file
// primitive) the same way `sweep()` (m7d-1) pairs with the per-event clocks:
// the kernel exposes the MECHANISM that walks every event, folds the calendar
// attestation into each pending `.ots`, records the anchored state into the
// ledger, and emits the `proof_anchored` occasion when an event newly crosses
// "every proof fully Bitcoin-anchored." Scheduling is the CONSUMER's
// (gitdone-equivalent: a separate timer from `sweep`, since upgrading talks to
// calendar servers and pays no idle cost when nothing is pending).
//
// LIFTED FROM gitdone/app/bin/ots-upgrade.js's processRepo/run + the
// notifyProofAnchored gate, trimmed and re-anchored to mailproof:
//  - gitdone's `.anchored-notified` SENTINEL FILE becomes a top-level
//    event.json flag (`ots_proof_anchored_notified_at`) — same store as the
//    sweep idempotency flags, one source of truth.
//  - gitdone's `completion.status==='complete' || threshold_reached_at` gate
//    collapses to mailproof's single top-level `status==='complete'` (the
//    completion engine's field — see the editEvent-guard fix).
//  - The per-file work (snapshot sha → ots upgrade → ots info block height)
//    isn't reimplemented — it IS createOts({otsBin}).upgradeProof from m7c-4.
//
// Concurrency: the slow per-file `ots upgrade` runs OUTSIDE the per-event
// mutex (talks to calendar servers). The ledger commit + the notified-flag
// flip happen INSIDE one mutex section, so they can't race with a concurrent
// ingest writing into the same .git. The notification is sent outside the lock.
// Best-effort throughout: a per-event failure (ledger commit, sync, send) is
// recorded in the summary, never thrown — proof anchoring is not allowed to
// undo state already written elsewhere.


import { withEventMutex } from './event-mutex.js';
import { renderDefault } from './templates.js';

/**
 * Compose the proof-anchor pass (m7d-4) over the bound store/ledger/ots + the
 * shared notifier. Requires `ots` (createOts).
 * @param {Object} [deps]
 * @param {any} [deps.eventStore]
 * @param {any} [deps.gitrepo]
 * @param {any} [deps.ots]
 * @param {(args: any) => Promise<any>} [deps.deliver]
 * @param {string | null} [deps.domain]
 * @returns {{ upgradeProofs: (opts?: { now?: string }) => Promise<{ events: Array<Record<string, any>>, anchored: number, pending: number, notified: any[] }> }}
 */
function createProofAnchor({
  eventStore, gitrepo, ots, deliver, domain = null,
} = {}) {
  if (!ots) throw new Error('createProofAnchor: ots required (createOts({otsBin}))');
  if (!eventStore || !gitrepo) throw new Error('createProofAnchor: eventStore + gitrepo required');
  const { loadEvent, listEventIds, writeEventAtomic, isComplete } = eventStore;
  const { listProofFiles, commitProofUpgrade, syncEventJson } = gitrepo;

  /**
   * @param {Record<string, any>} event
   * @param {string} eventId
   * @returns {string}
   */
  const replyBaseFor = (event, eventId) =>
    `${event && event.type === 'crypto' ? 'attest' : 'event'}+${eventId}@${domain}`;

  // Walk every event repo, upgrade its pending proofs, record + maybe notify.
  // `now` is an ISO timestamp injectable for deterministic tests. Returns
  // { events: [{ eventId, checked, newlyAnchored, pendingAfter, committed,
  //              patched, notified }], anchored, pending, notified: [] }.
  async function upgradeProofs({ now = new Date().toISOString() } = {}) {
    /** @type {{ events: Array<Record<string, any>>, anchored: number, pending: number, notified: any[] }} */
    const summary = { events: [], anchored: 0, pending: 0, notified: [] };
    for (const eventId of await listEventIds()) {
      const proofs = await listProofFiles(eventId);
      if (proofs.length === 0) {
        summary.events.push({ eventId, checked: 0, newlyAnchored: 0, pendingAfter: 0, committed: false, patched: 0, notified: false });
        continue;
      }

      // Per-proof upgrade — slow, no event lock held.
      /** @type {Array<{ proofRel: string, jsonRel: string, blockHeight: number | null }>} */
      const anchored = [];   // every anchored proof (newly or already) → patch JSON
      let newlyAnchored = 0; // count that CHANGED this run (gates the notify)
      let pendingAfter = 0;
      for (const p of proofs) {
        let r;
        try { r = await ots.upgradeProof(p.proofAbs); }
        catch { continue; }  // primitive shouldn't throw, but guard anyway
        if (!r || r.error) continue;
        if (r.anchored) {
          anchored.push({ proofRel: p.proofRel, jsonRel: p.jsonRel, blockHeight: r.block_height || null });
          if (r.changed) newlyAnchored += 1;
        } else if (r.pending) {
          pendingAfter += 1;
        }
      }

      // Record + decide-to-notify under the per-event mutex, so a concurrent
      // ingest can't interleave a reply commit with our proof-upgrade commit.
      const locked = await withEventMutex(eventId, async () => {
        let committed = null;
        if (anchored.length > 0) {
          try { committed = await commitProofUpgrade(eventId, { anchored, stamp: now }); }
          catch { /* ledger commit best-effort */ }
        }
        const cur = await loadEvent(eventId);
        if (!cur) return { committed, notify: null };
        // Only emit on a FRESH full-anchor transition: at least one proof newly
        // anchored this run, none still pending, the event is complete, and we
        // haven't already notified. A pure backfill run (flag-patch only) MUST
        // NOT re-send.
        const fullyAnchored = pendingAfter === 0 && newlyAnchored > 0;
        const eligible = isComplete(cur)
          && fullyAnchored
          && !cur.ots_proof_anchored_notified_at;
        if (!eligible) return { committed, notify: null };
        const next = { ...cur, ots_proof_anchored_notified_at: now };
        await writeEventAtomic(eventId, next);
        try { await syncEventJson(eventId, next, 'event proof anchored: notified'); }
        catch { /* repo mirror best-effort */ }
        return { committed, notify: next };
      });

      // The notification fires OUTSIDE the lock (same posture as ingest/sweep).
      let notifiedRec = null;
      if (deliver && locked.notify && locked.notify.initiator) {
        const ev = locked.notify;
        const block = (anchored.find((a) => a.blockHeight) || {}).blockHeight || null;
        const ctx = { mode: ev.type === 'crypto' ? 'crypto' : 'workflow', eventId, event: ev, blockHeight: block, anchoredCount: anchored.length, newlyAnchored };
        notifiedRec = await deliver({
          kind: 'proof_anchored',
          to: ev.initiator,
          replyAddress: replyBaseFor(ev, eventId),
          ...renderDefault('proof_anchored', ctx), ctx,
        });
        if (notifiedRec) summary.notified.push(notifiedRec);
      }

      summary.events.push({
        eventId,
        checked: proofs.length,
        newlyAnchored,
        pendingAfter,
        committed: !!(locked.committed && locked.committed.committed),
        patched: (locked.committed && locked.committed.patched) ? locked.committed.patched.length : 0,
        notified: !!notifiedRec,
      });
      summary.anchored += newlyAnchored;
      summary.pending += pendingAfter;
    }
    return summary;
  }

  return { upgradeProofs };
}

export { createProofAnchor };
