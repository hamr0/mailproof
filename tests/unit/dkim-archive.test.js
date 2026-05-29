
// DKIM public-key archival (src/dkim-archive.js). Pure parsing/PEM helpers +
// fetchDkimKey driven through an injected offline resolver (no network) and
// pickSignatureToArchive over synthetic mailauth shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchDkimKey, pickSignatureToArchive, extractPublicKey, toPem,
} from '../../src/dkim-archive.js';

test('extractPublicKey: pulls p= from a DKIM TXT record, ignoring other tags', () => {
  assert.equal(extractPublicKey('v=DKIM1; k=rsa; p=ABC123'), 'ABC123');
  assert.equal(extractPublicKey(['v=DKIM1; ', 'p=DEF456']), 'DEF456'); // joined chunks
  assert.equal(extractPublicKey('v=DKIM1; k=rsa'), null);              // no p=
  assert.equal(extractPublicKey(null), null);
});

test('toPem: wraps base64 SPKI into 64-col PEM with PUBLIC KEY headers', () => {
  const pem = toPem('A'.repeat(100));
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(pem, /\n-----END PUBLIC KEY-----\n$/);
  const body = pem.split('\n').slice(1, -2);
  assert.equal(body[0].length, 64); // wrapped at 64 cols
  assert.equal(toPem(null), null);
});

test('pickSignatureToArchive: prefers pass+aligned, then pass, then first, else null', () => {
  const aligned = { signingDomain: 'a', status: { result: 'pass', aligned: true } };
  const pass = { signingDomain: 'b', status: { result: 'pass', aligned: false } };
  const fail = { signingDomain: 'c', status: { result: 'fail' } };
  assert.equal(pickSignatureToArchive({ dkim: { results: [fail, pass, aligned] } }), aligned);
  assert.equal(pickSignatureToArchive({ dkim: { results: [fail, pass] } }), pass);
  assert.equal(pickSignatureToArchive({ dkim: { results: [fail] } }), fail);
  assert.equal(pickSignatureToArchive({ dkim: { results: [] } }), null);
  assert.equal(pickSignatureToArchive(null), null);
});

test('fetchDkimKey: resolves p= via the injected resolver and returns PEM + lookup', async () => {
  const resolver = async (name) => {
    assert.equal(name, 'sel1._domainkey.signer.example');
    return [['v=DKIM1; k=rsa; p=Zm9vYmFy']];
  };
  const r = await fetchDkimKey('signer.example', 'sel1', { resolver });
  assert.equal(r.base64, 'Zm9vYmFy');
  assert.match(r.pem, /BEGIN PUBLIC KEY/);
  assert.equal(r.lookup, 'sel1._domainkey.signer.example');
  assert.ok(r.fetched_at);
  assert.equal(r.error, undefined);
});

test('fetchDkimKey: records an error (not throw) on missing inputs, bad labels, or no record', async () => {
  assert.equal((await fetchDkimKey('', 'sel')).error, 'missing domain/selector');
  assert.equal((await fetchDkimKey('bad domain', 'sel')).error, 'invalid domain/selector');

  const empty = await fetchDkimKey('signer.example', 'sel1', { resolver: async () => [] });
  assert.equal(empty.error, 'no TXT record');
  assert.equal(empty.pem, null);

  const noP = await fetchDkimKey('signer.example', 'sel1', { resolver: async () => [['v=DKIM1; k=rsa']] });
  assert.equal(noP.error, 'no p= tag');
});
