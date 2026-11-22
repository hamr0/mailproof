// `mailproof record` (SPEC B14, M5): one raw email from a file or stdin into the trail. The B14.9 plan, case by case (the number is in the
// test title). IMAP and DNS are never contacted: the library is built through `deps.makeMailproof` with a stub resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { Mailproof, hashDocument } from '../../src/index.js';
import { validateConfig, mailproofOptions } from '../../src/cli/config.js';
import * as configModule from '../../src/cli/config.js';
import { MAX_TOTAL_BYTES } from '../../src/proof/limits.js';
import { trailLockFile } from '../../src/proof/trail.js';
import { makeWorld } from '../helpers/cli.js';
import { stubResolver } from '../helpers/proof.js';
import { bundleWorld, fakeOts } from '../helpers/bundle.js';
import { inProcess } from '../helpers/mcp.js';
import { makeTmpDir } from '../helpers/tmp.js';

const mail = (n = 1, extra = '') => Buffer.from(`From: a@sender.invalid\r\nTo: me@owner.invalid\r\nSubject: m${n}\r\nMessage-ID: <m${n}@sender.invalid>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n${extra}\r\nbody ${n}\r\n`);
const resolver = stubResolver({});
const CHUNK = 64 * 1024;
/** @param {Buffer} b @returns {Buffer[]} */
const chunks = (b, size = CHUNK) => { const out = []; for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size)); return out; };
const sha = (b) => hashDocument(b).replace(/^sha256:/, '');

/** A pipe-only world: one account, no host. `deps.makeMailproof` builds the real library over a stub resolver, in-process, as the command does. */
function pipeWorld(accountExtra = {}, mpExtra = {}) {
  const trailDir = makeTmpDir('mp-rec-trail-');
  const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir, ...accountExtra } } });
  const mk = (extra = {}) => new Mailproof({ ...mailproofOptions(/** @type {any} */ ({ trailDir, trail: 'default', otsBin: null, stamp: {}, content: {} })), worker: { size: 0 }, resolver, lockTimeoutMs: 5000, ...mpExtra, ...extra });
  const deps = { makeMailproof: () => mk() };
  const root = path.join(trailDir, 'default');
  const rec = (argv, o = {}) => w.run(['record', ...argv], { deps, ...o });
  return { w, trailDir, root, mk, deps, rec };
}
const head = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const commits = (root) => execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const recordFiles = (root) => { const d = path.join(root, 'records'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((s) => fs.readdirSync(path.join(d, s))).filter((f) => f.endsWith('.json')) : []; };

/** A stub library that records what the command calls. */
function stubDeps({ sweep } = {}) {
  const calls = { record: [], digest: [], sweep: 0 };
  const mp = {
    record: async (raw, ctx) => { calls.record.push({ raw, ctx }); return { id: 'a'.repeat(32), duplicate: false, commit: 'c0ffee' }; },
    _recordDigest: async (d, ctx) => { calls.digest.push({ d, ctx }); return { id: 'b'.repeat(32), duplicate: false, commit: 'c0ffee' }; },
    _autoSweep: async () => { calls.sweep++; if (sweep) await sweep(); return null; },
    close: async () => {},
  };
  return { calls, deps: { makeMailproof: () => mp } };
}

// ---- input and the library call ----

test('B14.9-1: stdin to `record --direction in`: exit 0, one record, direction in, the human line', async () => {
  const p = pipeWorld();
  const r = await p.rec(['--direction', 'in', '--account', 'me'], { input: mail() });
  assert.equal(r.code, 0, r.stderr);
  const m = p.mk();
  const rows = await m.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'in');
  const rec = await m.get(rows[0].id);
  assert.equal(r.stdout.trim(), `recorded ${rows[0].id} in ${rec.verdicts.live.trust}/${rec.verdicts.portable.trust}`);
  assert.equal(r.stderr, '');
});

test('B14.9-2: the same with --direction out', async () => {
  const p = pipeWorld();
  const r = await p.rec(['--direction', 'out'], { input: mail() });
  assert.equal(r.code, 0, r.stderr);
  const m = p.mk();
  const rows = await m.list();
  assert.equal(rows[0].direction, 'out');
  assert.match(r.stdout.trim(), /^recorded [0-9a-f]{32} out \S+\/\S+$/);
});

