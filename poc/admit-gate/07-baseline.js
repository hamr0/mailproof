import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { SIG, msg, msgBh, CRLF } from './gen.js';
import { cpu, nxdomain } from './cpu.js';
import { makeKey, signedMail } from '../../tests/helpers/proof.js';
const mp = (r) => new Mailproof({ trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-')), resolver: r || nxdomain });
const t = async (label, raw, r) => { const m = mp(r); await m.check(raw); const a = []; for (let i = 0; i < 3; i++) a.push((await cpu(() => m.check(raw))).ms); console.log(label.padEnd(60), Math.min(...a).toFixed(0), 'ms'); };
await t('tiny, fake bh (mismatch), 1 sig', msg([SIG(), 'From: me@x.example']));
await t('tiny, no signature', msg(['From: me@x.example']));
await t('128 KiB html-ish body, fake bh', msg([SIG(), 'From: me@x.example'], ('<a>'.repeat(25) + CRLF).repeat(1700)));
await t('same body, matching bh', msgBh([], ('<a>'.repeat(25) + CRLF).repeat(1700)));
const key = makeKey('rsa');
for (const lines of [10, 1000, 5000]) {
  const body = Array.from({ length: lines }, (_, i) => 'l' + i + 'x'.repeat(40)).join(CRLF) + CRLF;
  const s = await signedMail({ signers: [{ domain: 's.example', selector: 'sel', key }], body });
  const raw = Buffer.from(s.raw); raw[raw.length - 20] ^= 1;
  await t(`1 valid sig, tampered body ${lines} lines`, raw, s.resolver);
}
