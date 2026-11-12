// src/cli/style.js (SPEC B11.7a): the colour decision, the symbols, links, relative time, truncation and the output backstop. Everything
// comes in through the injected env and stream facts, so nothing here depends on the machine running the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStyle, styleOf, rel, allowStyle, stripStyle, fileUrl, isUtf8 } from '../../src/cli/style.js';

const UTF = { LANG: 'en_US.UTF-8' };

test('colour is on only for a TTY with NO_COLOR unset and TERM not dumb; FORCE_COLOR forces it for a pipe; NO_COLOR beats FORCE_COLOR', () => {
  assert.equal(makeStyle({ env: {}, isTTY: true }).on, true);
  assert.equal(makeStyle({ env: {}, isTTY: false }).on, false, 'a pipe');
  assert.equal(makeStyle({ env: { NO_COLOR: '1' }, isTTY: true }).on, false);
  assert.equal(makeStyle({ env: { NO_COLOR: '' }, isTTY: true }).on, true, 'an empty NO_COLOR is unset (no-color.org)');
  assert.equal(makeStyle({ env: { TERM: 'dumb' }, isTTY: true }).on, false);
  assert.equal(makeStyle({ env: { FORCE_COLOR: '1' }, isTTY: false }).on, true);
  assert.equal(makeStyle({ env: { FORCE_COLOR: '0' }, isTTY: false }).on, false);
  assert.equal(makeStyle({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTTY: true }).on, false);
});

test('helpers wrap with SGR codes when on and return the text untouched when off; an empty string stays empty', () => {
  const on = makeStyle({ env: { FORCE_COLOR: '1' } });
  assert.equal(on.bold('x'), '\x1b[1mx\x1b[0m');
  assert.equal(on.dim('x'), '\x1b[2mx\x1b[0m');
  assert.equal(on.green('x'), '\x1b[32mx\x1b[0m');
  assert.equal(on.yellow('x'), '\x1b[33mx\x1b[0m');
  assert.equal(on.red('x'), '\x1b[31mx\x1b[0m');
  assert.equal(on.cyan('x'), '\x1b[36mx\x1b[0m');
  assert.equal(on.inverse('x'), '\x1b[7mx\x1b[0m');
  assert.equal(on.badge('green', 'OK'), '\x1b[7;32mOK\x1b[0m');
  assert.equal(on.green(''), '');
  const off = makeStyle({ env: {} });
  for (const f of ['bold', 'dim', 'green', 'yellow', 'red', 'cyan', 'inverse']) assert.equal(off[f]('x'), 'x', f);
  assert.equal(off.badge('red', 'NO'), 'NO');
  assert.equal(stripStyle(on.green(on.bold('x'))), 'x');
});

test('symbols: check, warning, cross and dot in a UTF-8 locale (LC_ALL, LC_CTYPE, LANG in that order); ASCII words otherwise', () => {
  assert.deepEqual(makeStyle({ env: UTF }).sym, { ok: '✓', warn: '!', bad: '✗', dot: '·', dash: '–' });
  assert.equal(makeStyle({ env: {} }).sym.ok, 'ok');
  assert.equal(makeStyle({ env: { LANG: 'C' } }).sym.bad, 'x');
  assert.equal(makeStyle({ env: { LANG: 'C', LC_ALL: 'de_DE.utf8' } }).utf8, true, 'LC_ALL wins');
  assert.equal(makeStyle({ env: { LANG: 'en_US.UTF-8', LC_ALL: 'C' } }).utf8, false, 'LC_ALL=C wins over LANG');
  assert.equal(isUtf8({ LC_CTYPE: 'en_US.UTF-8' }), true);
  assert.equal(makeStyle({ env: UTF }).rule().length, 64);
  assert.equal(makeStyle({ env: {} }).rule(), '-'.repeat(64));
  assert.equal(makeStyle({ env: {}, columns: 40 }).rule().length, 40);
});

