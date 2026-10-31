// The PRD section 3 trust rule, one case per branch (synthetic mailauth shapes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrust, dmarcPublished } from '../../src/proof/trust.js';

const dkim = (pass = true, aligned = true) => ({ results: [{ status: { result: pass ? 'pass' : 'fail', aligned: aligned ? 'x.example' : null } }] });
const dmarc = (result, rr) => ({ status: { result }, ...(rr ? { rr } : {}) });

test('no DMARC record + aligned DKIM pass = verified (the v2 change)', () => {
  assert.equal(classifyTrust({ dkim: dkim(), dmarc: dmarc('none') }), 'verified');
  assert.equal(dmarcPublished({ dmarc: dmarc('none') }), false);
});
test('published DMARC that passes = verified', () => {
  assert.equal(classifyTrust({ dkim: dkim(), dmarc: dmarc('pass', 'v=DMARC1; p=none') }), 'verified');
});
test('published DMARC that fails = not verified', () => {
  assert.equal(classifyTrust({ dkim: dkim(), dmarc: dmarc('fail', 'v=DMARC1; p=reject') }), 'unverified');
});
test('DMARC temperror/permerror counts as published and fails closed', () => {
  for (const r of ['temperror', 'permerror']) {
    assert.equal(dmarcPublished({ dmarc: dmarc(r) }), true);
    assert.equal(classifyTrust({ dkim: dkim(), dmarc: dmarc(r) }), 'unverified');
  }
});
test('no DMARC but unaligned or failing DKIM is still unverified', () => {
  assert.equal(classifyTrust({ dkim: dkim(true, false), dmarc: dmarc('none') }), 'unverified');
  assert.equal(classifyTrust({ dkim: dkim(false, false), dmarc: dmarc('none') }), 'unverified');
});
test('forwarded: any ARC pass without a list; only listed sealers with one', () => {
  const chain = [{ 'arc-seal': { parsed: { d: { value: 'Sealer.Example' } } } }];
  const auth = { dkim: dkim(false, false), dmarc: dmarc('fail'), arc: { status: { result: 'pass' }, chain } };
  assert.equal(classifyTrust(auth), 'forwarded');
  assert.equal(classifyTrust(auth, { trustedSealers: ['sealer.example'] }), 'forwarded');
  assert.equal(classifyTrust(auth, { trustedSealers: ['other.example'] }), 'unverified');
  assert.equal(classifyTrust(auth, { trustedSealers: [] }), 'unverified');
});
test('authorized: SPF pass + DMARC pass with failing DKIM', () => {
  assert.equal(classifyTrust({ dkim: dkim(false, false), dmarc: dmarc('pass', 'x'), spf: { status: { result: 'pass' } } }), 'authorized');
});
