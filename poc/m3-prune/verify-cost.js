// Step 4 cost: re-verify every kept record offline (verifyRecord: DKIM only, from the record alone).
// Builds a real small trail through Mailproof#record() with signed mail (test helpers), then times verifyRecord over
// the stored record JSON files, the way step 4 would walk the kept records.
// Usage: node verify-cost.js <scratchDir> [N=300]
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { verifyRecord } from '../../src/index.js';
import { signedMail, stubResolver, makeKey } from '../../tests/helpers/proof.js';

const [scratch, nArg = '300'] = process.argv.slice(2);
const N = Number(nArg);
const dir = path.join(scratch, 'verify-trail');
fs.rmSync(dir, { recursive: true, force: true });
const keys = Object.fromEntries(['a', 'b', 'c', 'd'].map((x) => [x, makeKey('rsa')]));
const map = {};
const mp0 = [];
for (let i = 0; i < N; i++) {
  const d = 'abcd'[i % 4], domain = `${d}.example`;
  const m = await signedMail({ domain, selector: 's', signers: [{ domain, selector: 's', alg: 'rsa', key: keys[d] }], from: `u${i}@${domain}`, to: 'me@owner.example', subject: 'mail ' + i, body: 'hello ' + i + '\r\n'.repeat(3) + 'x'.repeat(2000) + '\r\n' });
  Object.assign(map, m.map); mp0.push(m.raw);
}
const mp = new Mailproof({ trailDir: dir, resolver: stubResolver(map), worker: { size: 0 } });
const tRec0 = Date.now();
for (const raw of mp0) await mp.record(raw, { direction: 'in', source: 'poc' });
const tRec = Date.now() - tRec0;
await mp.close();
const rdir = path.join(dir, 'default', 'records');
const files = fs.readdirSync(rdir).filter((f) => f.endsWith('.json'));
for (const f of files.slice(0, 20)) verifyRecord(fs.readFileSync(path.join(rdir, f), 'utf8')); // warm up
const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
let ok = 0;
for (const f of files) { const v = verifyRecord(JSON.parse(fs.readFileSync(path.join(rdir, f), 'utf8'))); if (v.ok) ok++; }
const wall = Number(process.hrtime.bigint() - t0) / 1e6, cpu = process.cpuUsage(c0);
const perRecordMs = wall / files.length;
console.log(JSON.stringify({ records: files.length, verifiedOk: ok, recordMsEach: +(tRec / N).toFixed(1), verifyWallMs: +wall.toFixed(0), verifyCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(0), perRecordMs: +perRecordMs.toFixed(3), extrapolate: { '20k_kept_10k_s': +(perRecordMs * 10000 / 1000).toFixed(1), '80k_kept_40k_s': +(perRecordMs * 40000 / 1000).toFixed(1) } }));
fs.rmSync(dir, { recursive: true, force: true });