test('B14.9-3: a <file> argument (~ expanded) records the same id as stdin; a missing file is exit 1; a directory is exit 64', async () => {
  const p = pipeWorld();
  const bytes = mail(3);
  const a = await p.rec(['--direction', 'in', '--json'], { input: bytes });
  assert.equal(a.code, 0, a.stderr);
  fs.writeFileSync(path.join(p.w.home, 'x.eml'), bytes);
  const b = await p.rec(['--direction', 'in', '~/x.eml', '--json']);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).id, JSON.parse(a.stdout).id);
  assert.equal(JSON.parse(b.stdout).duplicate, true);
  const missing = await p.rec(['--direction', 'in', '~/nope.eml']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr.trim().split('\n').length, 1, 'one stderr line');
  assert.match(missing.stderr, /nope\.eml/);
  fs.mkdirSync(path.join(p.w.home, 'dir'));
  const dir = await p.rec(['--direction', 'in', '~/dir']);
  assert.equal(dir.code, 64, dir.stderr);
});

test('B14.9-4: the same bytes again: exit 0, `already recorded <id>`, duplicate true in --json, no new commit', async () => {
  const p = pipeWorld();
  const first = await p.rec(['--direction', 'in', '--json'], { input: mail(4) });
  const id = JSON.parse(first.stdout).id;
  const before = [head(p.root), commits(p.root)];
  const again = await p.rec(['--direction', 'in'], { input: mail(4) });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.trim(), `already recorded ${id}`);
  const j = await p.rec(['--direction', 'in', '--json'], { input: mail(4) });
  assert.equal(JSON.parse(j.stdout).duplicate, true);
  assert.deepEqual([head(p.root), commits(p.root)], before, 'no new commit');
});

test('B14.9-5: empty stdin and an empty file: exit 1, one stderr line, nothing written', async () => {
  const p = pipeWorld();
  const a = await p.rec(['--direction', 'in'], { input: Buffer.alloc(0) });
  assert.equal(a.code, 1);
  assert.equal(a.stderr.trim().split('\n').length, 1);
  assert.match(a.stderr, /record: empty message/);
  fs.writeFileSync(path.join(p.w.home, 'empty.eml'), '');
  const b = await p.rec(['--direction', 'in', '~/empty.eml']);
  assert.equal(b.code, 1);
  assert.equal(b.stderr.trim().split('\n').length, 1);
  assert.equal(fs.existsSync(p.root), false, 'nothing written, not even the trail');
});

test('B14.9-6: no --direction, --direction=sideways: exit 64; no file and stdin a TTY: exit 64, nothing read', async () => {
  const p = pipeWorld();
  const none = await p.rec([], { input: mail() });
  assert.equal(none.code, 64);
  assert.match(none.stderr, /--direction/);
  const bad = await p.rec(['--direction=sideways'], { input: mail() });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /--direction/);
  assert.equal((await p.rec(['--direction'], { input: mail() })).code, 64);
  const tty = await p.rec(['--direction', 'in'], { input: [mail()], stdinTty: true });
  assert.equal(tty.code, 64);
  assert.match(tty.stderr, /stdin|terminal/);
  assert.equal(tty.stdinRead, false, 'the command never reads a terminal');
  assert.equal(fs.existsSync(p.root), false);
});

test('B14.9-7: --source defaults to pipe; --source pipe:postfix reaches the record', async () => {
  const p = pipeWorld();
  await p.rec(['--direction', 'in'], { input: mail(1) });
  await p.rec(['--direction', 'in', '--source', 'pipe:postfix'], { input: mail(2) });
  const m = p.mk();
  const rows = await m.list();
  const sources = new Map();
  for (const row of rows) sources.set((await m.get(row.id)).source, true);
  assert.deepEqual([...sources.keys()].sort(), ['pipe', 'pipe:postfix']);
});

