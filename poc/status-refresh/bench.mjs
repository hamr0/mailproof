// One measurement per process. Usage: node bench.mjs <list1|list10|status> <trailDir>
// Prints `RESULT {wallMs, cpuMs (this process, user+sys), rssMB (peak, this process)}`; the driver adds git children's CPU via /usr/bin/time.
import { performance } from 'node:perf_hooks';
import { Mailproof } from '../../src/index.js';
const [mode, trailDir] = process.argv.slice(2);
const mp = new Mailproof({ trailDir, trail: 'default', worker: { size: 0 }, content: { store: false } });
const t0 = performance.now(), c0 = process.cpuUsage();
let r;
if (mode === 'list1') r = await mp.list({ limit: 1 });
else if (mode === 'list10') r = await mp.list({ limit: 10 });
else if (mode === 'status') { const s = await mp.status({ refresh: true }); r = [s.records?.total, s.records?.verified, s.index]; }
else throw new Error('mode');
const wall = performance.now() - t0, c = process.cpuUsage(c0);
await mp.close();
console.log('RESULT ' + JSON.stringify({ wallMs: Math.round(wall), cpuMs: Math.round((c.user + c.system) / 1000), rssMB: Math.round(process.resourceUsage().maxRSS / 1024), out: JSON.stringify(r).slice(0, 80) }));
