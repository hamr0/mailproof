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
  // the mode is ctx.source, or an `X-Fault:` header of the message (check() has no source of its own)
  const mode = Buffer.from(m.buf).toString('latin1').match(/^X-Fault: (\w+)/m)?.[1] ?? m.ctx.source;
  if (mode === 'loop') for (;;);                                                              // CPU forever
  if (mode === 'burn') {                                                                      // ~30 ms of this thread's CPU, then a normal 'done': over a 5 ms budget, but done before the first 50 ms tick
    const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
    for (const c0 = cpu(); cpu() - c0 < 30;);
  }
  if (mode === 'regex') /(a+)+$/.test('a'.repeat(60) + 'b');                                  // catastrophic backtracking
  if (mode === 'alloc') { const keep = []; for (;;) keep.push(Buffer.alloc(1 << 20, 1)); }    // external memory only
  if (mode === 'heap') { const keep = []; for (;;) keep.push({ a: keep.length, s: 'x'.repeat(100) }); }   // JS heap
  if (mode === 'exit') process.exit(3);                                                       // the thread ends without a word
  if (mode === 'throw') { setTimeout(() => { throw new Error('boom outside the build'); }, 0); return; }   // uncaught, not a reported failure
  if (mode === 'sleep') await new Promise((r) => setTimeout(r, Number(m.captured) || 400)); // busy wall time, no CPU
  if (mode === 'dns') {                                                                        // asks the main thread to resolve
    port.postMessage({ type: 'rpc', rpc: 1, name: 'x.example', rr: 'TXT' });
    return;
  }
  port.postMessage({ type: 'done', job: m.job, out: { record: { id: 'ok' }, keyFiles: [], overLimit: null } });
});
port.postMessage({ type: 'ready' });
