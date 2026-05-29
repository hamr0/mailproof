
// m7c-6 — the PUBLIC verification email endpoints wired through ingest():
//   verify+<id>@           → match a forwarded original to a committed reply
//                            (+ DKIM re-verify against the archived key), READ-ONLY
//   reverify+<id>-<seq>@   → re-evaluate ONE contested commit, persisting an
//                            immutable reverify record
// Both emit a *_report occasion through the shared deliver() seam (neutral
// default body; prose is policy). The verify primitives themselves are covered
// by reverify.test.js / verifier.test.js — here we prove the EMAIL WIRING:
// routing, candidate extraction from a forwarded attachment, and the report send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';
import { verifiedSigner, makeDkimKeypair, signDkim, buildResolver } from '../helpers/dkim.js';

// A message DKIM-signed by a domain that does NOT align with From: it verifies
// cryptographically (a key is archived) but classifies 'unverified' at reception
// — the contested case reverify+ exists to repair.
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

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-verifyep-'));

// Same capture-to-file fake sendmail used elsewhere.
function fakeSendmail() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'mailproof-cap-'));
  const script = path.join(dir, 'sendmail.sh');
  fss.writeFileSync(script, `#!/bin/sh\nf=$(mktemp "${dir}/msg.XXXXXX")\ncat > "$f"\nexit 0\n`, { mode: 0o755 });
  return {
    script,
    cleanup: () => fss.rmSync(dir, { recursive: true, force: true }),
    captures: () => fss.readdirSync(dir).filter((f) => f.startsWith('msg.'))
      .map((f) => fss.readFileSync(path.join(dir, f), 'utf8')),
  };
}

// Wrap an original .eml as a base64 attachment on a clean human-looking forward
// (so the candidate bytes round-trip exactly → the commit's raw_sha256 matches).
function forwardWithEml(originalEml, { from, to }) {
  const b64 = Buffer.from(originalEml).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`, `To: ${to}`, 'Subject: Fwd: please verify',
    `Date: ${new Date().toUTCString()}`, `Message-ID: <fwd.${Date.now()}@asker.example>`,
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BORDER"', '',
    '--BORDER', 'Content-Type: text/plain; charset=utf-8', '', 'Please verify the attached original.',
    '--BORDER',
    'Content-Type: application/octet-stream',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="original.eml"', '',
    b64,
    '--BORDER--', '',
  ].join('\r\n');
}

test('verify+: a forwarded original matches its commit and a MATCH report is sent', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'vfy1', type: 'crypto', title: 'Sign deed', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });
    const original = await signer.sign({ from: 'alice@signer.example', to: `attest+vfy1@${OPERATOR}` });
    const ing = await core.ingest(original, envOf(`attest+vfy1@${OPERATOR}`, 'alice@signer.example'));
    assert.equal(ing.counted, true);

    // Forward the original to the public verify+ endpoint.
    const fwd = forwardWithEml(original, { from: 'auditor@asker.example', to: `verify+vfy1@${OPERATOR}` });
    const r = await core.ingest(fwd, envOf(`verify+vfy1@${OPERATOR}`, 'auditor@asker.example'));

    assert.equal(r.command, 'verify');
    assert.equal(r.matched, true);
    assert.equal(r.report.matchType, 'raw_email');
    assert.equal(r.report.sequence, ing.committedSeq);
    assert.equal(r.report.dkim_reverify.ok, true); // re-verified against the archived key
    assert.deepEqual(r.notified, [{ kind: 'verify_report', to: 'auditor@asker.example', ok: true, reason: null }]);

    const msg = cap.captures().find((m) => /To:\s*auditor@asker\.example/i.test(m));
    assert.match(msg, /Subject:.*Verification report/i);
    assert.match(msg, /MATCH/);
    assert.match(msg, /DKIM re-verify.*PASS/);
    assert.match(msg, /From:\s*verify\+vfy1@app\.example/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verify+: a forwarded message that matches nothing yields a NO MATCH report (no commit)', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const signer = verifiedSigner({ domain: 'signer.example' });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'vfy2', type: 'crypto', title: 'Sign', initiator: 'boss@signer.example',
      signers: ['alice@signer.example'], threshold: 1, activated_at: '2026-01-01T00:00:00Z',
    });
    const original = await signer.sign({ from: 'alice@signer.example', to: `attest+vfy2@${OPERATOR}` });
    await core.ingest(original, envOf(`attest+vfy2@${OPERATOR}`, 'alice@signer.example'));

    // Forward an UNRELATED message (different bytes) to verify+.
    const unrelated = await signer.sign({ from: 'alice@signer.example', to: 'someone@elsewhere.example', subject: 'unrelated' });
    const fwd = forwardWithEml(unrelated, { from: 'auditor@asker.example', to: `verify+vfy2@${OPERATOR}` });
    const r = await core.ingest(fwd, envOf(`verify+vfy2@${OPERATOR}`, 'auditor@asker.example'));

    assert.equal(r.command, 'verify');
    assert.equal(r.matched, false);
    const msg = cap.captures().find((m) => /To:\s*auditor@asker\.example/i.test(m));
    assert.match(msg, /no match/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('verify+: an unknown event id is not committed and sends nothing', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, sendmailBin: cap.script });
    const fwd = forwardWithEml('From: x@y.example\r\n\r\nhi', { from: 'q@asker.example', to: `verify+nope999@${OPERATOR}` });
    const r = await core.ingest(fwd, envOf(`verify+nope999@${OPERATOR}`, 'q@asker.example'));
    assert.equal(r.command, 'verify');
    assert.equal(r.reason, 'unknown_event');
    assert.equal(cap.captures().length, 0);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('reverify+: forwarding the original upgrades a contested commit through the email path', async () => {
  const tmp = await tmpDir();
  const cap = fakeSendmail();
  try {
    const { signedEml, resolver } = await nonAlignedSigned({
      from: 'alice@corp.example', to: `event+rvy1-sign@${OPERATOR}`,
    });
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver, sendmailBin: cap.script });
    await core.createEvent({
      id: 'rvy1', type: 'workflow', flow: 'sequential', title: 'Contract', initiator: 'boss@corp.example',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'sign', participant: 'alice@corp.example', minTrust: 'unverified' }],
    });
    const ing = await core.ingest(signedEml, envOf(`event+rvy1-sign@${OPERATOR}`, 'alice@corp.example'));
    assert.equal(ing.trustLevel, 'unverified'); // contested at reception

    const fwd = forwardWithEml(signedEml, { from: 'auditor@asker.example', to: `reverify+rvy1-${ing.committedSeq}@${OPERATOR}` });
    const r = await core.ingest(fwd, envOf(`reverify+rvy1-${ing.committedSeq}@${OPERATOR}`, 'auditor@asker.example'));

    assert.equal(r.command, 'reverify');
    assert.equal(r.commitSequence, ing.committedSeq);
    assert.equal(r.report.found, true);
    assert.equal(r.upgraded, true); // re-verified against the archived key → upgraded
    assert.equal(r.report.trust_level_before, 'unverified');
    assert.equal(r.report.trust_level_after, 'verified');
    assert.deepEqual(r.notified, [{ kind: 'reverify_report', to: 'auditor@asker.example', ok: true, reason: null }]);

    const msg = cap.captures().find((m) => /To:\s*auditor@asker\.example/i.test(m));
    assert.match(msg, /Re-verification report/i);
    assert.match(msg, /unverified → verified/);
    assert.match(msg, /upgraded/i);
  } finally {
    cap.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
