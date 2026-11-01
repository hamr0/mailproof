// The admission gate (src/proof/admit.js) must see the message the way the parsers will: the
// header/body boundary the way mailsplit (inside mailparser), mailauth's MessageParser and our
// splitMessage see it, and DKIM-Signature fields the way mailauth's header parser reads them.
// A gate that counts fewer signatures or a shorter header block than a parser reads can be
// shown a message that looks small and costs a lot. Each claim is checked against the real
// parsers, on named odd cases and on seeded random input.
import test from 'node:test';
import assert from 'node:assert/strict';
import mailparserPkg from 'mailparser';
import { MessageParser } from 'mailauth/lib/dkim/message-parser';
import { parseHeaders } from 'mailauth/lib/tools';
import { admit, overLimitReason } from '../../src/proof/admit.js';
import { splitMessage, signedNames, parseTags } from '../../src/proof/signed-headers.js';
import { MAX_BODY_LINE, MAX_MIME_PARTS, MAX_HEADER_BYTES, MAX_H_NAMES } from '../../src/proof/limits.js';

const { simpleParser } = /** @type {any} */ (mailparserPkg);

/** The body mailauth's MessageParser hands to its body hasher (it rewrites every bare LF to CRLF on the way). */
async function mailauthBody(buf) {
  class P extends MessageParser {
    chunks = [];
    async nextChunk(c) { this.chunks.push(c); }
  }
  const p = new P();
  p.end(buf);
  await new Promise((resolve, reject) => { p.on('finish', resolve); p.on('error', reject); });
  return Buffer.concat(p.chunks);
}
const norm = (b) => Buffer.from(b).toString('binary').replace(/\r\n/g, '\n');

/** Bytes after the header block, as the gate sees it. */
const gateBody = (buf) => buf.subarray(admit(buf).m.headerBytes);

// ---- header/body boundary -------------------------------------------------------------------------
const ODD = {
  'CRLF': 'A: 1\r\nB: 2\r\n\r\nbody\r\nX-Marker: m\r\n',
  'LF only': 'A: 1\nB: 2\n\nbody\nX-Marker: m\n',
  'LF then CRLF blank': 'A: 1\nB: 2\n\r\nbody\nX-Marker: m\n',
  'CRLF then LF blank': 'A: 1\r\nB: 2\r\n\nbody\nX-Marker: m\n',
  'leading blank line (LF)': '\nA: 1\n\nbody\nX-Marker: m\n',
  'leading blank line (CRLF)': '\r\nA: 1\r\n\r\nbody\r\nX-Marker: m\r\n',
  'two leading blank lines': '\n\nA: 1\n\nbody\nX-Marker: m\n',
  'CR CR LF is not an empty line': 'A: 1\r\n\r\r\nB: 2\r\n\r\nbody\r\nX-Marker: m\r\n',
  'blank-looking line with spaces is not empty': 'A: 1\r\n  \r\nB: 2\r\n\r\nbody\r\nX-Marker: m\r\n',
  'header only, no blank line': 'A: 1\r\nB: 2',
  'header then blank at the end': 'A: 1\r\n\r\n',
  'bare CR separators: no line ends at all': 'A: 1\rB: 2\r\rbody\rX-Marker: m\r',
};

for (const [name, text] of Object.entries(ODD)) {
  test(`boundary: ${name}`, async () => {
    const buf = Buffer.from(text, 'binary');
    const g = admit(buf);
    assert.equal(g.limit, null);
    const fromGate = norm(gateBody(buf));
    assert.equal(norm(splitMessage(buf).body), fromGate, 'splitMessage');
    assert.equal(norm(await mailauthBody(buf)), fromGate, 'mailauth MessageParser');
    // mailparser (mailsplit): a header-looking line is a header only before the boundary
    const mark = text.indexOf('X-Marker');
    if (mark >= 0 && g.m.headerBytes < buf.length) {
      const p = await simpleParser(buf);
      assert.equal(p.headers.has('x-marker'), g.m.headerBytes > mark, 'mailparser agrees on where the headers end');
    }
  });
}

test('boundary: a message with a leading blank line has no header fields and no signatures, whatever follows', () => {
  const buf = Buffer.from('\r\nDKIM-Signature: v=1; h=a\r\nFrom: x@y\r\n\r\nbody');
  const g = admit(buf);
  assert.deepEqual([g.m.headerLines, g.m.headerFields, g.m.signatures], [0, 0, 0]);
  assert.equal(splitMessage(buf).rows.length, 0, 'splitMessage reads no headers either');
});

// ---- seeded random messages ----------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

