// Per-process memory of Mailproof#prune (findings F25): samples /proc RssAnon/VmHWM of the whole process tree every 100 ms, per git subcommand.
// usage: node prune-mem-run.mjs <dir of trail-N> <before ISO> <logPrefix>   (trail dir name is t, as made by gen-sharded.js)
// usage: node run.mjs <trailDir(trail-N)> <before> <logPrefix>
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [dir, before, lp] = process.argv.slice(2);
const log = lp + '.child.jsonl'; fs.rmSync(log, { force: true });
const child = spawn('/usr/bin/time', ['-f', '%e %U %S', '-o', lp + '.time', 'node', new URL('child.mjs', import.meta.url).pathname, dir, before, log], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = ''; child.stdout.on('data', (d) => (out += d));
const T = Date.now(); const peaks = {}; let sumPeak = { anon: 0, t: 0, procs: '' }; const series = [];
const tick = setInterval(() => {
  const all = new Map();
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try {
    const st = fs.readFileSync(`/proc/${d}/status`, 'utf8'); const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(st) || [0, 0])[1]) / 1024;
    const cl = fs.readFileSync(`/proc/${d}/cmdline`, 'latin1').split('\0');
    const name = cl[0].endsWith('git') ? 'git ' + (cl.find((x, i) => i > 0 && !x.startsWith('-') && !x.includes('=')) ?? '') : (/node/.test(cl[0]) ? 'node' : cl[0].slice(-15));
    all.set(Number(d), { pp: Number(/^PPid:\s+(\d+)/m.exec(st)[1]), anon: g('RssAnon'), rss: g('VmRSS'), hwm: g('VmHWM'), name }); } catch {} }
  const set = new Set([child.pid]); let grew = true; while (grew) { grew = false; for (const [p, v] of all) if (!set.has(p) && set.has(v.pp)) { set.add(p); grew = true; } }
  let sum = 0, desc = []; for (const p of set) { const v = all.get(p); if (!v || v.name.includes('time')) continue; sum += v.anon;
    const k = v.name; const e = (peaks[k] ??= { anon: 0, hwm: 0, rss: 0 }); e.anon = Math.max(e.anon, v.anon); e.hwm = Math.max(e.hwm, v.hwm); e.rss = Math.max(e.rss, v.rss); if (v.anon > 20) desc.push(`${k}=${Math.round(v.anon)}`); }
  series.push([Date.now() - T, Math.round(sum), desc.join(' ')]);
  if (sum > sumPeak.anon) sumPeak = { anon: Math.round(sum), t: Date.now() - T, procs: desc.join(' ') };
}, 100);
await new Promise((r) => child.on('close', r)); clearInterval(tick);
const [wall, user, sys] = fs.readFileSync(lp + '.time', 'utf8').trim().split('\n').pop().split(' ').map(Number);
const evs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const mems = evs.filter((e) => e.mem); const mx = (k) => Math.round(Math.max(...mems.map((m) => m[k])));
console.log(JSON.stringify({ wall, cpu: +(user + sys).toFixed(1), events: evs.filter((e) => e.ev), node: { heapUsedMax: mx('heapUsed'), heapTotalMax: mx('heapTotal'), externalMax: mx('external'), abMax: mx('ab'), rssAnonMax: mx('rssAnon'), hwm: mx('hwm') }, treeAnonPeak: sumPeak, perProc: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, { anon: Math.round(v.anon), hwm: Math.round(v.hwm) }]).filter(([, v]) => v.hwm > 30)), result: out.trim().split('\n').pop() }, null, 1));
fs.writeFileSync(lp + '.series.json', JSON.stringify(series));
