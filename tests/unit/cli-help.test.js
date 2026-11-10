// The help table (SPEC B11.11): generated from primitives.json and the command table; nothing in it is retyped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HELP } from '../../src/cli/help.generated.js';
import { COMMANDS, GLOBAL_FLAGS } from '../../src/cli/commands.js';
import { HANDLER_NAMES } from '../../src/cli/run.js';
import { renderList, renderCommand } from '../../src/cli/help.js';

const primitives = new Map(JSON.parse(fs.readFileSync(new URL('../../primitives.json', import.meta.url), 'utf8')).primitives.map((p) => [p.name, p]));

test('help.generated.js is fresh (the same check as npm run check:cli-help)', () => {
  const out = execFileSync(process.execPath, [new URL('../../scripts/gen-cli-help.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});

test('every command with a handler has a table row and a help row, and the reverse', () => {
  assert.deepEqual([...HANDLER_NAMES].sort(), Object.keys(COMMANDS).sort());
  assert.deepEqual(Object.keys(HELP.commands).sort(), Object.keys(COMMANDS).sort());
});

test('every command and every flag has help text; a command with a primitive takes the library text word for word', () => {
  for (const [name, row] of Object.entries(HELP.commands)) {
    assert.ok(row.summary.trim(), `${name}: summary`);
    assert.ok(row.when.trim(), `${name}: when`);
    assert.match(row.usage, new RegExp(`^mailproof ${name}`));
    for (const f of row.flags) assert.ok(f.help.trim(), `${name} --${f.name}: help`);
    const prim = COMMANDS[name].primitive;
    if (prim) {
      assert.ok(primitives.has(prim), `${name}: primitive ${prim} exists`);
      assert.equal(row.when, primitives.get(prim).when, `${name}: when is the library's`);
      assert.equal(row.fails, primitives.get(prim).fails, `${name}: fails is the library's`);
    }
  }
  for (const f of HELP.globalFlags) assert.ok(f.help.trim(), `--${f.name}`);
  assert.deepEqual(HELP.globalFlags.map((f) => f.name), Object.keys(GLOBAL_FLAGS));
});

test('the rendered list names every command; a command renders usage, flags and failures; an unknown one is null', () => {
  const list = renderList();
  for (const n of Object.keys(COMMANDS)) assert.match(list, new RegExp(`^  ${n} `, 'm'));
  const prune = renderCommand('prune');
  assert.match(prune, /^Usage: mailproof prune \[flags\]/);
  assert.match(prune, /--before <date>/);
  assert.match(prune, /--delete-backup/);
  assert.match(prune, /\nFails:\n/);
  assert.equal(renderCommand('nope'), null);
  assert.equal(renderCommand('__proto__'), null);
});
