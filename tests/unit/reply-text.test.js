// The reply-text stripper `mailproof-quote/1` (SPEC B6.3, B6.4): one fixture per client style and encoding, the
// determinism contract, the failure controls, linear-time cases, and parity with the POC the GO decision rests on (F20).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { stripReplyText, extractReplyText, replyTextPath, STRIPPER } from '../../src/proof/reply-text.js';
import { strip as pocStrip } from '../../poc/m2-quotes/strip.mjs';
import { FIXTURES, QUOTED } from '../helpers/reply-fixtures.js';

const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const cpuMs = (fn) => { const t = process.cpuUsage(); fn(); const u = process.cpuUsage(t); return (u.user + u.system) / 1000; };
const plain = (body, extra = '') => Buffer.from(`Content-Type: text/plain; charset=utf-8${extra}\r\n\r\n${body}`, 'utf8');

for (const f of FIXTURES) {
  test(`stripper: ${f.name}`, () => {
    const r = stripReplyText(f.raw);
    assert.deepEqual({ text: r.text, quote: r.quote, trailing: r.trailing, boundary: r.boundary, source: r.source }, f.expect);
    assert.equal(r.text_sha256, sha(f.expect.text), 'the hash is over the UTF-8 bytes of the text');
    assert.equal(r.text_bytes, Buffer.byteLength(f.expect.text, 'utf8'));
  });
}

test('control: no fixture that quotes returns the quoted history (a whole-body return would fail this)', () => {
  let quoting = 0;
  for (const f of FIXTURES) {
    const whole = f.raw.toString('latin1');
    if (!whole.includes(QUOTED) || f.expect.source === 'html-only') continue;
    quoting++;
    const r = stripReplyText(f.raw);
    assert.ok(!r.text.includes(QUOTED), f.name);
    assert.ok(!/wrote:|Original Message|Forwarded message|^>/m.test(r.text), f.name);
    if (f.expect.quote === 'found') assert.ok(r.text.length < whole.length, f.name);
  }
  assert.ok(quoting >= 10, 'the control must actually see quoting fixtures');
  // and the opposite control: with no quote the text IS the whole body
  assert.equal(stripReplyText(plain('one\r\ntwo\r\n')).text, 'one\ntwo');
});

test('determinism: the same bytes give the same text, hash and flags every time; the result depends on bytes only', () => {
  for (const f of FIXTURES) {
    const a = stripReplyText(f.raw);
    const b = stripReplyText(Buffer.from(f.raw));
    assert.deepEqual(a, b, f.name);
  }
  // a different header the stripper does not read changes nothing
  const base = FIXTURES[0].raw;
  assert.deepEqual(stripReplyText(Buffer.concat([Buffer.from('Subject: other\r\nX-Foo: 1\r\n'), base])), stripReplyText(base));
});

