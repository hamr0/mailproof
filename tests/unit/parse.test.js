
// Inbound decoding (src/parse.js). parseMessage is a deterministic function of
// the raw bytes; authenticateMessage runs the real mailauth pipeline OFFLINE
// via an injected resolver (no network), so both live here as fast unit tests.
// We assert the WRAPPER's contract — the structured shape and that the safe
// defaults hold — not mailauth/mailparser internals (testing the vetted dep
// would be testing the dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, authenticateMessage } from '../../src/parse.js';
import { hashDocument } from '../../src/notary.js';
import { classifyTrust } from '../../src/classifier.js';

const CRLF = '\r\n';

// A multipart message with one base64 attachment whose decoded bytes are
// exactly "hello doc" (9 bytes) — so the expected hash is hashDocument of that.
const WITH_ATTACHMENT = [
  'From: Alice <alice@example.com>',
  'To: event+abc-step1@mp.example',
  'Subject: Re: please sign',
  'Message-ID: <msg-1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b0"',
  '',
  '--b0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'hello',
  '--b0',
  'Content-Type: application/pdf; name="doc.pdf"',
  'Content-Disposition: attachment; filename="doc.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('hello doc').toString('base64'),
  '--b0--',
  '',
].join(CRLF);

const NO_ATTACHMENT = [
  'From: bob@example.com',
  'Subject: hi',
  'Message-ID: <m2@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'just a body',
  '',
].join(CRLF);

// -- parseMessage --

test('parseMessage: extracts from / messageId / attachment (notary-hashed)', async () => {
  const raw = Buffer.from(WITH_ATTACHMENT);
  const r = await parseMessage(raw);

  assert.deepEqual(r.from, { address: 'alice@example.com', name: 'Alice' });
  assert.equal(r.messageId, '<msg-1@example.com>');
  assert.equal(r.rawSha256, hashDocument(raw));

  assert.equal(r.attachments.length, 1);
  const att = r.attachments[0];
  assert.equal(att.filename, 'doc.pdf');
  assert.equal(att.size, 9);
  // The capture half: the stored hash is the notary fingerprint of the bytes.
  assert.equal(att.sha256, hashDocument(Buffer.from('hello doc')));
});

test('parseMessage: no attachments → empty array; absent name → null', async () => {
  const r = await parseMessage(Buffer.from(NO_ATTACHMENT));
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.from, { address: 'bob@example.com', name: null });
  assert.equal(r.messageId, '<m2@example.com>');
});

// -- authenticateMessage --

// Offline resolver: every DNS lookup fails as if the name does not exist, so no
// SPF/DKIM/DMARC/ARC can pass — deterministic and network-free.
const noDnsResolver = async () => {
  const e = new Error('test: no DNS');
  e.code = 'ENOTFOUND';
  throw e;
};

test('authenticateMessage: returns a classifiable result; no auth → unverified', async () => {
  const auth = await authenticateMessage(
    Buffer.from(NO_ATTACHMENT),
    { clientIp: '198.51.100.7', clientHelo: 'mta.example', sender: 'bob@example.com' },
    { resolver: noDnsResolver }
  );
  // Shape the classifier (m1) consumes.
  for (const k of ['dkim', 'spf', 'dmarc', 'arc']) {
    assert.ok(k in auth, `auth result has ${k}`);
  }
  // With no resolvable records nothing can authenticate.
  assert.equal(classifyTrust(auth), 'unverified');
});

test('authenticateMessage: tolerates an empty envelope (no ip/helo/sender)', async () => {
  const auth = await authenticateMessage(Buffer.from(NO_ATTACHMENT), {}, { resolver: noDnsResolver });
  assert.equal(classifyTrust(auth), 'unverified');
});
