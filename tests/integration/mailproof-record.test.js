// Mailproof.record -> get -> list against a real git trail (real `git`, temp dirs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-trail-'));
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const clock = (iso = '2026-11-01T10:00:00Z') => () => new Date(iso);
const mk = (dir, m, extra = {}) => new Mailproof({ trailDir: dir, resolver: m.resolver, now: clock(), ...extra });
const BODY = 'TOPSECRET-BODY-TEXT\r\n';

test('record: round trip, one commit per record, nothing but signed headers stored', async () => {
  const dir = tmp();
  const m = await signedMail({ subject: 'Quarterly numbers', body: BODY, inReplyTo: '<orig@a.example>', references: '<root@a.example> <orig@a.example>' });
  const mp = mk(dir, m);
  const r = await mp.record(m.raw, { direction: 'in', source: 'test' });
  assert.equal(r.duplicate, false);
  assert.match(r.id, /^[0-9a-f]{32}$/);
  const root = path.join(dir, 'default');
  const log = gitOut(root, 'log', '--format=%s').split('\n');
  assert.deepEqual(log, [`record ${r.id.slice(0, 12)} in verified/verified`, 'trail created']);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.ok(!log.join('\n').includes('Quarterly'));

  const rec = await mp.get(r.id);
  assert.deepEqual(rec, JSON.parse(JSON.stringify(r.record)));
  assert.equal(rec.v, 2);
  assert.equal(rec.captured, '2026-11-01T10:00:00.000Z');
  assert.equal(rec.direction, 'in');
  assert.equal(rec.source, 'test');
  assert.equal(rec.message.in_reply_to, '<orig@a.example>');
  assert.deepEqual(rec.message.references, ['<root@a.example>', '<orig@a.example>']);
  assert.match(rec.message.raw_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(rec.message.from, undefined, 'signed records carry From only inside signed_headers');
  assert.equal(rec.verdicts.live.trust, 'verified');
  assert.equal(rec.verdicts.portable.trust, 'verified');
  assert.equal(rec.signatures.length, 1);
  assert.ok(rec.signatures[0].key.p && rec.signatures[0].key_file);

  // never the body, never the raw email, no plaintext Subject outside signed_headers
  const onDisk = fs.readFileSync(path.join(root, 'records', `${r.id}.json`), 'utf8');
  assert.ok(!onDisk.includes('TOPSECRET'));
  assert.ok(!onDisk.includes('Quarterly'), 'Subject only appears base64-encoded in signed_headers');
  assert.ok(onDisk.endsWith('}\n'));
});

test('list: newest first, filter by direction, limit; get rejects bad ids', async () => {
  const dir = tmp();
  const m1 = await signedMail({ body: 'one\r\n' });
  const m2 = await signedMail({ body: 'two\r\n', signers: [{ domain: m1.domain, selector: 'sel1', key: m1.signers[0].key }] });
  let t = '2026-11-01T10:00:00Z';
  const mp = new Mailproof({ trailDir: dir, resolver: m1.resolver, now: () => new Date(t) });
  const a = await mp.record(m1.raw, { direction: 'in' });
  t = '2026-11-02T10:00:00Z';
  const b = await mp.record(m2.raw, { direction: 'out' });
  assert.deepEqual((await mp.list()).map((x) => x.id), [b.id, a.id]);
  assert.deepEqual((await mp.list({ direction: 'in' })).map((x) => x.id), [a.id]);
  assert.equal((await mp.list({ limit: 1 })).length, 1);
  assert.equal(await mp.get('../../etc/passwd'), null);
  assert.equal(await mp.get('0'.repeat(32)), null);
  assert.deepEqual(await new Mailproof({ trailDir: tmp() }).list(), []);
});

test('dedupe: the same email twice makes no second commit', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = mk(dir, m);
  const a = await mp.record(m.raw, { direction: 'in', source: 'imap' });
  const b = await mp.record(m.raw, { direction: 'out', source: 'pipe' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  assert.equal(b.commit, a.commit);
  assert.equal(gitOut(path.join(dir, 'default'), 'rev-list', '--count', 'HEAD'), '2');
  assert.equal((await mp.get(a.id)).source, 'imap', 'first capture wins');
});

test('same signed mail with an extra transit header gets the same id (b=-based)', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = mk(dir, m);
  const a = await mp.record(m.raw, { direction: 'in' });
  const viaPipe = Buffer.concat([Buffer.from('Received: from mta.local by me; Sun, 1 Nov 2026 10:00:00 +0000\r\n'), m.raw]);
  assert.equal((await mp.record(viaPipe, { direction: 'in' })).id, a.id);
});

test('key archive: once per domain+selector+key; a rotated key adds a file, never rewrites', async () => {
  const dir = tmp();
  const m1 = await signedMail({ body: 'one\r\n' });
  const m1b = await signedMail({ body: 'again\r\n', signers: [{ domain: m1.domain, selector: 'sel1', key: m1.signers[0].key }] });
  const m2 = await signedMail({ body: 'two\r\n' }); // same domain/selector, NEW key
  let cur = m1.resolver;
  const mp = new Mailproof({ trailDir: dir, resolver: (n, t) => cur(n, t), now: clock() });
  const keyDir = path.join(dir, 'default', 'keys', m1.domain, 'sel1');
  await mp.record(m1.raw, { direction: 'in' });
  const first = fs.readdirSync(keyDir);
  const firstBytes = fs.readFileSync(path.join(keyDir, first[0]), 'utf8');
  await mp.record(m1b.raw, { direction: 'in' });
  assert.deepEqual(fs.readdirSync(keyDir), first, 'same key again: no new file');
  cur = m2.resolver;
  await mp.record(m2.raw, { direction: 'in' });
  const after = fs.readdirSync(keyDir);
  assert.equal(after.length, 2);
  assert.equal(fs.readFileSync(path.join(keyDir, first[0]), 'utf8'), firstBytes);
  const kf = JSON.parse(firstBytes);
  assert.equal(kf.v, 2);
  assert.equal(kf.domain, m1.domain);
  assert.match(kf.txt, /^v=DKIM1/);
  assert.equal(kf.lookup, `sel1._domainkey.${m1.domain}`);
});

test('unsigned mail is recorded as unverified with minimal metadata and no key archive', async () => {
  const dir = tmp();
  const raw = Buffer.from('From: Eve <eve@nowhere.example>\r\nTo: me@x.example\r\nSubject: hello secret subject\r\nMessage-ID: <u1@nowhere.example>\r\n\r\nplain body\r\n');
  const mp = new Mailproof({ trailDir: dir, now: clock(), resolver: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } });
  const r = await mp.record(raw, { direction: 'in' });
  const rec = await mp.get(r.id);
  assert.equal(rec.verdicts.live.trust, 'unverified');
  assert.equal(rec.verdicts.portable.trust, 'unverified');
  assert.equal(rec.verdicts.portable.basis, 'none');
  assert.deepEqual(rec.signatures, []);
  assert.equal(rec.message.from, 'eve@nowhere.example');
  assert.equal(rec.message.message_id, '<u1@nowhere.example>');
  assert.ok(!fs.existsSync(path.join(dir, 'default', 'keys')));
  const text = fs.readFileSync(path.join(dir, 'default', 'records', `${r.id}.json`), 'utf8');
  assert.ok(!text.includes('secret subject') && !text.includes('plain body'));
});

