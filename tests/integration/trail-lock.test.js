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