test('B14.9-8: each envelope flag reaches record(); empty values pass empty (sender: null); no flag passes no envelope', async () => {
  const run = async (argv) => {
    const s = stubDeps();
    const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir: makeTmpDir('mp-rec-env-') } } });
    const r = await w.run(['record', '--direction', 'in', ...argv, '--json'], { input: mail(), deps: s.deps });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(s.calls.record.length, 1);
    return s.calls.record[0].ctx;
  };
  assert.deepEqual(await run(['--client-ip', '192.0.2.1']), { direction: 'in', source: 'pipe', envelope: { clientIp: '192.0.2.1' } });
  assert.deepEqual(await run(['--client-helo=mx.example.net']), { direction: 'in', source: 'pipe', envelope: { clientHelo: 'mx.example.net' } });
  assert.deepEqual(await run(['--sender', 'bob@example.net']), { direction: 'in', source: 'pipe', envelope: { sender: 'bob@example.net' } });
  assert.deepEqual(await run(['--client-ip=', '--client-helo=']), { direction: 'in', source: 'pipe', envelope: { clientIp: '', clientHelo: '' } });
  assert.deepEqual(await run(['--sender=']), { direction: 'in', source: 'pipe', envelope: { sender: null } });
  assert.deepEqual(await run(['--client-ip=192.0.2.9', '--client-helo=h', '--sender=s@x.example']), { direction: 'in', source: 'pipe', envelope: { clientIp: '192.0.2.9', clientHelo: 'h', sender: 's@x.example' } });
  assert.deepEqual(await run([]), { direction: 'in', source: 'pipe' });
});

test('B14.9-9: --recipient=x is an unknown flag: exit 64, nothing recorded', async () => {
  const p = pipeWorld();
  const r = await p.rec(['--direction', 'in', '--recipient=x'], { input: mail() });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /recipient/);
  assert.equal(fs.existsSync(p.root), false);
});

test('B14.9-10: --json is { id, duplicate, commit, ots?, content? } with no `record` key; a duplicate has no ots', async () => {
  const p = pipeWorld();
  const a = JSON.parse((await p.rec(['--direction', 'in', '--json'], { input: mail() })).stdout);
  assert.ok(Object.keys(a).every((k) => ['id', 'duplicate', 'commit', 'ots', 'content'].includes(k)), Object.keys(a).join());
  for (const k of ['id', 'duplicate', 'commit']) assert.ok(k in a, k);
  assert.equal('record' in a, false);
  assert.equal(a.duplicate, false);
  const b = JSON.parse((await p.rec(['--direction', 'in', '--json'], { input: mail() })).stdout);
  assert.equal(b.duplicate, true);
  assert.equal('ots' in b, false);
  assert.equal('record' in b, false);
});

// ---- over the cap ----

test('B14.9-11: MAX_TOTAL_BYTES + 1 bytes streamed to stdin: exit 0, unverified, over limit: total_bytes, id = the hash of the bytes', async () => {
  const bytes = Buffer.alloc(MAX_TOTAL_BYTES + 1, 0x61);
  const p = pipeWorld();
  const r = await p.rec(['--direction', 'in', '--json'], { input: chunks(bytes) });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.id, sha(bytes).slice(0, 32));
  assert.equal(j.duplicate, false);
  const rec = await p.mk().get(j.id);
  assert.equal(rec.verdicts.live.trust, 'unverified');
  assert.equal(rec.verdicts.live.reason, 'over limit: total_bytes');
  assert.equal(rec.message.size, bytes.length);
  assert.equal(rec.message.raw_sha256, `sha256:${sha(bytes)}`);
  const human = await pipeWorld().rec(['--direction', 'in'], { input: chunks(bytes) });
  assert.match(human.stdout.trim(), /^recorded [0-9a-f]{32} in unverified\/unverified$/);
});

test('B14.9-12: the same over-cap bytes again are duplicate: true, and a library record() of them gives the same id', async () => {
  const bytes = Buffer.alloc(MAX_TOTAL_BYTES + 5, 0x62);
  const p = pipeWorld();
  const a = JSON.parse((await p.rec(['--direction', 'in', '--json'], { input: chunks(bytes) })).stdout);
  const b = JSON.parse((await p.rec(['--direction', 'in', '--json'], { input: chunks(bytes) })).stdout);
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  const lib = await p.mk().record(bytes, { direction: 'in', source: 'api' });
  assert.equal(lib.id, a.id);
  assert.equal(lib.duplicate, true);
});

