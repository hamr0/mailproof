// The one place the caller's resolver is held to its contract. Two things a resolver can do wrong, both answered as a
// DNS error so the call goes on: never answering, and answering with something that is not plain data. mailproof.js
// wraps the caller's resolver once, so a worker thread and the in-process path (`worker.size: 0`) behave the same.

import { DNS_TIMEOUT_MS } from './limits.js';

/** The code of the error raised for an answer that is not plain data. */
const BAD_RESPONSE_CODE = 'EBADRESP';

/**
 * Wrap a resolver so that
 *  - a lookup not settled within DNS_TIMEOUT_MS is the error `dns timeout`, `code: 'ETIMEOUT'` (what the system
 *    resolver raises; mailauth reads it as a temporary error, not "no record"; same message as fetchDkimKey's), and
 *  - an answer `structuredClone` refuses (a function, a symbol, ...), which is exactly what a worker's
 *    `postMessage` would refuse, is the error `resolver returned a non-plain value`, `code: 'EBADRESP'`.
 * A resolver returns plain data, as node:dns does.
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} resolver
 * @param {number} [timeoutMs]
 * @returns {F}
 */
function guardResolver(resolver, timeoutMs = DNS_TIMEOUT_MS) {
  return /** @type {F} */ (async (/** @type {any[]} */ ...args) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), timeoutMs);
    });
    try {
      // resolver() may throw synchronously or hand back a non-promise: Promise.resolve().then covers both
      const value = await Promise.race([Promise.resolve().then(() => resolver(...args)), late]);
      try { structuredClone(value); } catch { throw Object.assign(new Error('resolver returned a non-plain value'), { code: BAD_RESPONSE_CODE }); }
      return value;
    } finally {
      clearTimeout(timer);
    }
  });
}

export { guardResolver, BAD_RESPONSE_CODE };
