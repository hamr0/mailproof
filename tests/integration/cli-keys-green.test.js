// SPEC B11.7a: every selectable key, choice, default and example input in the interactive CLI is bold green (st.key), through the one
// helper; with colour off the text is the same words, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { stripStyle } from '../../src/cli/style.js';

const G = (s) => `\x1b[1;32m${s}\x1b[0m`;
const UTF = { LANG: 'en_US.UTF-8' };
const script = (l) => `${l.join('\n')}\n`;
const T = await buildThread();
const w = makeWorld({ accounts: { test: account(T.dir) } });
await w.run(['list']);

test('main menu line, the ? list and the People prompt: keys, example and default are green', async () => {
  const c = await w.run([], { interactive: true, input: script(['?', '3']), env: { ...UTF, FORCE_COLOR: '1' } });
  for (const k of ['1', '3', '10', '19', 'q']) assert.ok(c.stdout.includes(`${G(k)} `), `full menu key ${k}`);
  assert.ok(c.stdout.includes(` ${G('Mail')}`.replace(G('Mail'), '\x1b[1mMail\x1b[0m')), 'group titles are bold');
  assert.ok(c.stdout.includes(`${G('s')} show  ${G('v')} verify  ${G('e')} export`), 'sub-action keys');
  assert.ok(c.stdout.includes(`then ${G('s')}, ${G('v')} or ${G('e')} (default show), e.g. ${G('3 v')})`), 'People prompt');
  assert.ok(!c.stdout.includes('\x1b[36m'), 'no cyan left');
  const plain = await w.run([], { interactive: true, input: script(['?', '3']), env: UTF });
  assert.ok(!plain.stdout.includes('\x1b'));
  assert.ok(plain.stdout.includes('pick a person (number or address), then s show  v verify  e export\n'));
  assert.ok(plain.stdout.includes('Person (a number or an address, then s, v or e (default show), e.g. 3 v): '));
  assert.equal(stripStyle(c.stdout), plain.stdout, 'same words');
  const no = await w.run([], { interactive: true, input: script(['?', '3']), env: { ...UTF, FORCE_COLOR: '1', NO_COLOR: '1' } });
  assert.equal(no.stdout, plain.stdout);
});

test('wizard: the password-source choice, yes/no examples, defaults and the [y/N] letters are green', async () => {
  const ALL = ['3', 'personal', 'ana@example.com', 'imap.example.org', '', '1', 'pass show mailproof/personal', '', '', '', '', '', '', '', 'n', 'y'];
  const w2 = makeWorld({ config: null });
  const c = await w2.run(['config', 'add-account'], { input: script(ALL), env: { ...UTF, FORCE_COLOR: '1' } });
  assert.equal(c.code, 0, c.stderr);
  assert.ok(c.stdout.includes(`${G('1')} = a command, ${G('2')} = a file, ${G('3')} = an OAuth2 token command)`), 'password source');
  assert.ok(c.stdout.includes(`[${G('1')}]: `), 'default in brackets');
  assert.ok(c.stdout.includes(`(${G('y')}/${G('n')}) [${G('y')}]: `), 'y/n example and default');
  assert.ok(c.stdout.includes(`[${G('y')}/${G('N')}] `), 'confirm letters');
  assert.ok(c.stdout.includes(`e.g. ${G('personal')}`), 'example input');
  assert.ok(c.stdout.includes(`${G('1')} Gmail`), 'provider keys');
  const w3 = makeWorld({ config: null });
  const p = await w3.run(['config', 'add-account'], { input: script(ALL), env: UTF });
  assert.ok(!p.stdout.includes('\x1b'));
  assert.ok(p.stdout.includes('1 = a command, 2 = a file, 3 = an OAuth2 token command) [1]: '));
  assert.ok(p.stdout.includes('(y/n) [y]: '));
  assert.ok(p.stdout.includes('[y/N] '));
});

