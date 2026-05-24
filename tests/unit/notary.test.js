'use strict';

// Document notary — pure half (PRD §4.1). hashDocument is the one source of
// truth for the fingerprint format that m7's parser and verifyDocument share.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashDocument, createNotary } = require('../../src/notary');

test('hashDocument: sha256:-prefixed lowercase hex, deterministic', () => {
  const h = hashDocument(Buffer.from('contract bytes'));
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, hashDocument(Buffer.from('contract bytes')));   // stable
});

test('hashDocument: matches a plain SHA-256 of the same bytes', () => {
  const bytes = Buffer.from('hello');
  const expected = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(hashDocument(bytes), expected);
});

test('hashDocument: distinct inputs → distinct hashes; string == its utf8 bytes', () => {
  assert.notEqual(hashDocument('a'), hashDocument('b'));
  assert.equal(hashDocument('café'), hashDocument(Buffer.from('café', 'utf8')));
});

test('createNotary: requires both gitrepo and eventStore', () => {
  assert.throws(() => createNotary({}), /gitrepo.*eventStore|required/);
  assert.throws(() => createNotary({ gitrepo: {} }), /required/);
});
