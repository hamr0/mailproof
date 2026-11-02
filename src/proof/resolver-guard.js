// The one place the caller's resolver is held to its contract. Two things a resolver can do wrong, both answered as a
// DNS error so the call goes on: never answering, and answering with something that is not plain data. mailproof.js
// wraps the caller's resolver once, so a worker thread and the in-process path (`worker.size: 0`) behave the same.

import dns from 'node:dns';
import { DNS_TIMEOUT_MS, DNS_BUDGET_MS } from './limits.js';

/** The system resolver (what mailauth and the key fetch default to), for when the caller injected none. */
const systemResolver = (/** @type {string} */ name, /** @type {string} */ type) => dns.promises.resolve(name, /** @type {any} */ (type));

/** The code of the error raised for an answer that is not plain data. */
const BAD_RESPONSE_CODE = 'EBADRESP';

/**
 * Wrap a resolver so that
 *  - a lookup not settled within DNS_TIMEOUT_MS is the error `dns timeout`, `code: 'ETIMEOUT'` (what the system
 *    resolver raises; mailauth reads it as a temporary error, not "no record"; same message as fetchDkimKey's),
 *  - the lookups of one guarded resolver together may wait at most `budgetMs` (DNS_BUDGET_MS): each lookup is
 *    bounded by min(timeout, budget left), and once the budget is spent a lookup fails at once with the same
 *    error. The budget is the wall time during which at least one lookup is in flight (the union of the waits,
 *    not their sum: lookups run in parallel bursts, 50 at once waiting 5 s is 5 s of budget, not 250 s). So the
 *    DNS time of everything that shares this guard is at most `budgetMs`, whatever the number of lookups. Make
 *    one guard per message, and
 *  - an answer `structuredClone` refuses (a function, a symbol, ...), which is exactly what a worker's
 *    `postMessage` would refuse, is the error `resolver returned a non-plain value`, `code: 'EBADRESP'`.
 * A resolver returns plain data, as node:dns does.
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} resolver
 * @param {number} [timeoutMs]
 * @param {number} [budgetMs]
 * @returns {F}
 */
function guardResolver(resolver, timeoutMs = DNS_TIMEOUT_MS, budgetMs = DNS_BUDGET_MS) {
  let inFlight = 0;       // lookups waiting now
  let spent = 0;          // ms of budget used by closed stretches (>= 1 lookup in flight)
  let since = 0;          // start of the open stretch
  const left = () => budgetMs - spent - (inFlight > 0 ? performance.now() - since : 0);
  const timeoutError = () => Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' });
  return /** @type {F} */ (async (/** @type {any[]} */ ...args) => {
    const allowed = Math.min(timeoutMs, left());
    if (allowed <= 0) throw timeoutError();
    if (inFlight++ === 0) since = performance.now();
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), allowed);
    });
    try {
      // resolver() may throw synchronously or hand back a non-promise: Promise.resolve().then covers both
      const value = await Promise.race([Promise.resolve().then(() => resolver(...args)), late]);
      try { structuredClone(value); } catch { throw Object.assign(new Error('resolver returned a non-plain value'), { code: BAD_RESPONSE_CODE }); }
      return value;
    } finally {
      clearTimeout(timer);
      if (--inFlight === 0) spent += performance.now() - since;
    }
  });
}

export { guardResolver, systemResolver, BAD_RESPONSE_CODE };