test('l= leaves part of the body unsigned: the record flags partial_body', async () => {
  const m = await signedMail({ body: 'signed part and an unsigned tail\r\n', bodyLength: 5, canon: 'simple/simple' });
  const rec = await (async () => { const mp = mk(tmp(), m); const r = await mp.record(m.raw, { direction: 'in' }); return mp.get(r.id); })();
  assert.equal(rec.signatures[0].partial_body, true);
});

test('multiple signatures: one entry each, both keys archived', async () => {
  const m = await signedMail({ from: 'me@a.example', signers: [{ domain: 'a.example', selector: 's1' }, { domain: 'b.example', selector: 's2', alg: 'ed25519' }] });
  const dir = tmp();
  const mp = mk(dir, m);
  const rec = await mp.get((await mp.record(m.raw, { direction: 'in' })).id);
  assert.equal(rec.signatures.length, 2);
  assert.deepEqual(rec.signatures.map((s) => s.key.k).sort(), ['ed25519', 'rsa']);
  assert.equal(rec.verdicts.live.dkim.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'default', 'keys', 'b.example', 's2')));
});

test('attachments: sha256 + size + filename recorded, content never', async () => {
  const bytes = Buffer.from('PDF-ISH-ATTACHMENT-CONTENT');
  const m = await signedMail({ attachment: { filename: 'contract.pdf', bytes } });
  const dir = tmp();
  const mp = mk(dir, m);
  const r = await mp.record(m.raw, { direction: 'in' });
  const rec = await mp.get(r.id);
  assert.equal(rec.attachments.length, 1);
  assert.equal(rec.attachments[0].filename, 'contract.pdf');
  assert.equal(rec.attachments[0].size, bytes.length);
  assert.match(rec.attachments[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!fs.readFileSync(path.join(dir, 'default', 'records', `${r.id}.json`), 'utf8').includes('ATTACHMENT-CONTENT'));
});

test('a failing commit leaves no files behind and the tree clean', async () => {
  const dir = tmp();
  const m1 = await signedMail({ body: 'one\r\n' });
  const m2 = await signedMail({ body: 'two\r\n', signers: [{ domain: m1.domain, selector: 'sel1', key: m1.signers[0].key }] });
  const mp = mk(dir, m1);
  await mp.record(m1.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(() => mp.record(m2.raw, { direction: 'in' }), /git commit failed/);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal(fs.readdirSync(path.join(root, 'records')).length, 1);
  fs.rmSync(hook);
  assert.equal((await mp.record(m2.raw, { direction: 'in' })).duplicate, false, 'recoverable once the hook is gone');
});

test('input validation: direction required, empty message, trail names', async () => {
  const m = await signedMail({});
  const mp = mk(tmp(), m);
  await assert.rejects(() => mp.record(m.raw, {}), /direction/);
  await assert.rejects(() => mp.record(m.raw, { direction: 'sideways' }), /direction/);
  await assert.rejects(() => mp.record(Buffer.alloc(0), { direction: 'in' }), /empty/);
  assert.throws(() => new Mailproof({ trailDir: tmp(), trail: '../evil' }), /trail name/);
  assert.throws(() => new Mailproof({}), /trailDir/);
});

test('two named trails are independent repos', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const a = new Mailproof({ trailDir: dir, trail: 'alpha', resolver: m.resolver, now: clock() });
  const b = new Mailproof({ trailDir: dir, trail: 'beta', resolver: m.resolver, now: clock() });
  const r = await a.record(m.raw, { direction: 'in' });
  assert.equal(r.duplicate, false);
  assert.equal((await b.record(m.raw, { direction: 'in' })).duplicate, false);
  assert.ok(fs.existsSync(path.join(dir, 'alpha', '.git')) && fs.existsSync(path.join(dir, 'beta', '.git')));
});

test('bound methods destructure', async () => {
  const m = await signedMail({});
  const { record, get, list } = mk(tmp(), m);
  const r = await record(m.raw, { direction: 'in' });
  assert.ok(await get(r.id));
  assert.equal((await list()).length, 1);
});
