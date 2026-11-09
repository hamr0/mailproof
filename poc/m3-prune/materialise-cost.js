// Cost of turning the bare result into a normal trail directory (working tree + index) and of the swap renames.
// Usage: node materialise-cost.js <oldTrailRepo (non-bare, for git config)> <bare repo from b.js/c.js> <scratchDir>
import fs from 'node:fs';
import path from 'node:path';
import { materialise, paths } from './swap.js';

const [live, bare, scratch] = process.argv.slice(2);
const trailDir = path.join(scratch, 'mat'); fs.rmSync(trailDir, { recursive: true, force: true }); fs.mkdirSync(trailDir);
fs.cpSync(bare, path.join(trailDir, 'b.git'), { recursive: true });
const P = paths(trailDir, 'default', '2026-11-09');
fs.cpSync(path.join(live, '.git', 'config'), path.join(trailDir, 'cfg'));
fs.mkdirSync(P.live); fs.cpSync(path.join(live, '.git', 'config'), path.join(P.live, 'cfg')); // stand-in: only `git config` of P.live is read
const cfgRepo = path.join(trailDir, 'cfgrepo'); fs.mkdirSync(cfgRepo); (await import('node:child_process')).execFileSync('git', ['init', '-q', cfgRepo]); fs.copyFileSync(path.join(live, '.git', 'config'), path.join(cfgRepo, '.git', 'config'));
P.live = cfgRepo;
const t0 = process.hrtime.bigint(), c0 = process.cpuUsage();
materialise(path.join(trailDir, 'b.git'), P);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const t1 = process.hrtime.bigint();
fs.renameSync(P.tmp, path.join(trailDir, 'swapped')); fs.renameSync(cfgRepo, path.join(trailDir, 'bak'));
const msRename = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(JSON.stringify({ files: fs.readdirSync(path.join(trailDir, 'swapped', 'records')).length, materialiseMs: Math.round(ms), renamesMs: +msRename.toFixed(2) }));
fs.rmSync(trailDir, { recursive: true, force: true });
