// In-process write mutex, keyed by an opaque string: the legacy event store
// keys it by event id, the v2 trail (proof/trail.js) by the trail root path.
//
// Every code path that writes a keyed resource AND/OR commits to its git repo
// must run inside withMutex(key, fn) so two writers of the same key in this
// process can't interleave (and can't hit git's `index.lock` against the same
// .git dir).
//
// This serialises writers WITHIN a single Node process. It does NOT guard
// across processes: concurrent processes writing the same key (e.g. a
// per-message pipe transport, one process per inbound mail) are unsupported
// and can fail on git's `index.lock` (git does not retry it). A consumer that
// needs cross-process safety must add its own filesystem-level lock (O_EXCL
// on a sentinel) or run a single writer.


/** @type {Map<string, Promise<any>>} */
const _writeMutex = new Map();

/**
 * Serialise `work` against other writers of the same key WITHIN this process
 * (does not guard across processes — see the file header). Returns whatever
 * `work` resolves to.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withMutex(key, work) {
  const prev = _writeMutex.get(key);
  const p = (async () => {
    if (prev) { try { await prev; } catch { /* ignore prior failure */ } }
    return work();
  })();
  _writeMutex.set(key, p);
  try { return await p; }
  finally {
    // Only clear if we're still the latest entry — a follow-up call may
    // have already chained itself behind us.
    if (_writeMutex.get(key) === p) _writeMutex.delete(key);
  }
}

export { withMutex };
