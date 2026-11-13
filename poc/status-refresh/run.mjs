// Driver: node run.mjs <outDir> <N> [reps=3]. Needs gen.mjs output at <outDir>/trail-<N>. Deletes nothing (caller removes the dir).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
const [outDir, nArg, rArg = '3'] = process.argv.slice(2);
const N = Number(nArg), R = Number(rArg);
const trailDir = path.join(outDir, `trail-${N}`), root = path.join(trailDir, 'default');
const here = import.meta.dirname;
const pending = JSON.parse(fs.readFileSync(path.join(trailDir, 'pending.json')));
let pi = 0;
const rmIndex = () => { for (const f of fs.readdirSync(trailDir)) if (/index/.test(f)) fs.rmSync(path.join(trailDir, f), { force: true, recursive: true }); };
const run = (mode) => new Promise((res, rej) => {
  const t0 = process.hrtime.bigint();
  const p = spawn('/usr/bin/time', ['-f', 'TIME %e %U %S %M', process.execPath, path.join(here, 'bench.mjs'), mode, trailDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
  p.on('exit', (c) => {
    if (c !== 0) return rej(new Error(mode + ' exit ' + c + ' ' + e));
    const r = JSON.parse(o.match(/RESULT (.*)/)[1]); const t = e.match(/TIME (\S+) (\S+) (\S+) (\S+)/);
    res({ ...r, wallS: +t[1], cpuTotalS: +t[2] + +t[3], maxRssMB: Math.round(+t[4] / 1024) });
  });
});
const git = (a, input) => execFileSync('git', a, { cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const addCommits = (k) => { // k new records on top of HEAD, one commit each, via fast-import
  const recs = pending.slice(pi, pi + k); pi += k;
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  let s = '', t = Date.parse('2026-12-01T00:00:00Z');
  recs.forEach((r, i) => {
    const body = JSON.stringify(r, null, 2) + '\n'; const m = `record ${r.id.slice(0, 12)} ${r.direction} x/x`;
    s += `commit refs/heads/main\ncommitter mailproof <noreply@mailproof.invalid> ${Math.floor(t / 1000) + i} +0000\ndata ${Buffer.byteLength(m)}\n${m}\n${i === 0 ? `from ${head}\n` : ''}M 100644 inline records/${r.id.slice(0, 2)}/${r.id}.json\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  });
  git(['fast-import', '--quiet'], s); git(['reset', '-q']); git(['checkout', '-q', '--', '.']);
};
const out = { N, reps: {} };
const push = (k, v) => (out.reps[k] ??= []).push(v);
for (let i = 0; i < R; i++) {
  rmIndex(); push('rebuild_list1', await run('list1'));
  rmIndex(); push('status_cold', await run('status'));
  push('status_current', await run('status'));
  push('list10_current', await run('list10'));
  addCommits(1); push('catchup_1', await run('list1'));
  addCommits(100); push('catchup_100', await run('list1'));
  push('status_after_catchup', await run('status'));
}
console.log(JSON.stringify(out));
