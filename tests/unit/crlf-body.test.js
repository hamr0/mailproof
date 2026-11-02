// crlfBody / hashInput (src/proof/body-status.js): the shared bare-LF -> CRLF copy of a body that is fed to
// the RELAXED hasher once per message instead of letting mailauth convert it, line by line, once per
// signature. It is only valid if the digest AND the canonicalised length are identical to hashing the
// original, so that is checked against mailauth itself on seeded mixed-ending fuzz (empty, no final
// newline, trailing whitespace, lone CR, CR CR LF, l= cutting mid-line, both algorithms). `simple` is
// the counterexample that decides the scope: it hashes a bare LF as it is, so it must NOT get the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dkimBody } from 'mailauth/lib/dkim/body';
import { crlfBody, hashInput } from '../../src/proof/body-status.js';

const ATOMS = ['a', 'b', ' ', '\t', '\r', '\n', '\r\n', '\n', '\r\n', 'x y', '  ', '\r\r\n', '\n\n', '\r\n\r\n'];
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }
const digest = (mode, alg, l, buf) => { const h = dkimBody(mode, alg, l); h.update(buf); return `${h.digest('base64')}|${h.canonicalizedLength}`; };

test('crlfBody: bare LF becomes CRLF, everything else (CRLF, lone CR, CR CR LF) is untouched; no bare LF returns the same buffer', () => {
  const b = (s) => Buffer.from(s, 'binary');
  assert.equal(crlfBody(b('a\nb\r\nc\n')).toString('binary'), 'a\r\nb\r\nc\r\n');
  assert.equal(crlfBody(b('\n')).toString('binary'), '\r\n');
  assert.equal(crlfBody(b('a\rb\r\r\n')).toString('binary'), 'a\rb\r\r\n');
  const clean = b('a\r\nb\r\n');
  assert.equal(crlfBody(clean), clean);
  assert.equal(crlfBody(b('')).length, 0);
  const lf = b('x\ny');
  assert.equal(crlfBody(lf), crlfBody(lf), 'built once per buffer');
});

test('hashInput: relaxed gets the copy, simple gets the original bytes', () => {
  const lf = Buffer.from('x\ny\n');
  assert.equal(hashInput('simple', lf), lf);
  assert.equal(hashInput('relaxed', lf).toString(), 'x\r\ny\r\n');
});

test('relaxed: digest and canonical length equal those of the original, on mixed-ending fuzz', () => {
  const rnd = rng(12345);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const count = Math.floor(rnd() * 30);
    let s = '';
    for (let k = 0; k < count; k++) s += ATOMS[Math.floor(rnd() * ATOMS.length)];
    const buf = Buffer.from(s, 'binary');
    for (const alg of ['sha1', 'sha256']) {
      for (const l of [false, 0, 1, 2, 3, 5, 7, Math.floor(rnd() * (buf.length + 3))]) {
        n++;
        assert.equal(digest('relaxed', alg, l, crlfBody(buf)), digest('relaxed', alg, l, buf), JSON.stringify([s, alg, l]));
      }
    }
  }
  assert.ok(n > 60000);
});

test('simple is NOT equivalent (why hashInput leaves it alone)', () => {
  const buf = Buffer.from('x\ny\n');
  assert.notEqual(digest('simple', 'sha256', false, crlfBody(buf)), digest('simple', 'sha256', false, buf));
});
