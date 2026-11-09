// The reply-text stripper `mailproof-quote/1` (SPEC B6.3, B6.4): one fixture per client style and encoding, the
// determinism contract, the failure controls, linear-time cases, and parity with the POC the GO decision rests on (F20).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { stripReplyText, extractReplyText, replyTextPath, STRIPPER, endsAttribution } from '../../src/proof/reply-text.js';
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
  // the verb followed by the name is an attribution too (name-after-verb form, SPEC B6.4 rule 1)
  assert.equal(b('x\r\nAm 03.11.2025 um 10:00 schrieb Bob:\r\n> q'), 'attribution');
  assert.equal(b('x\r\nLe lun. 3 nov. 2025 à 10:00, Bob a écrit :\r\n> q'), 'attribution');
  assert.equal(b('x\r\nOn Mon,\r\nNov 3,\r\n2025 at 10:00 Bob\r\n<b@example.net> wrote:\r\n> q'), 'attribution');
  assert.equal(b('x\r\nOn Mon,\r\nNov 3,\r\n2025 at 10:00 Bob\r\n<b@example.net>\r\nwrote:\r\n> q'), 'quote-run', 'five lines is too many');
  assert.equal(b('x\r\nOn the other hand, he wrote a letter\r\nand then slept.'), null, 'no line ends with the verb');
  assert.equal(b('x\r\nOn Monday we agreed.\r\n\r\nwrote:'), null, 'an empty line ends the lookahead');
  assert.equal(b('x\r\n  > indented is not a quote line'), null);
  assert.equal(b('x\r\nBegin forwarded message:\r\n\r\ny'), 'forward-marker');
  assert.equal(b('x\r\nFrom: a\r\nnothing like a sent line\r\n'), null);
});

