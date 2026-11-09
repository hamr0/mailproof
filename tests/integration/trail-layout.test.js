// The sharded trail layout (SPEC B3, findings F24): records/<2hex>/<id>.json, replies/<2hex>/<id>.<slug>.json,
// one canonical path helper (src/proof/layout.js), and a clear error for the pre-M3 flat layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { recordPath, recordOtsPath, replyPath, parseRecordPath, isReplyPath, recordIdsFromPaths, assertTrailLayout } from '../../src/proof/layout.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const tmp = () => makeTmpDir('mp-layout-');
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const ID = 'ab' + 'cd'.repeat(15);

test('the path helpers spell the sharded layout (literals, not the helper itself)', () => {
  assert.equal(recordPath(ID), `records/ab/${ID}.json`);
  assert.equal(recordOtsPath(ID), `records/ab/${ID}.json.ots`);
  assert.equal(replyPath(ID, 'mailproof-quote-1'), `replies/ab/${ID}.mailproof-quote-1.json`);
});

test('the parsers accept only the library\'s own paths (shard must be the id\'s own)', () => {
  assert.deepEqual(parseRecordPath(`records/ab/${ID}.json`), { id: ID, ots: false });
  assert.deepEqual(parseRecordPath(`records/ab/${ID}.json.ots`), { id: ID, ots: true });
  for (const bad of [`records/${ID}.json`, `records/cd/${ID}.json`, `records/ab/${ID.toUpperCase()}.json`, `records/ab/x/${ID}.json`, `records/ab/${ID}.txt`, `record/ab/${ID}.json`, 'records/ab/abcd.json']) {
    assert.equal(parseRecordPath(bad), null, bad);
  }
  assert.equal(isReplyPath(`replies/ab/${ID}.mailproof-quote-1.json`), true);
  for (const bad of [`replies/${ID}.q-1.json`, `replies/cd/${ID}.q-1.json`, `replies/ab/${ID}.Q.json`, `replies/ab/${ID}.json`]) assert.equal(isReplyPath(bad), false, bad);
  // ids of record files only: the .ots, a wrong shard and a flat path are not ids
  const list = [`records/ab/${ID}.json`, `records/ab/${ID}.json.ots`, `records/cd/${ID}.json`, `records/${ID}.json`, `replies/ab/${ID}.q-1.json`].join('\0');
  assert.deepEqual(recordIdsFromPaths(list), [ID]);
});

test('record() and replyText() write sharded paths on disk, one commit each', async () => {
  const dir = tmp();
  const m = await signedMail({ body: 'hello\r\n' });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 } });
  const r = await mp.record(m.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  assert.equal(gitOut(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((f) => f.startsWith('records/')).join(), `records/${r.id.slice(0, 2)}/${r.id}.json`);
  assert.ok(fs.existsSync(path.join(root, 'records', r.id.slice(0, 2), `${r.id}.json`)));
  assert.deepEqual(fs.readdirSync(path.join(root, 'records')), [r.id.slice(0, 2)], 'only the shard dir at the top of records/');
  assert.equal((await mp.get(r.id)).id, r.id);
  const t = await mp.replyText(m.raw);
  assert.equal(gitOut(root, 'show', '--name-only', '--format=', 'HEAD'), `replies/${t.id.slice(0, 2)}/${t.id}.mailproof-quote-1.json`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'replies')), [t.id.slice(0, 2)]);
});

test('index catch-up and a full rebuild see records across shards (and ignore .ots and replies)', async () => {
  const dir = tmp();
  const first = await signedMail({ body: 'mail 0\r\n' });
  const mails = [first];
  for (let i = 1; i < 5; i++) mails.push(await signedMail({ body: `mail ${i}\r\n`, domain: first.domain, signers: [{ domain: first.domain, selector: 'sel1', key: first.signers[0].key }] }));
  const mp = new Mailproof({ trailDir: dir, resolver: first.resolver, worker: { size: 0 } });
  const ids = [];
  for (const m of mails.slice(0, 3)) ids.push((await mp.record(m.raw, { direction: 'in' })).id);
  assert.equal((await mp.list()).length, 3, 'first build');
  for (const m of mails.slice(3)) ids.push((await mp.record(m.raw, { direction: 'in' })).id);
  await mp.replyText(mails[0].raw);
  const sorted = (rows) => rows.map((r) => r.id).sort();
  assert.deepEqual(sorted(await mp.list()), [...ids].sort(), 'catch-up');
  fs.rmSync(path.join(dir, '.default.index.sqlite'), { force: true });
  fs.rmSync(path.join(dir, '.default.index.sqlite-wal'), { force: true });
  fs.rmSync(path.join(dir, '.default.index.sqlite-shm'), { force: true });
  assert.deepEqual(sorted(await mp.list()), [...ids].sort(), 'rebuild');
});

test('a trail with the pre-M3 flat layout fails with ERR_TRAIL_LAYOUT on write, get, list and expire/forget; nothing is converted', async () => {
  const dir = tmp();
  const m = await signedMail({ body: 'flat\r\n' });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 } });
  const r = await mp.record(m.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  // turn it into a flat trail, as 2.2.x wrote it
  fs.renameSync(path.join(root, recordPath(r.id)), path.join(root, 'records', `${r.id}.json`));
  fs.rmdirSync(path.join(root, 'records', r.id.slice(0, 2)));
  const rejects = (p) => assert.rejects(p, { code: 'ERR_TRAIL_LAYOUT', message: /pre-M3 flat layout/ });
  await rejects(mp.record(m.raw, { direction: 'in' }));
  await rejects(mp.get(r.id));
  await rejects(mp.list());
  await rejects(mp.copies(r.id));
  await rejects(mp.expireContent());
  await rejects(mp.forget(r.id));
  await rejects(mp.replyText(m.raw));
  assert.deepEqual(fs.readdirSync(path.join(root, 'records')), [`${r.id}.json`], 'nothing converted');
  await assertTrailLayout(path.join(dir, 'no-such-trail'));   // a missing trail is not a layout error
});
