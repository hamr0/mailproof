// TEMPORARY CI diagnostic (measurement only): does Worker#cpuUsage() under-report on this runner?
// One JSON line per measurement. Writes nothing into the repo tree.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { WorkerPool, workerConfig } from '../src/proof/pool.js';
import { buildRecord } from '../src/proof/build.js';
import { signedMail } from '../tests/helpers/proof.js';
import { WORST_CASES } from '../tests/helpers/worst-cases.js';

const out = (o) => console.log(JSON.stringify(o));
const ms = (u) => (u.user + u.system) / 1000;
const r1 = (n) => Math.round(n * 10) / 10;
const cpus = os.cpus();
out({ kind: 'env', node: process.version, release: os.release(), cpus: cpus.length, model: cpus[0]?.model, availableParallelism: os.availableParallelism(), arch: process.arch,
  hasThreadCpuUsage: typeof process.threadCpuUsage === 'function' });

// (a) minimal worker spinning ~1500 ms
const CODE = `
const { parentPort } = require('node:worker_threads');
const tcu = () => (typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null);
const c0 = tcu(), t0 = performance.now();
while (performance.now() - t0 < 1500) { Math.sqrt(Math.random()); }
const c1 = tcu();
parentPort.on('message', () => {});   // keep the worker alive so cpuUsage() works after 'done'
parentPort.postMessage({ type: 'done', threadCpuMs: c0 && c1 ? ((c1.user - c0.user) + (c1.system - c0.system)) / 1000 : null, wallMs: performance.now() - t0 });
`;
for (let i = 0; i < 3; i++) {
  const w = new Worker(CODE, { eval: true });
  await new Promise((res) => w.once('online', res));
  const base = ms(await w.cpuUsage());
  const polls = [];
  const iv = setInterval(() => { w.cpuUsage().then((u) => polls.push(r1(ms(u) - base))).catch(() => {}); }, 50);
  const m = await new Promise((res, rej) => { w.once('message', res); w.once('error', rej); });
  clearInterval(iv);
  const atDone = await w.cpuUsage().then((u) => r1(ms(u) - base), (e) => e.code);
  out({ kind: 'minimal', run: i, insideThreadCpuMs: m.threadCpuMs && r1(m.threadCpuMs), mainObservedAtDoneMs: atDone, lastPolls: polls.slice(-4), wallMs: r1(m.wallMs) });
  await w.terminate();
}

// (b) real pool path
const slow = WORST_CASES.find((c) => c.name === '10 valid signatures, tampered 500,000 one-byte bare-LF lines');
const slowMsg = await slow.build();
const ord = await signedMail({ body: 'hello\r\n' });
const captured = new Date().toISOString();
const pool = new WorkerPool(workerConfig({ cpuMs: 1e9, wallMs: 1e9 }));
for (const [label, m] of [['slow', slowMsg], ['ordinary', ord]]) {
  for (let i = 0; i < 3; i++) {
    const p0 = process.cpuUsage(), t0 = performance.now();
    const r = await pool.run(m.raw, { ctx: { direction: 'in', source: 'diag' }, captured, hasEnvelope: false, trustedSealers: [] }, m.resolver);
    const p1 = process.cpuUsage(p0);
    out({ kind: 'pool', msg: label, run: i, poolCpuMs: r.cpuMs === undefined ? r : r1(r.cpuMs), wallMs: r1(performance.now() - t0), processCpuMs: r1(ms(p1)), processUserMs: r1(p1.user / 1000), processSystemMs: r1(p1.system / 1000) });
  }
}
pool.close();

// (c) in-process build of SLOW
for (let i = 0; i < 3; i++) {
  const c0 = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null, p0 = process.cpuUsage(), t0 = performance.now();
  await buildRecord(slowMsg.raw, { direction: 'in', source: 'diag' }, { captured, hasEnvelope: false, trustedSealers: [], resolver: slowMsg.resolver });
  const c1 = c0 && process.threadCpuUsage();
  out({ kind: 'inprocess', msg: 'slow', run: i, threadCpuMs: c0 ? r1(ms({ user: c1.user - c0.user, system: c1.system - c0.system })) : null, processCpuMs: r1(ms(process.cpuUsage(p0))), wallMs: r1(performance.now() - t0) });
}
process.exit(0);
