// F39 build: the index work is visible and bounded. The library reports index progress (`status({ refresh: true, onProgress })`), a bounded
// refresh (`refresh: 'bounded'`, the MCP tool) never builds a cold index, the CLI `status` says what it is doing on a terminal, and
// `sync` brings the index up to date at its end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { INDEX_QUIET_RECORDS, INDEX_BOUNDED_RECORDS } from '../../src/proof/limits.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const extra = (n) => Buffer.from(`From: Y <y@y.example>\r\nTo: me@owner.example\r\nMessage-ID: <y${n}@y.example>\r\n\r\nhi\r\n`);
const idxOf = (T) => path.join(T.dir, '.default.index.sqlite');
const dropIndex = (T) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(idxOf(T) + s, { force: true }); };

/** One commit that adds `n` junk record files (the index reads them as unreadable records: counted as changed, never rows). */
function junkCommit(T, n) {
  const root = path.join(T.dir, 'default');
  for (let i = 0; i < n; i++) {
    const id = (0x10000000 + i).toString(16).padStart(32, '0');
    fs.mkdirSync(path.join(root, 'records', id.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(root, 'records', id.slice(0, 2), `${id}.json`), '{');
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `junk ${n}`);
}

test('library: status({ refresh: true, onProgress }) on an absent index reports a rebuild from 0 to the record count; a current index reports nothing', async () => {
  const T = await buildThread();
  const ev = [];
  const s = await T.mp.status({ refresh: true, onProgress: (e) => ev.push({ ...e }) });
  assert.equal(s.index, 'present');
  assert.ok(ev.length >= 2, 'a start and a done event');
  assert.deepEqual(ev[0], { phase: 'rebuild', done: 0, total: 6 });
  assert.deepEqual(ev[ev.length - 1], { phase: 'rebuild', done: 6, total: 6 });
  const again = [];
  await T.mp.status({ refresh: true, onProgress: (e) => again.push(e) });
  assert.deepEqual(again, [], 'a current index: no work, no event');
});

test('library: a small catch-up is quiet, a catch-up over INDEX_QUIET_RECORDS reports; a throwing onProgress never fails the call', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(1), 'in', 10);
  const quiet = [];
  await T.mp.status({ refresh: true, onProgress: (e) => quiet.push(e) });
  assert.deepEqual(quiet, [], 'one new record: quiet');
  junkCommit(T, INDEX_QUIET_RECORDS + 20);
  const ev = [];
  const s = await T.mp.status({ refresh: true, onProgress: (e) => { ev.push({ ...e }); throw new Error('boom'); } });
  assert.equal(s.index, 'present');
  assert.deepEqual(ev[0], { phase: 'catch-up', done: 0, total: INDEX_QUIET_RECORDS + 20 });
  assert.equal(ev[ev.length - 1].done, INDEX_QUIET_RECORDS + 20);
});

test('library: refresh "bounded" never builds a cold index: read-only answer, index absent, a hint, no file', async () => {
  const T = await buildThread();
  const s = await T.mp.status({ refresh: 'bounded' });
  assert.equal(s.index, 'absent');
  assert.equal(s.records.totalSource, 'git');
  assert.equal(s.records.in, null);
  assert.match(s.hint, /sync/);
  assert.match(s.hint, /mailproof status/);
  assert.equal(fs.existsSync(idxOf(T)), false, 'nothing was built');
});

test('library: refresh "bounded" does the cheap catch-up within the budget, and skips it over the budget with index "stale" and a hint', async () => {
  const T = await buildThread();
  await T.mp.list();
  await T.rec('extra', extra(2), 'in', 10);
  const near = await T.mp.status({ refresh: 'bounded' });
  assert.equal(near.index, 'present', 'one commit behind: caught up');
  assert.equal(near.records.total, 7);
  assert.equal(near.hint, undefined);
  junkCommit(T, INDEX_BOUNDED_RECORDS + 5);
  const far = await T.mp.status({ refresh: 'bounded' });
  assert.equal(far.index, 'stale');
  assert.equal(far.records.in, null);
  assert.match(far.hint, /sync/);
  const full = await T.mp.status({ refresh: true });
  assert.equal(full.index, 'present', 'the full refresh still catches it up');
  assert.equal(full.hint, undefined);
});

