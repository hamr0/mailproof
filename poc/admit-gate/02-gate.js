// Proof 2b: the 1/2/4/8 MB one-line body: ungated check() vs gated, CPU ms.
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { GatedMailproof } from './gate.js';
import { Mailproof } from '../../src/index.js';
import { msgBh, CRLF } from './gen.js';
import { cpu, nxdomain } from './cpu.js';
const opts = { trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-')), resolver: nxdomain };
const raw = new Mailproof(opts), gated = new GatedMailproof(opts);
const med = async (fn) => { await fn(); const t = []; for (let i = 0; i < 3; i++) t.push((await cpu(fn)).ms); return t.sort((a, b) => a - b)[1]; };
console.log('size'.padEnd(8), 'ungated check'.padStart(14), 'gated check'.padStart(12), 'gated result');
for (const mb of [1, 2, 4, 8, 16]) {
  const b = msgBh([], 'a'.repeat(mb * (1 << 20) + 1) + CRLF);   // +1: strictly over the 1 MiB line limit even at 1 MB
  const u = mb <= 8 ? await med(() => raw.check(b)) : NaN;
  let res; const g = await med(async () => { res = await gated.check(b); });
  console.log(`${mb} MiB`.padEnd(8), (isNaN(u) ? 'skipped' : u.toFixed(0) + ' ms').padStart(14), (g.toFixed(2) + ' ms').padStart(12), res.verdict, res.reason);
}
