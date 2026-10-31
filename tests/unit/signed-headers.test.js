import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, parseTags, canonPair, selectSigned } from '../../src/proof/signed-headers.js';

const msg = 'Received: a\r\nSubject: one\r\n two\r\nTo: x@y\r\nReceived: b\r\nTo: z@y\r\n\r\nbody\r\n';

test('splitMessage keeps folds and returns the body', () => {
  const { rows, body } = splitMessage(msg);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].raw, 'Subject: one\r\n two');
  assert.equal(body.toString(), 'body\r\n');
});

test('selectSigned takes duplicates bottom-up and ignores oversigned names', () => {
  const { rows } = splitMessage(msg);
  assert.deepEqual(selectSigned(rows, 'to:to:to:cc'), ['To: z@y', 'To: x@y']);
  assert.deepEqual(selectSigned(rows, 'subject'), ['Subject: one\r\n two']);
});

test('parseTags and canonPair', () => {
  assert.deepEqual(parseTags('DKIM-Signature: v=1; d=a.b; b=ab\r\n cd'), { v: '1', d: 'a.b', b: 'ab cd' });
  assert.deepEqual(canonPair(undefined), { h: 'simple', b: 'simple' });
  assert.deepEqual(canonPair('relaxed'), { h: 'relaxed', b: 'simple' });
});