test('boundary: gate = splitMessage = mailauth over 400 random messages with odd line endings', async () => {
  const r = rng(7);
  const pieces = ['A: 1', 'B: two', ' folded', '\tfold', '', '', '', '', '   ', ':', 'noColon', 'DKIM-Signature: v=1', 'body text', '--bnd'];
  const eols = ['\r\n', '\n', '\r', '\r\r\n', '\n\r', '\r\n', '\n'];
  let withBody = 0;
  for (let k = 0; k < 400; k++) {
    let text = '';
    for (let i = 0, n = 1 + Math.floor(r() * 9); i < n; i++) text += pick(r, pieces) + (r() < 0.9 ? pick(r, eols) : '');
    const buf = Buffer.from(text, 'binary');
    const g = admit(buf);
    if (g.limit !== null) continue;
    const want = norm(gateBody(buf));
    assert.equal(norm(splitMessage(buf).body), want, `case ${k} splitMessage ${JSON.stringify(text)}`);
    assert.equal(norm(await mailauthBody(buf)), want, `case ${k} mailauth ${JSON.stringify(text)}`);
    if (want.length) withBody++;
  }
  assert.ok(withBody > 100, `only ${withBody} cases had a body`);
});

// ---- DKIM-Signature fields as mailauth reads them -----------------------------------------------------
const SIG_PIECES = [
  'DKIM-Signature: v=1; d=a.example; h=from:to; b=AA',
  'dkim-signature : v=1; h=a:b:c',
  'DKIM-Signature',                // the name alone: the colon may follow on the next line
  'DKIM-Signature\t',
  ' : v=1; h=a:b',
  ': v=1; h=a:b:c:d',
  '\tcontinuation; h=x:y:z',
  'junk without a colon',
  'h=a:b:c:d:e',
  'X-Other: v',
  'From: me@x.example',
  'DKIM-Signature\xa0: v=1',
  'DKIM-Signatures: v=1',
  'xDKIM-Signature: v=1',
  'DKIM-Signature :',
  ' ',
  // whitespace parseTags trims (String.trim: HT LF VT FF CR SP NBSP) before, after and inside a tag name
  'DKIM-Signature: v=1;\x0bh=a:b:c:d:e',
  'DKIM-Signature: v=1;\x0ch=a:b:c:d',
  'DKIM-Signature: v=1;\xa0h=a:b:c',
  'DKIM-Signature: v=1;\rh=a:b:c:d:e:f',
  'DKIM-Signature: v=1; h\x0b=a:b:c:d',
  'DKIM-Signature: v=1; h\xa0\x0c =a:b:c',
  'DKIM-Signature: v=1;\x0b \xa0\x0c\th=a:b:c:d:e:f:g',
  'DKIM-Signature: x\x0bh=a:b; \xa0h=a:b:c',   // "x\x0bh" is one name (not h); the second is h
];

test('signatures: the gate counts every DKIM-Signature mailauth reads, and sizes each as mailauth does (600 random header blocks)', () => {
  const r = rng(11);
  let seen = 0, folded = 0;
  for (let k = 0; k < 600; k++) {
    const eol = pick(r, ['\r\n', '\n']);
    const lines = Array.from({ length: 1 + Math.floor(r() * 9) }, () => pick(r, SIG_PIECES));
    const block = lines.join(eol);
    const buf = Buffer.from(block + eol + eol + 'body', 'binary');
    const rows = parseHeaders(Buffer.from(block, 'binary')).parsed.filter((x) => x.key === 'dkim-signature');
    const g = admit(buf);
    if (rows.length > 10) continue;
    assert.equal(g.m.signatures, rows.length, `case ${k} ${JSON.stringify(block)}`);
    if (rows.length) seen++;
    if (rows.some((x) => x.line.toString('binary').includes('\n'))) folded++;
    // never smaller than the largest field mailauth sees (mailauth counts every line ending as CRLF, so only compare when they are)
    const biggest = Math.max(0, ...rows.map((x) => x.line.length));
    const names = Math.max(0, ...rows.map((x) => signedNames(parseTags(x.line.toString('binary')).h || '').length));
    if (eol === '\r\n') assert.ok(g.m.maxSigBytes >= biggest, `case ${k} size: gate ${g.m.maxSigBytes} < ${biggest}`);
    assert.ok(g.m.maxHNames >= names, `case ${k} h= names: gate ${g.m.maxHNames} < ${names}`);
  }
  assert.ok(seen > 200 && folded > 30, `weak corpus: ${seen} with signatures, ${folded} folded`);
});

test('h_names: whitespace parseTags trims before a tag name does not hide h= from the limit', () => {
  const names = Array.from({ length: MAX_H_NAMES + 1 }, (_, i) => `n${i}`).join(':');
  for (const ws of ['\x0b', '\x0c', '\xa0', '\r', '\t', ' ', '\x0b\xa0 \x0c']) {
    const buf = Buffer.from(`DKIM-Signature: v=1;${ws}h=${names}; b=AA\r\nFrom: x@y\r\n\r\nbody`, 'binary');
    assert.equal(signedNames(parseTags(buf.toString('binary').split('\r\n')[0]).h).length, MAX_H_NAMES + 1, `the parser reads the names after ${JSON.stringify(ws)}`);
    assert.equal(admit(buf).limit, 'h_names', `refused after ${JSON.stringify(ws)}`);
  }
  // ... and between the name and the = sign
  const buf = Buffer.from(`DKIM-Signature: v=1; h\x0b=${names}\r\n\r\nbody`, 'binary');
  assert.equal(admit(buf).limit, 'h_names');
});

