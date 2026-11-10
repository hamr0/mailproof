// M3 step 4: Mailproof#replyFacts (SPEC B10) on the synthetic thread of tests/helpers/thread-trail.js (example.* only).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { trailIndexFile } from '../../src/proof/trail.js';
import { recordPath } from '../../src/proof/layout.js';
import { buildThread } from '../helpers/thread-trail.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const REQ = '<req@owner.example>';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const ids = (bundles) => bundles.map((b) => b.recordId);
const man = (headers, body = 'APPROVE\r\n') => Buffer.from([...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));

const FIELDS = ['messageId', 'messageKey', 'recordId', 'commit', 'trail', 'captured', 'from', 'fromRaw', 'fromDomain', 'fromDkimAligned', 'to', 'toRaw', 'cc', 'ccRaw',
  'date', 'dateSource', 'subject', 'subjectSource', 'dkim', 'dmarc', 'spf', 'arc', 'live', 'portable', 'link', 'text', 'firstLine', 'textSource',
  'bodyProven', 'quote', 'trailing', 'attachments'];
const CLOSED = {
  fromDkimAligned: ['pass', 'fail', 'none'], dateSource: ['signed', 'claimed', 'none'], subjectSource: ['signed', 'claimed', 'none'],
  dkim: ['pass', 'fail', 'none'], dmarc: ['pass', 'fail', 'none', 'other'], spf: ['pass', 'fail', 'none', 'other'], arc: ['pass', 'fail', 'none', 'other'],
  live: ['verified', 'forwarded', 'authorized', 'unverified'], portable: ['verified', 'forwarded', 'authorized', 'unverified'],
  link: ['signed', 'unsigned', 'none'], textSource: ['content', 'none', 'over-limit'], bodyProven: ['proven', 'unproven'],
  quote: ['found', 'not-found', 'inline'], trailing: ['yes', 'no'],
};
function assertShape(b) {
  assert.deepEqual(Object.keys(b), FIELDS);
  for (const [k, v] of Object.entries(b)) assert.equal(typeof v, 'string', k);
  for (const [k, set] of Object.entries(CLOSED)) assert.ok(set.includes(b[k]), `${k}=${b[k]}`);
}

test('0 replies: an unknown id, a request nobody answered, an empty trail, bare id without brackets', async () => {
  const { mp, dir, r } = await buildThread();
  assert.deepEqual(await mp.replyFacts({ messageId: '<nobody@owner.example>' }), []);
  assert.deepEqual(await mp.replyFacts({ messageId: '<z1@zed.example>' }), []);        // recorded, never answered
  assert.deepEqual(await mp.replyFacts({ messageId: '<r2@gamma.example>' }), []);      // a reply nobody answered
  assert.equal((await mp.replyFacts({ messageId: 'req@owner.example' })).length, 3, 'brackets are added when missing');
  await assert.rejects(() => mp.replyFacts({ messageId: '' }), TypeError);
  await assert.rejects(() => mp.replyFacts({}), TypeError);
  await assert.rejects(() => mp.replyFacts(), TypeError);
  assert.ok(r.req);
  const { Mailproof } = await import('../../src/proof/mailproof.js');
  assert.deepEqual(await new Mailproof({ trailDir: dir, trail: 'empty', worker: { size: 0 } }).replyFacts({ messageId: REQ }), []);
});