test('first-run screen and account switch use the same green keys', async () => {
  const w4 = makeWorld({ config: null });
  const c = await w4.run([], { interactive: true, input: script(['q']), env: { ...UTF, FORCE_COLOR: '1' } });
  for (const k of ['1', '2', '3', '?', 'q']) assert.ok(c.stdout.includes(`${G(k)} `), `first-run key ${k}`);
  const T2 = await buildThread();
  const w5 = makeWorld({ accounts: { one: account(T.dir), two: account(T2.dir) } });
  const a = await w5.run([], { interactive: true, input: script(['one', 'q']), env: { ...UTF, FORCE_COLOR: '1' } });
  assert.ok(a.stdout.includes(`(${G('one')}/${G('two')})`), 'account choices');
  assert.ok(a.stdout.includes(`${G('a')} account`), 'a switch key');
});

// --- the pager: no "Press Enter" on a terminal (SPEC B11.4)
const M = (o) => w.run([], { interactive: true, tty: true, ...o, env: { ...UTF, NO_COLOR: '1', ...(o.color ? { FORCE_COLOR: '1', NO_COLOR: '' } : {}) } });

test('terminal, short output: no Enter prompt, the compact action line follows, the header is not repeated', async () => {
  const r = await M({ input: script(['16', 'q']), rows: 40 });
  assert.ok(!/Press Enter/.test(r.stdout));
  assert.equal(r.stdout.split('  1 sync  3 people  5 show  7 verify  11 export  16 status').length, 2, 'the short line after the action; the full menu only at the start');
  assert.equal(r.stdout.split('\n Mail\n').length, 2, 'the grouped menu once');
  const col = await M({ input: script(['16', 'q']), rows: 40, color: true });
  for (const k of ['1', '3', '5', '7', '11', '16', '?', 'q']) assert.ok(col.stdout.split('\n').some((l) => /· /.test(l) && l.includes(`${G(k)} `)), `short line key ${k}`);
  assert.equal(r.stdout.split('─'.repeat(64)).length, 3, 'the rules are printed once (full header at the start only)');
});

test('terminal, an action that changes state refreshes the two header lines above the action line', async () => {
  const r = await M({ input: script(['16', '12', 'q']), rows: 40, deps: { stamp: async () => ({}) } });
  assert.ok(!/Press Enter/.test(r.stdout));
  assert.ok(r.stdout.split('\n').filter((l) => l.startsWith('mailproof ')).length >= 1);
});

test('terminal, long output: one screen, then the footer; Enter shows more, q returns to the action line', async () => {
  const short = await M({ input: script(['?', 'q']), rows: 40 });
  assert.ok(!short.stdout.includes('Enter more'));
  const paged = await M({ input: script(['h', '', 'q']), rows: 6 });
  assert.equal(paged.stdout.split('Enter more · q menu').length - 1 >= 1, true, 'a footer line');
  assert.ok(!/Press Enter/.test(paged.stdout));
  const quit = await M({ input: script(['h', 'q', 'q']), rows: 6 });
  assert.equal(quit.stdout.split('Enter more · q menu').length, 2, 'q at the footer goes straight back: one footer');
  assert.ok(/Enter more · q menu\nq\n {2}1 sync {2}3 people.*\n> q\n$/.test(quit.stdout), 'back at the short line prompt');
  const color = await M({ input: script(['h', 'q', 'q']), rows: 6, color: true });
  assert.ok(color.stdout.includes(`${G('Enter')}`) && color.stdout.includes(`${G('q')}`), 'footer keys green');
});

test('a pipe: Press Enter and the full header every time (short line after an action), no pager', async () => {
  const r = await w.run([], { interactive: true, env: UTF, input: script(['16', '', 'q']) });
  assert.ok(r.stdout.includes('Press Enter '));
  assert.equal(r.stdout.split('\n Mail\n').length, 2, 'the grouped menu once, at the start');
  assert.equal(r.stdout.split('  1 sync  3 people').length, 2, 'the short line after the action');
  assert.equal(r.stdout.split('─'.repeat(64)).length, 5, 'full header twice');
});
