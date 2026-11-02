// Overhead per message: in-process check() vs cold worker vs warm pool; copy vs transfer vs shared. Wall + CPU (all threads).
import fs from 'node:fs'; import os from 'node:os'; import crypto from 'node:crypto'; import { pathToFileURL } from 'node:url';
import { Mailproof, makeWorkerMailproof, SRC } from './wm.js';
const { signedMail } = await import(pathToFileURL(SRC + '/tests/helpers/proof.js').href);
const N = +process.env.N || 30;
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p90 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
const sizes = { '50KB': 50 * 1024, '1MB': 1024 * 1024 };
const msgs = {};
for (const [k, n] of Object.entries(sizes)) msgs[k] = k === '50KB' ? await signedMail({ body: 'hello\r\n', attachment: { filename: 'a.bin', bytes: crypto.randomBytes(n * 0.75) } }) : await signedMail({ body: crypto.randomBytes(n * 0.74).toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n' });
console.log('load', os.loadavg().map((x) => x.toFixed(2)).join(' '), 'sizes', Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, v.raw.length])));
async function measure(label, mp, m, n = N) {
  const wall = [], cpu = [];
  await mp.check(m.raw);   // one warm-up (JIT; pool spawn is measured separately in cold mode)
  for (let i = 0; i < n; i++) {
    const c0 = process.cpuUsage(), t0 = performance.now();
    const r = await mp.check(m.raw);
    wall.push(performance.now() - t0); const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000);
    if (r.portable.trust !== 'verified') throw new Error('not verified ' + label);
  }
  console.log(label.padEnd(34), 'wall med', med(wall).toFixed(1).padStart(7), 'p90', p90(wall).toFixed(1).padStart(7), 'ms | cpu med', med(cpu).toFixed(1).padStart(7), 'ms');
}
for (const [sz, m] of Object.entries(msgs)) {
  console.log('--', sz);
  await measure('in-process', new Mailproof({ trailDir: '/tmp/x', resolver: m.resolver }), m);
  for (const mode of ['copy', 'transfer', 'shared']) {
    const W = makeWorkerMailproof({ size: 1, transfer: mode });
    const mp = new W({ trailDir: '/tmp/x', resolver: m.resolver });
    await measure(`warm pool=1 ${mode}`, mp, m); await mp.close();
  }
  for (const mode of ['copy', 'transfer']) {
    const W = makeWorkerMailproof({ size: 0, transfer: mode });
    const mp = new W({ trailDir: '/tmp/x', resolver: m.resolver });
    await measure(`COLD per message ${mode}`, mp, m, 15); await mp.close();
  }
}
// throughput: 32 concurrent checks of the 50KB mail
const m = msgs['50KB'];
for (const size of [0, 1, 2, 4]) {
  const t0 = performance.now(), c0 = process.cpuUsage();
  const mp = size === 0 ? new Mailproof({ trailDir: '/tmp/x', resolver: m.resolver }) : new (makeWorkerMailproof({ size }))({ trailDir: '/tmp/x', resolver: m.resolver });
  await mp.check(m.raw);
  const t1 = performance.now();
  await Promise.all(Array.from({ length: 64 }, () => mp.check(m.raw)));
  const c = process.cpuUsage(c0);
  console.log(`64 concurrent 50KB, ${size === 0 ? 'in-process' : 'pool=' + size}`.padEnd(34), 'wall', (performance.now() - t1).toFixed(0), 'ms');
  if (mp.close) await mp.close();
}
// pool startup cost = time to first result on a fresh pool
{
  const ts = [];
  for (let i = 0; i < 8; i++) { const mp = new (makeWorkerMailproof({ size: 1 }))({ trailDir: '/tmp/x', resolver: m.resolver }); const t0 = performance.now(); await mp.check(m.raw); ts.push(performance.now() - t0); await mp.close(); }
  console.log('first check on a fresh worker (spawn+import+job) med', med(ts).toFixed(0), 'ms');
}
