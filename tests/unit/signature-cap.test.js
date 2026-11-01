// MAX_SIGNATURES: at most 10 DKIM-Signature headers are evaluated per message (key fetch,
// verify, body analysis); the rest are only counted in `signatures_skipped`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { splitMessage, dropExtraSignatures } from '../../src/proof/signed-headers.js';
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

test('40 bogus signatures against a 100 ms resolver: at most 10 key lookups, signatures_skipped 30', async () => {
  const { fn, lookups } = slowResolver();
  const mp = new Mailproof({ trailDir: trailDir(), resolver: fn });
  const raw = plain(bogusRows(40));
  const t = performance.now();
  const { record } = await mp.record(raw, { direction: 'in', source: 't' }).then(async (r) => ({ record: await mp.get(r.id) }));
  const ms = performance.now() - t;
  assert.equal(record.signatures.length, 10);
  assert.equal(record.signatures_skipped, 30);
  const keyLookups = new Set(lookups);
  assert.ok(keyLookups.size <= 10, `${keyLookups.size} distinct key lookups: ${[...keyLookups].join(' ')}`);
  assert.ok(lookups.length <= 10, `${lookups.length} key lookups in total`);
  assert.deepEqual(record.signatures.map((s) => s.tags.d), Array.from({ length: 10 }, (_, i) => `bogus${i}.example`), 'the first ten, in header order');
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms (uncapped is ~4 s+)`);
  const c = await mp.check(raw);
  assert.equal(c.signatures, 10);
  assert.equal(c.signatures_skipped, 30);
});

test('a message whose only VALID signature is the 11th is not evaluated (the intended tradeoff)', async () => {
  const m = await signedMail({ body: 'ok\r\n' });
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  const eleventh = prepend(m.raw, bogusRows(10));
  const c = await mp.check(eleventh);
  assert.equal(c.signatures, 10);
  assert.equal(c.signatures_skipped, 1);
  assert.equal(c.portable.trust, 'unverified');
  assert.notEqual(c.live.trust, 'verified');
  // The same signature as the 10th IS evaluated and verifies.
  const tenth = prepend(m.raw, bogusRows(9));
  const ok = await mp.check(tenth);
  assert.equal(ok.signatures, 10);
  assert.equal('signatures_skipped' in ok, false);
  assert.equal(ok.portable.trust, 'verified');
});

test('messages with 10 or fewer signatures: no signatures_skipped, no change to the bytes handed to mailauth', async () => {
  const m = await signedMail({ body: 'ok\r\n', signers: Array.from({ length: 3 }, (_, i) => ({ domain: 'signer.example', selector: `s${i}` })) });
  assert.equal(dropExtraSignatures(m.raw), m.raw, 'same buffer');
  const ten = prepend(plain([]), bogusRows(10));
  assert.equal(dropExtraSignatures(ten), ten, 'exactly 10 is untouched');
  const mp = new Mailproof({ trailDir: trailDir(), resolver: m.resolver });
  const r = await mp.record(m.raw, { direction: 'in', source: 't' });
  const rec = await mp.get(r.id);
  assert.equal(rec.signatures.length, 3);
  assert.equal('signatures_skipped' in rec, false);
  assert.equal('signatures_skipped' in await mp.check(m.raw), false);
});

test('dropExtraSignatures removes only whole signature headers past the first 10, nothing else', () => {
  const folded = 'DKIM-Signature: v=1; a=rsa-sha256;\r\n\td=folded.example; s=sel;\r\n b=AAAA';
  for (const nl of ['\r\n', '\n']) {
    for (const body of ['body\r\n', '', 'x']) {
      const rows = [...bogusRows(10), folded, 'X-Keep: 1', bogus(11), 'X-Keep2: 2\r\n continued', bogus(12)];
      const text = (rows.join('\r\n') + '\r\n\r\n' + body).replace(/\r\n/g, nl);
      const out = dropExtraSignatures(Buffer.from(text));
      const kept = splitMessage(out);
      assert.equal(kept.rows.filter((r) => r.name === 'dkim-signature').length, 10);
      assert.deepEqual(kept.rows.filter((r) => r.name !== 'dkim-signature').map((r) => r.name), ['x-keep', 'x-keep2']);
      assert.equal(kept.body.toString(), body.replace(/\r\n/g, nl), 'body untouched');
      assert.equal(out.toString(), (bogusRows(10).join('\r\n') + '\r\nX-Keep: 1\r\nX-Keep2: 2\r\n continued\r\n\r\n' + body).replace(/\r\n/g, nl), 'exactly the extra headers are gone');
    }
  }
  // A header block that ends in a signature and has no body at all.
  const bare = Buffer.from([...bogusRows(11), ''].join('\r\n'));
  assert.equal(splitMessage(dropExtraSignatures(bare)).rows.length, 10);
});