test('attribution with the name after the verb (Dutch, German) and the language-independent rule above a > run', () => {
  const r = (body) => stripReplyText(plain(body));
  const nl = 'Op vr 7 nov 2026 om 10:00 schreef Amr <a@example.com>:';
  // Dutch, > quote: the attribution is not in the text, the text is exactly the reply
  let x = r(`Ja, akkoord.\r\n\r\n${nl}\r\n> Betaling goedkeuren?\r\n`);
  assert.deepEqual([x.text, x.boundary, x.quote], ['Ja, akkoord.', 'attribution', 'found']);
  // wrapped over two lines
  x = r('Ja, akkoord.\r\n\r\nOp vr 7 nov 2026 om 10:00 schreef Amr <\r\na@example.com>:\r\n> Betaling goedkeuren?\r\n');
  assert.deepEqual([x.text, x.boundary], ['Ja, akkoord.', 'attribution']);
  // German with > quote
  x = r('Einverstanden.\r\n\r\nAm 07.11.2026 um 10:00 schrieb Amr:\r\n> Zahlung freigeben?\r\n');
  assert.deepEqual([x.text, x.boundary], ['Einverstanden.', 'attribution']);
  // German without > marks: the quoted request is not in the text
  x = r('Einverstanden.\r\n\r\nAm 07.11.2026 um 10:00 schrieb Amr:\r\nZahlung freigeben?\r\n');
  assert.deepEqual([x.text, x.quote, x.boundary], ['Einverstanden.', 'found', 'attribution']);
  // a language with no listed verb, above a > run (Russian, Japanese)
  x = r('Да.\r\n\r\n7 ноября 2026 г. в 10:00 Amr <a@example.com> написал:\r\n> Утвердить?\r\n');
  assert.deepEqual([x.text, x.boundary], ['Да.', 'attribution']);
  x = r('了解です。\r\n\r\n2026年11月7日 10:00 Amr <a@example.com>:\r\n> 承認しますか？\r\n');
  assert.deepEqual([x.text, x.boundary], ['了解です。', 'attribution']);
  // one blank line between the attribution and the > run is allowed; two are not (shown with the unlisted-language form)
  const ru = '7 ноября 2026 г. в 10:00 Amr <a@example.com> написал:';
  assert.deepEqual([r('Да.\r\n' + ru + '\r\n> q').text, r('Да.\r\n' + ru + '\r\n\r\n> q').text], ['Да.', 'Да.']);
  assert.deepEqual([r('Да.\r\n' + ru + '\r\n\r\n\r\n> q').text, r('Да.\r\n' + ru + '\r\n\r\n\r\n> q').boundary], ['Да.\n' + ru, 'quote-run']);
  // negatives: the sender's own text stays
  x = r('Op maandag schreef ik het volgende:\r\nBetaal niet.\r\nGroet');
  assert.deepEqual([x.text, x.boundary], ['Op maandag schreef ik het volgende:\nBetaal niet.\nGroet', null]);
  x = r('Op maandag schreef ik het volgende:\r\nBetaal niet.\r\n> q');
  assert.deepEqual([x.text, x.boundary], ['Op maandag schreef ik het volgende:\nBetaal niet.', 'quote-run']);
  assert.equal(r('Am Montag schrieb ich:\r\nNein.').boundary, null);
  assert.equal(r('Am Montag schrieb ich:\r\nNein.\r\n> q').text, 'Am Montag schrieb ich:\nNein.');
  assert.equal(r('See below:\r\n> q').text, 'See below:');
  assert.equal(r('Ja.\r\nDetails:\r\n> q').text, 'Ja.\nDetails:');
  assert.equal(r('Ja, akkoord.\r\n' + nl + '\r\n> q').text, 'Ja, akkoord.', 'a reply line directly above the attribution stays');
  assert.equal(r('Да, согласен.\r\n' + ru + '\r\n> q').text, 'Да, согласен.', 'unlisted language: the reply line above stays');
  assert.equal(r('Ja, akkoord om 10:00 prima.\r\n' + nl + '\r\n> q').text, 'Ja, akkoord om 10:00 prima.', 'a sentence-ending line is not a wrap');
  assert.equal(r('Meeting on 12:30 sharp:\r\n> q').boundary, 'attribution', 'a time before a colon is a signal (documented limit: the rule is shape-based)');
  assert.equal(r('Ik schreef Amr:\r\nZahlung?').boundary, null, 'no opener: not the name-after-verb form');
  assert.equal(r('Ik schreef Amr op 2026-11-07:\r\nlater').boundary, null);
});

test('linear time: long lines in the attribution look-back and the name-after-verb form', () => {
  const long = 'Op ' + 'schreef '.repeat(50000) + ':';
  const bufs = [
    plain(long + '\r\n> q'),
    plain('a'.repeat(300000) + ':\r\n> q'),
    plain('<'.repeat(300000) + '\r\n' + '1234:'.repeat(1000) + '\r\n> q'),
    plain((' '.repeat(100000) + ':').repeat(3) + 'x\r\n> q'),
  ];
  for (const buf of bufs) {
    const ms = cpuMs(() => stripReplyText(buf));
    assert.ok(ms < 3000, `${ms} ms of CPU`);
  }
  assert.equal(stripReplyText(bufs[1]).boundary, 'quote-run', 'a very long line is never an attribution');
});

test('linear time: the 4-line attribution test on a long run of white space after a verb', () => {
  const raw = plain(`hi\r\nOn Mon\r\nfoo\r\nbar\r\nwrote${' '.repeat(250000)}x\r\n`);
  // measured before the fix: ~479 / 1821 / 7608 ms at 20k / 40k / 80k spaces, ~75 s at 250k; here a few milliseconds
  const ms = cpuMs(() => stripReplyText(raw));
  assert.ok(ms < 3000, `${ms} ms of CPU`);
  assert.equal(stripReplyText(raw).boundary, null);
  assert.equal(endsAttribution('wrote' + ' '.repeat(250000) + ':'), true);
  assert.equal(endsAttribution('wrote' + ' '.repeat(250000) + 'x'), false);
});

