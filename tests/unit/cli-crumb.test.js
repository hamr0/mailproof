// The menu's where-am-I breadcrumb (SPEC B11.4a): one dim rule line, width-fitted, ASCII when the locale is not UTF-8, terminal-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStyle, stripStyle } from '../../src/cli/style.js';
import { crumbLine } from '../../src/cli/crumb.js';

const utf = (columns = 80, extra = {}) => makeStyle({ env: { LANG: 'en_US.UTF-8', ...extra }, columns });
const ascii = (columns = 80) => makeStyle({ env: { LANG: 'C' }, columns });

test('the path, then a rule to the rule width (64 at most)', () => {
  const l = crumbLine(utf(100), ['4 list', 'bob@beta.example', '#3', 't thread', '#2']);
  assert.ok(l.startsWith('── mailproof › 4 list › bob@beta.example › #3 › t thread › #2 ─'), l);
  assert.equal([...l].length, 64);
  assert.equal(crumbLine(utf(100), ['5 show', 'bob@beta.example']).slice(0, 40), '── mailproof › 5 show › bob@beta.example');
  assert.equal([...crumbLine(utf(40), ['5 show'])].length, 40, 'a narrow terminal: the rule stops at its width');
});

test('the root alone, and the ASCII fallback uses - and > only', () => {
  assert.match(crumbLine(utf(), []), /^── mailproof ─+$/);
  const a = crumbLine(ascii(), ['4 list', 'everyone', 's "weekly"']);
  assert.ok(a.startsWith('-- mailproof > 4 list > everyone > s "weekly" -'), a);
  assert.ok(/^[\x20-\x7e]+$/.test(a), 'ASCII only');
});

test('colour off: plain; colour on: one dim span around the line', () => {
  const on = makeStyle({ env: { LANG: 'en_US.UTF-8', FORCE_COLOR: '1' }, columns: 80 });
  const l = crumbLine(on, ['4 list']);
  assert.ok(l.startsWith('\x1b[2m') && l.endsWith('\x1b[0m'));
  assert.equal(stripStyle(l), crumbLine(utf(), ['4 list']));
});

test('never wider than the terminal: the left/middle goes first, the last segment is kept', () => {
  for (const cols of [20, 30, 40, 60]) {
    const l = crumbLine(utf(cols), ['4 list', 'someone.very.long@example.organisation', '#1', 'v verify']);
    assert.ok([...l].length <= cols, `${cols}: ${[...l].length} ${l}`);
    assert.ok(l.includes('v verify') || cols <= 20, l);
    assert.ok(l.includes('…'), 'a cut shows');
  }
  const tiny = crumbLine(utf(8), ['4 list', '#1', 'v verify']);
  assert.ok([...tiny].length <= 8, tiny);
  assert.ok(!crumbLine(ascii(30), ['4 list', 'someone.very.long@example.organisation', '#1']).includes('…'), 'ASCII cut uses ...');
});

test('terminal-safe: a segment from an email carries no escape or bidi character', () => {
  const l = crumbLine(utf(100), ['4 list', 'evil\x1b[2J‮@x.example', 's "a\nb"']);
  assert.ok(!/[\x00-\x08\x0a-\x1f\x7f‮]/.test(l), JSON.stringify(l));
});
