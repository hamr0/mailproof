// TEST-ONLY worker for pool.js (passed as `workerUrl`): speaks the same protocol as src/proof/worker.js but, instead
// of building a record, misbehaves as `ctx.source` says, so each way a job can run away is reproduced on demand.
// NEVER imported from src/.
import { parentPort } from 'node:worker_threads';

const port = parentPort;
let current = 0;
port.on('message', async (m) => {
  if (m.type === 'rpc-result') {   // the answer to the 'dns' job: hand it back as the result
    port.postMessage({ type: 'done', job: current, out: { record: { id: 'dns' }, keyFiles: [], overLimit: null, answer: m.value, error: m.error } });
    return;
  }
  if (m.type !== 'job') return;
  current = m.job;
  const mode = m.ctx.source;
  if (mode === 'loop') for (;;);                                                              // CPU forever
  if (mode === 'regex') /(a+)+$/.test('a'.repeat(60) + 'b');                                  // catastrophic backtracking
  if (mode === 'alloc') { const keep = []; for (;;) keep.push(Buffer.alloc(1 << 20, 1)); }    // external memory only
  if (mode === 'heap') { const keep = []; for (;;) keep.push({ a: keep.length, s: 'x'.repeat(100) }); }   // JS heap
  if (mode === 'sleep') await new Promise((r) => setTimeout(r, Number(m.captured) || 400)); // busy wall time, no CPU
  if (mode === 'dns') {                                                                        // asks the main thread to resolve
    port.postMessage({ type: 'rpc', rpc: 1, name: 'x.example', rr: 'TXT' });
    return;
  }
  port.postMessage({ type: 'done', job: m.job, out: { record: { id: 'ok' }, keyFiles: [], overLimit: null } });
});
port.postMessage({ type: 'ready' });
