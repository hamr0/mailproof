// Run a command under /usr/bin/time and sample the summed RSS of its whole process tree from /proc every 200 ms.
// Usage: node bench.js <label> <out.json> -- <cmd> [args]     prints and appends one JSON line to out.json
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [label, outFile] = argv.slice(0, sep), cmd = argv.slice(sep + 1);
const tf = `${outFile}.time.${process.pid}`;
const child = spawn('/usr/bin/time', ['-f', '%e %U %S %M', '-o', tf, ...cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = ''; child.stdout.on('data', (d) => (stdout += d));
const kids = () => { // pid -> { ppid, rss (incl. mmap'd file pages), anon (heap/stack only), label }
  const m = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/status`, 'utf8');
      const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(st) || [0, 0])[1]) * 1024;
      const pp = Number(/^PPid:\s+(\d+)/m.exec(st)[1]);
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'latin1').split('\0').filter((x) => !x.startsWith('/') || x.length < 12).slice(0, 4).join(' ').slice(0, 40);
      m.set(Number(d), { pp, rss: g('VmRSS'), anon: g('RssAnon'), comm: cmd });
    } catch { /* gone */ }
  }
  return m;
};
let peakSum = 0, peakMax = 0, peakAnonSum = 0;
const peakComm = {}; // largest RSS ever seen per process name (git subcommands show up as `git-fast-expor`, `git-fast-impor`, ...)
const tick = setInterval(() => {
  const all = kids(); const set = new Set([child.pid]); let grew = true;
  while (grew) { grew = false; for (const [p, v] of all) if (!set.has(p) && set.has(v.pp)) { set.add(p); grew = true; } }
  let sum = 0, mx = 0, asum = 0; for (const p of set) { const v = all.get(p); const r = v?.rss || 0; sum += r; asum += v?.anon || 0; mx = Math.max(mx, r); if (v) peakComm[v.comm] = Math.max(peakComm[v.comm] || 0, v.anon); }
  peakAnonSum = Math.max(peakAnonSum, asum); peakSum = Math.max(peakSum, sum); peakMax = Math.max(peakMax, mx);
}, 200);
const code = await new Promise((r) => child.on('close', r));
clearInterval(tick);
const [wall, user, sys, maxkb] = fs.readFileSync(tf, 'utf8').trim().split('\n').pop().split(' ').map(Number);
fs.rmSync(tf, { force: true });
const row = { label, exit: code, wallS: wall, cpuS: +(user + sys).toFixed(2), userS: user, sysS: sys, peakRssTreeMB: Math.round(peakSum / 1e6), peakAnonTreeMB: Math.round(peakAnonSum / 1e6), peakRssLargestProcMB: Math.round(Math.max(peakMax, maxkb * 1024) / 1e6), peakAnonByProcessMB: Object.fromEntries(Object.entries(peakComm).filter(([, v]) => v > 5e7).map(([k, v]) => [k, Math.round(v / 1e6)])), result: stdout.trim().split('\n').pop() };
console.log(JSON.stringify(row));
fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
