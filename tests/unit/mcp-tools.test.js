// The MCP tool table against the library (SPEC B12.4): complete, fresh, annotated, and consistent with the JSDoc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Mailproof } from '../../src/index.js';
import { TOOLS, EXCLUDED } from '../../src/mcp/tools.js';
import { GENERATED_TOOLS } from '../../src/mcp/tools.generated.js';
import { problems, build, requiredNames, mcpTexts, MCP_MAX_CHARS } from '../../scripts/gen-mcp-tools.mjs';

const publicMethods = () => Object.entries(Object.getOwnPropertyDescriptors(Mailproof.prototype))
  .filter(([k, d]) => k !== 'constructor' && !k.startsWith('_') && typeof d.value === 'function').map(([k]) => k);

test('the table is complete: every method and exported function is a tool or excluded with a reason', () => {
  assert.deepEqual(problems(publicMethods()), []);
  for (const [k, why] of Object.entries(EXCLUDED)) assert.ok(why.length > 10, k);
});

test('24 tools: 18 read, 4 write, 2 destructive; every tool has all four hints, set explicitly', () => {
  const t = Object.values(TOOLS);
  assert.equal(t.length, 24);
  assert.deepEqual(['read', 'write', 'destructive'].map((c) => t.filter((x) => x.cls === c).length), [18, 4, 2]);
  for (const [name, x] of Object.entries(TOOLS)) {
    assert.deepEqual(Object.keys(x.annotations).sort(), ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'], name);
    assert.equal(x.annotations.readOnlyHint, x.cls === 'read', `${name}: readOnly iff class read`);
    assert.equal(x.annotations.destructiveHint, x.cls === 'destructive', `${name}: destructive only for forget and prune`);
  }
});

test('the hints are exactly the B12.3 table', () => {
  const open = ['check', 'record', 'sync', 'upgradeStamps'];
  const notIdem = ['sync', 'upgradeStamps'];
  for (const [name, x] of Object.entries(TOOLS)) {
    assert.equal(x.annotations.openWorldHint, open.includes(name), `${name} openWorld`);
    assert.equal(x.annotations.idempotentHint, !notIdem.includes(name), `${name} idempotent`);
  }
  assert.deepEqual(Object.keys(TOOLS).filter((n) => TOOLS[n].cls === 'destructive'), ['forget', 'prune']);
});

test('tools.generated.js is fresh (npm run build:mcp-tools)', () => {
  assert.equal(fs.readFileSync(new URL('../../src/mcp/tools.generated.js', import.meta.url), 'utf8'), build());
  assert.deepEqual(GENERATED_TOOLS.map((t) => t.name), Object.keys(TOOLS));
});

test('@mcp texts: at most 700 characters, name only codes the method documents, written in the tool\'s own terms', () => {
  const texts = mcpTexts();
  assert.ok(texts.size >= 10);
  for (const [name, text] of texts) assert.ok(text.length <= MCP_MAX_CHARS, name);
  // the shortened descriptions really are shorter than @when + @fails
  const prims = new Map(JSON.parse(fs.readFileSync(new URL('../../primitives.json', import.meta.url), 'utf8')).primitives.map((p) => [p.name, p]));
  for (const [name, text] of texts) assert.ok(text.length < prims.get(name).when.length + prims.get(name).fails.length, name);
});

test('the problems check catches what it should', () => {
  assert.ok(problems(['brandNewMethod']).some((p) => /brandNewMethod.*neither a tool nor in EXCLUDED/.test(p)));
  assert.deepEqual(requiredNames('mp.prune(opts: { before: Date, dryRun?: boolean }) => X'), ['before']);
  assert.deepEqual(requiredNames('mp.list(opts?: { limit?: number }) => X'), []);
  assert.deepEqual(requiredNames('mp.record(raw: Buffer, ctx: { direction: \'in\'|\'out\', source?: string }) => X'), ['direction']);
});

test('every tool schema property has a description, and the descriptions are not empty', () => {
  for (const t of GENERATED_TOOLS) {
    assert.ok(t.description.length > 40, t.name);
    for (const [k, v] of Object.entries(t.properties)) assert.ok(v.description, `${t.name}.${k}`);
  }
});

test('descriptions steer the model right: verifyRecord vs verify, and what addresses[].signed means', () => {
  const d = (n) => GENERATED_TOOLS.find((t) => t.name === n).description;
  assert.ok(d('verifyRecord').startsWith('For a record in your own trail use `verify` with its id; `verifyRecord` is for a record JSON someone sent you (e.g. a file in an export bundle)'));
  assert.match(d('verify'), /by id; find ids with `list\(\{ with \}\)`/);
  assert.match(d('get'), /`addresses\[\]\.signed` means covered by some signature, not that it verified; use the verdicts or `coverage`/);
  assert.match(d('list'), /coverage/);
  assert.match(d('counterparties'), /verified/);
  assert.match(d('sync'), /`ots` is a deprecated alias of `stamp`/);
  const ctx = fs.readFileSync(new URL('../../mailproof.context.md', import.meta.url), 'utf8');
  assert.ok(ctx.includes('`addresses[].signed` means covered by some signature, not that it verified; use the verdicts or `coverage`'));
});
