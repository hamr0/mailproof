// Kill works: deadline fires on a real admitted pathological message and on synthetic hangs; record is consistent, lock free, pool recovers.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execFileSync } from 'node:child_process'; import { pathToFileURL } from 'node:url';
import { Mailproof, makeWorkerMailproof, SRC } from './wm.js';
const { signedMail } = await import(pathToFileURL(SRC + '/tests/helpers/proof.js').href);
const { admit } = await import(pathToFileURL(SRC + '/src/proof/admit.js').href);
const SCR = '/tmp/claude-1000/-home-hamr-PycharmProjects-mailproof/1eb0833c-1eeb-422b-ad29-0eeae0eed090/scratchpad';
const T = fs.mkdtempSync(SCR + '/kill-');
const DEADLINE = +process.env.DEADLINE || 3000;
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const good = await signedMail({ body: 'hello world\r\n' });
const SIG = 'DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA';
const hdr = [SIG, 'From: me@x.example', 'Subject: s'].join('\r\n') + '\r\n\r\n';
const lineBody = Buffer.alloc(25 * 1024 * 1024 - 4096 - hdr.length); for (let i = 0; i < lineBody.length; i += 3) { lineBody[i] = 120; lineBody[i + 1] = 13; lineBody[i + 2] = 10; }
const evil = Buffer.concat([Buffer.from(hdr), lineBody]);
console.log('evil bytes', evil.length, 'lines', evil.length / 3 | 0, 'admitted by frozen HEAD:', admit(evil).ok, '| load', os.loadavg().map((x) => x.toFixed(2)).join(' '));

if (process.env.INPROC) {   // reference: how long the unprotected in-process path blocks
  const mp = new Mailproof({ trailDir: path.join(T, 'ref'), resolver: good.resolver });
  const t0 = performance.now(), c0 = process.cpuUsage(); await mp.check(evil); const c = process.cpuUsage(c0);
  console.log('IN-PROCESS check(evil): wall', (performance.now() - t0).toFixed(0), 'ms cpu', ((c.user + c.system) / 1000).toFixed(0), 'ms (event loop blocked throughout)');
}

const W = makeWorkerMailproof({ size: 2, deadlineMs: DEADLINE, cpuMs: process.env.CPU ? +process.env.CPU : undefined, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
const mp = new W({ trailDir: path.join(T, 't'), resolver: good.resolver });
const git = (...a) => execFileSync('git', ['-C', mp.root, ...a], { encoding: 'utf8' }).trim();
const lockFiles = () => fs.readdirSync(path.join(T, 't')).filter((f) => f.includes('lock'));
// event-loop responsiveness probe: max gap between 10ms ticks
let maxGap = 0, last = performance.now(); const tick = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);

await mp.record(good.raw, { direction: 'in', source: 'warm' });
const rss0 = rss();
async function killCase(label, raw, test) {
  if (test) raw = Buffer.concat([Buffer.from('X-Case: ' + label + '\r\n'), raw]);   // distinct bytes: an identical re-submission would be a duplicate of the warm-up record
  mp.__test = test; maxGap = 0;
  const t0 = performance.now(), cpu0 = process.cpuUsage();
  const r = await mp.record(raw, { direction: 'in', source: label });
  const wall = performance.now() - t0; const c = process.cpuUsage(cpu0);
  mp.__test = undefined;
  const rec = await mp.get(r.id); const expectCommits = (killCase.n = (killCase.n || 1) + 1) + 1;
  const commits = +git('rev-list', '--count', 'HEAD');
  console.log(JSON.stringify({ label, wall: Math.round(wall), cpuMainProc: Math.round((c.user + c.system) / 1000), reason: rec.verdicts.live.reason, trust: rec.verdicts.live.trust + '/' + rec.verdicts.portable.trust, sigs: rec.signatures.length, size: rec.message.size, commits, expectCommits, dup: r.duplicate, lock: lockFiles(), status: git('status', '--porcelain') || 'clean', fsck: git('fsck', '--no-progress') === '' ? 'ok' : 'check', workerReason: mp.last.reason, maxLoopGapMs: Math.round(maxGap), rssMB: rss() }));
  // pool recovers: the next normal message goes through
  const ok = await mp.record(good.raw, { direction: 'in', source: 'after-' + label });
  const v = await mp.verify(ok.id);
  console.log('   next normal message ->', ok.duplicate ? 'duplicate(same bytes; still processed)' : 'new record', 'verified:', v.ok, 'last job ok:', mp.last.ok, 'pool spawned/killed', mp.pool.stats.spawned + '/' + mp.pool.stats.killed);
}
await killCase('evil-25MiB-1byte-lines', evil, undefined);
await killCase('infinite-loop', good.raw, 'loop');
await killCase('catastrophic-regex', good.raw, 'regex');
await killCase('spin-after-build', good.raw, 'spin-after');
await killCase('js-heap-blowup', good.raw, 'heap');
await killCase('external-alloc-blowup', good.raw, 'alloc');
// verify the ledger afterwards
console.log('final: commits', git('rev-list', '--count', 'HEAD'), 'records', fs.readdirSync(path.join(mp.root, 'records')).length, 'lock files', lockFiles());
console.log('RSS MB before', rss0, 'after', rss());

// DNS pause: a resolver that takes 4x the deadline must NOT trip the deadline (the worker is idle, not hung)
const slow = new (makeWorkerMailproof({ size: 1, deadlineMs: 500 }))({ trailDir: path.join(T, 's'), resolver: async (n, t) => { await new Promise((r) => setTimeout(r, 2000)); return good.resolver(n, t); } });
const t0 = performance.now(); const c = await slow.check(good.raw);
console.log('slow DNS (each lookup 2000ms, deadline 500ms): wall', Math.round(performance.now() - t0), 'ms, trust', c.portable.trust, c.portable.reason ?? '');
// pool of 1: a hung job must not block the queue behind it
const one = new (makeWorkerMailproof({ size: 1, deadlineMs: 1000 }))({ trailDir: path.join(T, 'o'), resolver: good.resolver });
one.__test = 'loop'; const p1 = one.check(good.raw); one.__test = undefined; const p2 = one.check(good.raw);
const t1 = performance.now(); const [a, b] = await Promise.all([p1, p2]);
console.log('queue behind hung job (pool=1, deadline 1000):', a.portable.reason, '|', b.portable.trust, 'total', Math.round(performance.now() - t1), 'ms');
clearInterval(tick); await mp.close(); await slow.close(); await one.close();
fs.rmSync(T, { recursive: true, force: true });
