
// Offline durable verification (m7c-2). End to end: ingest a DKIM-signed reply
// (which archives the signer's public key on the commit), then verify the exact
// original bytes against that ARCHIVED key with live DNS disabled — proving the
// signature holds offline, the way a third party would re-check the proof after
// the signer rotates their DNS. No mocks; the real ledger + mailauth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';
import { verifiedFixture, noDnsResolver } from '../helpers/dkim.js';

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-verify-'));

test('verify: the exact committed email re-verifies against the archived key with NO live DNS', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await verifiedFixture({
      domain: 'signer.example', selector: 'sel1',
      from: 'alice@signer.example', to: `attest+v01@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'v01', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@signer.example'], threshold: 1,
    });
    await core.ingest(signedEml, envOf(`attest+v01@${OPERATOR}`, 'alice@signer.example'));

    // baseResolver = noDns: the archived key is the ONLY way DKIM can verify.
    const r = await core.verify('v01', signedEml, { resolver: noDnsResolver });
    assert.equal(r.matched, true);
    assert.equal(r.matchType, 'raw_email');
    assert.equal(r.sequence, 1);
    assert.equal(r.counted, true);
    assert.equal(r.trustLevel, 'verified');
    assert.equal(r.dkim_reverify.ok, true);            // verified against the ARCHIVED key, offline
    assert.equal(r.dkim_reverify.result, 'pass');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verify: a tampered email does not match the ledger', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await verifiedFixture({
      domain: 'signer.example', from: 'alice@signer.example', to: `attest+v02@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'v02', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@signer.example'], threshold: 1,
    });
    await core.ingest(signedEml, envOf(`attest+v02@${OPERATOR}`, 'alice@signer.example'));

    const tampered = Buffer.concat([signedEml, Buffer.from('\r\nX-Tamper: 1\r\n')]);
    const r = await core.verify('v02', tampered, { resolver: noDnsResolver });
    assert.equal(r.matched, false);
    assert.equal(r.matchType, 'none');
    assert.equal(r.dkim_reverify, undefined); // no match ⇒ no re-verify attempted
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verify: matches a committed attachment by its hash (accept-with-flag commits the doc)', async () => {
  const tmp = await tmpDir();
  try {
    const DOC = Buffer.from('the signed contract bytes');
    const multipartEml = Buffer.from([
      'From: alice@corp.example', `To: event+v03-sign@${OPERATOR}`, 'Subject: Re: sign',
      'Message-ID: <doc@corp.example>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain', '', 'see attached',
      '--b1', 'Content-Type: application/pdf; name="c.pdf"',
      'Content-Disposition: attachment; filename="c.pdf"',
      'Content-Transfer-Encoding: base64', '', DOC.toString('base64'), '--b1--', '',
    ].join('\r\n'));

    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    await core.createEvent({
      id: 'v03', type: 'workflow', flow: 'sequential', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'sign', participant: 'alice@corp.example', requires_attachment: true }],
    });
    // Unverified ⇒ committed but not counted; the attachment is recorded either way.
    await core.ingest(multipartEml, envOf(`event+v03-sign@${OPERATOR}`, 'alice@corp.example'));

    const r = await core.verify('v03', DOC);
    assert.equal(r.matched, true);
    assert.equal(r.matchType, 'attachment');
    assert.equal(r.sequence, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verify: unknown event with no commits returns matched:false, not an error', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    const r = await core.verify('nope', Buffer.from('anything'));
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'no_commits');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
