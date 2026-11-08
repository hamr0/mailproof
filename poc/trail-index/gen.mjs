// Step 2: synthetic trail of N records cloned from the GENUINE seed records (seed.mjs).
// Layout matches the library: <outDir>/trail-<N>/t/{trail.json,records/<id>.json,.git} on branch main, one commit
// per record with the library's subject `record <id12> <direction> <live>/<portable>`; commits via `git fast-import`.
// Clone variation (deterministic, seeded): id, message_id, captured, direction, trust, body_status, copy.kind,
// message_key groups (about 30% of records share a key with 1-4 others, and then share its Message-ID, as copies of one email do; about 2% have message_key null), attached_original (about 7%).
// Captured is NOT assumed monotonic in commit order: JITTER of the records are captured earlier than their commit
// position, so strategy D (git log) can fail the equality check.
// One commit per record is quadratic in git itself (every commit rewrites the records/ tree, N entries), so the
// per-record history is built only with history=full (1k, 10k); history=flat puts all N records in ONE commit
// (100k) and strategy D is not measurable there. The last PENDING records are generated but NOT written: they are
// saved to <trailDir>/pending.json so bench.mjs can commit them through the library's own commitRecord().
// Usage: node gen.mjs <outDir> <N> [jitter=0.03] [history=full|flat] [pending=300]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { serialise } from '../../src/proof/trail.js';

const [outDir, nArg, jArg, hArg = 'full', pArg = '300'] = process.argv.slice(2);
const N = Number(nArg), JITTER = jArg === undefined ? 0.03 : Number(jArg), FLAT = hArg === 'flat', PENDING = Number(pArg);
const TOTAL = N + PENDING;
const seeds = JSON.parse(fs.readFileSync(path.join(outDir, 'seeds.json'))).map((s) => s.record);
const trailDir = path.join(outDir, `trail-${N}`);
const root = path.join(trailDir, 't');
fs.rmSync(trailDir, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'records'), { recursive: true });

let st = 0x9e3779b9; // xorshift32, seeded: same trail every run
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const hex = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

// key groups: walk i; with p=.3 start a group of 2-5 consecutive-or-spread records sharing a key
const keyOf = new Array(TOTAL);
const keys = [];
for (let i = 0; i < TOTAL; i++) {
  if (keyOf[i] === undefined) {
    const k = hex('key' + i, 32); keys.push(k);
    keyOf[i] = k;
    if (rnd() < 0.3) {
      const extra = 1 + Math.floor(rnd() * 4);
      for (let e = 0; e < extra; e++) { const j = Math.min(TOTAL - 1, i + 1 + Math.floor(rnd() * 2000)); if (keyOf[j] === undefined) keyOf[j] = k; }
    }
  }
}

const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
git(['init', '-q', '--initial-branch=main']);
git(['config', 'user.name', 'mailproof']); git(['config', 'user.email', 'noreply@mailproof.invalid']);
fs.writeFileSync(path.join(root, 'trail.json'), serialise({ v: 2, name: 't', created: new Date(BASE).toISOString() }));

const fi = spawn('git', ['fast-import', '--quiet'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => { fi.on('exit', (c) => (c === 0 ? res() : rej(new Error('fast-import ' + c)))); });
const out = (s) => { if (!fi.stdin.write(s)) return new Promise((r) => fi.stdin.once('drain', r)); };
const ident = (ms) => `mailproof <noreply@mailproof.invalid> ${Math.floor(ms / 1000)} +0000`;
const blob = (rel, content) => `M 100644 inline ${rel}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
const msg = (m) => `data ${Buffer.byteLength(m)}\n${m}\n`;

const tj = serialise({ v: 2, name: 't', created: new Date(BASE).toISOString() });
if (!FLAT) await out(`commit refs/heads/main\ncommitter ${ident(BASE)}\n${msg('trail created')}${blob('trail.json', tj)}\n`);
if (FLAT) await out(`commit refs/heads/main\ncommitter ${ident(BASE)}\n${msg(`flat import of ${N} records`)}${blob('trail.json', tj)}`);
const pending = [];

const stats = { jittered: 0, withAtt: 0, groups: 0 };
for (let i = 0; i < TOTAL; i++) {
  const seed = seeds[i % seeds.length];
  const r = structuredClone(seed);
  r.id = hex('id' + i, 32);
  r.message_key = rnd() < 0.02 ? null : keyOf[i]; // about 2%: unsigned mail without a message_key
  r.message = { ...r.message, message_id: `<${keyOf[i].slice(0, 12)}@poc.example>`, raw_sha256: 'sha256:' + hex('raw' + i, 64) };
  let cap = BASE + (i + 1) * 1000;
  if (rnd() < JITTER) { cap = BASE + (Math.max(0, i - 30) + 1) * 1000 + (i % 999) + 1; stats.jittered++; } // never a multiple of 1000: unique
  r.captured = new Date(cap).toISOString();
  r.direction = rnd() < 0.8 ? 'in' : 'out';
  const live = rnd() < 0.85 ? 'verified' : pick(['forwarded', 'authorized', 'unverified']);
  const portable = rnd() < 0.9 ? live : 'unverified';
  r.verdicts = structuredClone(r.verdicts); r.verdicts.live.trust = live; r.verdicts.portable.trust = portable;
  r.body_status = pick(['matched', 'matched', 'matched', 'partial', 'mismatch', 'not-checked']);
  const kr = rnd(); const kind = kr < 0.7 ? 'direct' : kr < 0.85 ? 'relayed' : kr < 0.9 ? 'forward' : kr < 0.92 ? 'digest' : 'unknown';
  r.copy = { kind, evidence: {} };
  if ((kind === 'forward' || kind === 'digest') && keys.length > 1) {
    const n = 1 + Math.floor(rnd() * 2);
    r.copy.evidence.attached_original = Array.from({ length: n }, () => ({ message_key: pick(keys), dkim: 'pass', d: 'signer.example', body_status: 'matched' }));
    stats.withAtt++;
  }
  if (i >= N) { pending.push(r); continue; }
  const rel = `records/${r.id}.json`;
  const body = serialise(r);
  fs.writeFileSync(path.join(root, rel), body);
  const m = `record ${r.id.slice(0, 12)} ${r.direction} ${live}/${portable}`;
  if (FLAT) { const w = out(blob(rel, body)); if (w) await w; continue; }
  const w = out(`commit refs/heads/main\ncommitter ${ident(cap)}\n${msg(m)}${blob(rel, body)}\n`);
  if (w) await w;
}
if (FLAT) await out('\n');
fs.writeFileSync(path.join(trailDir, 'pending.json'), JSON.stringify(pending));
fi.stdin.end();
await done;
git(['reset', '-q']); // index := HEAD; working-tree files already match
console.log(JSON.stringify({ N, trailDir, jittered: stats.jittered, withAttachedOriginal: stats.withAtt, keys: keys.length, head: git(['rev-parse', 'HEAD']).toString().trim() }));
