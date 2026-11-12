// The user-facing paths (SPEC B11.2a): everything mailproof writes for the person goes under ~/mailproof/<kind>/, absolute under $HOME,
// created 0700 on first use; every path shown uses ~/; `~` and `~/x` expand in every path argument and prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tilde, userDir, ensureUserDir, expandHome } from '../../src/cli/paths.js';
import { defaultBundleOut } from '../../src/cli/bundle.js';
import { defaultBundlePath } from '../../src/cli/backup.js';
import { makeTmpDir } from '../helpers/tmp.js';

const NOW = new Date('2026-11-12T13:02:48Z');

test('tilde: the home directory is shown as ~, nothing else changes', () => {
  const env = { HOME: '/home/ana' };
  assert.equal(tilde('/home/ana/mailproof/exports/x', env), '~/mailproof/exports/x');
  assert.equal(tilde('/home/ana', env), '~');
  assert.equal(tilde('/home/anabel/x', env), '/home/anabel/x', 'a sibling prefix is not home');
  assert.equal(tilde('/srv/x', env), '/srv/x');
  assert.equal(tilde('relative/x', env), 'relative/x');
});

test('expandHome is the one helper: ~ and ~/x expand, anything else is as given', () => {
  const env = { HOME: '/home/ana' };
  assert.equal(expandHome('~', env), '/home/ana');
  assert.equal(expandHome('~/b/c', env), '/home/ana/b/c');
  assert.equal(expandHome('~bob/x', env), '~bob/x');
  assert.equal(expandHome('/abs', env), '/abs');
});

test('the default export and backup paths are absolute under $HOME/mailproof/<kind>/, never relative to the cwd', () => {
  const env = { HOME: '/home/ana' };
  assert.equal(userDir(env, 'exports'), '/home/ana/mailproof/exports');
  assert.equal(defaultBundleOut('work', NOW, false, env), '/home/ana/mailproof/exports/mailproof-bundle-work-20261112-130248');
  assert.equal(defaultBundleOut('work', NOW, true, env), '/home/ana/mailproof/exports/mailproof-bundle-work-20261112-130248.tar');
  assert.equal(defaultBundlePath(env, 'work', NOW), '/home/ana/mailproof/backups/work-20261112T130248Z.bundle');
});

test('ensureUserDir creates ~/mailproof/<kind> with mode 0700, and leaves an existing ~/mailproof alone', async () => {
  const home = makeTmpDir('mp-paths-home-');
  const d = await ensureUserDir({ HOME: home }, 'saved');
  assert.equal(d, path.join(home, 'mailproof', 'saved'));
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  const home2 = makeTmpDir('mp-paths-home2-');
  fs.mkdirSync(path.join(home2, 'mailproof'), { mode: 0o755 });
  fs.chmodSync(path.join(home2, 'mailproof'), 0o755);
  await ensureUserDir({ HOME: home2 }, 'exports');
  assert.equal(fs.statSync(path.join(home2, 'mailproof')).mode & 0o777, 0o755, 'the owner\'s own folder keeps its mode');
  assert.equal(fs.statSync(path.join(home2, 'mailproof', 'exports')).mode & 0o777, 0o700);
});
