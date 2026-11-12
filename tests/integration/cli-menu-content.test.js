// What each menu screen says (SPEC B11.4c, Part B of the 2026-11-12 walkthrough): plain words, browse rows, previews before anything is written.
// In-process on scripted stdin; IMAP and DNS are never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const T = await buildThread();
const world = () => makeWorld({ accounts: { test: account(T.dir) } });
const keys = (...l) => `${l.join('\n')}\n`;
const menu = (w, input, opts = {}) => w.run([], { interactive: true, input, ...opts });

test('B1 sync: choosing 1 just syncs the account\'s folders (no Folders/Sent questions); the overrides stay on the subcommand', async () => {
  const w = world();
  const seen = [];
  const deps = { sync: async (mp, opts) => { seen.push(opts); return { complete: true, folders: [] }; } };
  const r = await menu(w, keys('1', 'q'), { deps });
  assert.equal(seen.length, 1);
  assert.ok(!/Folders \(|Sent \(/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /^complete$/m);
  await w.run(['sync', '--folders', 'A', '--sent', 'off'], { deps });
  assert.deepEqual([seen[1].folders, seen[1].sent], [['A'], false]);
});

test('B13 the add-account wizard backs out on an empty answer or q, never "a value is needed"; B14 paths in errors show as ~/', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { interactive: true, input: keys('', 'q') });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('a value is needed'));
  assert.match(r.stdout, /Account name \(.*empty = back/);
  assert.match(r.stdout, /nothing written/);
  assert.ok(!fs.existsSync(w.configFile));
  const x = await w.run(['config', 'add-account'], { interactive: true, input: keys('', 'my-acct', 'q') });
  assert.match(x.stdout, /Email address \(.*empty = back/);
  const w2 = world();
  const e = await w2.run(['check', 'aaaaaaaa', '--profile', '~/nope.json']);
  assert.equal(e.code, 64);
  assert.ok(e.stderr.includes('cannot read ~/nope.json'), e.stderr);
  assert.ok(!e.stderr.includes(w2.home), 'the home path is never printed');
});
