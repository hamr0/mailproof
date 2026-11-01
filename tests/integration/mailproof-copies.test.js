// One record per distinct copy: raw-bytes id, message_key grouping, copy.kind, the
// forward-as-attachment link, and copies().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-copies-'));
const clock = (iso) => () => new Date(iso);
const BODY = 'Hello there.\r\nSecond line.\r\n';
const SPLIT = Buffer.from('\r\n\r\n');
const withBody = (raw, fn) => { const i = raw.indexOf(SPLIT) + 4; return Buffer.concat([raw.subarray(0, i), Buffer.from(fn(raw.subarray(i).toString('binary')), 'binary')]); };
const addHeaders = (raw, ...h) => Buffer.concat([Buffer.from(h.join('\r\n') + '\r\n'), raw]);

/** An unsigned forward carrying `inners` (raw RFC-822 buffers) as message/rfc822 parts. */
function forwardOf(inners, subject = 'Look at this', B = 'B') {
  const parts = inners.flatMap((b) => [`--${B}`, 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '', b.toString('binary').replace(/\r\n$/, '')]);
  return Buffer.from(['From: fwd@fwd.example', 'To: me@me.example', `Subject: ${subject}`, 'Message-ID: <fwd-1@fwd.example>', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}`, 'Content-Type: text/plain', '', 'see attached', ...parts, `--${B}--`, ''].join('\r\n'), 'binary');
}

test('direct and list-relayed copies: 2 records, one message_key, copy kinds, body status, copies()', async () => {
  const m = await signedMail({ body: BODY });
  const mp = new Mailproof({ trailDir: tmp(), resolver: m.resolver, now: clock('2026-11-01T10:00:00Z') });
  const relayedRaw = addHeaders(withBody(m.raw, (b) => b + '\r\n-- \r\nlist footer\r\n'),
    'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=Relay.Example; s=arc; b=AAAA', 'List-Id: <news.lists.example.org>');
  const direct = await mp.record(m.raw, { direction: 'in', source: 'imap' });
  const relayed = await mp.record(relayedRaw, { direction: 'in', source: 'postfix' });
  assert.equal(direct.duplicate, false);
  assert.equal(relayed.duplicate, false);
  assert.notEqual(direct.id, relayed.id);
  assert.equal(direct.record.message_key, relayed.record.message_key);
  assert.match(direct.record.message_key, /^[0-9a-f]{32}$/);
  assert.equal(direct.record.copy.kind, 'direct');
  assert.deepEqual(direct.record.copy.evidence, {});
  assert.equal(relayed.record.copy.kind, 'relayed');
  assert.deepEqual(relayed.record.copy.evidence, { arc_sealers: ['relay.example'], list_id_domain: 'lists.example.org' });
  assert.equal(direct.record.body_status, 'matched');
  assert.equal(relayed.record.body_status, 'mismatch');
  assert.equal(relayed.record.signatures[0].body.explain[0].kind, 'appended');
  assert.equal(relayed.record.verdicts.portable.trust, 'verified', 'the signed headers still verify on the relayed copy');

  for (const arg of [direct.id, relayed.id, direct.record.message_key]) {
    const c = await mp.copies(arg);
    assert.deepEqual(c.copies.map((x) => [x.id, x.copy]).sort(), [[direct.id, 'direct'], [relayed.id, 'relayed']].sort());
    assert.equal(c.original, direct.id, 'original = the direct copy whose body matched');
    assert.deepEqual(c.forwards, []);
  }
  assert.deepEqual(await mp.copies('0'.repeat(32)), { message_key: '0'.repeat(32), original: null, copies: [], forwards: [] });
  assert.deepEqual((await mp.copies('nope')).copies, []);
});

test('the identical copy twice is one record', async () => {
  const m = await signedMail({ body: BODY });
  const mp = new Mailproof({ trailDir: tmp(), resolver: m.resolver, now: clock('2026-11-01T10:00:00Z') });
  const a = await mp.record(m.raw, { direction: 'in', source: 'imap' });
  const b = await mp.record(m.raw, { direction: 'in', source: 'postfix' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  assert.equal(b.commit, a.commit);
  assert.equal((await mp.copies(a.id)).copies.length, 1);
});

test('a Fwd: subject marks a forward; Re: and ordinary subjects do not', async () => {
  const mk = async (subject) => { const m = await signedMail({ subject }); return (await new Mailproof({ trailDir: tmp(), resolver: m.resolver }).record(m.raw, { direction: 'in' })).record.copy; };
  assert.deepEqual(await mk('Fwd: quarterly'), { kind: 'forward', evidence: { subject_prefix: true } });
  assert.equal((await mk('FW: quarterly')).kind, 'forward');
  assert.equal((await mk('WG: Quartal')).kind, 'forward');
  assert.equal((await mk('Re: Fwd: quarterly')).kind, 'direct');
  assert.equal((await mk('Forward looking statement')).kind, 'direct');
});

test('forward as attachment: signed original linked by key + verdict, key archived, found under forwards', async () => {
  const orig = await signedMail({ body: BODY, subject: 'The original' });
  const dir = tmp();
  const mp = new Mailproof({ trailDir: dir, resolver: orig.resolver, now: clock('2026-11-01T10:00:00Z') });
  const fwd = await mp.record(forwardOf([orig.raw]), { direction: 'in', source: 'imap' });
  const ev = fwd.record.copy.evidence;
  assert.equal(fwd.record.copy.kind, 'forward');
  assert.equal(ev.attached_original.length, 1);
  const o = ev.attached_original[0];
  assert.equal(o.dkim, 'pass');
  assert.equal(o.d, orig.domain);
  assert.equal(o.body_status, 'matched');
  const direct = await mp.record(orig.raw, { direction: 'in', source: 'file' });
  assert.equal(o.message_key, direct.record.message_key);
  assert.equal(fwd.record.signatures.length, 0, 'the outer forward is unsigned');
  assert.ok(fs.readdirSync(path.join(dir, 'default', 'keys', orig.domain, 'sel1')).length === 1, 'inner signer key archived');
  const c = await mp.copies(direct.id);
  assert.deepEqual(c.copies.map((x) => x.id), [direct.id]);
  assert.deepEqual(c.forwards.map((x) => x.id), [fwd.id]);
  // nothing of the inner message is stored
  const onDisk = fs.readFileSync(path.join(dir, 'default', 'records', `${fwd.id}.json`), 'utf8');
  assert.ok(!onDisk.includes('The original') && !onDisk.includes('Second line'));
  assert.ok(!Buffer.from(onDisk).includes(Buffer.from('The original').toString('base64').slice(0, 12)));
});

test('tampered inner original: dkim fail; unsigned inner: dkim none', async () => {
  const orig = await signedMail({ body: BODY, subject: 'Pay 100' });
  const mp = new Mailproof({ trailDir: tmp(), resolver: orig.resolver });
  const tampered = Buffer.from(orig.raw.toString('binary').replace('Subject: Pay 100', 'Subject: Pay 900'), 'binary');
  const unsigned = Buffer.from('From: u@u.example\r\nMessage-ID: <u1@u.example>\r\n\r\nhi\r\n');
  const f = await mp.record(forwardOf([tampered, unsigned]), { direction: 'in' });
  const [t, u] = f.record.copy.evidence.attached_original;
  assert.equal(t.dkim, 'fail');
  assert.equal(u.dkim, 'none');
  assert.equal(t.message_key, (await mp.record(orig.raw, { direction: 'in' })).record.message_key, 'same signature, same key even when tampered');
});

test('unsigned mail: message_key from Message-ID, else null; kind unknown', async () => {
  const mp = new Mailproof({ trailDir: tmp() });
  const a = await mp.record(Buffer.from('From: a@a.example\r\nMessage-ID: <Abc@a.example>\r\n\r\nhi\r\n'), { direction: 'in' });
  const a2 = await mp.record(Buffer.from('From: a@a.example\r\nMessage-ID: <abc@A.example>\r\nReceived: x\r\n\r\nhi\r\n'), { direction: 'in' });
  const n = await mp.record(Buffer.from('From: a@a.example\r\n\r\nhi\r\n'), { direction: 'in' });
  assert.match(a.record.message_key, /^[0-9a-f]{32}$/);
  assert.equal(a.record.message_key, a2.record.message_key, 'normalised Message-ID (case, brackets)');
  assert.equal(n.record.message_key, null);
  assert.equal(a.record.copy.kind, 'unknown');
  assert.deepEqual((await mp.copies(n.id)).copies.map((x) => x.id), [n.id]);
});

test('inner cap: at most 10 originals examined, capped flagged', async () => {
  const inners = Array.from({ length: 12 }, (_, i) => Buffer.from(`From: u@u.example\r\nMessage-ID: <m${i}@u.example>\r\n\r\nhi\r\n`));
  const mp = new Mailproof({ trailDir: tmp() });
  const f = await mp.record(forwardOf(inners), { direction: 'in' });
  assert.equal(f.record.copy.evidence.attached_original.length, 10);
  assert.equal(f.record.copy.evidence.capped, true);
  const nine = await mp.record(forwardOf(inners.slice(0, 10), 'Ten'), { direction: 'in' });
  assert.equal(nine.record.copy.evidence.capped, undefined);
});

test('one level deep: an original that itself carries an rfc822 part is not recursed into', async () => {
  const innermost = Buffer.from('From: z@z.example\r\nMessage-ID: <z@z.example>\r\n\r\nz\r\n');
  const mid = forwardOf([innermost], 'inner fwd', 'C');
  const mp = new Mailproof({ trailDir: tmp() });
  const f = await mp.record(forwardOf([mid]), { direction: 'in' });
  assert.equal(f.record.copy.evidence.attached_original.length, 1);
});
