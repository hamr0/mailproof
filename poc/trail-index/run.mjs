// Driver: node run.mjs <size[,size...]> [--keep]
// For each size: generate the trail, run every measurement (one process each, under nice), write results-<size>.json,
// print the numbers, delete the trail (unless --keep). Size '1000j0' = 1k records with NO capture-time jitter (the control for D).
// 100000 uses a flat one-commit history (see gen.mjs), so strategy D is skipped there.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = import.meta.dirname;
const sizes = (process.argv[2] || '1000').split(',');
const keep = process.argv.includes('--keep');
const TMP = path.join(here, '.tmp');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sh = (script, args, env = {}) => {
  try {
    const out = execFileSync('nice', ['-n', '19', 'node', path.join(here, script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = out.split('\n').find((l) => l.startsWith('RESULT ')) ?? out.split('\n').find((l) => l.startsWith('{'));
    return JSON.parse(line.replace(/^RESULT /, ''));
  } catch (e) { console.error(`FAILED: ${script} ${args.join(' ')}\n${e.stderr || e.message}`); process.exit(2); }
};
const medObj = (objs) => Object.fromEntries(Object.keys(objs[0]).map((k) => [k, median(objs.map((o) => o[k]))]));
const ENGINES = ['node-sqlite', 'better-sqlite3'];

for (const size of sizes) {
  const j0 = size.endsWith('j0');
  const N = parseInt(size, 10);
  const base = j0 ? path.join(TMP, 'j0') : TMP;
  fs.mkdirSync(base, { recursive: true });
  if (j0) fs.copyFileSync(path.join(TMP, 'seeds.json'), path.join(base, 'seeds.json'));
  const env = { TRAILS: base };
  const flat = N >= 100000;
  console.log(`\n=== ${size}: generating`);
  sh('gen.mjs', [base, String(N), j0 ? '0' : '0.03', flat ? 'flat' : 'full']);
  const res = { size, N, flat, jitter: j0 ? 0 : 0.03 };
  sh('bench.mjs', ['select', String(N)], env);
  const Rfull = N >= 100000 ? 3 : 5;
  const qnames = Object.keys(JSON.parse(fs.readFileSync(path.join(base, `trail-${N}`, 'q.json'))));
  res.full = {}; res.fullRssMB = {};
  for (const q of qnames) { const r = sh('bench.mjs', ['full', String(N), String(Rfull), q], env); res.full[q] = r.medianMs; res.fullRssMB[q] = r.rssMB; }
  console.log('C full read (ms):', JSON.stringify(res.full), 'RSS MB max', Math.max(...Object.values(res.fullRssMB)));
  if (!flat) { res.dlog = sh('bench.mjs', ['dlog', String(N), '7'], env); console.log('D git log:', JSON.stringify(res.dlog.res), JSON.stringify(res.dlog.prefixAll), JSON.stringify(res.dlog.prefixIn)); }
  if (!j0) for (const engine of ENGINES) {
    const rb = [1, 2, 3].map(() => sh('bench.mjs', ['rebuild', engine, String(N)], env));
    const qs = [1, 2, 3].map(() => sh('bench.mjs', ['queries', engine, String(N), '15'], env));
    res[engine] = {
      rebuildMs: median(rb.map((x) => x.rebuildMs)), rebuildRssMB: median(rb.map((x) => x.rssMB)), fileMB: rb[0].fileMB, rows: rb[0].rows,
      importMs: median(qs.map((x) => x.importMs)), firstOpenMs: median(qs.map((x) => x.firstOpenMs)), openMs: median(qs.map((x) => x.openMs)),
      headRevParseMs: median(qs.map((x) => x.headRevParseMs)), headFileMs: median(qs.map((x) => x.headFileMs)),
      queryUs: medObj(qs.map((x) => x.medianUs)), answersChecked: qs[0].answersEqualToFullRead, queryRssMB: median(qs.map((x) => x.rssMB)),
    };
    console.log(engine, JSON.stringify(res[engine]));
  }
  if (!j0) for (const [i, engine] of ENGINES.entries()) {
    res[engine].insert = sh('bench.mjs', ['insert', engine, String(N), String(i * 150), '40', '100'], env);
    console.log(engine, 'insert', JSON.stringify(res[engine].insert));
  }
  fs.writeFileSync(path.join(here, `results-${size}.json`), JSON.stringify(res, null, 1));
  if (!keep) fs.rmSync(path.join(base, `trail-${N}`), { recursive: true, force: true });
}