test('B14.9-13: the reader holds at most the cap while size and sha256 cover all the bytes (readBounded)', async () => {
  const { readBounded } = await import('../../src/cli/record.js');
  const piece = Buffer.alloc(CHUNK, 0x63);
  const total = 2 * MAX_TOTAL_BYTES;
  const count = total / CHUNK;
  async function* gen() { for (let i = 0; i < count; i++) yield piece; }
  const ref = (await import('node:crypto')).createHash('sha256');
  for (let i = 0; i < count; i++) ref.update(piece);
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  async function* watched() { for await (const c of gen()) { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); yield c; } }
  const r = await readBounded(watched(), MAX_TOTAL_BYTES);
  assert.equal(r.size, total);
  assert.equal(r.sha256, ref.digest('hex'));
  assert.ok(r.held <= MAX_TOTAL_BYTES, `held ${r.held}`);
  assert.ok(r.maxHeld <= MAX_TOTAL_BYTES, `maxHeld ${r.maxHeld}`);
  assert.equal(r.over, true);
  assert.equal(r.buf, null, 'the buffer is dropped once over the cap');
  assert.ok(peak < MAX_TOTAL_BYTES + 16 * 1024 * 1024, `arrayBuffers grew ${peak}`);
  // a within-cap input comes back whole
  const small = await readBounded((async function* () { yield Buffer.from('ab'); yield 'cd'; })(), MAX_TOTAL_BYTES);
  assert.equal(small.over, false);
  assert.equal(small.buf.toString(), 'abcd');
  assert.equal(small.size, 4);
});

test('B14.9-14: an input of exactly MAX_TOTAL_BYTES goes through record() (the gate decides), not _recordDigest', async () => {
  const s = stubDeps();
  const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir: makeTmpDir('mp-rec-cap-') } } });
  const bytes = Buffer.alloc(MAX_TOTAL_BYTES, 0x64);
  const r = await w.run(['record', '--direction', 'in', '--json'], { input: chunks(bytes), deps: s.deps });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.calls.record.length, 1);
  assert.equal(s.calls.digest.length, 0);
  assert.equal(s.calls.record[0].raw.length, MAX_TOTAL_BYTES);
});

test('B14.9-15: over the cap, _recordDigest gets { raw_sha256, size } and { direction, source }; the envelope is not passed', async () => {
  const s = stubDeps();
  const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir: makeTmpDir('mp-rec-cap-') } } });
  const bytes = Buffer.alloc(MAX_TOTAL_BYTES + 1, 0x65);
  const r = await w.run(['record', '--direction', 'out', '--client-ip', '192.0.2.1', '--sender', 'a@b.example', '--source', 'pipe:postfix', '--json'], { input: chunks(bytes), deps: s.deps });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.calls.record.length, 0);
  assert.equal(s.calls.digest.length, 1);
  assert.deepEqual(s.calls.digest[0].d, { raw_sha256: `sha256:${sha(bytes)}`, size: bytes.length });
  assert.deepEqual(s.calls.digest[0].ctx, { direction: 'out', source: 'pipe:postfix' });
  assert.equal(s.calls.sweep, 1, 'the sweep runs for an over-cap record too');
});

// ---- config ----

const cfg = (account) => validateConfig({ v: 1, accounts: { me: account } }, { HOME: '/home/x' });

test('B14.9-16: a pipe-only account validates; user is optional there; IMAP-only keys are refused; an IMAP account still needs user and one secret', () => {
  assert.equal(typeof configModule.isPipeOnly, 'function', 'isPipeOnly is exported by config.js');
  const ok = cfg({ user: 'me@example.com', trailDir: '/var/lib/mp', trail: 'default' });
  assert.deepEqual(ok.problems, []);
  assert.equal(configModule.isPipeOnly(ok.config.accounts.me), true);
  const noUser = cfg({ trailDir: '/var/lib/mp' });
  assert.deepEqual(noUser.problems, []);
  assert.equal(configModule.isPipeOnly(noUser.config.accounts.me), true);
  // lenient rule (owner, 2026-11-22): no host plus any IMAP-only key is an IMAP account on imap.gmail.com, as in 4.0.0; nothing 4.0.0 accepted is refused
  const imapKeys = { port: 993, folders: ['INBOX'], sent: true, passCommand: 'echo x', passFile: '/x', accessTokenCommand: 'y' };
  for (const [k, v] of Object.entries(imapKeys)) {
    const extra = k === 'passCommand' || k === 'passFile' || k === 'accessTokenCommand' ? {} : { passCommand: 'echo x' };
    const r = cfg({ user: 'me@example.com', trailDir: '/var/lib/mp', ...extra, [k]: v });
    assert.deepEqual(r.problems, [], `${k}: ${r.problems.join(' | ')}`);
    assert.equal(configModule.isPipeOnly(r.config.accounts.me), false, k);
    assert.equal(r.config.accounts.me.host, 'imap.gmail.com', k);
  }
  const fileOnly = cfg({ user: 'me@example.com', trailDir: '/var/lib/mp', passFile: '/x' });
  assert.equal(fileOnly.config.accounts.me.port, 993);
  assert.deepEqual(fileOnly.config.accounts.me.secret, { passFile: '/x' });
  // an IMAP account: host present
  const imap = cfg({ host: 'imap.example.com', trailDir: '/var/lib/mp', passCommand: 'echo x', user: 'me@example.com' });
  assert.deepEqual(imap.problems, []);
  assert.equal(configModule.isPipeOnly(imap.config.accounts.me), false);
  assert.ok(cfg({ host: 'imap.example.com', trailDir: '/var/lib/mp', passCommand: 'echo x' }).problems.some((p) => /user: required/.test(p)));
  assert.ok(cfg({ host: 'imap.example.com', user: 'a@b.example', trailDir: '/var/lib/mp' }).problems.some((p) => /exactly one of/.test(p)));
  // no host and no user is still a pipe-only account, but a plaintext password key is refused as ever
  assert.ok(cfg({ trailDir: '/var/lib/mp', password: 'x' }).problems.length > 0);
});

