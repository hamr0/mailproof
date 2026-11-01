// Single writer per trail, proven with REAL separate processes (not just async
// tasks): the lock file serialises first-time `git init` and every commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Mailproof } from '../../src/proof/mailproof.js';
import { commitRecord } from '../../src/proof/trail.js';
import { signedMail } from '../helpers/proof.js';

const HELPER = fileURLToPath(new URL('../helpers/record-proc.js', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lock-'));
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Run the helper as a child process; resolves { code, out } with the parsed JSON line. */
function run(trailDir, mailFile, mapFile, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, trailDir, mailFile, mapFile, ...(timeout ? [String(timeout)] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve({ code, out: JSON.parse(out.trim().split('\n').pop()) }); }
      catch { reject(new Error(`helper gave no JSON (code ${code}): ${out} ${err}`)); }
    });
  });
}

/** Write N distinct signed mails + a merged DNS map into a scratch dir. */
async function fixtures(n) {
  const dir = tmp();
  const map = {};
  const files = [];
  for (let i = 0; i < n; i++) {
    const m = await signedMail({ body: `message ${i}\r\n`, domain: `d${i}.example` });
    Object.assign(map, m.map);
    const f = path.join(dir, `m${i}.eml`);
    fs.writeFileSync(f, m.raw);
    files.push(f);
  }
  const mapFile = path.join(dir, 'dns.json');
  fs.writeFileSync(mapFile, JSON.stringify(map));
  return { files, mapFile };
}

test('8 processes, distinct mails, fresh trail: 8 records, one trail-created commit, clean tree', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(8);
  const results = await Promise.all(files.map((f) => run(trailDir, f, mapFile)));
  for (const r of results) assert.equal(r.out.ok, true, JSON.stringify(r));
  const root = path.join(trailDir, 'default');
  const subjects = gitOut(root, 'log', '--format=%s').split('\n');
  assert.equal(subjects.filter((s) => s === 'trail created').length, 1);
  assert.equal(subjects.filter((s) => s.startsWith('record ')).length, 8);
  assert.equal(subjects.length, 9);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal((await new Mailproof({ trailDir }).list()).length, 8);
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false, 'lock released');
});

test('6 processes, identical bytes, fresh trail: 1 record, 5 duplicates, no errors', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const results = await Promise.all(Array.from({ length: 6 }, () => run(trailDir, files[0], mapFile)));
  for (const r of results) assert.equal(r.out.ok, true, JSON.stringify(r));
  assert.equal(results.filter((r) => r.out.duplicate === false).length, 1);
  assert.equal(results.filter((r) => r.out.duplicate === true).length, 5);
  const root = path.join(trailDir, 'default');
  assert.equal(gitOut(root, 'log', '--format=%s').split('\n').length, 2);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
});

test('a stale lock from a dead pid on this host is taken over', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise((r) => dead.on('close', r));
  fs.writeFileSync(path.join(trailDir, '.default.lock'), JSON.stringify({ pid, host: os.hostname(), started: new Date().toISOString() }));
  const r = await run(trailDir, files[0], mapFile, 10000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false);
});

test('a lock held by a live process times out with ERR_TRAIL_LOCKED and writes nothing', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const lock = path.join(trailDir, '.default.lock');
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
  fs.writeFileSync(lock, mine);
  const r = await run(trailDir, files[0], mapFile, 300);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.code, 'ERR_TRAIL_LOCKED');
  assert.equal(fs.existsSync(path.join(trailDir, 'default')), false, 'nothing written, not even the repo');
  assert.equal(fs.readFileSync(lock, 'utf8'), mine, 'live lock untouched');
});

test('a lock from another host is never taken over', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const lock = path.join(trailDir, '.default.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'some-other-host.invalid', started: new Date().toISOString() }));
  const r = await run(trailDir, files[0], mapFile, 300);
  assert.equal(r.out.code, 'ERR_TRAIL_LOCKED');
  assert.equal(fs.existsSync(lock), true);
});

