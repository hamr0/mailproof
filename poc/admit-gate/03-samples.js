// Proof 3: admit() over every real sample IN PLACE. Prints counts/maxima only, never content or file names.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { admit } from './admit.js';
import { LIMITS } from './limits.js';
const H = os.homedir();
const dirs = ['mailproof-m0-samples', 'mailproof-m0-samples-gmail', 'mailproof-m0-samples-gmail2', 'mailproof-m0-samples-batch3', 'mailproof-m0-samples-sent'].map((d) => path.join(H, d)).concat(path.join(H, 'PycharmProjects/gitdone/poc/phase0'));
const dims = { headerBytes: 'MAX_HEADER_BYTES', headerLines: 'MAX_HEADER_LINES', headerFields: 'MAX_HEADER_FIELDS', signatures: 'MAX_SIGNATURES', maxHNames: 'MAX_H_NAMES', maxSigBytes: 'MAX_SIG_BYTES', mimeLines: 'MAX_MIME_PARTS', maxBodyLine: 'MAX_BODY_LINE' };
const max = Object.fromEntries(Object.keys(dims).map((k) => [k, 0])); max.bytes = 0;
let count = 0, rejected = 0; const perDir = {};
const files = [];
for (const d of dirs) { for (const f of fs.readdirSync(d)) { if (f.endsWith('.eml')) files.push([d, f]); } }
const lineLens = [];
for (const [d, f] of files) {
  const buf = fs.readFileSync(path.join(d, f));
  const r = admit(buf, LIMITS, { stopEarly: false });
  count++; if (!r.ok) { rejected++; console.log('REJECTED sample #' + count, r.reason); }
  for (const k of Object.keys(max)) max[k] = Math.max(max[k], r.m[k]);
  lineLens.push(r.m.maxBodyLine);
  perDir[path.basename(d)] = (perDir[path.basename(d)] || 0) + 1;
}
console.log('samples:', count, 'rejected:', rejected, JSON.stringify(perDir));
console.log('dimension'.padEnd(14), 'real max'.padStart(9), 'limit'.padStart(9), 'headroom'.padStart(9));
for (const [k, lim] of Object.entries(dims)) {
  const L = LIMITS[lim], v = max[k];
  const flag = v * 4 > L ? '  <-- within 4x' : '';
  console.log(k.padEnd(14), String(v).padStart(9), String(L).padStart(9), (v ? (L / v).toFixed(1) + 'x' : 'inf').padStart(9) + flag);
}
console.log('largest message bytes:', max.bytes);
lineLens.sort((a, b) => b - a); console.log('top-5 per-message max body line (bytes):', lineLens.slice(0, 5).join(', '));
