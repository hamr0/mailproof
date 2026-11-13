// F39 POC (throwaway, never shipped): synthetic trails for the schema 6 rebuild / status-refresh measurement.
// Usage: node gen.mjs <outDir> <N> [pending=310]
// Seeds: 7 genuine records made through the real Mailproof#record() with test DKIM keys (tests/helpers), then cloned to N
// records in the sharded layout (records/<id[0:2]>/<id>.json), one commit per record via `git fast-import`. Mix:
//   reply, signed In-Reply-To/References/Cc, 10 signed headers (rsa)        35%
//   reply, 10 signed headers (ed25519 + rsa, two signatures)                 5%
//   plain signed mail, 5 signed headers, no threading (rsa)                 20%
//   request out, signed Cc                                                  12%
//   reply whose signed Subject was altered after signing (fails: unverified) 8%
//   unsigned mail (no signature at all)                                     20%
// Clones keep the signed headers, so signatures still verify and the re-check is real work; id, message_id, captured
// and direction vary. `pending` extra records are saved to pending.json (committed later by bench.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver, makeKey } from '../../tests/helpers/proof.js';
import { makeTmpDir } from '../../tests/helpers/tmp.js';
import { serialise } from '../../src/proof/trail.js';
import { recordPath } from '../../src/proof/layout.js';

const [outDir, nArg, pArg = '310'] = process.argv.slice(2);
const N = Number(nArg), PENDING = Number(pArg), TOTAL = N + PENDING;
const T0 = new Date('2026-11-01T10:00:00Z');

// ---- seeds
const full = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'mime-version', 'content-type'];
const small = ['from', 'to', 'subject', 'date', 'message-id'];
const key = { o: makeKey('rsa'), b: makeKey('rsa'), c: makeKey('rsa'), e: makeKey('ed25519') };
const mk = (domain, k, extra = {}) => signedMail({ domain, selector: 's', signers: [{ domain, selector: 's', alg: k.alg, key: k }], signTime: T0, ...extra });
const mails = {
  reply: await mk('beta.example', key.b, { from: 'Bob <bob@beta.example>', to: 'me@owner.example', messageId: '<r1@beta.example>', inReplyTo: '<req@owner.example>', references: '<req@owner.example>', extraHeaders: ['Cc: carol@gamma.example'], headerList: full }),
  dual: await signedMail({ domain: 'gamma.example', selector: 's', from: 'carol@gamma.example', to: 'me@owner.example', messageId: '<r2@gamma.example>', inReplyTo: '<req@owner.example>', references: '<req@owner.example>', headerList: full, signTime: T0,
    signers: [{ domain: 'gamma.example', selector: 's', alg: 'rsa', key: key.c }, { domain: 'gamma.example', selector: 's2', alg: 'ed25519', key: key.e }] }),
  plain: await mk('beta.example', key.b, { from: 'dan@beta.example', to: 'me@owner.example', messageId: '<p1@beta.example>', headerList: small }),
  req: await mk('owner.example', key.o, { from: 'Owner <me@owner.example>', to: 'Bob <bob@beta.example>', messageId: '<req@owner.example>', extraHeaders: ['Cc: carol@gamma.example'], headerList: full }),
  bad: await mk('beta.example', key.b, { from: 'Bob <bob@beta.example>', to: 'me@owner.example', messageId: '<r3@beta.example>', inReplyTo: '<req@owner.example>', references: '<req@owner.example>', headerList: full }),
};
mails.bad.raw = Buffer.from(mails.bad.raw.toString('binary').replace('Subject: Re: please sign', 'Subject: Re: please sign!'), 'binary');
if (!mails.bad.raw.toString('binary').includes('sign!')) throw new Error('tamper did not apply');
const unsigned = Buffer.from('From: Zed <zed@zed.example>\r\nTo: me@owner.example\r\nSubject: hello\r\nMessage-ID: <z1@zed.example>\r\n\r\nhello\r\n');
const map = {}; for (const m of Object.values(mails)) Object.assign(map, m.map);