test('an unparseable lock is stale only once older than lockTimeoutMs', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const lock = path.join(trailDir, '.default.lock');
  fs.writeFileSync(lock, 'garbage');
  const soon = new Date(Date.now() + 60000); // "young" regardless of how slow the child starts
  fs.utimesSync(lock, soon, soon);
  const fresh = await run(trailDir, files[0], mapFile, 300);
  assert.equal(fresh.out.code, 'ERR_TRAIL_LOCKED', 'young garbage lock is respected');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const r = await run(trailDir, files[0], mapFile, 5000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
});

test('a failed commit removes only this call\'s new files; tracked files are untouched', async () => {
  const trailDir = tmp();
  const m1 = await signedMail({ body: 'one\r\n' });
  const mp = new Mailproof({ trailDir, resolver: m1.resolver });
  await mp.record(m1.raw, { direction: 'in' });
  const root = path.join(trailDir, 'default');
  const trackedBefore = fs.readFileSync(path.join(root, 'trail.json'), 'utf8');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const id = 'ab'.repeat(16);
  await assert.rejects(() => commitRecord(root, 'default', {
    record: { v: 2, id },
    keyFiles: [{ rel: 'keys/x.example/s/0000.json', json: { v: 2 } }],
    message: 'doomed',
    now: () => new Date(),
    // a (buggy) afterWrite that claims an already-tracked file as its own
    afterWrite: async () => ['trail.json'],
  }), /git commit failed/);
  assert.equal(fs.readFileSync(path.join(root, 'trail.json'), 'utf8'), trackedBefore, 'tracked file survives');
  assert.equal(fs.existsSync(path.join(root, 'records', `${id}.json`)), false, 'new record removed');
  assert.equal(fs.existsSync(path.join(root, 'keys/x.example/s/0000.json')), false, 'new key file removed');
  assert.equal(fs.readdirSync(path.join(root, 'records')).length, 1, 'the earlier committed record is intact');
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false, 'lock released after failure');
});

// --- crash recovery: a writer killed mid-commit must not lose the mail ---