test('library: refresh "bounded" on an index of an old schema is not rebuilt either', async () => {
  const T = await buildThread();
  await T.mp.list();
  const Database = (await import('better-sqlite3')).default;
  const d = new Database(idxOf(T)); d.prepare("UPDATE meta SET v = '5' WHERE k = 'schema'").run(); d.close();
  const s = await T.mp.status({ refresh: 'bounded' });
  assert.equal(s.index, 'stale');
  assert.match(s.hint, /sync/);
  assert.equal((await T.mp.status({ refresh: true })).index, 'present');
});

test('library: bad refresh values and a non-function onProgress throw a TypeError', async () => {
  const T = await buildThread();
  await assert.rejects(T.mp.status({ refresh: 'yes' }), TypeError);
  await assert.rejects(T.mp.status({ refresh: true, onProgress: 'x' }), TypeError);
});

test('CLI status on a terminal says what it is doing on stderr (start line, progress line), stdout unchanged', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  const r = await w.run(['status'], { stderrTty: true, env: { TERM: 'xterm' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /updating the trail index \(first time, or after an upgrade\)/);
  assert.match(r.stderr, /trail index 6 of 6 records/);
  assert.match(r.stderr, /\r\x1b\[K$/, 'the progress line is cleared at the end');
  assert.doesNotMatch(r.stdout, /updating|trail index \d/);
  assert.match(r.stdout, /^ {2}index +present$/m);
  const again = await w.run(['status'], { stderrTty: true, env: { TERM: 'xterm' } });
  assert.equal(again.stderr, '', 'a current index: nothing on stderr');
});

test('CLI status: no terminal, no progress; --json keeps stdout clean even on a terminal', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  const piped = await w.run(['status']);
  assert.equal(piped.stderr, '');
  dropIndex(T);
  const j = await w.run(['status', '--json'], { stderrTty: true, env: { TERM: 'xterm' } });
  assert.equal(JSON.parse(j.stdout).test.index, 'present', 'stdout is the JSON only');
  assert.match(j.stderr, /updating the trail index/);
});

test('CLI sync updates the index at its end, after the folder lines, and a failing update never fails the sync', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  assert.equal(fs.existsSync(idxOf(T)), false);
  const sync = async () => ({ folders: [{ folder: 'INBOX', direction: 'in', seen: 1, recorded: 1, duplicate: 0, over_limit: 0, complete: true, attempted: true }], complete: true, stamp: null });
  const r = await w.run(['sync'], { stderrTty: true, env: { TERM: 'xterm' }, deps: { sync } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(idxOf(T)), true, 'sync built the index');
  assert.match(r.stderr, /updating the trail index/);
  assert.equal((await T.mp.status()).index, 'present');
  // a current trail, one new record, an ordinary sync: the cheap catch-up, quiet
  await T.rec('extra', extra(3), 'in', 10);
  assert.equal((await T.mp.status()).index, 'stale');
  const r2 = await w.run(['sync'], { stderrTty: true, env: { TERM: 'xterm' }, deps: { sync } });
  assert.equal(r2.code, 0);
  assert.doesNotMatch(r2.stderr, /trail index/, 'a small catch-up says nothing');
  assert.equal((await T.mp.status()).index, 'present', 'the new record is already in the index');
  // a failing update (the library throws) is a warning at most, never the sync's exit code
  dropIndex(T);
  const w3 = makeWorld({ accounts: { test: account(T.dir) } });
  const broken = () => new Proxy(T.mp, { get: (t, k) => (k === 'status' ? async () => { throw new Error('index broke'); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const r3 = await w3.run(['sync'], { deps: { sync, makeMailproof: broken } });
  assert.equal(r3.code, 0);
});
