
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../src/envelope.js';

test('parseEnvelope: full argv from the Postfix pipe transport', () => {
  const argv = ['node', 'receive.js', '52.103.33.36', 'mail.example.com', 'a@b.com', 'event+abc-step1@example.com'];
  assert.deepEqual(parseEnvelope(argv), {
    clientIp: '52.103.33.36',
    clientHelo: 'mail.example.com',
    sender: 'a@b.com',
    recipient: 'event+abc-step1@example.com',
  });
});

test('parseEnvelope: "unknown" placeholders normalised to null', () => {
  const argv = ['node', 'receive.js', 'unknown', 'unknown', 'a@b.com', 'r@example.com'];
  const e = parseEnvelope(argv);
  assert.equal(e.clientIp, null);
  assert.equal(e.clientHelo, null);
  assert.equal(e.sender, 'a@b.com');
});

test('parseEnvelope: missing args produce nulls', () => {
  const argv = ['node', 'receive.js'];
  assert.deepEqual(parseEnvelope(argv), {
    clientIp: null, clientHelo: null, sender: null, recipient: null,
  });
});
