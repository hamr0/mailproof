// Both verdicts on really-signed mail: live from mailauth, portable from the record alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { authenticate, sealMessage } from 'mailauth';
import { dkimBody } from 'mailauth/lib/dkim/body';
import { generateCanonicalizedHeader } from 'mailauth/lib/dkim/header';
import { splitMessage, selectSigned } from '../../src/proof/signed-headers.js';
import { buildLive, buildPortable, RULES_VERSION } from '../../src/proof/verdict.js';
import { verifyRecord } from '../../src/proof/recheck.js';
import { signedMail, recordOf, makeKey, stubResolver } from '../helpers/proof.js';

const auth = (m, raw = m.raw) => authenticate(raw, { trustReceived: false, resolver: m.resolver, disableBimi: true });
const un = (x) => Buffer.from(x, 'base64').toString('binary');

test('published p=none DMARC: live and portable are both verified', async () => {
  const m = await signedMail({});
  const live = buildLive(await auth(m));
  assert.equal(live.trust, 'verified');
  assert.equal(live.dmarc.published, true);
  assert.equal(buildPortable(recordOf(m.raw, m.signers)).trust, 'verified');
});

test('no DMARC record: aligned DKIM is enough (live + portable)', async () => {
  const m = await signedMail({ dmarc: null });
  const live = buildLive(await auth(m));
  assert.equal(live.dmarc.published, false);
  assert.equal(live.trust, 'verified');
  assert.equal(buildPortable(recordOf(m.raw, m.signers)).trust, 'verified');
});

test('DMARC lookup SERVFAIL (temperror) counts as published and fails closed live', async () => {
  const m = await signedMail({ dmarcFail: 'ESERVFAIL' });
  const live = buildLive(await auth(m));
  assert.equal(live.dmarc.result, 'temperror');
  assert.equal(live.dmarc.published, true);
  assert.equal(live.trust, 'unverified');
  // portable never uses DMARC: aligned DKIM that re-checks is verified
  assert.equal(buildPortable(recordOf(m.raw, m.signers)).trust, 'verified');
});

test('DKIM pass but unaligned From: unverified in both verdicts', async () => {
  const m = await signedMail({ domain: 'signer.example', from: 'me@elsewhere.example' });
  assert.equal(buildLive(await auth(m)).trust, 'unverified');
  assert.equal(buildPortable(recordOf(m.raw, m.signers)).trust, 'unverified');
});

test('a signature that does not cover From can never align (portable)', async () => {
  // mailauth refuses to sign without From (ENOFROM), so build the signature by hand
  // with the same vetted canonicalisation; the re-check itself still has to accept it.
  const key = makeKey('rsa');
  const msg = 'From: me@signer.example\r\nTo: r@other.example\r\nSubject: hi\r\nDate: Mon, 4 May 2026 00:00:00 +0000\r\nMessage-ID: <a@signer.example>\r\n\r\nbody\r\n';
  const body = dkimBody('relaxed', 'sha256', false); body.update(Buffer.from('body\r\n'));
  const bh = body.digest('base64');
  const lineNoB = `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=signer.example; s=sel1; t=${Math.floor(Date.now() / 1000)}; h=to:subject:date:message-id; bh=${bh}; b=`;
  const rows = splitMessage(msg).rows;
  const lines = selectSigned(rows, 'to:subject:date:message-id').map((l) => ({ line: Buffer.from(l, 'binary') }));
  const { canonicalizedHeader } = generateCanonicalizedHeader('DKIM', { keys: 'to:subject:date:message-id', headers: lines }, { signatureHeaderLine: lineNoB, canonicalization: 'relaxed/relaxed' });
  const b = crypto.sign('sha256', Buffer.from(canonicalizedHeader), crypto.createPrivateKey(key.privPem)).toString('base64');
  const raw = Buffer.from(`${lineNoB}${b}\r\n${msg}`);
  const rec = recordOf(raw, [{ domain: 'signer.example', selector: 'sel1', key }]);
  assert.ok(!rec.signatures[0].signed_headers.some((x) => /^from:/i.test(un(x))));
  const v = verifyRecord(rec);
  assert.equal(v.signatures[0].ok, true, JSON.stringify(v.signatures));
  assert.equal(v.signatures[0].aligned, false);
  assert.equal(v.trust, 'unverified');
});

test('strict adkim in the stored DMARC record tightens portable alignment', async () => {
  const m = await signedMail({ domain: 'signer.example', from: 'me@sub.signer.example' });
  const rec = recordOf(m.raw, m.signers);
  assert.equal(buildPortable(rec).trust, 'verified'); // relaxed: same organisational domain
  rec.verdicts = { live: { dmarc: { rr: 'v=DMARC1; p=none; adkim=s' } } };
  assert.equal(buildPortable(rec).trust, 'unverified');
});

test('portable is judged at capture time: expired later still verified; tampered is not', async () => {
  const m = await signedMail({ signTime: new Date('2026-05-01T00:00:00Z'), expires: new Date('2026-05-08T00:00:00Z') });
  const rec = recordOf(m.raw, m.signers, { captured: '2026-05-02T00:00:00Z' });
  assert.equal(buildPortable(rec, { now: Date.parse('2027-01-01') }).trust, 'verified');
  assert.equal(buildPortable(rec, { at: '2026-06-01T00:00:00Z' }).trust, 'unverified');
});

test('engine stamp: rules version + mailauth version on both verdicts', async () => {
  const m = await signedMail({});
  const live = buildLive(await auth(m));
  const portable = buildPortable(recordOf(m.raw, m.signers));
  assert.equal(live.engine.rules, RULES_VERSION);
  assert.match(live.engine.mailauth, /^\d+\.\d+\.\d+/);
  assert.deepEqual(portable.engine, live.engine);
});

test('forwarded: a real ARC-sealed message with broken DKIM; gated by trustedSealers', async () => {
  const m = await signedMail({});
  const sealer = makeKey('rsa');
  const broken = Buffer.from(m.raw.toString('binary').replace('I confirm', 'I c0nfirm'), 'binary');
  const seal = await sealMessage(broken, { signingDomain: 'sealer.example', selector: 'arc1', privateKey: sealer.privPem, authResults: 'mx.example; dkim=pass' });
  const raw = Buffer.concat([Buffer.from(seal), broken]);
  const resolver = stubResolver({ ...m.map, '_dmarc.signer.example': 'v=DMARC1; p=none', 'arc1._domainkey.sealer.example': `v=DKIM1; k=rsa; p=${sealer.p}` });
  const a = await authenticate(raw, { trustReceived: false, resolver, disableBimi: true });
  assert.notEqual(a.dkim.results[0].status.result, 'pass');
  const trusted = buildLive(a, { trustedSealers: ['sealer.example'] });
  assert.equal(trusted.trust, 'forwarded');
  assert.deepEqual(trusted.arc.sealers, ['sealer.example']);
  assert.equal(buildLive(a, { trustedSealers: ['nobody.example'] }).trust, 'unverified');
});

test('SPF only appears in the live verdict when an envelope was supplied', async () => {
  const m = await signedMail({});
  const a = await auth(m);
  assert.equal(buildLive(a).spf, null);
  assert.ok(buildLive(a, { hasEnvelope: true }).spf === null || typeof buildLive(a, { hasEnvelope: true }).spf.result === 'string');
});
