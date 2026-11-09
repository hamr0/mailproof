// Child of prune-mem-run.mjs: runs Mailproof#prune on <dir>/t and logs phase events and its own memory every 100 ms. DEL=0: keep the backup.
import fs from 'node:fs';
import { Mailproof } from '../../src/proof/mailproof.js';
const [dir, before, log] = process.argv.slice(2);
const t0 = Date.now();
const ev = (n) => fs.appendFileSync(log, JSON.stringify({ ev: n, t: Date.now() - t0 }) + '\n');
const iv = setInterval(() => { const m = process.memoryUsage(); const st = fs.readFileSync('/proc/self/status', 'utf8'); const g = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(st)[1]) / 1024;
  fs.appendFileSync(log, JSON.stringify({ mem: 1, t: Date.now() - t0, heapUsed: m.heapUsed / 1048576, heapTotal: m.heapTotal / 1048576, external: m.external / 1048576, ab: m.arrayBuffers / 1048576, rssAnon: g('RssAnon'), hwm: g('VmHWM') }) + '\n'); }, 100);
const mp = new Mailproof({ trailDir: dir, trail: 't', worker: { size: 0 } });
mp._pruneHooks.afterPlan = () => ev('afterPlan');
mp._pruneHooks.afterBuild = () => ev('afterBuild');
mp._pruneHooks.afterLocks = () => ev('afterLocks');
ev('start');
const r = await mp.prune({ before, deleteBackup: process.env.DEL !== '0' });
ev('end'); clearInterval(iv);
const { reverify, stragglers, ...rest } = r;
console.log(JSON.stringify({ ...rest, stragglers: stragglers.length, failed: reverify.failed.length }));
