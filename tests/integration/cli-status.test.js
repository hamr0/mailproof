// `mailproof status` (SPEC B11.5, B11.14) brings the trail index up to date itself (an incremental catch-up under a short lock wait), so it
// shows the real in/out, verified and date counts; where it cannot (the index is unreadable, the SQLite add-on is missing, the lock is
// held) the read-only overview answers from git and the hint says why. It never opens IMAP and never changes the trail.
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

test('status: an absent index is built by status itself; the counts are the index\'s (in/out, dates), the trail is untouched', async () => {
  const T = await buildThread();
  const idx = path.join(T.dir, '.default.index.sqlite');
  assert.equal(fs.existsSync(idx), false, 'record() alone never creates it');
  const head = git(T.dir + '/default', 'rev-parse', 'HEAD');
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'present');
  assert.deepEqual([s.records.total, s.records.totalSource, s.records.in, s.records.out], [6, 'index', 5, 1]);
  assert.match(s.records.oldest, /^2026-/);
  assert.equal(fs.existsSync(idx), true, 'status brought the index up to date');
  assert.equal(git(T.dir + '/default', 'rev-parse', 'HEAD'), head, 'the trail itself is untouched');
  assert.equal(Object.hasOwn(s.records, 'verified'), false, '--json keeps its shape');
  fs.rmSync(idx);
  fs.rmSync(idx + '-wal', { force: true });
  fs.rmSync(idx + '-shm', { force: true });
  const text = await makeWorld({ accounts: { test: account(T.dir) } }).spawn(['status']);
  assert.match(text.stdout, /^ {2}records +6 \(5 in, 1 out\) [·-] 3 verified, 2 unverified [·-] 2026-\d\d-\d\d to 2026-\d\d-\d\d$/m, 'the text has the verified counts and the span');
  assert.match(text.stdout, /^test [·-] me@owner\.example$/m, 'the account line');
  assert.match(text.stdout, /^ {2}index +present$/m);
});

test('status: a stale index is caught up (the new record counts, in/out and dates known)', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(1), 'in', 10);
  const idx = path.join(T.dir, '.default.index.sqlite');
  assert.ok(fs.existsSync(idx));
  const s = await statusOf(T.dir);
  assert.equal(s.index, 'present');
  assert.deepEqual([s.records.total, s.records.totalSource, s.records.in, s.records.out], [7, 'index', 6, 1]);
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

test('status: succeeds at once while another process holds the trail lock (a short wait, then the overview from git, no lock file change)', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(2), 'in', 10); // stale: a list() would now need the lock
  const lock = path.join(T.dir, '.default.lock');
  const held = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
  fs.writeFileSync(lock, held);
  const t0 = Date.now();
  const s = await statusOf(T.dir);
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the lock');
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

test('status: a committed unreadable record: the catch-up builds the index without it (N), where the git count would be N+1', async () => {
  const T = await buildThread();
  await T.mp.list();
  const trail = T.dir + '/default';
  fs.mkdirSync(path.join(trail, 'records', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(trail, 'records', 'ab', 'ab000000000000000000000000000000.json'), '{not json');
  git(trail, 'add', '-A');
  git(trail, '-c', 'user.name=t', '-c', 'user.email=t@t.example', 'commit', '-q', '-m', 'corrupt');
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
  assert.equal(s.index, 'present', 'a corrupt index in a writable directory is rebuilt by the catch-up');
  assert.equal(s.records.total, 6);
  assert.equal(s.records.totalSource, 'index');
});

test('status: an index whose SQLite add-on cannot load is unknown, and the hint says so (not "run mailproof list")', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.mp.close();
  // a loader hook that makes `import('better-sqlite3')` fail in the spawned child only
  const hookDir = makeTmpDir('mp-cli-nosqlite-');
  fs.writeFileSync(path.join(hookDir, 'loader.mjs'), "export async function resolve(s, c, n) { if (s === 'better-sqlite3') throw new Error('add-on blocked by test'); return n(s, c); }\n");
  fs.writeFileSync(path.join(hookDir, 'hook.mjs'), "import { register } from 'node:module';\nregister('./loader.mjs', import.meta.url);\n");
  const env = { NODE_OPTIONS: `--import ${path.join(hookDir, 'hook.mjs')}` };
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  const j = await w.spawn(['status', '--json'], { env });
  assert.equal(j.code, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).test.index, 'unknown');
  const text = await w.spawn(['status'], { env });
  assert.match(text.stdout, /index +unknown/);
  assert.match(text.stdout, /better-sqlite3/);
  assert.match(text.stdout, /reinstall or rebuild/);
  assert.doesNotMatch(text.stdout, /index stale/);
});