test('endsAttribution is exactly the old unanchored regex, on generated strings', () => {
  const OLD = /(wrote|schreef|schrieb|a écrit|a ecrit|escribió|escribio|ha scritto|escreveu|skrev|napisał|napisala)\s*:?\s*$/i;
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const verbs = ['wrote', 'schreef', 'schrieb', 'a écrit', 'a ecrit', 'escribió', 'escribio', 'ha scritto', 'escreveu', 'skrev', 'napisał', 'napisala',
    'WROTE', 'Wrote', 'A ÉCRIT', 'ESCRIBIÓ', 'NAPISAŁ', 'ha  scritto', 'rote', 'wrot', 'scritto', 'écrit'];
  const bits = [':', ' ', '  ', '\t', '\n', '\u00a0', '\u2003', '\ufeff', 'x', 'a', 'é', 'É', '.', '::', ' : ', 'ł', 'İ', 'ſ', '\u212a'];
  let n = 0, hits = 0;
  for (let k = 0; k < 20000; k++) {
    let s = '';
    const parts = 1 + rnd(6);
    for (let j = 0; j < parts; j++) s += rnd(3) === 0 ? bits[rnd(bits.length)] : rnd(2) ? verbs[rnd(verbs.length)] : bits[rnd(bits.length)];
    if (k % 2) s = s + verbs[rnd(verbs.length)] + bits[rnd(bits.length)] + (rnd(2) ? bits[rnd(bits.length)] : '');   // end on a verb plus a tail
    const want = OLD.test(s.trim());
    assert.equal(endsAttribution(s), want, JSON.stringify(s));
    n++; if (want) hits++;
  }
  assert.ok(hits > 1000 && hits < n - 1000, `both outcomes are exercised (${hits}/${n})`);
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
  assert.equal(replyTextPath('a'.repeat(32)), `replies/aa/${'a'.repeat(32)}.mailproof-quote-1.json`);
});

test('parity with the POC stripper (poc/m2-quotes/strip.mjs): text, hash and flags on every fixture', () => {
  // The POC decodes with the platform TextDecoder; on Node versions that get windows-1252 0x80-0x9F wrong (22.19.0) its
  // output differs by design from the in-house decoder, so those fixtures are compared only where the platform is right.
  const platform1252Ok = new TextDecoder('windows-1252').decode(Uint8Array.of(0x80)) === '\u20ac';
  for (const f of FIXTURES) {
    if (!platform1252Ok && /windows-1252/.test(f.name)) continue;
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

// windows-1252 is decoded in-house: Node's TextDecoder returns raw C1 controls for 0x80-0x9F on 22.19.0 and the real
// characters on 22.22, which made the stripper's text and text_sha256 depend on the Node version.
test('stripper: windows-1252 table for 0x80-0x9F is pinned for every WHATWG label, including no charset', () => {
  const expected = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8DŽ\x8F\x90‘’“”•–—˜™š›œ\x9DžŸ';
  assert.equal([...expected].length, 32);
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
  const body = bytes.toString('latin1');
  for (const label of ['windows-1252', 'iso-8859-1', 'latin1', 'cp1252', 'US-ASCII', ' Windows-1252 ', null]) {
    const ct = label === null ? 'text/plain' : `text/plain; charset="${label}"`;
    const r = stripReplyText(Buffer.from(`Content-Type: ${ct}\r\n\r\n${body}`, 'latin1'));
    assert.equal(r.text, expected, `label ${label}`);
  }
});

// GBK is decoded as gb18030 (what WHATWG defines it to be): Node 22.19.0's own gbk maps these to private-use code points.
test('stripper: gbk and gb2312 decode like gb18030 (0xFF, A2E3, A3A0, A6D9)', () => {
  for (const label of ['gbk', 'gb2312']) {
    const r = stripReplyText(Buffer.from(`Content-Type: text/plain; charset=${label}\r\n\r\n[\xff][\xa2\xe3][\xa3\xa0][\xa6\xd9]`, 'latin1'));
    assert.equal(r.text, '[\ufffd][\u20ac][\u3000][\ufe10]', label);
  }
});
