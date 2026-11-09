// Worker-thread entry (spawned by pool.js): runs buildRecord() (or the reply-text stripper) off the main thread and nothing else. It
// writes nothing (no trail, no git, no lock) and has no clock or resolver of its own: the time of capture is
// a field of the job, and every DNS question is sent to the main thread, which asks the caller's resolver.
// So a worker the pool kills leaves no partial state behind.

import { parentPort } from 'node:worker_threads';
import { buildRecord } from './build.js';
import { extractReplyText } from './reply-text.js';

/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const pending = new Map();
let nextRpc = 1;

/** @param {string} name @param {string} [type] @returns {Promise<any>} */
const resolver = (name, type) => new Promise((resolve, reject) => {
  const rpc = nextRpc++;
  pending.set(rpc, { resolve, reject });
  /** @type {import('node:worker_threads').MessagePort} */ (parentPort).postMessage({ type: 'rpc', rpc, name, rr: type });
});

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort);
port.on('message', async (m) => {
  if (m.type === 'rpc-result') {
    const p = pending.get(m.rpc);
    pending.delete(m.rpc);
    if (!p) return;
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    else p.resolve(m.value);
    return;
  }
  if (m.type !== 'job') return;
  try {
    const buf = Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength);
    const out = m.kind === 'reply-text'   // the reply-text job (reply-text.js): gate and strip, nothing else
      ? extractReplyText(buf)
      : await buildRecord(buf, m.ctx, { captured: m.captured, hasEnvelope: m.hasEnvelope, trustedSealers: m.trustedSealers, keepAttachments: m.keepAttachments === true, resolver });
    port.postMessage({ type: 'done', job: m.job, out });
  } catch (e) {
    const err = /** @type {any} */ (e);
    port.postMessage({ type: 'fail', job: m.job, error: { message: String(err?.message), code: err?.code, name: err?.name } });
  }
});
port.postMessage({ type: 'ready' });
