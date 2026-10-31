// check / verify / matchBody / matchFile through the public class.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver } from '../helpers/proof.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ver-'));
const clock = (iso = '2026-11-01T10:00:00Z') => () => new Date(iso);

test('verify is offline: no DNS call, and still passes after the key leaves DNS', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const rec = await new Mailproof({ trailDir: dir, resolver: m.resolver, now: clock() }).record(m.raw, { direction: 'in' });
  let calls = 0;
  const dead = async () => { calls++; throw Object.assign(new Error('dns is gone'), { code: 'ESERVFAIL' }); };
  const mp = new Mailproof({ trailDir: dir, resolver: dead, now: clock('2030-01-01T00:00:00Z') });
  const v = await mp.verify(rec.id);
  assert.equal(v.ok, true);
  assert.equal(v.trust, 'verified');
  assert.equal(v.at, '2026-11-01T10:00:00.000Z');
  assert.equal(v.engine.rules, 'mp-rules/1');
  assert.equal(calls, 0);
  // and the same from a record object / JSON text, with no trail at all
  const obj = await mp.get(rec.id);
  assert.equal((await new Mailproof({ trailDir: tmp() }).verify(obj)).ok, true);
  assert.equal((await mp.verify(JSON.stringify(obj))).ok, true);
});

test('verify fails when the record file on disk is tampered', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, now: clock() });
  const { id } = await mp.record(m.raw, { direction: 'in' });
  const f = path.join(dir, 'default', 'records', `${id}.json`);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.signatures[0].signed_headers.shift();
  fs.writeFileSync(f, JSON.stringify(rec));
  const v = await mp.verify(id);
  assert.equal(v.ok, false);
  assert.equal(v.trust, 'unverified');
});

test('verify: unknown id and junk fail closed without throwing', async () => {
  const mp = new Mailproof({ trailDir: tmp() });
  assert.equal((await mp.verify('0'.repeat(32))).ok, false);
  assert.equal((await mp.verify('{nope')).ok, false);
  assert.equal((await mp.verify(null)).ok, false);
});

test('verify judges x= at capture time: valid when captured, expired when re-judged later', async () => {
  const m = await signedMail({ signTime: new Date('2026-11-01T09:00:00Z'), expires: new Date('2026-11-03T09:00:00Z') });
  const mp = new Mailproof({ trailDir: tmp(), resolver: m.resolver, now: clock('2026-11-01T10:00:00Z') });
  const { id } = await mp.record(m.raw, { direction: 'in' });
  assert.equal((await mp.verify(id)).ok, true);
  const late = await mp.verify(id, { at: '2026-11-10T00:00:00Z' });
  assert.equal(late.ok, false);
  assert.equal(late.signatures[0].why, 'expired');
});

test('check writes nothing and returns both verdicts', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, now: clock() });
  const c = await mp.check(m.raw);
  assert.equal(c.live.trust, 'verified');
  assert.equal(c.portable.trust, 'verified');
  assert.equal(c.signatures, 1);
  assert.equal(c.unsigned, false);
  assert.deepEqual(c.key_errors, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('check of an old .eml whose key has left DNS: key_errors, nothing verifies', async () => {
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: tmp(), resolver: stubResolver({}), now: clock() });
  const c = await mp.check(m.raw);
  assert.equal(c.key_errors.length, 1);
  assert.equal(c.portable.trust, 'unverified');
  assert.equal(c.live.trust, 'unverified');
});

test('check of unsigned mail', async () => {
  const mp = new Mailproof({ trailDir: tmp(), resolver: stubResolver({}), now: clock() });
  const c = await mp.check(Buffer.from('From: a@b.example\r\nSubject: x\r\n\r\nhi\r\n'));
  assert.equal(c.unsigned, true);
  assert.equal(c.live.trust, 'unverified');
});

test('F6 g through the API: matchBody own passes, another email fails; F4 altered body fails but verify holds', async () => {
  const a = await signedMail({ body: 'first body\r\n' });
  const b = await signedMail({ body: 'second body\r\n' });
  const mp = new Mailproof({ trailDir: tmp(), resolver: a.resolver, now: clock() });
  const { id } = await mp.record(a.raw, { direction: 'in' });
  const own = await mp.matchBody(id, a.raw);
  assert.equal(own.match, true);
  assert.equal(own.full, true);
  assert.equal((await mp.matchBody(id, b.raw)).match, false);
  const altered = Buffer.from(a.raw.toString('binary').replace('first body', 'f1rst body'), 'binary');
  assert.equal((await mp.matchBody(id, altered)).match, false);
  assert.equal((await mp.verify(id)).ok, true);
  assert.equal((await mp.matchBody('0'.repeat(32), a.raw)).match, false);
});

test('matchFile: the attachment matches by sha256; other bytes do not', async () => {
  const bytes = Buffer.from('the contract bytes');
  const m = await signedMail({ attachment: { filename: 'c.pdf', bytes } });
  const mp = new Mailproof({ trailDir: tmp(), resolver: m.resolver, now: clock() });
  const { id } = await mp.record(m.raw, { direction: 'in' });
  const hit = await mp.matchFile(id, bytes);
  assert.equal(hit.match, true);
  assert.equal(hit.attachment.filename, 'c.pdf');
  assert.equal(hit.attachment.size, bytes.length);
  assert.equal((await mp.matchFile(id, Buffer.from('the contract byteZ'))).match, false);
  assert.equal((await mp.matchFile(id, new Uint8Array(bytes))).match, true);
});

test('bound methods: const { verify } = mp', async () => {
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: tmp(), resolver: m.resolver, now: clock() });
  const { record, verify, check, matchBody, matchFile } = mp;
  const { id } = await record(m.raw, { direction: 'in' });
  assert.equal((await verify(id)).ok, true);
  assert.equal((await check(m.raw)).signatures, 1);
  assert.equal((await matchBody(id, m.raw)).match, true);
  assert.equal((await matchFile(id, Buffer.from('x'))).match, false);
});
