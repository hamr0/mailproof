// Pure parts of replyFacts (SPEC B10): the closed-set mappings, firstLine, RFC 2047 words, direct parents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstLineOf, resultOf, dkimOf, replyBundle } from '../../src/proof/reply-facts.js';
import { decodeWords, headerText, claimedHeader } from '../../src/proof/header-text.js';
import { directParents } from '../../src/proof/participants.js';

test('firstLine: first non-empty line after ECMAScript trim; any line break; no case folding or normalisation', () => {
  assert.equal(firstLineOf(''), '');
  assert.equal(firstLineOf('   \n\t\n'), '');
  assert.equal(firstLineOf(' \n﻿ APPROVE  \nx'), 'APPROVE');
  assert.equal(firstLineOf('\r\r\rAPPROVE\rx'), 'APPROVE');
  assert.equal(firstLineOf('\r\n\r\nApprove\r\nno'), 'Approve');
  assert.equal(firstLineOf('  OK no'), 'OK no');   // U+2028 is trimmed at the ends but is not a line break of the contract
  assert.equal(firstLineOf('é'), 'é');                       // not normalised
});

test('closed sets: dmarc/spf/arc map to pass, fail, none, other; dkim to pass, fail, none', () => {
  assert.equal(resultOf(null), 'none'); assert.equal(resultOf({}), 'none'); assert.equal(resultOf({ result: 'none' }), 'none');
  assert.equal(resultOf({ result: 'pass' }), 'pass'); assert.equal(resultOf({ result: 'fail' }), 'fail');
  for (const r of ['softfail', 'neutral', 'temperror', 'permerror', 'policy', 'PASS', 'x']) assert.equal(resultOf({ result: r }), 'other', r);
  assert.equal(dkimOf(undefined), 'none'); assert.equal(dkimOf([]), 'none'); assert.equal(dkimOf([{ result: 'none' }]), 'none');
  assert.equal(dkimOf([{ result: 'fail' }, { result: 'pass' }]), 'pass'); assert.equal(dkimOf([{ result: 'fail' }]), 'fail');
  assert.equal(dkimOf([{ result: 'neutral' }]), 'fail'); assert.equal(dkimOf([{ result: 'none' }, { result: 'fail' }]), 'fail');
});

test('RFC 2047: B and Q words, adjacent words join, unknown charset stays, 8-bit UTF-8 header, windows-1252', () => {
  assert.equal(decodeWords('=?UTF-8?B?w4lsw6h2ZQ==?='), 'Élève');
  assert.equal(decodeWords('=?utf-8?Q?a_b=C3=A9?= =?utf-8?Q?c?='), 'a béc');
  assert.equal(decodeWords('x =?utf-8?Q?y?= z'), 'x y z');
  assert.equal(decodeWords('=?x-unknown?Q?y?='), '=?x-unknown?Q?y?=');
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9?='), 'café');
  assert.equal(decodeWords('=?windows-1252?B?gA==?='), '€');
  assert.equal(decodeWords('=?utf-8*en?Q?hi?='), 'hi');
  assert.equal(decodeWords('plain'), 'plain');
  assert.equal(headerText(Buffer.from('Café').toString('latin1')), 'Café');
});

test('claimedHeader: first occurrence, unfolded, only the header block', () => {
  const raw = Buffer.from('Subject: one\r\n two\r\nsubject: again\r\nDate: d\r\n\r\nSubject: in the body\r\n');
  assert.equal(claimedHeader(raw, 'subject'), 'one two');
  assert.equal(claimedHeader(raw, 'date'), 'd');
  assert.equal(claimedHeader(Buffer.from('X: 1\n\nDate: body\n'), 'date'), null);
});

test('directParents: In-Reply-To and the last References entry only', () => {
  const p = (m) => [...directParents({ message: m })].sort();
  assert.deepEqual(p({ in_reply_to: '<a>', references: ['<x>', '<y>'] }), ['<a>', '<y>']);
  assert.deepEqual(p({ in_reply_to: null, references: ['<x>', '<y>'] }), ['<y>']);
  assert.deepEqual(p({ references: [] }), []);
  assert.deepEqual(p(undefined), []);
});

test('replyBundle on a bare unsigned record: all strings, safe defaults', () => {
  const rec = { v: 2, id: 'a'.repeat(32), captured: '2026-11-01T00:00:00.000Z', message: {}, signatures: [], attachments: [], verdicts: {}, body_status: 'not-checked', message_key: null };
  const b = replyBundle({ rec, parent: '<p@x>', commit: '', trail: 't', raw: null, text: { source: 'none' } });
  for (const v of Object.values(b)) assert.equal(typeof v, 'string');
  assert.equal(b.fromDkimAligned, 'none'); assert.equal(b.live, 'unverified'); assert.equal(b.link, 'none'); assert.equal(b.dateSource, 'none');
  assert.equal(b.dkim, 'none'); assert.equal(b.messageKey, '');
});
