// Sharded variant of gen.js (SPEC B3 layout: records/<id[0:2]>/<id>.json, replies/<id[0:2]>/...). After it runs: `git reset --hard main` and set user.name/user.email in <out>/trail-N/t, then run prune-mem-run.mjs (findings F25).
// Synthetic trail for the prune POC (throwaway, never shipped). Layout as the library writes it (SPEC B3, B6.2):
//   trail.json, records/<32hex>.json (~4 KB), records/<id>.json.ots (5%), keys/<domain>/<selector>/<16hex>.json
//   (shared; a sliding window so early keys retire), replies/<id>.mailproof-quote-1.json (reply-text commits made LATER
//   for a random earlier record, so about half of them cross the cutoff), one commit per file set, message as the library
//   writes it. Built with `git fast-import` (one commit per record is quadratic in tree hashing, see README).
// Captured is NOT strictly monotonic: JITTER of the records are captured up to 3 days before their commit position
// (clock skew / backfill), to test the prefix assumption. Commit date = captured of the record commit's moment.
// Usage: node gen.js <outDir> <N records> [jitter=0.02]    -> <outDir>/trail-<N>/t   (a git repo, branch main)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const [outDir, nArg, jArg] = process.argv.slice(2);
if (!outDir || !nArg) { console.error('usage: node gen.js <outDir> <N> [jitter]'); process.exit(1); }
const N = Number(nArg), JITTER = jArg === undefined ? 0.02 : Number(jArg);
const root = path.join(outDir, `trail-${N}`, 't');
fs.rmSync(path.dirname(root), { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });

let st = 0x9e3779b9;
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const hex = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const rb64 = (n) => crypto.randomBytes(Math.ceil(n * 3 / 4)).toString('base64').slice(0, n);
const BASE = Date.parse('2025-01-01T00:00:00.000Z');
const SPAN = 2 * 365 * 86400_000;
const K = 400; // key files
const keyPath = (k) => `keys/d${k % 150}.example/sel${k % 7}/${hex('key' + k, 16)}.json`;
const serialise = (o) => JSON.stringify(o, null, 2) + '\n';

const fi = spawn('git', ['-c', 'pack.compression=0', '-c', 'core.compression=0', 'fast-import', '--quiet', '--depth=50'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => fi.on('exit', (c) => (c === 0 ? res() : rej(new Error('fast-import ' + c)))));
const chunks = [];
let pending = 0;
const out = async (s) => { chunks.push(s); pending += s.length; if (pending > 1 << 20) await flush(); };
const flush = async () => { const b = chunks.join(''); chunks.length = 0; pending = 0; if (!fi.stdin.write(b)) await new Promise((r) => fi.stdin.once('drain', r)); };
const ident = (ms) => `mailproof <noreply@mailproof.invalid> ${Math.floor(ms / 1000)} +0000`;
const file = (rel, content) => `M 100644 inline ${rel}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
const commit = (ms, message, files) => `commit refs/heads/main\nauthor ${ident(ms)}\ncommitter ${ident(ms)}\ndata ${Buffer.byteLength(message)}\n${message}\n${files}\n`;

const ids = [];
const usedKeys = new Set();
let when = BASE;
await out(commit(when, 'trail created', file('trail.json', serialise({ v: 2, name: 't', created: new Date(BASE).toISOString() }))));
let nRecordCommits = 0, nReply = 0, nOts = 0, nJit = 0;
for (let i = 0; i < N; i++) {
  when = BASE + Math.floor((i + 1) * SPAN / (N + 1));
  const id = hex('rec' + i, 32);
  // sliding window over the keys: early keys retire; the window start moves from 0 to 0.7K
  const kk = Math.floor(i / N * K * 0.7) + Math.floor(rnd() * K * 0.3);
  const kp = keyPath(kk);
  const jit = rnd() < JITTER; if (jit) nJit++;
  const captured = new Date(when - (jit ? Math.floor(rnd() * 3 * 86400_000) : 0)).toISOString();
  const rec = {
    v: 2, id, message_key: hex('mk' + (i >> 2), 32), copy: { kind: 'direct', evidence: {} }, captured, direction: i % 3 ? 'in' : 'out', source: 'imap',
    message: { from: `a${i % 977}@example.com`, to: ['b@example.org'], subject: 'Re: ' + rb64(30), date: captured, message_id: `<${rb64(24)}@example.com>` },
    attachments: [], signatures: [{ d: `d${kk % 150}.example`, s: `sel${kk % 7}`, b: rb64(344), bh: rb64(44), signed_headers: [rb64(700)], key: { k: 'rsa', p: rb64(392) }, key_error: null, key_file: kp }],
    body_status: 'matched', verdicts: { live: { trust: 'pass' }, portable: { trust: 'pass' } }, ots: null, pad: rb64(900),
  };
  let files = file(`records/${id.slice(0,2)}/${id}.json`, serialise(rec));
  if (!usedKeys.has(kp)) {
    usedKeys.add(kp);
    files += file(kp, serialise({ v: 2, domain: `d${kk % 150}.example`, selector: `sel${kk % 7}`, k: 'rsa', p: rb64(392), txt: 'v=DKIM1; k=rsa; p=' + rb64(392), lookup: 'dns', first_fetched: captured }));
  }
  if (i % 20 === 0) { files += file(`records/${id.slice(0,2)}/${id}.json.ots`, rb64(1200)); nOts++; }
  await out(commit(when, `record ${id.slice(0, 12)} ${rec.direction} pass/pass`, files));
  ids.push(id); nRecordCommits++;
  if (rnd() < 0.04) { // a reply-text commit, later, for a random earlier record
    const r = ids[Math.floor(rnd() * ids.length)];
    const rep = { v: 2, kind: 'reply-text', record_id: r, text_sha256: 'sha256:' + hex('t' + r, 64), text_bytes: 42, stripper: 'mailproof-quote/1', quote: 'found', trailing: false, source: 'text/plain', boundary: null, body_status: 'matched', extracted_at: new Date(when + 5000).toISOString() };
    await out(commit(when + 5000, `reply-text ${r.slice(0, 12)} mailproof-quote/1 found`, file(`replies/${r.slice(0,2)}/${r}.mailproof-quote-1.json`, serialise(rep))));
    nReply++;
  }
}
await flush(); fi.stdin.end(); await done;
execFileSync('git', ['repack', '-a', '-d', '-q'], { cwd: root });
console.log(JSON.stringify({ root, records: nRecordCommits, replies: nReply, ots: nOts, keys: usedKeys.size, jittered: nJit, commits: nRecordCommits + nReply + 1 }));
