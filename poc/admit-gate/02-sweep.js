// Proof 2a: where does mailauth's relaxed body canonicaliser go super-linear? Fix TOTAL body size, vary LINE length,
// call the real public check() (signature with matching bh=). Also the single-line case at growing sizes.
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { msgBh, CRLF } from './gen.js';
import { cpu, nxdomain } from './cpu.js';
const mp = new Mailproof({ trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-')), resolver: nxdomain });
const run = async (raw) => { await mp.check(raw); const t = []; for (let i = 0; i < 3; i++) t.push((await cpu(() => mp.check(raw))).ms); return t.sort((a, b) => a - b)[1]; };
const TOTAL = 4 << 20;
console.log('A) total body 4 MiB, line length varies (CPU ms of check(), median of 3)');
for (const L of [76, 1024, 4096, 16384, 65536, 131072, 262144, 524288, 1 << 20, 2 << 20, 4 << 20]) {
  const lines = Math.max(1, Math.round(TOTAL / (L + 2)));
  const body = ('a'.repeat(L) + CRLF).repeat(lines);
  const t = await run(msgBh([], body));
  console.log(`  line ${String(L).padStart(8)} B x ${String(lines).padStart(6)} lines`.padEnd(40), t.toFixed(0).padStart(7), 'ms');
}
console.log('B) single line, growing size (doubling ratios)');
let prev = 0;
for (const mb of [0.25, 0.5, 1, 2, 4, 8]) {
  const body = 'a'.repeat(mb * (1 << 20)) + CRLF;
  const t = await run(msgBh([], body));
  console.log(`  ${String(mb).padStart(5)} MiB one line`.padEnd(30), t.toFixed(0).padStart(7), 'ms', prev ? `x${(t / prev).toFixed(2)}` : '');
  prev = t;
}
console.log('C) per-line cost at fixed 256 KiB lines, growing total (should be x2 per doubling if linear)');
prev = 0;
for (const mb of [2, 4, 8, 16]) {
  const lines = Math.round((mb << 20) / (262144 + 2));
  const t = await run(msgBh([], ('a'.repeat(262144) + CRLF).repeat(lines)));
  console.log(`  ${mb} MiB total`.padEnd(30), t.toFixed(0).padStart(7), 'ms', prev ? `x${(t / prev).toFixed(2)}` : '');
  prev = t;
}