test('the direct replies, earliest capture first; a grandchild and unrelated mail are not included; every value a string from its set', async () => {
  const { mp, r } = await buildThread();
  const b = await mp.replyFacts({ messageId: REQ });
  assert.deepEqual(ids(b), [r.signed.id, r.unsigned.id, r.failing.id]);   // not grand (its In-Reply-To is r1), not plain
  b.forEach(assertShape);
  const [s, u, f] = b;
  assert.equal(s.messageId, '<r1@beta.example>');
  assert.equal(s.from, 'bob@beta.example'); assert.equal(s.fromRaw, 'Bob@Beta.Example'); assert.equal(s.fromDomain, 'beta.example');
  assert.equal(s.to, 'me@owner.example'); assert.equal(s.cc, '');
  assert.equal(s.fromDkimAligned, 'pass'); assert.equal(s.link, 'signed');
  assert.equal(s.dkim, 'pass'); assert.equal(s.dmarc, 'pass'); assert.equal(s.spf, 'none'); assert.equal(s.arc, 'none');
  assert.equal(s.live, 'verified'); assert.equal(s.portable, 'verified');
  assert.equal(s.text, 'I confirm.'); assert.equal(s.firstLine, 'I confirm.');
  assert.equal(s.textSource, 'content'); assert.equal(s.bodyProven, 'proven'); assert.equal(s.trailing, 'no');
  assert.equal(s.trail, 'default'); assert.equal(s.captured, r.signed.captured);
  assert.equal(s.messageKey, r.signed.message_key);
  assert.equal(u.link, 'unsigned'); assert.equal(u.cc, 'dave@delta.example'); assert.equal(u.fromDkimAligned, 'pass');
  assert.equal(f.link, 'unsigned'); assert.equal(f.fromDkimAligned, 'fail'); assert.equal(f.dkim, 'fail'); assert.equal(f.live, 'unverified');
  // the grandchild's own reply set
  assert.deepEqual(ids(await mp.replyFacts({ messageId: '<r1@beta.example>' })), [r.grand.id]);
});

test('direct reply rule: the LAST References entry counts (no In-Reply-To), an earlier one does not; an outbound reply is not included', async () => {
  const { mp, rec, mk, r } = await buildThread();
  const sign = ['from', 'to', 'subject', 'date', 'message-id', 'references'];
  const last = await mk('beta.example', { from: 'bob@beta.example', messageId: '<last@beta.example>', references: '<old@owner.example> <req@owner.example>', headerList: sign });
  const early = await mk('beta.example', { from: 'bob@beta.example', messageId: '<early@beta.example>', references: '<req@owner.example> <other@owner.example>', headerList: sign });
  const out = await mk('owner.example', { from: 'me@owner.example', to: 'bob@beta.example', messageId: '<out@owner.example>', inReplyTo: REQ, references: REQ });
  const a = await rec('last', last.raw, 'in', 7);
  await rec('early', early.raw, 'in', 8);
  await rec('out', out.raw, 'out', 9);
  const b = await mp.replyFacts({ messageId: REQ });
  assert.deepEqual(ids(b), [r.signed.id, r.unsigned.id, r.failing.id, a.id]);
  assert.equal(b[3].link, 'signed');                 // References signed and verifying
  assert.deepEqual(ids(await mp.replyFacts({ messageId: '<other@owner.example>' })), [(await mp.list()).find((x) => x.message_id === '<early@beta.example>').id]);
});

test('copies of one reply are separate bundles with the same messageKey; ties on captured go by id', async () => {
  const { mp, rec, mails, r } = await buildThread();
  const relayed = await rec('relay', Buffer.concat([Buffer.from('X-Relay: hop1\r\n'), mails.signed.raw]), 'in', 7);
  assert.notEqual(relayed.id, r.signed.id); assert.equal(relayed.message_key, r.signed.message_key);
  const b = await mp.replyFacts({ messageId: REQ });
  assert.equal(b.length, 4);
  const same = b.filter((x) => x.messageKey === r.signed.message_key);
  assert.deepEqual(ids(same), [r.signed.id, relayed.id]);
  assert.ok(b.every((x, i) => i === 0 || b[i - 1].captured <= x.captured));
  // same capture time: id order
  const t1 = await rec('tie', Buffer.concat([Buffer.from('X-Relay: hop2\r\n'), mails.signed.raw]), 'in', 7);
  const tied = (await mp.replyFacts({ messageId: REQ })).filter((x) => x.captured === relayed.captured).map((x) => x.recordId);
  assert.deepEqual(tied, [relayed.id, t1.id].sort());
});

