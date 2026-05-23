'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTrust, TRUST_LEVELS } = require('../../src/classifier');

// Synthetic mailauth authenticate() result fragments. These mirror the REAL
// shape mailauth produces (carried over from gitdone's characterization
// tests): a DKIM result's `aligned` is the signing-domain string when aligned
// and null otherwise — NOT a boolean. The classifier reads it as truthy, but
// the fixtures must model the true contract so this suite documents the input
// honestly.
const dkimPassAligned = (domain = 'example.com') => ({
  results: [{ status: { result: 'pass', aligned: domain }, signingDomain: domain }],
});
const dkimPassUnaligned = () => ({
  results: [{ status: { result: 'pass', aligned: null }, signingDomain: 'other.com' }],
});
const dkimFail = () => ({ results: [{ status: { result: 'fail', aligned: null } }] });
const dkimNone = () => ({ results: [] });

const arcPass = () => ({ status: { result: 'pass' }, authResults: [{}, {}] });
const arcNone = () => ({ status: { result: 'none' } });
const spfPass = () => ({ status: { result: 'pass' } });
const spfNone = () => ({ status: { result: 'none' } });
const dmarcPass = () => ({ status: { result: 'pass' } });
const dmarcFail = () => ({ status: { result: 'fail' } });
const dmarcNone = () => ({ status: { result: 'none' } });

test('verified: DKIM pass aligned + DMARC pass', () => {
  const auth = { dkim: dkimPassAligned(), dmarc: dmarcPass(), spf: spfPass(), arc: arcPass() };
  assert.equal(classifyTrust(auth), 'verified');
});

test('verified: DKIM pass aligned + DMARC pass even with SPF none', () => {
  const auth = { dkim: dkimPassAligned(), dmarc: dmarcPass(), spf: spfNone(), arc: arcNone() };
  assert.equal(classifyTrust(auth), 'verified');
});

test('forwarded: DKIM fail + ARC pass', () => {
  const auth = { dkim: dkimFail(), arc: arcPass(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'forwarded');
});

test('forwarded: DKIM none + ARC pass', () => {
  const auth = { dkim: dkimNone(), arc: arcPass(), spf: spfNone(), dmarc: dmarcNone() };
  assert.equal(classifyTrust(auth), 'forwarded');
});

test('authorized: DKIM fail + SPF pass + DMARC pass', () => {
  const auth = { dkim: dkimFail(), arc: arcNone(), spf: spfPass(), dmarc: dmarcPass() };
  assert.equal(classifyTrust(auth), 'authorized');
});

test('unverified: DKIM none, no ARC, no SPF/DMARC pass', () => {
  const auth = { dkim: dkimNone(), arc: arcNone(), spf: spfNone(), dmarc: dmarcNone() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('unverified: DKIM pass but unaligned does not satisfy verified', () => {
  const auth = { dkim: dkimPassUnaligned(), arc: arcNone(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('unverified: DKIM pass aligned but DMARC fail cannot be verified', () => {
  const auth = { dkim: dkimPassAligned(), arc: arcNone(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('forwarded takes precedence over authorized when both qualify', () => {
  // ARC pass beats SPF+DMARC pass in our priority order.
  const auth = { dkim: dkimFail(), arc: arcPass(), spf: spfPass(), dmarc: dmarcPass() };
  assert.equal(classifyTrust(auth), 'forwarded');
});

// --- coverage beyond gitdone's original characterization suite ---

test('verified is the strongest: all four signals passing resolves to verified', () => {
  const auth = { dkim: dkimPassAligned(), spf: spfPass(), dmarc: dmarcPass(), arc: arcPass() };
  assert.equal(classifyTrust(auth), 'verified');
});

test('multiple DKIM signatures: any one pass+aligned satisfies verified', () => {
  const auth = {
    dkim: { results: [
      { status: { result: 'fail', aligned: null } },
      { status: { result: 'pass', aligned: 'example.com' }, signingDomain: 'example.com' },
    ] },
    dmarc: dmarcPass(),
  };
  assert.equal(classifyTrust(auth), 'verified');
});

test('defensive: null / undefined / empty input is unverified, never throws', () => {
  assert.equal(classifyTrust(null), 'unverified');
  assert.equal(classifyTrust(undefined), 'unverified');
  assert.equal(classifyTrust({}), 'unverified');
});

test('defensive: malformed dkim.results does not throw', () => {
  assert.equal(classifyTrust({ dkim: {} }), 'unverified');
  assert.equal(classifyTrust({ dkim: { results: [{}] } }), 'unverified');
});

test('TRUST_LEVELS is exported strongest-first', () => {
  assert.deepEqual(TRUST_LEVELS, ['verified', 'forwarded', 'authorized', 'unverified']);
});
