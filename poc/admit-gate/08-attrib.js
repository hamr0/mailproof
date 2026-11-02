// Attribution: where do the 10 tampered signatures spend CPU? mailauth alone vs the whole check().
import { authenticate } from 'mailauth';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { makeKey, signedMail } from '../../tests/helpers/proof.js';
import { cpu } from './cpu.js';
import { CRLF } from './gen.js';
const signers = Array.from({ length: 10 }, (_, i) => ({ domain: `s${i}.example`, selector: 'sel', key: makeKey('rsa') }));
const body = Array.from({ length: 1700 }, (_, i) => 'line' + String(i).padStart(6, '0') + 'x'.repeat(60)).join(CRLF) + CRLF;
const s = await signedMail({ signers, body }); const raw = Buffer.from(s.raw); raw[raw.length - 5000] ^= 1;
const ma = async () => { await authenticate(raw, { resolver: s.resolver, disableBimi: true, sender: 'a@s0.example', ip: '1.2.3.4', helo: 'x' }); };
await ma(); console.log('mailauth.authenticate alone, 10 tampered sigs, 128 KiB:', (await cpu(ma)).ms.toFixed(0), 'ms');
const mp = new Mailproof({ trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-')), resolver: s.resolver });
await mp.check(raw); console.log('Mailproof.check() same message:', (await cpu(() => mp.check(raw))).ms.toFixed(0), 'ms');