test('links: OSC 8 only when colour is on and MAILPROOF_NO_LINKS is unset; the URL cannot end the sequence early', () => {
  const on = makeStyle({ env: { FORCE_COLOR: '1' } });
  const l = on.link('docs', 'https://example.org/a');
  assert.match(l, /^\x1b\]8;id=[0-9a-f]{12};https:\/\/example\.org\/a\x1b\\docs\x1b\]8;;\x1b\\$/);
  const evil = on.link('t', 'https://x.example/\x1b\\\x07evil');
  assert.equal(evil.split('\x1b').length, 5, 'no ESC from the url: exactly the 4 of open and close');
  assert.ok(!evil.includes('\x07'));
  assert.equal(makeStyle({ env: { FORCE_COLOR: '1', MAILPROOF_NO_LINKS: '1' } }).link('docs', 'https://example.org'), 'docs');
  assert.equal(makeStyle({ env: {} }).link('docs', 'https://example.org'), 'docs');
  assert.equal(makeStyle({ env: { NO_COLOR: '1' }, isTTY: true }).link('docs', 'https://example.org'), 'docs');
  assert.equal(fileUrl('/tmp/a b/c#d'), 'file:///tmp/a%20b/c%23d');
});

test('rel: minutes, hours, days, past and future, and nothing for a bad date', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  assert.equal(rel('2026-11-11T11:59:50Z', now), 'just now');
  assert.equal(rel('2026-11-11T12:00:20Z', now), 'in a moment');
  assert.equal(rel('2026-11-11T11:50:00Z', now), '10 min ago');
  assert.equal(rel('2026-11-11T10:00:00Z', now), '2 h ago');
  assert.equal(rel('2026-11-11T16:00:00Z', now), 'in 4 h');
  assert.equal(rel('2026-11-08T12:00:00Z', now), '3 d ago');
  assert.equal(rel('2026-09-11T12:00:00Z', now), '2 mo ago');
  assert.equal(rel(now, now.getTime() + 3600_000), '1 h ago');
  assert.equal(rel('garbage', now), '');
  assert.equal(rel(null, now), '');
});

test('fit cuts on code points (never inside a surrogate pair) and ends with an ellipsis; width is the stream columns or 80', () => {
  const u = makeStyle({ env: UTF });
  assert.equal(u.fit('abcdefghij', 6), 'abcde…');
  assert.equal(u.fit('abc', 6), 'abc');
  assert.equal(u.fit('😀😀😀😀😀', 4), '😀😀😀…');
  assert.equal(makeStyle({ env: {} }).fit('abcdefghij', 6), 'abc...');
  assert.equal(u.fit('abcdef', 1), 'a');
  assert.equal(makeStyle({ env: {} }).width, 80);
  assert.equal(makeStyle({ env: {}, columns: 132 }).width, 132);
  assert.equal(makeStyle({ env: {}, columns: 0 }).width, 80);
  const ctx = { env: { FORCE_COLOR: '1' }, stdout: { isTTY: false, columns: 100 }, stderr: { isTTY: true } };
  assert.equal(styleOf(ctx).width, 100);
  assert.equal(styleOf(ctx, 'stderr').width, 80);
});

test('allowStyle keeps the sequences this module made and escapes everything else, including a forged link and a cursor move', () => {
  const on = makeStyle({ env: { FORCE_COLOR: '1' } });
  const mine = `${on.red('bad')} ${on.link('docs', 'https://example.org')}`;
  assert.equal(allowStyle(mine), mine, 'our own sequences pass');
  assert.equal(allowStyle('plain\nline'), 'plain\nline');
  assert.equal(allowStyle('a\x1b[2Jb'), 'a\\x1b[2Jb', 'a screen clear is shown, not run');
  assert.ok(!allowStyle('\x1b]8;;https://evil.example\x1b\\x').includes('\x1b]8;;https'), 'a forged link opener (no nonce) is escaped');
  assert.equal(allowStyle(`${on.green('ok')}\x1b]0;title\x07`), `${on.green('ok')}\\x1b]0;title\\x07`, 'an OSC title next to ours is escaped');
});

test('key and choices: bold green on, the same words (braces dropped) off', () => {
  const on = makeStyle({ env: { FORCE_COLOR: '1' } });
  const off = makeStyle({ env: { NO_COLOR: '1' } });
  assert.equal(on.key('s'), '\x1b[1;32ms\x1b[0m');
  assert.equal(on.choices('then {s} or {e}, e.g. {3 v}'), 'then \x1b[1;32ms\x1b[0m or \x1b[1;32me\x1b[0m, e.g. \x1b[1;32m3 v\x1b[0m');
  assert.equal(off.key('s'), 's');
  assert.equal(off.choices('then {s} or {e}, e.g. {3 v}'), 'then s or e, e.g. 3 v');
});