test('read-only: HEAD, the working tree and the trail files are unchanged; no reply-text row is written', async () => {
  const { mp, dir } = await buildThread();
  const root = path.join(dir, 'default');
  await mp.list();   // index built first: replyFacts itself then has nothing to catch up
  const before = [git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain'), fs.readdirSync(root).sort().join()];
  await mp.replyFacts({ messageId: REQ });
  await mp.replyFacts({ messageId: REQ });
  assert.deepEqual([git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain'), fs.readdirSync(root).sort().join()], before);
  assert.ok(!fs.existsSync(path.join(root, 'replies')));
});

test('content missing (store off): the bundle still comes from the record; text empty, textSource none, unproven', async () => {
  const { mp, r } = await buildThread({ content: { store: false } });
  const [s] = await mp.replyFacts({ messageId: REQ });
  assertShape(s);
  assert.equal(s.recordId, r.signed.id);
  assert.equal(s.text, ''); assert.equal(s.firstLine, ''); assert.equal(s.textSource, 'none');
  assert.equal(s.bodyProven, 'unproven'); assert.equal(s.quote, 'not-found'); assert.equal(s.trailing, 'no');
  assert.equal(s.fromDkimAligned, 'pass'); assert.equal(s.link, 'signed'); assert.equal(s.subjectSource, 'signed');
});

test('content forgotten later: the same bundle without text', async () => {
  const { mp, r } = await buildThread();
  assert.equal((await mp.replyFacts({ messageId: REQ }))[0].textSource, 'content');
  await mp.forget(r.signed.id);
  const [s] = await mp.replyFacts({ messageId: REQ });
  assert.equal(s.recordId, r.signed.id); assert.equal(s.textSource, 'none'); assert.equal(s.firstLine, '');
});

test('date and subject: signed when a verifying signature covers them, claimed from the stored raw email (decoded) otherwise, none without content', async () => {
  const subj = '=?UTF-8?B?w4lsw6h2ZQ==?= =?UTF-8?Q?_de_Gen=C3=A8ve?=';
  const mkMails = async (content) => {
    const t = await buildThread({ content });
    const signedEnc = await t.mk('beta.example', { from: 'bob@beta.example', messageId: '<enc-s@beta.example>', inReplyTo: REQ, subject: subj, headerList: ['from', 'to', 'subject', 'date', 'message-id', 'in-reply-to'] });
    const claimed = await t.mk('beta.example', { from: 'bob@beta.example', messageId: '<enc-c@beta.example>', inReplyTo: REQ, subject: subj, headerList: ['from', 'message-id'] });
    const a = await t.rec('a', signedEnc.raw, 'in', 7);
    const b = await t.rec('b', claimed.raw, 'in', 8);
    return { ...t, a, b };
  };
  const t = await mkMails(undefined);
  const out = await t.mp.replyFacts({ messageId: REQ });
  const sa = out.find((x) => x.recordId === t.a.id), cb = out.find((x) => x.recordId === t.b.id);
  assert.equal(sa.subject, 'Élève de Genève'); assert.equal(sa.subjectSource, 'signed'); assert.equal(sa.dateSource, 'signed');
  assert.equal(cb.subject, 'Élève de Genève'); assert.equal(cb.subjectSource, 'claimed');
  assert.equal(cb.dateSource, 'claimed'); assert.match(cb.date, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} 2026 /);
  const n = await mkMails({ store: false });
  const nb = (await n.mp.replyFacts({ messageId: REQ })).find((x) => x.recordId === n.b.id);
  assert.equal(nb.subject, ''); assert.equal(nb.subjectSource, 'none'); assert.equal(nb.date, ''); assert.equal(nb.dateSource, 'none');
  // a signature that does not verify does not make a header "signed"
  const f = out.find((x) => x.recordId === t.r.failing.id);
  assert.equal(f.subjectSource, 'claimed'); assert.equal(f.subject, 'Re: please sign!');
});

test('multi-value fields: comma, no space, header order, lower-cased with Raw siblings; attachments are hashes', async () => {
  const { mp, rec } = await buildThread();
  const raw = Buffer.from([
    'From: Eve <Eve@Example.NET>', 'To: Bob <B@one.example>, "Zed, Z" <z@two.example>', 'Cc: C@three.example', 'Cc: d@four.example',
    'Message-ID: <multi@example.net>', `In-Reply-To: ${REQ}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bb"', '',
    '--bb', 'Content-Type: text/plain; charset=utf-8', '', 'APPROVE', '--bb', 'Content-Type: application/octet-stream; name="a.bin"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="a.bin"', '', Buffer.from('first').toString('base64'),
    '--bb', 'Content-Type: application/octet-stream; name="b.bin"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="b.bin"', '', Buffer.from('second').toString('base64'), '--bb--', ''].join('\r\n'));
  const x = await rec('multi', raw, 'in', 7);
  const b = (await mp.replyFacts({ messageId: REQ })).find((y) => y.recordId === x.id);
  assert.equal(b.to, 'b@one.example,z@two.example'); assert.equal(b.toRaw, 'B@one.example,z@two.example');
  assert.equal(b.cc, 'c@three.example,d@four.example'); assert.equal(b.ccRaw, 'C@three.example,d@four.example');
  assert.equal(b.from, 'eve@example.net'); assert.equal(b.fromRaw, 'Eve@Example.NET');
  assert.match(b.attachments, /^sha256:[0-9a-f]{64},sha256:[0-9a-f]{64}$/);
  assert.equal(b.fromDkimAligned, 'none'); assert.equal(b.link, 'unsigned'); assert.equal(b.dkim, 'none'); assert.equal(b.live, 'unverified');
});

test('a reply with no Message-ID has messageId ""; the unsigned reply is fromDkimAligned none', async () => {
  const { mp, rec } = await buildThread();
  const x = await rec('nomid', man(['From: eve@example.net', 'To: me@owner.example', `In-Reply-To: ${REQ}`]), 'in', 7);
  const b = (await mp.replyFacts({ messageId: REQ })).find((y) => y.recordId === x.id);
  assert.equal(b.messageId, ''); assert.equal(b.messageKey, ''); assert.equal(b.fromDkimAligned, 'none'); assertShape(b);
});

test('quote, trailing and firstLine on real-shaped bodies', async () => {
  const { mp, rec } = await buildThread();
  const hdr = (id) => ['From: eve@example.net', 'To: me@owner.example', `Message-ID: <${id}@example.net>`, `In-Reply-To: ${REQ}`];
  const bottom = await rec('bottom', man(hdr('bottom'), 'On Mon, 3 Nov 2025 at 10:00, Owner <me@owner.example> wrote:\r\n> Approve payment of $5,000?\r\n\r\nAPPROVE\r\n'), 'in', 7);
  const nbsp = await rec('nbsp', man(hdr('nbsp'), ' \r\n﻿ \t APPROVE  \r\nsecond line\r\n'), 'in', 8);
  const cr = await rec('cr', man(hdr('cr'), '\r\r\rAPPROVE\rnot this\r'), 'in', 9);
  const empty = await rec('empty', man(hdr('empty'), '   \r\n\r\n'), 'in', 10);
  const lower = await rec('lower', man(hdr('lower'), 'approve\r\n'), 'in', 11);
  const out = await mp.replyFacts({ messageId: REQ });
  const by = (x) => out.find((y) => y.recordId === x.id);
  assert.equal(by(bottom).trailing, 'yes'); assert.equal(by(bottom).quote, 'found'); assert.equal(by(bottom).firstLine, '');
  assert.equal(by(nbsp).firstLine, 'APPROVE');
  assert.equal(by(cr).firstLine, 'APPROVE');
  assert.equal(by(empty).firstLine, '');
  assert.equal(by(lower).firstLine, 'approve');   // no case folding
});

test('commit is the commit that recorded the reply (matches git), from the index, also after catch-up and after a stale-schema rebuild', async () => {
  const { mp, dir, rec, mails } = await buildThread();
  const root = path.join(dir, 'default');
  const gitCommit = (id) => git(root, 'log', '--diff-filter=A', '--format=%H', '--', recordPath(id));
  const check = async () => { for (const b of await mp.replyFacts({ messageId: REQ })) { assert.match(b.commit, /^[0-9a-f]{40}$/); assert.equal(b.commit, gitCommit(b.recordId)); } };
  await check();
  const x = await rec('later', Buffer.concat([Buffer.from('X-Relay: hop\r\n'), mails.signed.raw]), 'in', 7);   // catch-up path
  await check();
  assert.equal((await mp.replyFacts({ messageId: REQ })).find((b) => b.recordId === x.id).commit, gitCommit(x.id));
  // an index cache of the previous schema (no commit column) is rebuilt, not read
  const file = path.join(dir, trailIndexFile('default'));
  const d = new Database(file);   // a real schema-3 file: the old table shapes, no commit_id and no direct column
  d.exec(`DROP TABLE rec; DROP TABLE links;
    CREATE TABLE rec(id TEXT PRIMARY KEY, captured TEXT NOT NULL, direction TEXT, live TEXT, portable TEXT, message_id TEXT, message_key TEXT, copy_kind TEXT, body_status TEXT) WITHOUT ROWID;
    CREATE TABLE links(rec_id TEXT NOT NULL, mid TEXT NOT NULL, via TEXT NOT NULL, strength TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY(rec_id, mid)) WITHOUT ROWID;
    UPDATE meta SET v = '3' WHERE k = 'schema'`);
  d.close();
  await check();
  const d2 = new Database(file, { readonly: true });
  assert.equal(d2.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, '4');
  assert.equal(d2.prepare('SELECT COUNT(*) AS n FROM rec WHERE commit_id IS NULL').get().n, 0);
  d2.close();
});

test('more than 200 direct replies rejects ERR_TOO_MANY_REPLIES, never a silent cut', async () => {
  const { mp, dir } = await buildThread();
  await mp.list();
  const d = new Database(path.join(dir, trailIndexFile('default')));
  const rec = d.prepare("INSERT INTO rec(id, captured, direction) VALUES (?, '2026-11-02T00:00:00.000Z', 'in')");
  const link = d.prepare("INSERT INTO links VALUES (?, '<flood@owner.example>', 'in-reply-to', 'unsigned', 0, 1)");
  for (let i = 0; i < 201; i++) { const id = i.toString(16).padStart(32, '0'); rec.run(id); link.run(id); }
  d.close();
  await assert.rejects(() => mp.replyFacts({ messageId: '<flood@owner.example>' }), { code: 'ERR_TOO_MANY_REPLIES' });
});

test('cost: replyFacts at 2,000 records (measured, wide margin)', async () => {
  const { mp, dir } = await buildThread();
  await mp.list();
  const d = new Database(path.join(dir, trailIndexFile('default')));
  const rec = d.prepare("INSERT INTO rec(id, captured, direction, commit_id) VALUES (?, '2026-11-02T00:00:00.000Z', 'in', 'x')");
  for (let i = 0; i < 2000; i++) rec.run(`f${i.toString(16).padStart(31, '0')}`);
  d.close();
  const t = process.hrtime.bigint();
  const b = await mp.replyFacts({ messageId: REQ });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(b.length, 3);
  console.log(`# replyFacts at 2,003 index rows: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 5000);
});