test('B14.9-17: sync, watch, the MCP sync tool refuse a pipe-only account; status shows pipe-only; list and stamp work on it', async () => {
  const ots = fakeOts();
  const p = pipeWorld({ ots: ots.bin });
  const line = 'me has no IMAP server (a pipe-only account): mail arrives through mailproof record';
  for (const argv of [['sync'], ['watch']]) {
    const r = await p.w.run(argv, { deps: { sync: async () => { throw new Error('IMAP must not be reached'); } } });
    assert.equal(r.code, 64, `${argv[0]}: ${r.stderr}`);
    assert.ok(r.stderr.includes(line), `${argv[0]}: ${r.stderr}`);
  }
  const m = await inProcess(p.w, { deps: { sync: async () => { throw new Error('IMAP must not be reached'); }, makeMailproof: () => p.mk() } });
  const mc = await m.call('sync', { account: 'me' });
  assert.equal(mc.isError, true);
  assert.equal(mc.error.code, 'ERR_BAD_ARGUMENT');
  assert.ok(String(mc.error.message).includes(line), JSON.stringify(mc.error));
  await m.close();
  const rec = await p.rec(['--direction', 'in'], { input: mail(17) });
  assert.equal(rec.code, 0, rec.stderr);
  const st = await p.w.run(['status']);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /pipe-only/);
  const ls = await p.w.run(['list']);
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout, /m17|sender\.invalid/);
  const stamp = await p.w.run(['stamp']);
  assert.equal(stamp.code, 0, stamp.stderr);
  // the config screen and the validator do not trip on it either
  assert.equal((await p.w.run(['config', 'validate'])).code, 0);
});

test('4.0.0 compat: a hostless account with passCommand validates and is a Gmail IMAP account on port 993', () => {
  const r = validateConfig({ v: 1, accounts: { personal: { user: 'a@b.example', trailDir: '/t/one', passCommand: 'pass show x' } } }, { HOME: '/home/x' });
  assert.deepEqual(r.problems, []);
  const a = r.config.accounts.personal;
  assert.equal(a.host, 'imap.gmail.com');
  assert.equal(a.port, 993);
  assert.equal(configModule.isPipeOnly(a), false);
});

test('B14.9-17b: the wizard login test is refused for a pipe-only account (one definition)', async () => {
  const { requireImap } = await import('../../src/cli/sync-op.js');
  const p = pipeWorld();
  const cfg2 = validateConfig({ v: 1, accounts: { me: { trailDir: '/var/lib/mp' } } }, {});
  assert.throws(() => requireImap(cfg2.config.accounts.me), { message: 'me has no IMAP server (a pipe-only account): mail arrives through mailproof record' });
  assert.ok(p);
});

// ---- sweep and lock ----