const seedDir = makeTmpDir('mp-f39-seed-');
const mp = new Mailproof({ trailDir: seedDir, resolver: stubResolver(map), worker: { size: 0 }, now: () => T0, content: { store: false } });
const seed = {};
for (const [k, raw, dir] of [['reply', mails.reply.raw, 'in'], ['dual', mails.dual.raw, 'in'], ['plain', mails.plain.raw, 'in'], ['req', mails.req.raw, 'out'], ['bad', mails.bad.raw, 'in'], ['unsigned', unsigned, 'in']])
  seed[k] = (await mp.record(raw, { direction: dir, source: 'test' })).record;
await mp.close();
const seedRoot = path.join(seedDir, 'default');
const DIST = [['reply', 0.35], ['dual', 0.05], ['plain', 0.20], ['req', 0.12], ['bad', 0.08], ['unsigned', 0.20]];

// ---- synthetic trail
let st = 0x9e3779b9;
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
const hex = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const pickKind = () => { let x = rnd(); for (const [k, p] of DIST) { if ((x -= p) < 0) return k; } return 'unsigned'; };
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const trailDir = path.join(outDir, `trail-${N}`);
const root = path.join(trailDir, 'default');
fs.rmSync(trailDir, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q', '--initial-branch=main']); git(['config', 'user.name', 'mailproof']); git(['config', 'user.email', 'noreply@mailproof.invalid']);
const tj = fs.readFileSync(path.join(seedRoot, 'trail.json'), 'utf8');
fs.writeFileSync(path.join(root, 'trail.json'), tj);

const fi = spawn('git', ['fast-import', '--quiet'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => fi.on('exit', (c) => (c === 0 ? res() : rej(new Error('fast-import ' + c)))));
const out = (s) => (fi.stdin.write(s) ? null : new Promise((r) => fi.stdin.once('drain', r)));
const ident = (ms) => `mailproof <noreply@mailproof.invalid> ${Math.floor(ms / 1000)} +0000`;
const blob = (rel, c) => `M 100644 inline ${rel}\ndata ${Buffer.byteLength(c)}\n${c}\n`;
const msg = (m) => `data ${Buffer.byteLength(m)}\n${m}\n`;
const files = [['trail.json', tj]];
for (const d of ['keys']) { const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else files.push([path.relative(seedRoot, q), fs.readFileSync(q, 'utf8')]); } }; walk(path.join(seedRoot, d)); }
await out(`commit refs/heads/main\ncommitter ${ident(BASE)}\n${msg('trail created')}${files.map(([r, c]) => blob(r, c)).join('')}\n`);

const pending = [];
const mix = {};
for (let i = 0; i < TOTAL; i++) {
  const kind = pickKind(); mix[kind] = (mix[kind] || 0) + 1;
  const r = structuredClone(seed[kind]);
  r.id = hex('id' + i, 32);
  r.message = { ...r.message, message_id: `<${hex('m' + i, 12)}@f39.example>`, raw_sha256: 'sha256:' + hex('raw' + i, 64) };
  r.message_key = kind === 'unsigned' ? null : hex('key' + i, 32);
  const cap = BASE + (i + 1) * 1000;
  r.captured = new Date(cap).toISOString();
  if (kind !== 'req') r.direction = rnd() < 0.85 ? 'in' : 'out';
  if (i >= N) { pending.push(r); continue; }
  const rel = recordPath(r.id);
  await out(`commit refs/heads/main\ncommitter ${ident(cap)}\n${msg(`record ${r.id.slice(0, 12)} ${r.direction} ${r.verdicts?.live?.trust}/${r.verdicts?.portable?.trust}`)}${blob(rel, serialise(r))}\n`);
}
fs.writeFileSync(path.join(trailDir, 'pending.json'), JSON.stringify(pending));
fi.stdin.end(); await done;
git(['reset', '-q']); git(['checkout', '-q', '--', '.']);
fs.rmSync(seedDir, { recursive: true, force: true });
console.log(JSON.stringify({ N, trailDir, mix, trust: Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.verdicts?.live?.trust + '/' + v.verdicts?.portable?.trust])) }));
