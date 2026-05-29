
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRawMessage, newMessageId, sanitizeSubject, withSignature,
} from '../../src/outbound.js';

// --- newMessageId ---

test('newMessageId: RFC 5322 shape with domain', () => {
  assert.match(newMessageId('example.com'), /^<\d+\.[0-9a-f]{16}@example\.com>$/);
});

test('newMessageId: unique across rapid calls', () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add(newMessageId('example.com'));
  assert.equal(set.size, 100);
});

test('newMessageId: throws without a domain (no fallback)', () => {
  assert.throws(() => newMessageId(), /domain required/);
  assert.throws(() => newMessageId(''), /domain required/);
});

// --- buildRawMessage ---

test('buildRawMessage: emits required headers in CRLF', () => {
  const raw = buildRawMessage({
    from: 'A <a@example.com>', to: 'b@example.org', subject: 'hi',
    body: 'hello world', domain: 'example.com',
  });
  assert.ok(raw.includes('\r\n'), 'has CRLF');
  assert.ok(!/(?<!\r)\n/.test(raw), 'no bare LF');
  assert.match(raw, /^From: A <a@example\.com>\r\n/);
  assert.match(raw, /\r\nTo: b@example\.org\r\n/);
  assert.match(raw, /\r\nSubject: hi\r\n/);
  assert.match(raw, /\r\nMessage-Id: <\d+\.[0-9a-f]{16}@example\.com>\r\n/);
  assert.match(raw, /\r\nDate: .+\r\n/);
  assert.match(raw, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(raw, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
});

test('buildRawMessage: no footer emits body verbatim (no signature by default)', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: 'hello world', domain: 'x',
  });
  assert.match(raw, /\r\n\r\nhello world$/);
  assert.doesNotMatch(raw, /-- \r\n/);
});

test('buildRawMessage: injected footer is appended with the RFC 3676 separator', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: 'hello world', domain: 'x',
    footer: 'Acme Corp\nsupport@acme.test',
  });
  assert.match(raw, /\r\n\r\nhello world\r\n\r\n-- \r\nAcme Corp\r\nsupport@acme\.test$/);
});

test('buildRawMessage: carries NO gitdone branding (NO-GO §8.6 boundary)', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: 'hi', domain: 'x',
    // even when a footer is supplied, the core injects only what it is given
    footer: 'Acme',
  });
  assert.doesNotMatch(raw, /gitdone/i);
  assert.doesNotMatch(raw, /git-done\.com/);
  assert.doesNotMatch(raw, /feedback@/);
});

test('buildRawMessage: optional threading headers', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: '.',
    inReplyTo: '<msg-1@example.com>', references: '<msg-1@example.com>', domain: 'x',
  });
  assert.match(raw, /\r\nIn-Reply-To: <msg-1@example\.com>\r\n/);
  assert.match(raw, /\r\nReferences: <msg-1@example\.com>\r\n/);
});

test('buildRawMessage: autoSubmitted override and suppression', () => {
  const override = buildRawMessage({ from: 'a@x', to: 'b@x', subject: 's', body: '.', autoSubmitted: 'auto-generated', domain: 'x' });
  assert.match(override, /\r\nAuto-Submitted: auto-generated\r\n/);
  const suppressed = buildRawMessage({ from: 'a@x', to: 'b@x', subject: 's', body: '.', autoSubmitted: false, domain: 'x' });
  assert.doesNotMatch(suppressed, /Auto-Submitted:/);
});

test('buildRawMessage: extraHeaders appended', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: '.',
    extraHeaders: { 'X-Mailproof-Event': 'demo123' }, domain: 'x',
  });
  assert.match(raw, /\r\nX-Mailproof-Event: demo123\r\n/);
});

test('buildRawMessage: throws on missing required fields', () => {
  assert.throws(() => buildRawMessage({ from: 'a', to: 'b', subject: 'c' }));
  assert.throws(() => buildRawMessage({ from: 'a', to: 'b', body: 'x' }));
  assert.throws(() => buildRawMessage({ from: 'a', subject: 'c', body: 'x' }));
  assert.throws(() => buildRawMessage({ to: 'b', subject: 'c', body: 'x' }));
});

test('buildRawMessage: a body containing a single "." is passed through intact', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: 'line1\r\n.\r\nline3', domain: 'x',
  });
  assert.ok(raw.endsWith('line1\r\n.\r\nline3'));
});

test('buildRawMessage: strips CR/LF from subject (header injection guard)', () => {
  const raw = buildRawMessage({
    from: 'a@x.com', to: 'b@x.com', subject: 'evil\r\nBcc: attacker@x.com', body: 'hi', domain: 'x.com',
  });
  const headerBlock = raw.split('\r\n\r\n')[0];
  assert.match(headerBlock, /Subject: evil Bcc: attacker@x\.com/);
  assert.doesNotMatch(headerBlock, /^Bcc:/m);
});

// --- pure helpers ---

test('sanitizeSubject: collapses CR/LF runs to a single space', () => {
  assert.equal(sanitizeSubject('a\r\n\r\nb'), 'a b');
  assert.equal(sanitizeSubject(null), '');
});

test('withSignature: no footer returns body unchanged; footer is idempotent', () => {
  assert.equal(withSignature('body', null), 'body');
  const once = withSignature('body', 'foot');
  assert.equal(withSignature(once, 'foot'), once, 'appending the same footer twice is a no-op');
});