test('B14.9-18: the content sweep runs after record when due, not when the marker is fresh; a throwing sweep leaves exit 0 and one stderr line', async () => {
  const clock = { t: Date.parse('2026-11-10T08:00:00Z') };
  const now = () => new Date(clock.t);
  const trailDir = makeTmpDir('mp-rec-sweep-');
  const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir } } });
  let swept = 0;
  const mk = () => {
    const mp = new Mailproof({ trailDir, worker: { size: 0 }, resolver, otsBin: null, now, lockTimeoutMs: 5000 });
    const real = mp.expireContent.bind(mp);
    mp.expireContent = async () => { swept++; return real(); };
    return mp;
  };
  const deps = { makeMailproof: mk };
  const go = (n) => w.run(['record', '--direction', 'in', '--json'], { input: mail(n), deps });
  assert.equal((await go(1)).code, 0);
  assert.equal(swept, 1, 'no marker: the sweep ran');
  assert.equal((await go(2)).code, 0);
  assert.equal(swept, 1, 'a fresh marker: no sweep');
  clock.t += 8 * 86_400_000;
  assert.equal((await go(3)).code, 0);
  assert.equal(swept, 2, 'sweepDays (7) old: the sweep ran again');
  // a sweep that throws: exit 0, one stderr line, and the record was committed before it ran
  const t2 = makeTmpDir('mp-rec-sweep2-');
  const w2 = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir: t2 } } });
  let seen = null;
  const mp2 = new Mailproof({ trailDir: t2, worker: { size: 0 }, resolver, otsBin: null, lockTimeoutMs: 5000 });
  mp2._autoSweep = async () => { seen = (await new Mailproof({ trailDir: t2, otsBin: null }).list()).length; throw new Error('disk on fire'); };
  const r = await w2.run(['record', '--direction', 'in'], { input: mail(9), deps: { makeMailproof: () => mp2 } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen, 1, 'the record was in the trail when the sweep ran');
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /content sweep failed: disk on fire/);
  assert.match(r.stdout, /^recorded /);
});

test('B14.9-19: ERR_TRAIL_LOCKED is exit 75 while another process holds the trail lock; nothing is written', async () => {
  const trailDir = makeTmpDir('mp-rec-lock-');
  const root = path.join(trailDir, 'default');
  const trailJs = new URL('../../src/proof/trail.js', import.meta.url).href;
  const script = `import { withTrailLock, trailLockFile } from ${JSON.stringify(trailJs)};
await withTrailLock(${JSON.stringify(root)}, trailLockFile('default'), 1000, async () => { process.stdout.write('held\\n'); await new Promise((r) => { process.stdin.on('end', r); process.stdin.resume(); }); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('lock holder did not start')), 10000); child.stdout.once('data', () => { clearTimeout(to); res(); }); child.on('error', rej); });
    assert.equal(fs.existsSync(path.join(trailDir, trailLockFile('default'))), true, 'the other process holds the lock file');
    const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir } } });
    const mp = new Mailproof({ trailDir, worker: { size: 0 }, resolver, otsBin: null, lockTimeoutMs: 300 });
    const r = await w.run(['record', '--direction', 'in'], { input: mail(), deps: { makeMailproof: () => mp } });
    assert.equal(r.code, 75, r.stderr);
    assert.equal(recordFiles(root).length, 0, 'nothing written');
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  }
});

test('B14.9-20: a stamp job paused after its snapshot (holding the stamp lock) does not block record', async () => {
  const ots = fakeOts();
  const bw = bundleWorld({ otsBin: ots.bin });
  await bw.rec({ tag: 'first' });
  const w = makeWorld({ accounts: { me: { user: 'me@owner.invalid', trailDir: bw.trailDir } } });
  let during = null;
  let took = null;
  bw.mp._stampHooks.afterSnapshot = async () => {
    const t0 = Date.now();
    during = await w.run(['record', '--direction', 'in', '--json'], { input: mail(20), deps: { makeMailproof: () => bw.mk({ resolver }) } });
    took = Date.now() - t0;
  };
  const res = await bw.mp.stamp();
  bw.mp._stampHooks.afterSnapshot = undefined;
  assert.ok(during, 'the hook ran');
  assert.equal(during.code, 0, during.stderr);
  assert.equal(JSON.parse(during.stdout).duplicate, false);
  assert.ok(took < 5000, `record waited ${took} ms`);
  assert.equal(res.error, undefined);
});

test('B14.8: the command builds the library in-process (worker size 0) and keeps `record` out of the primitives and the MCP tool table', async () => {
  const { recordOptions } = await import('../../src/cli/record.js');
  const o = recordOptions(/** @type {any} */ ({ trailDir: '/x', trail: 'default', otsBin: null, stamp: {}, content: {} }));
  assert.deepEqual(o.worker, { size: 0 });
  const prim = JSON.parse(fs.readFileSync(new URL('../../primitives.json', import.meta.url), 'utf8'));
  assert.equal(JSON.stringify(prim).includes('mailproof record'), false);
  const idx = await import('../../src/index.js');
  assert.equal('record' in idx, false);
  assert.ok(os.tmpdir());
});
