// POC worker: runs Mailproof#_build (the pure parse+verify half of check()/record()) off the main thread.
// Writes nothing: no trail, no git, no lock. DNS is proxied to the main thread (the injected resolver is a function).
import { parentPort, workerData } from 'node:worker_threads';

const { Mailproof } = await import(workerData.mailproofUrl);
let nextRpc = 1;
const pending = new Map();

parentPort.on('message', async (m) => {
  if (m.type === 'rpc-result') {
    const p = pending.get(m.rpc); pending.delete(m.rpc);
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    else p.resolve(m.value);
    return;
  }
  if (m.type !== 'job') return;
  try {
    if (m.test === 'loop') { for (;;); }                                   // synthetic infinite loop
    if (m.test === 'regex') { /(a+)+$/.test('a'.repeat(60) + 'b'); }       // catastrophic regex
    if (m.test === 'alloc') { const keep = []; for (;;) keep.push(Buffer.alloc(1 << 20, 1)); }   // external memory blow-up
    if (m.test === 'heap') { const keep = []; for (;;) keep.push({ a: keep.length, s: 'x'.repeat(100) }); }  // JS heap blow-up
    const resolver = (name, type) => new Promise((resolve, reject) => {
      const rpc = nextRpc++;
      pending.set(rpc, { resolve, reject });
      parentPort.postMessage({ type: 'rpc', rpc, name, rr: type });
    });
    const mp = new Mailproof({ trailDir: '/nonexistent-never-touched', resolver, now: () => new Date(m.captured) });
    mp.trustedSealers = m.trustedSealers;
    const raw = Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength);
    const out = await mp._build(raw, m.ctx);
    if (m.test === 'spin-after') { for (;;); }
    parentPort.postMessage({ type: 'done', job: m.job, out });
  } catch (e) {
    parentPort.postMessage({ type: 'fail', job: m.job, error: { message: String(e?.message), code: e?.code, name: e?.name } });
  }
});
parentPort.postMessage({ type: 'ready' });
