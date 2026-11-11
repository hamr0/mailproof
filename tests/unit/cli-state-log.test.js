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