test('idempotence: stripping the extracted text again is a no-op and not-found', () => {
  for (const f of FIXTURES) {
    if (f.expect.source === 'html-only') continue;
    const r = stripReplyText(f.raw);
    const again = stripReplyText(Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n' + r.text, 'utf8'));
    assert.equal(again.text_sha256, r.text_sha256, f.name);
    assert.equal(again.quote, 'not-found', f.name);
  }
});

test('trailing: false for inline, not-found, a quote with no > line, and a clean quote; true only for text after a > quote', () => {
  const t = (body) => stripReplyText(plain(body));
  assert.equal(t('Yes.\r\nOn Mon, B wrote:\r\n> q\r\n').trailing, false);
  assert.equal(t('Yes.\r\nOn Mon, B wrote:\r\n> q\r\n\r\n   \r\n').trailing, false, 'blank lines after the quote are not text');
  assert.equal(t('Yes.\r\nOn Mon, B wrote:\r\n> q\r\nSigned\r\n').trailing, true);
  assert.equal(t('Yes.\r\nOn Mon, B wrote:\r\n> q\r\nSigned\r\n> more\r\n').quote, 'inline');
  assert.equal(t('Yes.\r\nOn Mon, B wrote:\r\n> q\r\nSigned\r\n> more\r\n').trailing, false);
  assert.equal(t('Yes.\r\n-----Original Message-----\r\nFrom: a\r\nSent: b\r\n\r\ntext after\r\n').trailing, false, 'no > line: everything after the header block is the quoted message');
  assert.equal(t('only text').trailing, false);
});

test('boundary rules: attribution in other languages, up to 4 lines, and what is not a boundary', () => {
  const b = (body) => stripReplyText(plain(body)).boundary;
  assert.equal(b('x\r\nAm 03.11.2025 um 10:00 Bob Example <b@example.net> schrieb:\r\n> q'), 'attribution');
  assert.equal(b('x\r\nOp ma 3 nov. 2025 om 10:00 heeft Bob schreef:\r\n> q'), 'attribution');
  // a known limit of /1, pinned so a rule change must be a new version: the verb followed by the name is not an attribution
  // (it falls through to the first > line)
  assert.equal(b('x\r\nAm 03.11.2025 um 10:00 schrieb Bob:\r\n> q'), 'quote-run');
  assert.equal(b('x\r\nLe lun. 3 nov. 2025 à 10:00, Bob a écrit :\r\n> q'), 'attribution');
  assert.equal(b('x\r\nOn Mon,\r\nNov 3,\r\n2025 at 10:00 Bob\r\n<b@example.net> wrote:\r\n> q'), 'attribution');
  assert.equal(b('x\r\nOn Mon,\r\nNov 3,\r\n2025 at 10:00 Bob\r\n<b@example.net>\r\nwrote:\r\n> q'), 'quote-run', 'five lines is too many');
  assert.equal(b('x\r\nOn the other hand, he wrote a letter\r\nand then slept.'), null, 'no line ends with the verb');
  assert.equal(b('x\r\nOn Monday we agreed.\r\n\r\nwrote:'), null, 'an empty line ends the lookahead');
  assert.equal(b('x\r\n  > indented is not a quote line'), null);
  assert.equal(b('x\r\nBegin forwarded message:\r\n\r\ny'), 'forward-marker');
  assert.equal(b('x\r\nFrom: a\r\nnothing like a sent line\r\n'), null);
});

test('decoding: charset labels, BOM, invalid bytes, unknown charset, CR and lone CR line ends', () => {
  const raw = (ct, bytes, cte = '') => Buffer.concat([Buffer.from(`Content-Type: ${ct}\r\n${cte ? `Content-Transfer-Encoding: ${cte}\r\n` : ''}\r\n`), bytes]);
  assert.equal(stripReplyText(raw('text/plain; charset=utf-8', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).text, 'hi', 'BOM removed');
  assert.equal(stripReplyText(raw('text/plain; charset=utf-8', Buffer.from([0x61, 0xff, 0x62]))).text, 'a�b', 'invalid byte becomes U+FFFD');
  assert.equal(stripReplyText(raw('text/plain; charset=x-no-such-charset', Buffer.from('café', 'utf8'))).text, 'café', 'unknown label decodes as utf-8');
  assert.equal(stripReplyText(raw('text/plain; charset=iso-8859-1', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).text, 'café');
  assert.equal(stripReplyText(raw('text/plain', Buffer.from('a\rb\r\nc\nd'))).text, 'a\nb\nc\nd', 'CR, CR LF and LF all end a line');
  assert.equal(stripReplyText(raw('text/plain; charset=utf-8', Buffer.from('=3D x'), 'quoted-printable')).text, '= x');
  assert.equal(stripReplyText(raw('text/plain; charset=utf-8', Buffer.from('a=ZZb=4'), 'quoted-printable')).text, 'a=ZZb=4', 'not-hex = stays');
  assert.equal(stripReplyText(raw('text/plain; charset=utf-8', Buffer.from('YWJj\r\nZGVm!!'), 'base64')).text, 'abcdef', 'junk ignored');
  assert.equal(stripReplyText(raw('text/plain', Buffer.from('x'), 'x-weird')).text, 'x', 'unknown transfer encoding: bytes as they are');
});

test('format=flowed: joins same-depth lines, keeps the -- signature separator, honours delsp', () => {
  const t = (body, extra) => stripReplyText(plain(body, extra)).text;
  assert.equal(t('one \r\ntwo \r\nthree\r\nfour', '; format=flowed'), 'one two three\nfour');
  assert.equal(t('one \r\ntwo\r\n-- \r\nname', '; format=flowed'), 'one two\n-- \nname');
  assert.equal(t('one  \r\ntwo', '; format=flowed; delsp=yes'), 'one two', 'delsp drops the joining space');
  assert.equal(t('one \r\ntwo', ''), 'one \ntwo', 'not flowed: lines stay');
  assert.equal(stripReplyText(plain('Hi.\r\nOn Mon, B wrote:\r\n> a \r\n> b\r\nmy answer\r\n> c', '; format=flowed')).quote, 'inline');
  assert.equal(stripReplyText(plain('> a \r\n>> b\r\n', '; format=flowed')).trailing, false, 'a deeper line is not joined into a shallower one');
});

test('multipart: first text/plain leaf, not an attachment, not inside message/rfc822, nested', () => {
  const mp = (parts) => Buffer.from(['Content-Type: multipart/mixed; boundary=B', '', ...parts.flatMap((p) => ['--B', ...p, '']), '--B--', ''].join('\r\n'), 'latin1');
  const att = ['Content-Type: text/plain', 'Content-Disposition: attachment; filename=a.txt', '', 'attached text'];
  const body = ['Content-Type: text/plain', '', 'real body'];
  assert.equal(stripReplyText(mp([att, body])).text, 'real body');
  const inner = ['Content-Type: message/rfc822', '', 'Content-Type: text/plain', '', 'forwarded inner'];
  assert.equal(stripReplyText(mp([inner])).source, 'html-only', 'an attached message is not entered');
  const nested = ['Content-Type: multipart/alternative; boundary=N', '', '--N', 'Content-Type: text/plain', '', 'deep body', '--N--'];
  assert.equal(stripReplyText(mp([nested])).text, 'deep body');
  assert.equal(stripReplyText(Buffer.from('Subject: no content type\r\n\r\nplain by default')).text, 'plain by default');
  assert.equal(stripReplyText(Buffer.from('Content-Type: image/png\r\n\r\nxx')).source, 'html-only');
});

test('linear time: inputs that make a backtracking regex or a repeated string flatten quadratic finish at once', () => {
  const qp = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + ' '.repeat(100000) + 'x');
  const ws = plain('a' + ' '.repeat(100000) + 'b');
  const flowed = plain('word \r\n'.repeat(100000), '; format=flowed');
  const deep = plain('>'.repeat(200000) + ' x\r\n' + '>'.repeat(200000) + ' y \r\n', '; format=flowed');
  // measured on the POC: ~56 s, ~12 s and ~17 s; here a few milliseconds to a few hundred
  for (const [name, buf] of [['qp blanks', qp], ['trim', ws], ['flowed paragraph', flowed], ['quote depth', deep]]) {
    const ms = cpuMs(() => stripReplyText(buf));
    assert.ok(ms < 3000, `${name}: ${ms} ms of CPU`);
  }
  assert.equal(stripReplyText(ws).text.length, 100002);
});

test('extractReplyText: the gate runs first; an over-limit message is refused, not read', () => {
  const ok = extractReplyText(FIXTURES[0].raw);
  assert.equal(ok.ok, true);
  const over = extractReplyText(plain('x\r\n'.repeat(500001)));
  assert.deepEqual(over, { ok: false, limit: 'body_lines' });
});

test('replyTextPath: the version string with / replaced by -', () => {
  assert.equal(STRIPPER, 'mailproof-quote/1');
  assert.equal(replyTextPath('a'.repeat(32)), `replies/${'a'.repeat(32)}.mailproof-quote-1.json`);
});

test('parity with the POC stripper (poc/m2-quotes/strip.mjs): text, hash and flags on every fixture', () => {
  for (const f of FIXTURES) {
    const a = stripReplyText(f.raw);
    const p = pocStrip(f.raw);
    assert.equal(a.source, p.source, f.name);
    if (p.source === 'html-only') { assert.equal(a.text, ''); assert.equal(a.quote, 'not-found'); continue; }
    assert.equal(a.text, p.text, f.name);
    assert.equal(a.text_sha256, 'sha256:' + p.text_sha256, f.name);
    assert.equal(a.text_bytes, p.text_bytes, f.name);
    assert.equal(a.quote, p.quote, f.name);
    assert.equal(a.boundary, p.boundary, f.name);
    assert.equal(a.trailing, p.trailing, f.name);
  }
});
