// Offline DKIM-interop regression — proves mailproof's public surface verifies a
// signature produced by a REAL production opendkim key (signedreply.com), against
// the matching public-key record, with NO network. Deterministic + CI-safe: the
// resolver is built from the committed public record, so it can't flake on DNS.
//
// Provenance: the signature was produced with signedreply.com's production DKIM
// private key (held in `pass`, never committed); the .eml body is a benign
// fixture with no tokens/PII. The same key, over LIVE DNS, was confirmed
// `verified` against a genuine signedreply.com message via
// tests/manual/verify-live.mjs (selector gd202606). This test pins the offline
// half so the interop stays checked, not assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticateMessage, classifyTrust, summariseAuth } from '../../src/index.js';

const here = fileURLToPath(new URL('./fixtures/', import.meta.url));
const eml = fs.readFileSync(here + 'signedreply-sample.eml');
const record = [...fs.readFileSync(here + 'signedreply.dkim.txt', 'utf8').matchAll(/"([^"]*)"/g)]
  .map((m) => m[1]).join('').trim();

// Injected resolver from the committed public record (offline). DMARC mirrors
// signedreply.com's published policy (p=none; adkim=s) so alignment resolves.
const DOMAIN = 'signedreply.com';
const SELECTOR = 'gd202604';
const resolver = async (name, type) => {
  const map = {
    [`${SELECTOR}._domainkey.${DOMAIN}`]: record,
    [`_dmarc.${DOMAIN}`]: 'v=DMARC1; p=none; adkim=s; aspf=s',
  };
  const rec = (type || 'TXT').toUpperCase() === 'TXT' ? map[name] : undefined;
  if (rec === undefined) throw Object.assign(new Error('no rec ' + name), { code: 'ENOTFOUND' });
  return [[rec]];
};

test('verifies a real signedreply.com production-key DKIM signature (offline)', async () => {
  const auth = await authenticateMessage(eml, { sender: 'noreply@signedreply.com' }, { resolver });
  const sig = summariseAuth(auth).dkim.signatures[0];
  assert.equal(sig.result, 'pass', 'DKIM must pass against the production public key');
  assert.equal(sig.algorithm, 'rsa-sha256');
  assert.equal(sig.domain, DOMAIN);
  assert.equal(classifyTrust(auth), 'verified');
});