test('signatures: a DKIM-Signature whose colon sits on the next line, or hides behind junk lines, is counted and sized', () => {
  const mk = (...lines) => Buffer.from(lines.join('\r\n') + '\r\n\r\nbody');
  assert.equal(admit(mk('DKIM-Signature', ' : v=1; h=a')).m.signatures, 1);
  assert.equal(parseHeaders(Buffer.from('DKIM-Signature\r\n : v=1; h=a')).parsed[0].key, 'dkim-signature', 'mailauth reads it as one');
  // junk lines (no leading space, no colon) belong to the signature above them in mailauth's reading, so they count towards its size
  const junk = 'A'.repeat(1000);
  const g = admit(mk('DKIM-Signature: v=1; h=a', junk, junk, 'From: x@y'));
  assert.ok(g.m.maxSigBytes > 2000, `junk lines were not counted: ${g.m.maxSigBytes}`);
  // ... and so do h= names that continue on such lines (one that read "b:c" would open a field named b)
  const g2 = admit(mk('DKIM-Signature: v=1; h=a', 'b c:d:e', 'From: x@y'));
  assert.equal(g2.m.maxHNames, 3);
  assert.equal(signedNames(parseTags(parseHeaders(mk('DKIM-Signature: v=1; h=a', 'b c:d:e', 'From: x@y').subarray(0, 40 + 11)).parsed[0].line.toString('binary')).h).length, 3, 'as mailauth and the record read it');
  // the first line of the block opens a field whatever it is: a bare name there is a signature to mailauth
  assert.equal(admit(mk('DKIM-Signature', 'X-Other: v')).m.signatures, 1);
  assert.equal(parseHeaders(Buffer.from('DKIM-Signature\r\nX-Other: v')).parsed[0].key, 'dkim-signature');
  assert.equal(admit(mk('X-Other: v', 'DKIM-Signature', 'X-Other: v')).m.signatures, 0, '... but only the first line');
  // the first field's name is read across lines, line breaks removed: this is a signature to mailauth too
  const odd = ['DKIM-Sig', 'nature', '  ', ' : v=1; h=a'];
  assert.equal(parseHeaders(Buffer.from(odd.join('\r\n'))).parsed[0].key, 'dkim-signature');
  assert.equal(admit(mk(...odd)).m.signatures, 1);
});

test('signatures: names in every h= tag count (the largest wins), across folds', () => {
  const buf = Buffer.from('DKIM-Signature: h=a:b:c:d:e:f; h=a;\r\n\th=a:b:c; b=AA\r\nFrom: x@y\r\n\r\n');
  assert.equal(admit(buf).m.maxHNames, 6);
  // a tag that merely ends in h, or a value containing "h=", is not an h= tag
  assert.equal(admit(Buffer.from('DKIM-Signature: bh=a:b:c:d; xh=a:b:c; b=h=a:b:c:d:e\r\n\r\n')).m.maxHNames, 0);
});

// ---- MIME delimiters and body lines -----------------------------------------------------------------------
test('mime_parts counts delimiter lines mailsplit would act on, including one behind a lone CR', () => {
  const body = (line, n) => Buffer.from('A: 1\r\n\r\n' + Array.from({ length: n }, () => line).join('\n') + '\n');
  assert.equal(admit(body('--bnd', MAX_MIME_PARTS)).limit, null);
  assert.equal(admit(body('--bnd', MAX_MIME_PARTS + 1)).limit, 'mime_parts');
  assert.equal(admit(body('\r--bnd', MAX_MIME_PARTS + 1)).limit, 'mime_parts', 'a lone CR in front of the delimiter still delimits (mailsplit)');
  assert.equal(admit(body('-x--bnd', MAX_MIME_PARTS + 1)).limit, null, 'not at the start of the line');
});

test('body_line: the line ending is not counted; a last line with no ending is', () => {
  const head = 'A: 1\r\n\r\n';
  const line = (n, end) => Buffer.from(head + 'a'.repeat(n) + end);
  for (const end of ['\r\n', '\n', '']) {
    assert.equal(admit(line(MAX_BODY_LINE, end)).limit, null, JSON.stringify(end));
    assert.equal(admit(line(MAX_BODY_LINE + 1, end)).limit, 'body_line', JSON.stringify(end));
  }
});

test('header_bytes is measured to and including the empty line', () => {
  const pad = (n) => Buffer.from('A: ' + 'a'.repeat(n - 3 - 2) + '\r\n\r\nbody');   // header block = n + 2 bytes with the empty line
  assert.equal(admit(pad(MAX_HEADER_BYTES - 2)).limit, null);
  assert.equal(admit(pad(MAX_HEADER_BYTES - 1)).limit, 'header_bytes');
});

test('the reason has one stable form', () => {
  assert.equal(overLimitReason('body_line'), 'over limit: body_line');
});
