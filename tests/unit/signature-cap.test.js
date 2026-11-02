// MAX_SIGNATURES: a message with more than 10 DKIM-Signature headers is refused whole by the admission
// gate (recorded unverified, `over limit: signatures`), not trimmed to the first 10. Each signature costs
// a DNS key fetch (up to 5 s) and a body hash, so an uncapped count would let a sender hold a call for as
// long as they like. (The just-under / just-over cases for every limit are in input-limits.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { MAX_SIGNATURES } from '../../src/proof/limits.js';
import { signedMail } from '../helpers/proof.js';

const trailDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cap-'));
const bogus = (i) => `DKIM-Signature: v=1; a=rsa-sha256; d=bogus${i}.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA`;
const bogusRows = (n, from = 0) => Array.from({ length: n }, (_, i) => bogus(from + i));
const plain = (extra) => Buffer.from([...extra, 'From: me@signer.example', 'To: rcpt@other.example', 'Subject: hi', 'Date: Sun, 01 Nov 2026 10:00:00 GMT', 'Message-ID: <cap@signer.example>', '', 'body', ''].join('\r\n'));
const prepend = (raw, rows) => Buffer.concat([Buffer.from(rows.join('\r\n') + '\r\n'), raw]);

/** A resolver that answers after 100 ms and logs every DKIM key lookup. */
function slowResolver(inner) {
  const lookups = [];
  const fn = async (name, type) => {
    if (name.includes('._domainkey.')) lookups.push(name);
    await new Promise((r) => setTimeout(r, 100));
    if (inner) return inner(name, type);
    throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
  };
  return { fn, lookups };
}

test('MAX_SIGNATURES is 10', () => { assert.equal(MAX_SIGNATURES, 10); });

test('40 bogus signatures against a 100 ms resolver: refused whole, not one key lookup, recorded', async () => {
  const { fn, lookups } = slowResolver();
  // in-process, parsers already loaded: the bound below is about the gate and DNS, not about starting a worker
  // thread or loading mailauth for the first time
  await import('../../src/proof/build.js');
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn, worker: { size: 0 } });
  const raw = plain(bogusRows(40));
  const t = performance.now();
  const r = await mp.record(raw, { direction: 'in', source: 't' });
  const ms = performance.now() - t;
  const record = await mp.get(r.id);
  assert.deepEqual(record.signatures, []);
  assert.equal(record.verdicts.live.reason, 'over limit: signatures');
  assert.equal(record.verdicts.portable.reason, 'over limit: signatures');
  assert.deepEqual(lookups, []);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms (uncapped is ~4 s+)`);
  const c = await mp.check(raw);
  assert.equal(c.signatures, 0);
  assert.equal(c.unsigned, false);
});

test('a message whose only VALID signature is the 11th is refused whole; as the 10th it verifies', async () => {
  const m = await signedMail({ body: 'ok\r\n' });
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  const eleventh = prepend(m.raw, bogusRows(10));
  const c = await mp.check(eleventh);
  assert.equal(c.signatures, 0);
  assert.equal(c.portable.trust, 'unverified');
  assert.equal(c.portable.reason, 'over limit: signatures');
  assert.notEqual(c.live.trust, 'verified');
  const tenth = prepend(m.raw, bogusRows(9));
  const ok = await mp.check(tenth);
  assert.equal(ok.signatures, 10);
  assert.equal(ok.portable.trust, 'verified');
  assert.equal('reason' in ok.portable, false);
});

test('10 or fewer signatures: all of them recorded, the live verdict computed on the message exactly as received', async () => {
  const m = await signedMail({ body: 'ok\r\n', signers: Array.from({ length: 3 }, (_, i) => ({ domain: 'signer.example', selector: `s${i}` })) });
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  const r = await mp.record(m.raw, { direction: 'in', source: 't' });
  const rec = await mp.get(r.id);
  assert.equal(rec.signatures.length, 3);
  assert.equal(rec.verdicts.live.dkim.length, 3, 'mailauth saw all three: the bytes were not altered');
  assert.equal('reason' in rec.verdicts.live, false);
});
