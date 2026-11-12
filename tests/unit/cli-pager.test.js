// The menu pager's break points (final tidy, item 5): before a `#N of M` block, else before a section heading; inside a block only when
// that one block is longer than the screen. Held-back text is shown one screen at a time on a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePager } from '../../src/cli/pager.js';
import { makeStyle } from '../../src/cli/style.js';

const SEC = ['Message', 'People', 'Proof', 'Content', 'Seal'];
const block = (n, m, rowsPer) => ['', `#${n} of ${m}`, ...SEC.flatMap((s, k) => ['', ...(k ? [] : []), s, ...Array.from({ length: rowsPer }, (_, i) => `${s.toLowerCase()} ${i}`)].filter((x, idx) => !(k === 0 && idx === 0)))];
async function pages(lines, rows) {
  const written = [];
  const real = { isTTY: true, columns: 80, rows, write: (s) => { written.push(String(s)); } };
  const p = { ask: async () => '', askSecret: async () => '', suspend: (f) => f(), close() {} };
  const pager = makePager(real, p, makeStyle());
  pager.stream.write(`${lines.join('\n')}\n`);
  await pager.show();
  // one entry per page: the text between footers
  return written.join('').split(/Enter more[^\n]*\n/).map((x) => x.replace(/\n$/, '').split('\n'));
}

test('a page break goes before a `#N of M` block, not right after its header', async () => {
  const lines = ['7 emails with the address x', ...[1, 2, 3].flatMap((n) => block(n, 3, 1))];
  // each block is 1 blank + header + 5 sections * 2 lines = about 11 lines; the screen holds two and a bit of the third
  const out = await pages(lines, 28);
  assert.ok(out.length >= 2);
  for (const pg of out) assert.ok(!/^#\d of 3$/.test(pg.at(-1)), `a page does not end on a block header: ${pg.at(-1)}`);
  for (const pg of out.slice(1)) assert.match(pg[0], /^#\d of 3$/, 'every later page starts at a block header');
  assert.equal(out.flat().filter((l) => /^#\d of 3$/.test(l)).length, 3, 'nothing lost');
});

test('a block longer than the screen splits before a section heading', async () => {
  const lines = ['x', '', '#1 of 1', ...SEC.flatMap((s) => ['', s, ...Array.from({ length: 6 }, (_, i) => `${s} ${i}`)])];
  const out = await pages(lines, 18);
  assert.ok(out.length >= 2);
  for (const pg of out.slice(2)) assert.ok(SEC.includes(pg[0]), `a page starts at a section heading: ${pg[0]}`);
});

test('plain output with no blocks pages exactly as before', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const out = await pages(lines, 12);
  assert.deepEqual(out.map((x) => x.length), [10, 10, 10, 10]);
});
