// rotateLog: the MCP audit file rotates to <file>.1 instead of being truncated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rotateLog } from '../../src/cli/state.js';
import { makeTmpDir } from '../helpers/tmp.js';

const MIB = 1024 * 1024;

test('rotateLog: under the limit the file is untouched', async () => {
  const dir = makeTmpDir('rot-');
  const f = path.join(dir, 'mcp.log');
  fs.writeFileSync(f, 'x\n'.repeat(1000));
  await rotateLog(f);
  assert.equal(fs.readFileSync(f, 'utf8'), 'x\n'.repeat(1000));
  assert.equal(fs.existsSync(`${f}.1`), false);
});

test('rotateLog: over the limit it is renamed whole to .1, replacing an older .1; a missing file is a no-op', async () => {
  const dir = makeTmpDir('rot-');
  const f = path.join(dir, 'mcp.log');
  const big = 'new line\n'.repeat(Math.ceil(MIB / 9) + 1);
  fs.writeFileSync(f, big);
  fs.writeFileSync(`${f}.1`, 'older\n');
  await rotateLog(f);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8'), big);
  await rotateLog(f);   // missing: no-op, .1 kept
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8'), big);
});

test('rotateLog: a failed rename leaves the current file alone and does not throw', async () => {
  const dir = makeTmpDir('rot-');
  const f = path.join(dir, 'mcp.log');
  fs.writeFileSync(f, 'y'.repeat(MIB + 10));
  fs.mkdirSync(path.join(`${f}.1`, 'sub'), { recursive: true });   // a non-empty directory cannot be replaced by a file
  await rotateLog(f);
  assert.equal(fs.statSync(f).size, MIB + 10);
});

test('rotateLog: two servers starting together both finish; the file is renamed once and nothing is lost', async () => {
  const dir = makeTmpDir('rot-');
  const f = path.join(dir, 'mcp.log');
  const big = 'new line\n'.repeat(Math.ceil(MIB / 9) + 1);
  fs.writeFileSync(f, big);
  await Promise.all([rotateLog(f), rotateLog(f), rotateLog(f)]);   // all pass the stat check; one rename wins, the others hit ENOENT, swallowed
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8'), big);
});

test('rotateLog: a symlinked log is sized through the link but only the link is renamed; the target is left alone and the next start finds a plain file', async () => {
  const dir = makeTmpDir('rot-');
  const target = path.join(dir, 'elsewhere.log');
  const f = path.join(dir, 'mcp.log');
  const big = 'z'.repeat(MIB + 10);
  fs.writeFileSync(target, big);
  fs.symlinkSync(target, f);
  await rotateLog(f);
  assert.equal(fs.existsSync(f), false);                      // the link moved
  assert.equal(fs.lstatSync(`${f}.1`).isSymbolicLink(), true);
  assert.equal(fs.statSync(target).size, MIB + 10);           // the target is untouched, not trimmed
  fs.writeFileSync(f, 'fresh\n');                             // the next start writes a plain file, so it is not re-renamed
  await rotateLog(f);
  assert.equal(fs.readFileSync(f, 'utf8'), 'fresh\n');
});