const waitFor = async (pred, ms = 10000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('SIGKILL mid-commit: retrying the same mail commits it, tree clean, dead lock taken over', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(2);
  assert.equal((await run(trailDir, files[0], mapFile)).out.ok, true);
  const root = path.join(trailDir, 'default');
  const marker = path.join(tmp(), 'in-commit');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nsleep 60\n`, { mode: 0o755 });
  // detached = own process group, so the sleeping hook dies with the writer
  const child = spawn(process.execPath, [HELPER, trailDir, files[1], mapFile], { stdio: 'ignore', detached: true });
  await waitFor(() => fs.existsSync(marker));
  process.kill(-child.pid, 'SIGKILL');
  await new Promise((r) => child.on('close', r));
  // the crash left what the reviewer saw: staged record + key, a dead lock, no new commit
  assert.notEqual(gitOut(root, 'status', '--porcelain'), '', 'crash left a dirty tree');
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), true, 'dead lock left behind');
  assert.equal(gitOut(root, 'log', '--format=%s').split('\n').length, 2);
  fs.rmSync(hook);
  const r = await run(trailDir, files[1], mapFile, 10000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
  assert.equal(r.out.duplicate, false, 'the half-written record does not count as recorded');
  const subjects = gitOut(root, 'log', '--format=%s').split('\n');
  assert.equal(subjects.length, 3);
  assert.ok(subjects[0].startsWith(`record ${r.out.id.slice(0, 12)}`));
  assert.ok(gitOut(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes(`records/${r.out.id}.json`));
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false);
  assert.equal((await run(trailDir, files[1], mapFile)).out.duplicate, true, 'now it really is a duplicate');
});

test('leftover record + key from a crashed writer (staged / untracked) are replaced and committed', async () => {
  const trailDir = tmp();
  const m1 = await signedMail({ body: 'one\r\n' });
  await new Mailproof({ trailDir, resolver: m1.resolver }).record(m1.raw, { direction: 'in' });
  const root = path.join(trailDir, 'default');
  const id = 'cd'.repeat(16);
  const keyRel = 'keys/leftover.example/s/0000.json';
  fs.mkdirSync(path.join(root, 'keys/leftover.example/s'), { recursive: true });
  fs.writeFileSync(path.join(root, `records/${id}.json`), 'stale\n');
  fs.writeFileSync(path.join(root, `records/${id}.json.ots`), 'stale\n');
  fs.writeFileSync(path.join(root, keyRel), 'stale\n');
  execFileSync('git', ['add', `records/${id}.json`], { cwd: root }); // staged, as after a kill between add and commit
  const res = await commitRecord(root, 'default', {
    record: { v: 2, id }, keyFiles: [{ rel: keyRel, json: { v: 2, k: 'new' } }], message: 'redo', now: () => new Date(),
  });
  assert.equal(res.duplicate, false);
  const committed = gitOut(root, 'show', '--name-only', '--format=', 'HEAD').split('\n');
  assert.ok(committed.includes(`records/${id}.json`) && committed.includes(keyRel), committed.join(','));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, keyRel), 'utf8')), { v: 2, k: 'new' });
  assert.equal(fs.existsSync(path.join(root, `records/${id}.json.ots`)), false, 'untracked leftover removed');
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  // a second call is a true duplicate and leaves the committed key untouched
  const again = await commitRecord(root, 'default', { record: { v: 2, id }, keyFiles: [], message: 'x', now: () => new Date() });
  assert.equal(again.duplicate, true);
});

test('crash during first trail creation: the next call finishes it', async () => {
  const states = {
    'init only, no commit': (root) => { fs.mkdirSync(root, { recursive: true }); execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root }); },
    'trail.json written, repo initialised, not committed': (root) => {
      fs.mkdirSync(path.join(root, 'records'), { recursive: true });
      fs.writeFileSync(path.join(root, 'trail.json'), '{"v":2,"name":"default","created":"x"}\n');
      execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
    },
    'trail.json written, no repo': (root) => {
      fs.mkdirSync(path.join(root, 'records'), { recursive: true });
      fs.writeFileSync(path.join(root, 'trail.json'), '{"v":2,"name":"default","created":"x"}\n');
    },
  };
  for (const [label, setup] of Object.entries(states)) {
    const root = path.join(tmp(), 'default');
    setup(root);
    const id = 'ef'.repeat(16);
    const res = await commitRecord(root, 'default', { record: { v: 2, id }, keyFiles: [], message: 'rec', now: () => new Date() });
    assert.equal(res.duplicate, false, label);
    assert.deepEqual(gitOut(root, 'log', '--format=%s').split('\n'), ['rec', 'trail created'], label);
    assert.ok(gitOut(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes('trail.json'), label);
    assert.equal(gitOut(root, 'status', '--porcelain'), '', label);
  }
});

// --- stale takeover goes through a break lock: exactly one taker, never a live lock ---

const deadPid = async () => {
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise((r) => dead.on('close', r));
  return pid;
};
const lockInfo = (pid) => JSON.stringify({ pid, host: os.hostname(), started: new Date().toISOString() });
const subjectsOf = (root) => gitOut(root, 'log', '--format=%s').split('\n');

test('12 processes race for a planted stale lock, 5 rounds: one commit per distinct mail, clean tree, no index.lock', async () => {
  const { files, mapFile } = await fixtures(6);
  const pid = await deadPid();
  for (let round = 0; round < 5; round++) {
    const trailDir = tmp();
    fs.writeFileSync(path.join(trailDir, '.default.lock'), lockInfo(pid));
    // 12 writers, each of 6 mails twice
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(trailDir, files[i % 6], mapFile, 20000)));
    for (const r of results) assert.equal(r.out.ok, true, `round ${round}: ${JSON.stringify(r)}`);
    assert.equal(results.filter((r) => r.out.duplicate === false).length, 6, `round ${round}`);
    const root = path.join(trailDir, 'default');
    const subjects = subjectsOf(root);
    assert.equal(subjects.filter((s) => s.startsWith('record ')).length, 6, `round ${round}`);
    assert.equal(subjects.filter((s) => s === 'trail created').length, 1, `round ${round}`);
    assert.equal(gitOut(root, 'status', '--porcelain'), '', `round ${round}`);
    assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false, `round ${round}: lock released`);
    assert.equal(fs.existsSync(path.join(trailDir, '.default.lock.break')), false, `round ${round}: break lock released`);
  }
});

test('a stale break lock (dead pid) is recovered', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const pid = await deadPid();
  fs.writeFileSync(path.join(trailDir, '.default.lock'), lockInfo(pid));
  fs.writeFileSync(path.join(trailDir, '.default.lock.break'), lockInfo(pid));
  const r = await run(trailDir, files[0], mapFile, 10000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock')), false);
  assert.equal(fs.existsSync(path.join(trailDir, '.default.lock.break')), false);
});

test('a live break lock: waiters leave the main lock alone and time out', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const pid = await deadPid();
  const main = path.join(trailDir, '.default.lock');
  const brk = path.join(trailDir, '.default.lock.break');
  // main lock stale, break lock held by a live process (this one): nobody may break in
  fs.writeFileSync(main, lockInfo(pid));
  fs.writeFileSync(brk, lockInfo(process.pid));
  const stale = fs.readFileSync(main, 'utf8');
  const r1 = await run(trailDir, files[0], mapFile, 500);
  assert.equal(r1.out.code, 'ERR_TRAIL_LOCKED');
  assert.equal(fs.readFileSync(main, 'utf8'), stale, 'main lock untouched');
  assert.equal(JSON.parse(fs.readFileSync(brk, 'utf8')).pid, process.pid, 'live break lock untouched');
  // main lock live too
  fs.writeFileSync(main, lockInfo(process.pid));
  const live = fs.readFileSync(main, 'utf8');
  const r2 = await run(trailDir, files[0], mapFile, 500);
  assert.equal(r2.out.code, 'ERR_TRAIL_LOCKED');
  assert.equal(fs.readFileSync(main, 'utf8'), live);
  assert.equal(fs.existsSync(path.join(trailDir, 'default')), false, 'nothing written');
  // once the break lock is released the stale main lock is taken over
  fs.rmSync(brk);
  fs.writeFileSync(main, lockInfo(pid));
  const r3 = await run(trailDir, files[0], mapFile, 10000);
  assert.equal(r3.out.ok, true, JSON.stringify(r3));
});

test('an unparseable break lock is stale only once old', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const pid = await deadPid();
  const main = path.join(trailDir, '.default.lock');
  const brk = path.join(trailDir, '.default.lock.break');
  fs.writeFileSync(main, lockInfo(pid));
  fs.writeFileSync(brk, 'garbage');
  const soon = new Date(Date.now() + 60000);
  fs.utimesSync(brk, soon, soon);
  const young = await run(trailDir, files[0], mapFile, 500);
  assert.equal(young.out.code, 'ERR_TRAIL_LOCKED', 'young garbage break lock is respected');
  assert.equal(fs.readFileSync(brk, 'utf8'), 'garbage');
  assert.equal(JSON.parse(fs.readFileSync(main, 'utf8')).pid, pid, 'main untouched');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(brk, old, old);
  const r = await run(trailDir, files[0], mapFile, 10000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
});

test('a break lock older than max(lockTimeoutMs, 10 s) is stale even if its pid is alive', async () => {
  const trailDir = tmp();
  const { files, mapFile } = await fixtures(1);
  const pid = await deadPid();
  fs.writeFileSync(path.join(trailDir, '.default.lock'), lockInfo(pid));
  const brk = path.join(trailDir, '.default.lock.break');
  fs.writeFileSync(brk, lockInfo(process.pid));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(brk, old, old);
  const r = await run(trailDir, files[0], mapFile, 10000);
  assert.equal(r.out.ok, true, JSON.stringify(r));
});
