
// Contested-commit reverify (m7c-3). A reply whose DKIM didn't align at
// reception (so it was recorded below `verified`) is later proven by forwarding
// the raw .eml: we re-run DKIM against the ARCHIVED key and, on a pass, upgrade
// the recorded trust — persisting an IMMUTABLE reverify-NNN.json (the original
// commit is never rewritten). End to end on the real ledger + mailauth, offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';
import { makeDkimKeypair, signDkim, buildResolver, verifiedFixture, noDnsResolver } from '../helpers/dkim.js';

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-reverify-'));

// A message DKIM-signed by a domain that does NOT match the From domain
// (non-aligned). DKIM verifies cryptographically (so a key gets archived) but
// alignment fails ⇒ classifyTrust → 'unverified' at reception. The resolver
// serves only the signer's DKIM key.
async function nonAlignedSigned({ signDomain = 'mailer.example', selector = 'sel1', from, to }) {
  const { privPem, pubB64 } = makeDkimKeypair();
  const unsigned = [
    `From: ${from}`, `To: ${to}`, 'Subject: Re: please sign',
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}@${signDomain}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'I confirm.\r\n',
  ].join('\r\n');
  const signedEml = await signDkim(unsigned, { domain: signDomain, selector, privateKeyPem: privPem });
  const resolver = buildResolver({ [`${selector}._domainkey.${signDomain}`]: `v=DKIM1; k=rsa; p=${pubB64}` });
  return { signedEml, resolver };
}

test('reverify: upgrades a contested (non-aligned) commit to verified against the archived key', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await nonAlignedSigned({
      from: 'alice@corp.example', to: `event+rv01-sign@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'rv01', type: 'workflow', flow: 'sequential', activated_at: '2026-01-01T00:00:00Z',
      // minTrust unverified so the reply still commits with its archived key.
      steps: [{ id: 'sign', participant: 'alice@corp.example', minTrust: 'unverified' }],
    });
    const ing = await core.ingest(signedEml, envOf(`event+rv01-sign@${OPERATOR}`, 'alice@corp.example'));
    assert.equal(ing.trustLevel, 'unverified'); // not aligned ⇒ below verified at reception

    // Forward the raw .eml to contest it; re-verify against the archived key with NO live DNS.
    const r = await core.reverify('rv01', ing.committedSeq, signedEml, { resolver: noDnsResolver });
    assert.equal(r.found, true);
    assert.equal(r.dkim_reverify.ok, true);
    assert.equal(r.upgraded, true);
    assert.equal(r.trust_level_before, 'unverified');
    assert.equal(r.trust_level_after, 'verified');
    assert.equal(r.reverifySequence, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('reverify: an already-verified commit records the attempt but does not upgrade', async () => {
  const tmp = await tmpDir();
  try {
    const { signedEml, resolver } = await verifiedFixture({
      domain: 'signer.example', from: 'alice@signer.example', to: `attest+rv02@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver });
    await core.createEvent({
      id: 'rv02', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@signer.example'], threshold: 1,
    });
    const ing = await core.ingest(signedEml, envOf(`attest+rv02@${OPERATOR}`, 'alice@signer.example'));
    assert.equal(ing.trustLevel, 'verified');

    const r = await core.reverify('rv02', ing.committedSeq, signedEml, { resolver: noDnsResolver });
    assert.equal(r.found, true);
    assert.equal(r.dkim_reverify.ok, true);
    assert.equal(r.upgraded, false);
    assert.equal(r.trust_level_after, 'verified');
    assert.equal(r.policy_note, 'already verified');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('reverify: a missing target commit returns found:false, not an error', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: noDnsResolver });
    await core.createEvent({
      id: 'rv03', type: 'crypto', activated_at: '2026-01-01T00:00:00Z',
      signers: ['a@x.example'], threshold: 1,
    });
    const r = await core.reverify('rv03', 9, Buffer.from('x'));
    assert.equal(r.found, false);
    assert.match(r.reason, /no commit-009/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
