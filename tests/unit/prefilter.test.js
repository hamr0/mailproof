'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preFilter, extractHeaderBlock, rawHeader } = require('../../src/prefilter');

const headers = (lines) => lines.join('\r\n') + '\r\n\r\nbody\r\n';

test('preFilter: clean human reply passes', () => {
  const block = headers(['From: alice@example.com', 'To: event+abc-step1@example.com', 'Subject: hi']);
  assert.deepEqual(preFilter(block, 'alice@example.com'), { rejected: false, reason: null });
});

test('preFilter: Auto-Submitted: auto-replied is rejected', () => {
  const block = headers([
    'From: ooo@example.com',
    'To: event+abc-step1@example.com',
    'Auto-Submitted: auto-replied',
    'Subject: out of office',
  ]);
  const res = preFilter(block, 'ooo@example.com');
  assert.equal(res.rejected, true);
  assert.match(res.reason, /^auto-submitted: auto-replied$/);
});

test('preFilter: Auto-Submitted: no is allowed', () => {
  const block = headers(['From: alice@example.com', 'Auto-Submitted: no']);
  assert.equal(preFilter(block, 'alice@example.com').rejected, false);
});

test('preFilter: List-Id rejects', () => {
  const block = headers(['From: announce@example.com', 'List-Id: <announce.example.com>']);
  assert.equal(preFilter(block, 'announce@example.com').rejected, true);
});

test('preFilter: List-Unsubscribe rejects', () => {
  const block = headers(['From: news@example.com', 'List-Unsubscribe: <https://example.com/unsub>']);
  assert.equal(preFilter(block, 'news@example.com').rejected, true);
});

test('preFilter: Precedence: bulk rejects', () => {
  const block = headers(['From: bulk@example.com', 'Precedence: bulk']);
  assert.equal(preFilter(block, 'bulk@example.com').rejected, true);
});

test('preFilter: Precedence: junk rejects', () => {
  const block = headers(['From: junk@example.com', 'Precedence: junk']);
  assert.equal(preFilter(block, 'junk@example.com').rejected, true);
});

test('preFilter: noreply@ system sender rejects', () => {
  const block = headers(['From: noreply@bigservice.com']);
  const res = preFilter(block, 'noreply@bigservice.com');
  assert.equal(res.rejected, true);
  assert.match(res.reason, /system sender/);
});

test('preFilter: mailer-daemon rejects', () => {
  const block = headers(['From: mailer-daemon@anywhere.com']);
  assert.equal(preFilter(block, 'mailer-daemon@anywhere.com').rejected, true);
});

test('preFilter: case-insensitive header matching', () => {
  const block = headers(['from: ooo@example.com', 'auto-submitted: auto-replied']);
  assert.equal(preFilter(block, 'ooo@example.com').rejected, true);
});

test('rawHeader: handles folded headers (continuation lines)', () => {
  const block = 'List-Unsubscribe: <https://example.com/unsub>,\r\n  <mailto:unsub@example.com>\r\n\r\nbody';
  const v = rawHeader(block, 'List-Unsubscribe');
  assert.match(v, /unsub@example\.com/);
});

test('extractHeaderBlock: splits at first blank line (CRLF)', () => {
  const raw = Buffer.from('From: a@b\r\nSubject: x\r\n\r\nbody here');
  assert.equal(extractHeaderBlock(raw, 4096), 'From: a@b\r\nSubject: x');
});

test('extractHeaderBlock: splits at LF blank line too', () => {
  const raw = Buffer.from('From: a@b\nSubject: x\n\nbody');
  assert.equal(extractHeaderBlock(raw, 4096), 'From: a@b\nSubject: x');
});

test('extractHeaderBlock: respects maxBytes cap', () => {
  const raw = Buffer.from('A'.repeat(1000) + '\r\n\r\nbody');
  const block = extractHeaderBlock(raw, 100);
  assert.equal(block.length, 100);
});
