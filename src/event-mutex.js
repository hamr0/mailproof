// Per-event in-process write mutex.
//
// Every code path that writes events/{id}.json AND/OR commits to the
// per-event git repo must run inside withEventMutex(eventId, fn) so:
//   - two concurrent activations can't both observe !activated_at
//   - an edit can't race with first-visit activation
//   - atomic event-json updates can't race with each other
//   - simple-git's `index.lock` isn't hit by concurrent `git add` against
//     the same .git dir from different writers in this process
//
// This serialises writers WITHIN a single Node process. It does NOT guard
// across processes: a consumer that runs mailproof as a per-message pipe
// transport (one process per inbound mail) relies on the host MTA's delivery
// serialisation plus simple-git's `index.lock` retries between processes. A
// multi-worker consumer that needs cross-process safety must add its own
// filesystem-level lock (O_EXCL on a sentinel).

'use strict';

/** @type {Map<string, Promise<any>>} */
const _writeMutex = new Map();

/**
 * Serialise `work` against other writers of the same event WITHIN this process
 * (does not guard across processes — see the file header). Returns whatever
 * `work` resolves to.
 * @template T
 * @param {string} eventId
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withEventMutex(eventId, work) {
  const prev = _writeMutex.get(eventId);
  const p = (async () => {
    if (prev) { try { await prev; } catch { /* ignore prior failure */ } }
    return work();
  })();
  _writeMutex.set(eventId, p);
  try { return await p; }
  finally {
    // Only clear if we're still the latest entry — a follow-up call may
    // have already chained itself behind us.
    if (_writeMutex.get(eventId) === p) _writeMutex.delete(eventId);
  }
}

module.exports = { withEventMutex };
