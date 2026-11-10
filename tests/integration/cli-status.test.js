// `mailproof status` is truly read-only (SPEC B11.5, B11.14): it never builds, creates or catches up the trail index and
// never takes the trail lock. With a current index the counts come from one aggregate query; otherwise from git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmpDir } from '../helpers/tmp.js';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const statusOf = async (dir) => {
  const r = await makeWorld({ accounts: { test: account(dir) } }).spawn(['status', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).test;
};
const extra = (n) => Buffer.from(`From: Y <y@y.example>\r\nTo: me@owner.example\r\nMessage-ID: <y${n}@y.example>\r\n\r\nhi\r\n`);

test('status: an absent index is reported and never created; counts come from git, in/out and dates are null', async () => {
  const T = await buildThread();
  const idx = path.join(T.dir, '.default.index.sqlite');
  assert.equal(fs.existsSync(idx), false, 'record() alone never creates it');
  const head = git(T.dir + '/default', 'rev-parse', 'HEAD');
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'absent');
  assert.deepEqual(s.records, { total: 6, totalSource: 'git', in: null, out: null, oldest: null, newest: null });
  assert.equal(fs.existsSync(idx), false, 'status did not create the index');
  assert.equal(git(T.dir + '/default', 'rev-parse', 'HEAD'), head);
  const text = await makeWorld({ accounts: { test: account(T.dir) } }).spawn(['status']);
  assert.match(text.stdout, /records +6 files at HEAD \(no index yet; run `mailproof list` for in\/out and dates\)/);
  assert.match(text.stdout, /index +absent/);
  await T.mp.list();
  assert.equal(fs.existsSync(idx), true, 'list() builds it');
  fs.rmSync(idx);
  assert.equal((await statusOf(T.dir)).index, 'absent', 'a deleted index file reads absent again');
  assert.equal(fs.existsSync(idx), false);
});

test('status: a stale index stays untouched, counts come from git', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(1), 'in', 10);
  const idx = path.join(T.dir, '.default.index.sqlite');
  const before = fs.statSync(idx);
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'stale');
  assert.deepEqual(s.records, { total: 7, totalSource: 'git', in: null, out: null, oldest: null, newest: null });
  const after = fs.statSync(idx);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  await T.mp.list();
  assert.equal((await statusOf(T.dir)).index, 'present', 'a read brought it up to date');
});

test('status: a current index answers the counts and dates, equal to list()', async () => {
  const T = await buildThread();
  const rows = await T.mp.list();
  const times = rows.map((r) => r.captured).sort();
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'present');
  assert.deepEqual(s.records, { total: rows.length, totalSource: 'index', in: rows.filter((r) => r.direction === 'in').length, out: rows.filter((r) => r.direction === 'out').length, oldest: times[0], newest: times[times.length - 1] });
  assert.deepEqual([s.records.in, s.records.out], [5, 1]);
});

test('status: succeeds at once while another process holds the trail lock (no wait, no lock file change)', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(2), 'in', 10); // stale: a list() would now need the lock
  const lock = path.join(T.dir, '.default.lock');
  const held = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
  fs.writeFileSync(lock, held);
  const t0 = Date.now();
  const s = await statusOf(T.dir);
  assert.ok(Date.now() - t0 < 20000, 'did not wait for the lock');
  assert.equal(s.index, 'stale');
  assert.equal(s.records.total, 7);
  assert.equal(fs.readFileSync(lock, 'utf8'), held, 'the lock file is untouched');
});

test('status --json: an empty trail has records null and index absent', async () => {
  const s = await statusOf(makeTmpDir('mp-cli-st-'));
  assert.equal(s.records, null);
  assert.equal(s.index, 'absent');
});

const listing = (dir) => fs.readdirSync(dir).sort();

test('status: a present index leaves the trail unchanged and adds at most -wal/-shm files', async () => {
  const T = await buildThread();
  await T.mp.list();
  const trail = T.dir + '/default';
  const head = git(trail, 'rev-parse', 'HEAD');
  const before = listing(T.dir);
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'present');
  assert.equal(s.records.totalSource, 'index');
  assert.equal(git(trail, 'rev-parse', 'HEAD'), head);
  assert.equal(git(trail, 'status', '--porcelain'), '');
  const added = listing(T.dir).filter((f) => !before.includes(f));
  assert.deepEqual(added.filter((f) => !/\.sqlite-(wal|shm)$/.test(f)), [], 'only SQLite side files may appear');
});

test('status: a committed unreadable record counts from git (N+1) until the index is built (N)', async () => {
  const T = await buildThread();
  await T.mp.list();
  const trail = T.dir + '/default';
  fs.mkdirSync(path.join(trail, 'records', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(trail, 'records', 'ab', 'ab000000000000000000000000000000.json'), '{not json');
  git(trail, 'add', '-A');
  git(trail, '-c', 'user.name=t', '-c', 'user.email=t@t.example', 'commit', '-q', '-m', 'corrupt');
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'stale');
  assert.equal(s.records.total, 7);
  assert.equal(s.records.totalSource, 'git');
  const text = await makeWorld({ accounts: { test: account(T.dir) } }).spawn(['status']);
  assert.match(text.stdout, /records +7 files at HEAD \(index stale; run `mailproof list` for in\/out and dates\)/);
  await T.mp.list();
  const f = await statusOf(T.dir);
  assert.equal(f.index, 'present');
  assert.equal(f.records.total, 6);
  assert.equal(f.records.totalSource, 'index');
});

test('status: a fresh index in a read-only trailDir is unreadable, counted from git, exit 0, nothing created', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores directory permissions');
  const T = await buildThread();
  await T.mp.list();
  await T.mp.close();
  for (const f of listing(T.dir)) assert.ok(!/-(wal|shm)$/.test(f), 'clean close leaves no side files');
  const before = listing(T.dir);
  fs.chmodSync(T.dir, 0o555);
  try {
    const s = await statusOf(T.dir); // asserts exit code 0
    assert.equal(s.index, 'unreadable');
    assert.equal(s.records.total, 6);
    assert.equal(s.records.totalSource, 'git');
    assert.equal(s.records.in, null);
    const text = await makeWorld({ accounts: { test: account(T.dir) } }).spawn(['status']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /index +unreadable/);
    assert.match(text.stdout, /check permissions on the trail directory/);
    assert.deepEqual(listing(T.dir), before, 'no file created');
  } finally { fs.chmodSync(T.dir, 0o755); }
});

test('status: a garbage index file is unreadable, counted from git', async () => {
  const T = await buildThread();
  fs.writeFileSync(path.join(T.dir, '.default.index.sqlite'), 'this is not a sqlite database, '.repeat(50));
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'unreadable');
  assert.equal(s.records.total, 6);
  assert.equal(s.records.totalSource, 'git');
  await T.mp.list();
  assert.equal((await statusOf(T.dir)).index, 'present', 'list rebuilds a corrupt index in a writable directory');
});
