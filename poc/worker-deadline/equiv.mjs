// Equivalence: check()+record() through the worker path vs in-process, on the personal samples (read in place, never printed).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import dns from 'node:dns';
import { Mailproof, makeWorkerMailproof } from './wm.js';
const H = os.homedir();
const dirs = ['mailproof-m0-samples', 'mailproof-m0-samples-gmail', 'mailproof-m0-samples-gmail2', 'mailproof-m0-samples-batch3', 'mailproof-m0-samples-sent'].map((d) => path.join(H, d)).concat(path.join(H, 'PycharmProjects/gitdone/poc/phase0'));
const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.eml')).map((f) => path.join(d, f)));
// one memoising resolver (answers AND errors) shared by both paths, so DNS cannot make them differ
const memo = new Map();
const resolver = async (name, rr) => {
  const k = name + '|' + rr;
  if (!memo.has(k)) memo.set(k, dns.promises.resolve(name, rr).then((v) => ({ v }), (e) => ({ e: { code: e.code, message: e.message } })));
  const r = await memo.get(k);
  if (r.e) throw Object.assign(new Error(r.e.message), { code: r.e.code });
  return structuredClone(r.v);
};
const now = () => new Date('2026-11-02T00:00:00Z');
const SCR = process.env.WD_DIR || path.join(os.tmpdir(), 'mailproof-worker-deadline');
fs.mkdirSync(SCR, { recursive: true });
const T = fs.mkdtempSync(path.join(SCR, 'eq-'));
const W = makeWorkerMailproof({ size: 2, deadlineMs: 60000, cpuMs: 30000 });
const a = new Mailproof({ trailDir: path.join(T, 'a'), resolver, now });
const b = new W({ trailDir: path.join(T, 'b'), resolver, now });
const strip = (r) => JSON.stringify(r, (k, v) => (k === 'trail' ? undefined : v));
let same = 0, diff = 0, total = 0;
for (const f of files) {
  const raw = fs.readFileSync(f); total++;
  const env = { clientIp: '203.0.113.9', sender: 'a@example.com' };
  const [c1, c2] = [await a.check(raw), await b.check(raw)];
  const [d1, d2] = [await a.check(raw, { envelope: env }), await b.check(raw, { envelope: env })];
  const [r1, r2] = [await a.record(raw, { direction: 'in', source: 'eq' }), await b.record(raw, { direction: 'in', source: 'eq' })];
  const rec1 = strip(r1), rec2 = strip(r2);
  if (!globalThis.__k) globalThis.__k = { sig: 0, keyerr: 0 }; __k.sig += c1.signatures; __k.keyerr += c1.key_errors.length; const ok = strip(c1) === strip(c2) && strip(d1) === strip(d2) && rec1.replace(/"commit":"[0-9a-f]+",?/, '') === rec2.replace(/"commit":"[0-9a-f]+",?/, '');
  // archived key files: equal except the fetch time
  const kd = (root) => { const out = {}; const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (out[path.relative(root, p)] = fs.readFileSync(p, 'utf8').replace(/"first_fetched":"[^"]*"/, '')); }); return out; };
  const ka = JSON.stringify(kd(path.join(a.root, 'keys'))), kb = JSON.stringify(kd(path.join(b.root, 'keys')));
  const rec = ok && (await a.get(r1.id)) && JSON.stringify(await a.get(r1.id)) === JSON.stringify(await b.get(r2.id));
  if (ok && rec) same++; else { diff++; console.log('DIFF', path.basename(path.dirname(f)), total); }
  if (ka.length && ka !== kb) { diff++; console.log('KEYFILE DIFF', total); }
}
console.log("sigs", JSON.stringify(globalThis.__k)); console.log(JSON.stringify({ total, same, diff, spawned: b.pool.stats.spawned, killed: b.pool.stats.killed, dnsNames: memo.size, withKeys: [...memo.keys()].length }));
await b.close(); fs.rmSync(T, { recursive: true });
