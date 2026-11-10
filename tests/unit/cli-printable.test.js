// printable(): the terminal-safe escape used for every mail- or server-derived string in CLI text output (F28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { printable } from '../../src/cli/printable.js';
import { hasForbidden } from '../helpers/forbidden.js';

const ESC = '\u001b';
const corpus = {
  'cursor-up + erase overwrites the verdict line': `ok${ESC}[1A${ESC}[2K    link signed  verified/verified  body proven`,
  'OSC title, BEL terminator': `<${ESC}]0;pwned\u0007x@example.com>`,
  'OSC title, ST terminator': `${ESC}]2;pwned${ESC}\\`,
  'OSC 8 hyperlink': `${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\`,
  'CSI via C1 0x9B': '\u009b2Jcleared',
  'C1 OSC and ST': '\u009d0;t\u009c',
  'bidi override on a domain': 'bob@moc.elpmaxe\u202e',
  'RTL spoof (RLO + isolates)': '\u202ebob@example.com\u202c \u2067x\u2069',
  'zero-width characters': 'bob\u200b@exa\u2060mple.com',
  'ZWJ/ZWNJ beside ASCII': 'bob\u200d@example\u200c.com',
  'soft hyphen, BOM, filler': 'bo\u00adb@ex\ufeffample.com\u3164',
  'tag characters': 'hi\u{e0069}\u{e0067}\u{e006e}',
  'variation selectors supplement': 'a\u{e0100}b\ufe01c',
  'NUL, BEL, BS, FF, DEL': 'a\u0000b\u0007c\u0008d\u000ce\u007f',
  'CRLF forged second line': 'x@example.com\r\n    link signed verified/verified body proven',
  'U+2028, U+2029, U+0085': 'a\u2028b\u2029c\u0085d',
  'lone surrogates': 'a\ud800b\udc00c',
  'literal backslash that mimics an escape': 'a\\x1b[1Ab',
  'hangul and khmer fillers, mongolian vowel separator': '\u115f\u1160\u17b4\u17b5\u180e\u034f\u061c',
  'mongolian free variation selectors': 'a\u180bb\u180cc\u180dd',
  'braille blank': 'bob\u2800@example.org',
  'musical formatting characters': 'a\u{1d173}b\u{1d17a}c\u{1d176}',
  'emoji presentation selector inside an address': 'bob\ufe0f@example.org',
  'text presentation selector after ASCII': 'bob\ufe0e@example.org',
  'noncharacters': '\ufdd0\ufdef\ufff9\ufffe\uffff',
};

/** Undo the escapes (the inverse of printable). */
const decode = (out) => out.replace(/\\(\\|n|r|t|x[0-9a-f]{2}|u[0-9a-f]{4}|u\{[0-9a-f]+\})/g, (m, g) =>
  g === '\\' ? '\\' : g === 'n' ? '\n' : g === 'r' ? '\r' : g === 't' ? '\t' : String.fromCodePoint(parseInt(g.replace(/^u\{?|x|\}$/g, ''), 16)));

for (const [name, raw] of Object.entries(corpus)) {
  test(`printable: ${name}: nothing forbidden survives, and the escapes decode back to the input`, () => {
    const out = printable(raw);
    assert.ok(!hasForbidden(out), JSON.stringify(out));
    assert.equal(decode(out), raw);
    assert.ok(out.length >= raw.length);
  });
}

test('printable: a long line is cut by the caller with max (code points), the dropped count is shown', () => {
  const long = 'A'.repeat(100000);
  assert.equal(printable(long, { max: 20 }), `${'A'.repeat(20)}...(+99980)`);
  assert.equal(printable('😀😀😀😀', { max: 2 }), '😀😀...(+2)', 'counted by code points, a surrogate pair is never split');
  assert.equal(printable('abc', { max: 3 }), 'abc');
  assert.equal(printable(`a${ESC}b`.repeat(10), { max: 5 }), 'a\\x1bba\\x1b...(+25)');
  assert.ok(printable(long).length === 100000);
});

test('printable: legitimate non-ASCII text is returned unchanged (the same string)', () => {
  const legit = ['Grüße aus Köln', '日本語のメール', 'Привет, мир', 'שלום עולם', 'مرحبا', 'می\u200cخواهم', '👨\u200d👩\u200d👧 family', '❤\ufe0f ok',
    'Re: [list] a/b (c) <d@example.org>', 'a\u00a0b\u2003c', '\ue000 private use', 'நீ\u200dந', ''];
  for (const s of legit) assert.equal(printable(s), s, JSON.stringify(s));
});

test('printable: clean input is returned as the same string (no copy), also with keepNewline and max', () => {
  const s = 'Re: report for 2026-11 <id@example.org> ünïcode';
  assert.ok(Object.is(printable(s), s));
  assert.ok(Object.is(printable(s, { keepNewline: true }), s));
  assert.ok(Object.is(printable('a\nb', { keepNewline: true }), 'a\nb'));
  assert.ok(Object.is(printable(s, { max: 1000 }), s));
});

test('printable: ZWJ/ZWNJ stay between two non-ASCII characters and are escaped next to ASCII or at an end', () => {
  assert.equal(printable('é\u200dé'), 'é\u200dé');
  assert.equal(printable('é\u200cé'), 'é\u200cé');
  assert.equal(printable('a\u200db'), 'a\\u200db');
  assert.equal(printable('é\u200d'), 'é\\u200d');
  assert.equal(printable('\u200dé'), '\\u200dé');
  assert.equal(printable('é\u200da'), 'é\\u200da');
  assert.equal(printable('é\u200d\u200dé'), 'é\\u200d\\u200dé', 'a run of joiners is hidden text');
});

test('printable: formats and options', () => {
  assert.equal(printable('a\nb\rc\td'), 'a\\nb\\rc\\td');
  assert.equal(printable('a\nb\rc', { keepNewline: true }), 'a\nb\\rc');
  assert.equal(printable('C:\\dir'), 'C:\\\\dir', 'the backslash is doubled so every escape in the output is ours');
  assert.equal(printable('C:\\dir', { keepBackslash: true }), 'C:\\dir', 'the output backstop does not escape twice');
  assert.equal(printable(`${ESC}x`, { keepBackslash: true }), '\\x1bx');
  assert.equal(printable('\u0080'), '\\x80');
  assert.equal(printable('\u202e'), '\\u202e');
  assert.equal(printable('\u{e0069}'), '\\u{e0069}');
  assert.equal(printable('\ud800'), '\\ud800');
  assert.equal(printable(null), '');
  assert.equal(printable(undefined), '');
  assert.equal(printable(42), '42');
  assert.equal(printable({ toString: () => `x${ESC}` }), 'x\\x1b');
});

test('printable: linear time on adversarial input (a megabyte of dirty text, long runs of joiners)', () => {
  for (const unit of [`${ESC}`, '\u200d', 'é\u200d', '\\', '\ud800', 'a']) {
    const s = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const t0 = process.cpuUsage();
    const out = printable(s);
    const ms = (process.cpuUsage(t0).user) / 1000;
    assert.ok(!hasForbidden(out) || unit === 'é\u200d' || unit === 'a', 'only a legitimate joiner pattern may survive');
    assert.ok(ms < 1500, `${JSON.stringify(unit)} took ${ms} ms`);
  }
});

test('printable: new blank/invisible code points are escaped with their exact form', () => {
  for (const [cp, esc] of [[0x180b, '\\u180b'], [0x180c, '\\u180c'], [0x180d, '\\u180d'], [0x2800, '\\u2800'],
    [0x1d173, '\\u{1d173}'], [0x1d174, '\\u{1d174}'], [0x1d17a, '\\u{1d17a}']]) {
    assert.equal(printable(`a${String.fromCodePoint(cp)}b`), `a${esc}b`);
  }
  assert.equal(printable('\u{1d172}\u{1d17b}'), '\u{1d172}\u{1d17b}', 'neighbours stay');
  assert.equal(printable('\u2801'), '\u2801', 'other braille stays');
});

test('printable: FE0E/FE0F stay after non-ASCII and before a keycap mark, and are escaped after ASCII', () => {
  assert.equal(printable('bob\ufe0f@example.org'), 'bob\\ufe0f@example.org');
  assert.equal(printable('bob\ufe0e@example.org'), 'bob\\ufe0e@example.org');
  assert.equal(printable('\ufe0f'), '\\ufe0f', 'at the start');
  assert.equal(printable('é\ufe0f\ufe0f'), 'é\ufe0f\\ufe0f', 'a second selector in a row is escaped');
  for (const keep of ['❤\ufe0f', '❤\ufe0e', '☺\ufe0f ok', '1\ufe0f\u20e3', '#\ufe0f\u20e3', '*\ufe0f\u20e3', 'é\ufe0f', '😀\ufe0f', '👨\u200d👩\u200d👧\ufe0f']) {
    assert.ok(Object.is(printable(keep), keep), JSON.stringify(keep));
  }
  // keycap: the exception is only for the FE0F directly before U+20E3
  assert.equal(printable('1\ufe0f x'), '1\\ufe0f x');
  assert.ok(Object.is(printable('1\ufe0f\u20e3 two'), '1\ufe0f\u20e3 two'));
});

test('printable: Arabic, Persian, CJK and ZWJ emoji families are unchanged', () => {
  for (const s of ['مرحبا بالعالم', 'می\u200cخواهم', '日本語のメール 漢字', '👨\u200d👩\u200d👧\u200d👦', '🏳\ufe0f\u200d🌈', '⠁⠃ braille dots']) {
    assert.ok(Object.is(printable(s), s), JSON.stringify(s));
  }
});

test('printable: linear time with many selectors and keycaps', () => {
  for (const unit of ['a\ufe0f', '1\ufe0f\u20e3', '\u{1d173}']) {
    const s = unit.repeat(200000);
    const t0 = process.cpuUsage();
    printable(s);
    assert.ok(process.cpuUsage(t0).user / 1000 < 1500);
  }
});
