// Peak/after RSS per hostile shape, one fresh process per case. node mem.mjs <case> [limits=on|off] [deadline=3000]
import { pathToFileURL } from 'node:url'; import fs from 'node:fs';
import { Mailproof, makeWorkerMailproof, SRC } from './wm.js';
const { signedMail } = await import(pathToFileURL(SRC + '/tests/helpers/proof.js').href);
const [, , kase, limits = 'on', deadline = '3000'] = process.argv;
const mb = (n) => Math.round(n / 1048576);
const good = await signedMail({ body: 'hello\r\n' });
const SIG = 'DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA';
const hdr = [SIG, 'From: me@x.example', 'Subject: s'].join('\r\n') + '\r\n\r\n';
const body = Buffer.alloc(25 * 1024 * 1024 - 4096 - hdr.length); for (let i = 0; i < body.length; i += 3) { body[i] = 120; body[i + 1] = 13; body[i + 2] = 10; }
const evil = Buffer.concat([Buffer.from(hdr), body]);
const rl = limits === 'on' ? { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } : undefined;
const test = { evil: undefined, loop: 'loop', heap: 'heap', alloc: 'alloc', inproc: undefined }[kase];
const raw = kase === 'loop' || kase === 'heap' || kase === 'alloc' ? good.raw : evil;
const base = mb(process.memoryUsage().rss);
let peak = base; const iv = setInterval(() => { peak = Math.max(peak, mb(process.memoryUsage().rss)); }, 50);
const T = fs.mkdtempSync('/tmp/claude-1000/-home-hamr-PycharmProjects-mailproof/1eb0833c-1eeb-422b-ad29-0eeae0eed090/scratchpad/mem-');
const t0 = performance.now(); let reason;
if (kase === 'inproc') { await new Mailproof({ trailDir: T, resolver: good.resolver }).check(raw); reason = 'in-process'; }
else {
  const mp = new (makeWorkerMailproof({ size: 1, deadlineMs: +deadline, resourceLimits: rl }))({ trailDir: T, resolver: good.resolver });
  mp.__test = test; const c = await mp.check(raw); reason = (mp.last.reason || 'ok') + ' / ' + (c.portable.reason || c.portable.trust);
}
const wall = Math.round(performance.now() - t0);
const afterKill = mb(process.memoryUsage().rss);
await new Promise((r) => setTimeout(r, 4000)); const after4 = mb(process.memoryUsage().rss);
clearInterval(iv); global.gc?.();
console.log(JSON.stringify({ kase, limits, deadline, outcome: reason, wallMs: wall, rssBaseMB: base, rssPeakMB: peak, rssAtKillMB: afterKill, rssPlus4sMB: after4 }));
process.exit(0);
