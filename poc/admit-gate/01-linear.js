// Proof 1: admit() is linear. Each generator at N, 2N, 4N; long-line body at 1/2/4/8 MB; normal 1 MB / 25 MB.
import { admit } from './admit.js';
import { ALL, normalMessage } from './gen.js';
import { timeIt } from './cpu.js';
const f = (x) => x.toFixed(2).padStart(8);
console.log('generator'.padEnd(44), 'size(N)'.padStart(9), 't(N)', 't(2N)', 't(4N)', ' x2/x4 ratios (ms CPU, admit stopEarly=false)');
let worst = 0;
for (const [name, g] of Object.entries(ALL)) {
  if (g.init) { /* signed no-@ From: build is async, handled below */ }
  const build = g.init ? (await g.init()).build : g.build;
  const ts = [], sz = [];
  const SC = name.startsWith('one-line') ? 1 : (g.scale || 16);
  for (const k of [1, 2, 4]) { const b = await build(g.N * k * SC); sz.push(b.length); ts.push(await timeIt(() => admit(b, undefined, { stopEarly: false }), 5)); }
  const r1 = ts[1] / Math.max(ts[0], 0.01), r2 = ts[2] / Math.max(ts[1], 0.01);
  if (ts[0] > 0.5) worst = Math.max(worst, r1, r2);
  console.log(name.padEnd(44), String(sz[0]).padStart(9), f(ts[0]), f(ts[1]), f(ts[2]), `  x${r1.toFixed(2)} x${r2.toFixed(2)}${ts[0] <= 0.5 ? '  (t(N)<0.5ms: noise-dominated)' : ''}`);
}
console.log('worst ratio among measurable rows:', worst.toFixed(2));
console.log('\nlong-line body (matching bh), admit:');
let prev = null;
for (const mb of [1, 2, 4, 8, 16, 32]) {
  const b = ALL['one-line body (matching bh)'].build(mb << 20);
  const t = await timeIt(() => admit(b, undefined, { stopEarly: false }), 5);
  console.log(`  ${mb} MB one line`.padEnd(20), f(t), 'ms', prev ? `x${(t / Math.max(prev, 0.01)).toFixed(2)}` : '');
  prev = t;
}
console.log('\nnormal messages (base64 attachment, 76-col lines):');
for (const mb of [1, 25]) {
  const b = normalMessage(mb << 20);
  const t = await timeIt(() => admit(b, undefined, { stopEarly: false }), 5);
  const r = admit(b);
  console.log(`  ${mb} MB (${b.length} B)`.padEnd(30), f(t), 'ms', 'ok=' + r.ok, 'lines=' + r.m.bodyLines);
}
// pathological line-count: 25 MB of bare newlines (the worst case for per-line overhead)
const nl = Buffer.alloc(25 << 20, 10); nl.write('From: a\n\n');
console.log('  25 MB of "\\n" only (25M lines)', f(await timeIt(() => admit(nl, undefined, { stopEarly: false }), 3)), 'ms');
