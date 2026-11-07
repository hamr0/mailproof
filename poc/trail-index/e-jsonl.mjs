// Strategy E (stdlib, no dependency): a JSON-lines sidecar of the same columns, loaded into Maps on open.
// Measures the part SQLite avoids: the per-process load. Rows are SYNTHETIC (same columns/shape as the index rows,
// ids and keys derived by hash), not read from a trail; load cost depends on row count and width only.
// Usage: node e-jsonl.mjs gen <dir> <N>   |   node e-jsonl.mjs load <dir> <N>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
const [mode, dir, nArg] = process.argv.slice(2);
const N = Number(nArg), file = path.join(dir, `e-${N}.jsonl`);
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
if (mode === 'gen') {
  const out = [];
  for (let i = 0; i < N; i++) {
    const key = hex('k' + Math.floor(i / 1.3));
    out.push(JSON.stringify({ id: hex('i' + i), captured: new Date(1767225600000 + i * 1000).toISOString(), direction: i % 5 ? 'in' : 'out', live: 'verified', portable: 'verified', message_id: `<${key.slice(0, 12)}@poc.example>`, message_key: key, copy_kind: 'direct', body_status: 'matched', att: i % 14 === 0 ? [hex('k' + (i >> 1))] : [] }));
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
} else {
  const t0 = performance.now();
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map(), byKey = new Map(), byMid = new Map(), byAtt = new Map();
  for (const r of rows) {
    byId.set(r.id, r);
    for (const [m, k] of [[byKey, r.message_key], [byMid, r.message_id]]) { const g = m.get(k); g ? g.push(r) : m.set(k, [r]); }
    for (const a of r.att) { const g = byAtt.get(a); g ? g.push(r) : byAtt.set(a, [r]); }
  }
  const sorted = rows.sort((a, b) => (a.captured < b.captured ? 1 : -1)); // newest first, for list()
  const loadMs = performance.now() - t0;
  console.log(JSON.stringify({ N, loadMs: Math.round(loadMs), rssMB: Math.round(process.resourceUsage().maxRSS / 1024), fileMB: +(fs.statSync(file).size / 1e6).toFixed(1), top: sorted.length }));
}
