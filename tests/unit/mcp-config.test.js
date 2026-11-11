// The `mcp` block of the config (SPEC B12.2): strict, defaults filled in by mcpSettings, ~ expanded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, mcpSettings, MCP_DEFAULTS } from '../../src/cli/config.js';

const env = { HOME: '/home/ana' };
const acct = { user: 'a@b.example', trailDir: '/t', passCommand: 'x' };
const check = (mcp) => validateConfig({ v: 1, accounts: { a: acct }, ...(mcp === undefined ? {} : { mcp }) }, env);

test('no mcp block: the defaults (no paths in, no files out, 512 KiB / 1 MiB)', () => {
  const { config, problems } = check();
  assert.deepEqual(problems, []);
  assert.deepEqual(mcpSettings(config), { inputDirs: [], outputDir: null, maxResponseBytes: 524288, maxBinaryBytes: 1048576 });
  assert.deepEqual(MCP_DEFAULTS, { maxResponseBytes: 524288, maxBinaryBytes: 1048576 });
});

test('a full mcp block validates; ~ expands; empty block is allowed', () => {
  const { config, problems } = check({ inputDirs: ['~/Downloads', '/srv/in/'], outputDir: '~/out', maxResponseBytes: 2048, maxBinaryBytes: 4096 });
  assert.deepEqual(problems, []);
  assert.deepEqual(config.mcp, { inputDirs: ['/home/ana/Downloads', '/srv/in'], outputDir: '/home/ana/out', maxResponseBytes: 2048, maxBinaryBytes: 4096 });
  assert.deepEqual(check({}).config.mcp, { inputDirs: [], outputDir: null, ...MCP_DEFAULTS });
});

test('every problem names its JSON path', () => {
  const { config, problems } = check({ inputDirs: ['rel', 3], outputDir: 'x', maxResponseBytes: 10, maxBinaryBytes: 'big', extra: true });
  assert.equal(config, null);
  assert.ok(problems.some((p) => p.startsWith('mcp.inputDirs[0]:')));
  assert.ok(problems.some((p) => p.startsWith('mcp.inputDirs[1]:')));
  assert.ok(problems.some((p) => p.startsWith('mcp.outputDir:')));
  assert.ok(problems.some((p) => p.startsWith('mcp.maxResponseBytes:')));
  assert.ok(problems.some((p) => p.startsWith('mcp.maxBinaryBytes:')));
  assert.ok(problems.includes('mcp.extra: unknown key'));
  assert.deepEqual(check('nope').problems, ['mcp: must be an object']);
  assert.deepEqual(check({ inputDirs: 'x' }).problems, ['mcp.inputDirs: must be an array of absolute directories']);
});
