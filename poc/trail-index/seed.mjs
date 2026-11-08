// Step 1: make a handful of GENUINE records with the repo's own Mailproof#record().
// Seeds: the committed real signedreply.com fixture (production DKIM key) + signed synthetic mails from the
// test helper (needed for attachment / In-Reply-To shapes the one real fixture lacks).
// Usage: node seed.mjs <outDir>   -> writes <outDir>/seeds.json (array of record objects)
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { signedMail } from '../../tests/helpers/proof.js';

const out = process.argv[2];
const fx = path.resolve(import.meta.dirname, '../../tests/integration/fixtures');
const txt = [...fs.readFileSync(fx + '/signedreply.dkim.txt', 'utf8').matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('').trim();
const realResolver = async (name, type) => {
  const map = { 'gd202604._domainkey.signedreply.com': txt, '_dmarc.signedreply.com': 'v=DMARC1; p=none; adkim=s; aspf=s' };
  const rec = (type || 'TXT').toUpperCase() === 'TXT' ? map[name] : undefined;
  if (rec === undefined) throw Object.assign(new Error('no rec ' + name), { code: 'ENOTFOUND' });
  return [[rec]];
};
const seeds = [];
const trailDir = path.join(out, 'seedtrail');
const rec = async (raw, resolver, direction, label) => {
  const mp = new Mailproof({ trailDir, trail: 'seed', resolver, worker: { size: 0 } });
  const r = await mp.record(raw, { direction, source: 'poc' });
  seeds.push({ label, record: r.record });
};
await rec(fs.readFileSync(fx + '/signedreply-sample.eml'), realResolver, 'in', 'real-signedreply');
for (const [i, opts] of [{}, { inReplyTo: '<ask@me.example>' }, { attachment: { filename: 'a.bin', bytes: Buffer.from('x'.repeat(500)) } }].entries()) {
  const m = await signedMail(opts);
  await rec(m.raw, m.resolver, i === 1 ? 'out' : 'in', 'helper-' + i);
}
fs.writeFileSync(path.join(out, 'seeds.json'), JSON.stringify(seeds));
for (const s of seeds) console.log(s.label, s.record.id, s.record.direction, s.record.verdicts.live.trust, s.record.verdicts.portable.trust, s.record.body_status, s.record.copy?.kind, JSON.stringify(s.record.message), Buffer.byteLength(JSON.stringify(s.record, null, 2)));
