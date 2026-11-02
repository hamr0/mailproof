// Every tests/helpers/worst-cases.js case (built just under a limit, admitted by the gate): in-process vs warm worker; wall + cpu.
// Usage: node worst.mjs [--reps 3]. Run again under CPU load (LOAD=n burners are started by load.sh) for the heavy-load numbers.
import os from 'node:os'; import { pathToFileURL } from 'node:url';
import { Mailproof, makeWorkerMailproof, SRC } from './wm.js';
const { WORST_CASES, admitted } = await import(pathToFileURL(SRC + '/tests/helpers/worst-cases.js').href);
const REPS = +process.env.REPS || 2;
const W = makeWorkerMailproof({ size: 1, deadlineMs: 120000, cpuMs: 120000, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
let resolver; const mpOf = (C, r) => new C({ trailDir: '/tmp/x', resolver: r });
console.log('load', os.loadavg().map((x) => x.toFixed(2)).join(' '), 'reps', REPS);
const rows = [];
for (const c of WORST_CASES) {
  const { raw, resolver } = await c.build();
  admitted(raw);
  const a = mpOf(Mailproof, resolver), b = mpOf(W, resolver);
  await b.check(Buffer.from('From: a@b.example\r\n\r\nx\r\n'));   // pool warm
  let wi = 1e9, ww = 1e9, cw = 0, wc = 1e9;
  let ja, jb;
  for (let i = 0; i < REPS; i++) {
    let t0 = performance.now(); const ra = await a.check(raw); wi = Math.min(wi, performance.now() - t0); ja = JSON.stringify(ra);
    const c0 = process.cpuUsage(); t0 = performance.now(); const rb = await b.check(raw); ww = Math.min(ww, performance.now() - t0); const cu = process.cpuUsage(c0); cw = (cu.user + cu.system) / 1000; wc = Math.min(wc, b.last.cpuMs); jb = JSON.stringify(rb);
  }
  rows.push({ name: c.name, limit: c.limit, bytes: raw.length, inproc: Math.round(wi), worker: Math.round(ww), procCpu: Math.round(cw), workerThreadCpu: Math.round(wc), same: ja === jb, ceilingMs: c.ceilingMs });
  console.log(JSON.stringify(rows.at(-1)));
  await b.close();
}
const mc = Math.max(...rows.map((r) => r.workerThreadCpu)); console.log('MAX worker-thread CPU', mc, 'ms; second', rows.map((r) => r.workerThreadCpu).sort((x, y) => y - x)[1]);
const mx = Math.max(...rows.map((r) => r.worker)), mi = Math.max(...rows.map((r) => r.inproc));
console.log('MAX in-process', mi, 'ms; MAX worker wall', mx, 'ms; all same:', rows.every((r) => r.same), '; second-largest worker', rows.map((r) => r.worker).sort((x, y) => y - x)[1]);
