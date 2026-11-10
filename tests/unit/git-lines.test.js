// gitLines (git.js): streamed git output with no size ceiling, git errors in git()'s shape, early stop, no leaked child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, gitLines } from '../../src/proof/git.js';
import { makeTmpDir } from '../helpers/tmp.js';

const LINES = 2_000_000; // "line-NNNNNNN\n" is 13 bytes: 26 MB, past the 16 MB `git()` buffer
let root;
function repo() {
  if (root) return root;
  root = makeTmpDir('mp-gitlines-');
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t.invalid');
  const chunks = [];
  for (let i = 0; i < LINES; i++) chunks.push(`line-${String(i).padStart(7, '0')}\n`);
  fs.writeFileSync(path.join(root, 'big.txt'), chunks.join(''));
  fs.writeFileSync(path.join(root, 'a b.txt'), 'x');
  fs.writeFileSync(path.join(root, 'é.txt'), 'y'); // a multi-byte name, split across chunks only by luck: covered by the decoder
  g('add', '.'); g('commit', '-qm', 'c');
  return root;
}
const noChild = () => assert.ok(!process.getActiveResourcesInfo().includes('ChildProcess'), 'no child process left');

test('gitLines streams output larger than the old 16 MB git() buffer, line by line and in order', async () => {
  const cwd = repo();
  await assert.rejects(git(cwd, ['show', 'HEAD:big.txt']), /git show failed/, 'git() cannot hold it');
  let n = 0, bad = 0;
  await gitLines(cwd, ['show', 'HEAD:big.txt'], (l) => { if (l !== `line-${String(n).padStart(7, '0')}`) bad++; n++; });
  assert.equal(n, LINES);
  assert.equal(bad, 0);
  noChild();
});

test('gitLines splits on a NUL separator and keeps multi-byte names whole; an async onLine is awaited in order', async () => {
  const cwd = repo();
  const seen = [];
  await gitLines(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], async (p) => { await new Promise((r) => setImmediate(r)); seen.push(p); }, { sep: '\0' });
  assert.deepEqual(seen, ['a b.txt', 'big.txt', 'é.txt']);
});

test('gitLines passes a final unterminated piece and handles empty output', async () => {
  const cwd = repo();
  const seen = [];
  await gitLines(cwd, ['show', 'HEAD:a b.txt'], (l) => seen.push(l));
  assert.deepEqual(seen, ['x']);
  await gitLines(cwd, ['ls-tree', 'HEAD', '--', 'nope'], () => assert.fail('no lines expected'));
});

test('gitLines rejects like git(): "git <subcommand> failed: <stderr>" with a cause', async () => {
  const cwd = repo();
  await assert.rejects(gitLines(cwd, ['show', 'HEAD:missing'], () => {}), (e) => /^git show failed: .*missing/s.test(e.message) && e.cause instanceof Error);
  await assert.rejects(git(cwd, ['show', 'HEAD:missing']), /^Error: git show failed: .*missing/s);
  await assert.rejects(gitLines(path.join(cwd, 'no-such-dir'), ['status'], () => {}), /git status failed/);
  noChild();
});

test('an early stop (onLine returns false) resolves and kills git; a throwing onLine rejects with its error and kills git', async () => {
  const cwd = repo();
  let n = 0;
  const t = Date.now();
  await gitLines(cwd, ['show', 'HEAD:big.txt'], () => { n++; return n < 3 ? undefined : false; });
  assert.equal(n, 3, 'no line after the stop');
  noChild();
  const boom = new Error('boom');
  await assert.rejects(gitLines(cwd, ['show', 'HEAD:big.txt'], () => { throw boom; }), (e) => e === boom);
  noChild();
  assert.ok(Date.now() - t < 5000, 'stopped without reading the whole output');
});
