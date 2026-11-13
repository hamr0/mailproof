// The local content store (SPEC B7): raw email + attachments beside the trail, retention, forget. Real git trail,
// real files, worker.size 0 unless a test says otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { runSync } from '../../src/proof/sync.js';
import { MAX_TOTAL_BYTES } from '../../src/proof/limits.js';
import { signedMail } from '../helpers/proof.js';
import { makeFake } from '../helpers/fake-imap-session.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { recordPath } from '../../src/proof/layout.js';

const T0 = new Date('2026-11-01T10:00:00Z');
const DAY = 86_400_000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PDF = Buffer.from('%PDF-1.4 the very same contract bytes\n'.repeat(20));

/** A mailproof whose clock the test moves; `m` supplies the resolver for the signed mails it records. */
function setup(m, extra = {}) {
  const dir = makeTmpDir('mp-content-');
  const clock = { t: T0 };
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => clock.t, ...extra });
  return { dir, clock, mp, root: path.join(dir, 'default'), cdir: path.join(dir, 'default.content') };
}
const rawFile = (cdir, id) => path.join(cdir, 'raw', id.slice(0, 2), `${id}.eml`);
const attFile = (cdir, hex) => path.join(cdir, 'att', hex.slice(0, 2), hex);
const files = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

test('default on: raw + attachment land beside the trail (never in git), 0600/0700, and read back', async () => {
  const m = await signedMail({ signTime: T0, body: 'hello\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, root, cdir, dir } = setup(m);
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.deepEqual(r.content, { stored: true, attachments: 1 });
  assert.ok(fs.existsSync(rawFile(cdir, r.id)));
  assert.ok(fs.existsSync(attFile(cdir, sha(PDF))));
  assert.deepEqual(await mp.rawEmail(r.id), m.raw);
  assert.deepEqual(await mp.attachment(`sha256:${sha(PDF)}`), PDF);
  assert.deepEqual(await mp.attachment(sha(PDF)), PDF);
  assert.equal(fs.statSync(rawFile(cdir, r.id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(rawFile(cdir, r.id))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(cdir).mode & 0o777, 0o700);
  // not in the repo, not tracked, no temp files left
  assert.equal(files(root).filter((f) => f.includes('.eml')).length, 0);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.content')).length, 1);
  assert.ok(files(cdir).every((f) => !f.includes('.tmp-')));
  assert.equal(JSON.stringify(await mp.get(r.id)).includes(PDF.toString('base64')), false);
  // the record wire format carries no content field
  assert.equal('content' in (await mp.get(r.id)), false);
});

test('store:false is proof-only: nothing written, no content field, reads are null', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, dir } = setup(m, { content: { store: false } });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal('content' in r, false);
  assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.content')), false);
  assert.equal(await mp.rawEmail(r.id), null);
  assert.equal(await mp.attachment(sha(PDF)), null);
  const dup = await mp.record(m.raw, { direction: 'in' });
  assert.deepEqual(Object.keys(dup).sort(), ['commit', 'duplicate', 'id']);
});

test('attachments:false keeps the raw but no attachment files', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, cdir } = setup(m, { content: { attachments: false } });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.deepEqual(r.content, { stored: true, attachments: 0 });
  assert.ok(fs.existsSync(rawFile(cdir, r.id)));
  assert.equal(fs.existsSync(path.join(cdir, 'att')), false);
  assert.equal(await mp.attachment(sha(PDF)), null);
});

test('worker path: attachment bytes come back from the worker', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, cdir } = setup(m, { worker: { size: 1 } });
  try {
    const r = await mp.record(m.raw, { direction: 'in' });
    assert.deepEqual(r.content, { stored: true, attachments: 1 });
    assert.deepEqual(fs.readFileSync(attFile(cdir, sha(PDF))), PDF);
  } finally { await mp.close(); }
});

test('write-once and dedup: two records sharing an attachment keep one file; an existing file is never overwritten', async () => {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'copy.pdf', bytes: PDF } });
  const { mp, cdir } = setup(a);
  const ra = await mp.record(a.raw, { direction: 'in' });
  const attPath = attFile(cdir, sha(PDF));
  const ino = fs.statSync(attPath).ino;
  const rb = await mp.record(b.raw, { direction: 'in' });
  assert.deepEqual(rb.content, { stored: true, attachments: 1 });
  assert.equal(files(path.join(cdir, 'att')).length, 1);
  assert.equal(fs.statSync(attPath).ino, ino, 'the existing attachment file is kept, not replaced');
  assert.notEqual(ra.id, rb.id);
});

test('self-verify on read: a corrupted file is never returned', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, cdir } = setup(m);
  const r = await mp.record(m.raw, { direction: 'in' });
  fs.writeFileSync(rawFile(cdir, r.id), Buffer.concat([m.raw, Buffer.from('x')]));
  fs.writeFileSync(attFile(cdir, sha(PDF)), 'tampered');
  assert.equal(await mp.rawEmail(r.id), null);
  assert.equal(await mp.attachment(sha(PDF)), null);
  await assert.rejects(mp.replyText({ id: r.id }), (e) => e.code === 'ERR_NO_CONTENT' && /hash check/.test(e.message));
  const mb = await mp.matchBody(r.id);
  assert.equal(mb.match, false);
  assert.match(mb.reason, /hash check/);
  assert.equal(await mp.rawEmail('../../etc/passwd'), null);
  assert.equal(await mp.attachment('../x'), null);
});

test('replyText({ id }), matchBody without raw, and ERR_NO_CONTENT', async () => {
  const m = await signedMail({ signTime: T0, body: 'Yes, approved.\r\n' });
  const { mp } = setup(m);
  const r = await mp.record(m.raw, { direction: 'in' });
  const viaRaw = await mp.replyText(m.raw);
  const viaId = await mp.replyText({ id: r.id });
  assert.equal(viaId.text, viaRaw.text);
  assert.equal(viaId.text, 'Yes, approved.');
  assert.equal(viaId.duplicate, true);
  assert.equal(viaId.proven, true);
  const mb = await mp.matchBody(r.id);
  assert.equal(mb.match, true);
  assert.equal(mb.full, true);
  assert.equal((await mp.matchBody(r.id, m.raw)).match, true);
  await assert.rejects(mp.replyText({ id: '0'.repeat(32) }), (e) => e.code === 'ERR_NO_CONTENT');
  await assert.rejects(mp.replyText({ id: 'nope' }), /32 hex/);

  const off = setup(m, { content: { store: false } });
  const r2 = await off.mp.record(m.raw, { direction: 'in' });
  await assert.rejects(off.mp.replyText({ id: r2.id }), (e) => e.code === 'ERR_NO_CONTENT');
  const none = await off.mp.matchBody(r2.id);
  assert.deepEqual([none.match, none.reason], [false, 'no stored content']);
});

test('backfill on a duplicate, unless the record is already expired', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, cdir, dir, clock } = setup(m, { content: { store: false } });
  const r = await mp.record(m.raw, { direction: 'in' });
  const on = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => clock.t, content: { days: 30 } });
  const d = await on.record(m.raw, { direction: 'in' });
  assert.equal(d.duplicate, true);
  assert.deepEqual(d.content, { stored: true, attachments: 1 });
  assert.deepEqual(await on.rawEmail(r.id), m.raw);
  // same again: nothing to write, still reported as stored
  assert.deepEqual((await on.record(m.raw, { direction: 'in' })).content, { stored: true, attachments: 1 });

  // expired: remove, move the clock past retention, record again: not backfilled
  await on.forget(r.id);
  clock.t = new Date(T0.getTime() + 31 * DAY);
  const e = await on.record(m.raw, { direction: 'in' });
  assert.equal(e.duplicate, true);
  assert.deepEqual(e.content, { stored: false, attachments: 0 });
  assert.equal(fs.existsSync(rawFile(cdir, r.id)), false);
});

test('rollback: a failed commit removes the content files this call created, only those', async () => {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'd.pdf', bytes: Buffer.from('another file') } });
  const { mp, root, cdir } = setup(a);
  const ra = await mp.record(a.raw, { direction: 'in' });
  const before = files(cdir).sort();
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(mp.record(b.raw, { direction: 'in' }));
  assert.deepEqual(files(cdir).sort(), before, 'the failed call left no content behind and kept the earlier record\'s');
  assert.deepEqual(await mp.rawEmail(ra.id), a.raw);
  assert.equal(await mp.get(crypto.createHash('sha256').update(b.raw).digest('hex').slice(0, 32)), null);
});

test('a content write failure never loses the proof', async () => {
  const m = await signedMail({ signTime: T0 });
  const { mp, dir } = setup(m);
  fs.writeFileSync(path.join(dir, 'default.content'), 'a file where the directory should be');
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal(r.duplicate, false);
  assert.equal(r.content.stored, false);
  assert.equal(r.content.attachments, 0);
  assert.match(r.content.error, /\w/);
  assert.equal((await mp.verify(r.id)).ok, true);
  assert.ok(await mp.get(r.id));
});

test('over-limit: raw stored when it passed the total-size gate, never attachments; over 25 MiB not stored', async () => {
  const { mp, cdir } = setup({ resolver: undefined });
  const longLine = Buffer.from(`From: a@x.example\r\nTo: b@y.example\r\nSubject: s\r\n\r\n${'x'.repeat(300 * 1024)}\r\n`);
  const r = await mp.record(longLine, { direction: 'in' });
  assert.equal(r.record.verdicts.live.reason, 'over limit: body_line');
  assert.deepEqual(r.content, { stored: true, attachments: 0 });
  assert.deepEqual(await mp.rawEmail(r.id), longLine);
  assert.equal(fs.existsSync(path.join(cdir, 'att')), false);

  const big = Buffer.alloc(MAX_TOTAL_BYTES + 1, 0x61);
  const rb = await mp.record(big, { direction: 'in' });
  assert.equal(rb.record.verdicts.live.reason, 'over limit: total_bytes');
  assert.deepEqual(rb.content, { stored: false, attachments: 0 });
  assert.equal(await mp.rawEmail(rb.id), null);
});

test('check() stores nothing', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, dir } = setup(m);
  await mp.check(m.raw);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('expiry: content goes after days from captured, shared attachment survives until its last user, proofs stay', async () => {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'c2.pdf', bytes: PDF } });
  const { mp, cdir, clock } = setup(a, { content: { days: 10 } });
  const ra = await mp.record(a.raw, { direction: 'in' });
  clock.t = new Date(T0.getTime() + 8 * DAY);
  const rb = await mp.record(b.raw, { direction: 'in' });

  assert.deepEqual(await mp.expireContent({ now: new Date(T0.getTime() + 9 * DAY) }), { removed: 0, attachments: 0 });
  // day 11: a is 11 days old (expired), b is 3 days old
  assert.deepEqual(await mp.expireContent({ now: new Date(T0.getTime() + 11 * DAY) }), { removed: 1, attachments: 0 });
  assert.equal(await mp.rawEmail(ra.id), null);
  assert.deepEqual(await mp.rawEmail(rb.id), b.raw);
  assert.deepEqual(await mp.attachment(sha(PDF)), PDF, 'b still needs the attachment');
  // day 19: b is 11 days old
  assert.deepEqual(await mp.expireContent({ now: new Date(T0.getTime() + 19 * DAY) }), { removed: 1, attachments: 1 });
  assert.equal(await mp.attachment(sha(PDF)), null);
  assert.deepEqual(await mp.expireContent({ now: new Date(T0.getTime() + 19 * DAY) }), { removed: 0, attachments: 0 });
  // proofs untouched
  for (const id of [ra.id, rb.id]) { assert.ok(await mp.get(id)); assert.equal((await mp.verify(id)).ok, true); }
  assert.equal(files(cdir).filter((f) => !f.includes('/gone/')).length, 0, 'no content left (only the notes of why it went)');
  assert.equal(files(path.join(cdir, 'gone')).length, 2, 'C13: one note per expired email, beside the store, outside git');
  assert.equal((await mp.describe(ra.id)).records[0].content.gone.reason, 'expired');
  await assert.rejects(mp.expireContent({ now: 'soon' }), TypeError);
});

test('expireContent keeps content whose record cannot be read, and sweeps orphan attachment files', async () => {
  const m = await signedMail({ signTime: T0 });
  const { mp, cdir, root } = setup(m, { content: { days: 1 } });
  const r = await mp.record(m.raw, { direction: 'in' });
  const orphan = Buffer.from('nobody references me');
  fs.mkdirSync(path.join(cdir, 'att', sha(orphan).slice(0, 2)), { recursive: true });
  fs.writeFileSync(attFile(cdir, sha(orphan)), orphan);
  fs.writeFileSync(path.join(root, recordPath(r.id)), '{ not json');
  const res = await mp.expireContent({ now: new Date(T0.getTime() + 400 * DAY) });
  assert.deepEqual(res, { removed: 0, attachments: 1 });
  assert.ok(fs.existsSync(rawFile(cdir, r.id)));
});

test('forget: by id, by array, idempotent; proofs untouched', async () => {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'c2.pdf', bytes: PDF } });
  const c = await signedMail({ signTime: T0, body: 'three\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }] });
  const { mp } = setup(a);
  const [ra, rb, rc] = [await mp.record(a.raw, { direction: 'in' }), await mp.record(b.raw, { direction: 'in' }), await mp.record(c.raw, { direction: 'in' })];
  assert.deepEqual(await mp.forget(ra.id), { removed: 1, attachments: 0 }, 'b still references the attachment');
  assert.deepEqual(await mp.forget(ra.id), { removed: 0, attachments: 0 });
  assert.deepEqual(await mp.forget([rb.id, rc.id, '1'.repeat(32)]), { removed: 2, attachments: 1 });
  for (const r of [ra, rb, rc]) { assert.equal(await mp.rawEmail(r.id), null); assert.equal((await mp.verify(r.id)).ok, true); }
  assert.equal(await mp.attachment(sha(PDF)), null);
  await assert.rejects(mp.forget('nope'), TypeError);
  await assert.rejects(mp.forget(['nope']), TypeError);
  await assert.rejects(mp.forget(42), TypeError);
});

test('forget by counterparty: exact address on From/To/Cc, date range, other people untouched', async () => {
  const key = (await signedMail({ signTime: T0 })).signers[0];
  const dom = 'signer.example';
  const mk = (over) => signedMail({ signTime: T0, domain: dom, signers: [{ domain: dom, selector: 'sel1', key: key.key }], ...over });
  const m1 = await mk({ body: '1\r\n', to: 'Bob <bob@gmail.com>' });
  const m2 = await mk({ body: '2\r\n', to: 'bob@company.com' });
  const m3 = await mk({ body: '3\r\n', from: 'BOB@Gmail.com', to: 'me@signer.example' });
  const m4 = await mk({ body: '4\r\n', to: 'carol@gmail.com', extraHeaders: ['Cc: bob@gmail.com'], headerList: ['from', 'to', 'subject', 'date', 'message-id'] });  // Cc unsigned: found via the record's addresses field
  const { mp, clock } = setup(m1);
  const out = [];
  for (const [i, m] of [m1, m2, m3, m4].entries()) { clock.t = new Date(T0.getTime() + i * DAY); out.push(await mp.record(m.raw, { direction: 'in' })); }
  const present = async () => (await Promise.all(out.map((r) => mp.rawEmail(r.id)))).map((x) => x !== null);

  // range: only the first day
  assert.deepEqual(await mp.forget({ with: 'bob@gmail.com', before: new Date(T0.getTime() + 1 * DAY) }), { removed: 1, attachments: 0 });
  assert.deepEqual(await present(), [false, true, true, true]);
  // after is inclusive: m3 (day 2) onward
  assert.deepEqual(await mp.forget({ with: 'Bob@gmail.com', after: new Date(T0.getTime() + 3 * DAY) }), { removed: 1, attachments: 0 });
  assert.deepEqual(await present(), [false, true, true, false]);
  assert.deepEqual(await mp.forget({ with: 'bob@gmail.com' }), { removed: 1, attachments: 0 });
  assert.deepEqual(await present(), [false, true, false, false]);
  assert.deepEqual(await mp.forget({ with: 'bob@gmail.com' }), { removed: 0, attachments: 0 });
  assert.deepEqual(await mp.forget({ with: 'bob@company.com' }), { removed: 1, attachments: 0 });
  for (const r of out) assert.equal((await mp.verify(r.id)).ok, true);
  await assert.rejects(mp.forget({ with: 'not an address' }), TypeError);
  await assert.rejects(mp.forget({ with: 'a@b.example', before: 'yesterday-ish' }), TypeError);
});

test('forget by counterparty finds the unsigned record by its message.from', async () => {
  const dir = makeTmpDir('mp-content-');
  const mp = new Mailproof({ trailDir: dir, worker: { size: 0 }, now: () => T0, resolver: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  const raw = Buffer.from('From: Eve <eve@x.example>\r\nTo: me@y.example\r\nSubject: hi\r\nMessage-ID: <1@x.example>\r\n\r\nhello\r\n');
  const r = await mp.record(raw, { direction: 'in' });
  assert.equal(r.record.message.from, 'eve@x.example');
  assert.deepEqual(await mp.forget({ with: 'eve@x.example' }), { removed: 1, attachments: 0 });
});

test('expire and forget take the trail lock', async () => {
  const m = await signedMail({ signTime: T0 });
  const { mp, root } = setup(m, { lockTimeoutMs: 150 });
  const r = await mp.record(m.raw, { direction: 'in' });
  // another process (a live pid on this host) holds the lock file
  const lock = path.join(path.dirname(root), '.default.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), started: new Date().toISOString() }));
  await assert.rejects(mp.expireContent(), (e) => e.code === 'ERR_TRAIL_LOCKED');
  await assert.rejects(mp.forget(r.id), (e) => e.code === 'ERR_TRAIL_LOCKED');
  assert.ok(await mp.rawEmail(r.id), 'nothing was deleted, and reads take no lock');
  fs.rmSync(lock);
  assert.deepEqual(await mp.forget(r.id), { removed: 1, attachments: 0 });
});

test('no content directory: expire and forget return zeros and create nothing', async () => {
  const dir = makeTmpDir('mp-content-');
  const mp = new Mailproof({ trailDir: path.join(dir, 'nested'), worker: { size: 0 } });
  assert.deepEqual(await mp.expireContent(), { removed: 0, attachments: 0 });
  assert.deepEqual(await mp.forget('a'.repeat(32)), { removed: 0, attachments: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'nested')), false);
});

test('sync runs the retention sweep once at the end of a run', async () => {
  const m = await signedMail({ signTime: T0 });
  const { mp, clock } = setup(m, { content: { days: 5 } });
  const r = await mp.record(m.raw, { direction: 'in' });
  clock.t = new Date(T0.getTime() + 6 * DAY);
  let calls = 0;
  const fake = makeFake({ folders: { INBOX: { msgs: [] } } });
  const host = { root: mp.root, trail: mp.trail, record: mp.record, recordDigest: (d, c) => mp._recordDigest(d, c), expireContent: async () => { calls++; return mp.expireContent(); } };
  const res = await runSync(host, { host: 'imap.account.test', user: 'u@account.test', auth: { pass: 'pw' }, sent: false }, { openSession: fake.openSession, sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(res.folders[0].error, null);
  assert.equal(await mp.rawEmail(r.id), null);
});

test('the automatic sweep defaults to weekly and honours a custom sweepDays', async () => {
  const m = await signedMail({ signTime: T0 });
  const run = async (opts) => {
    const { mp, clock, dir } = setup(m, { content: opts });
    await mp.record(m.raw, { direction: 'in' });
    const marker = path.join(dir, '.default.content-sweep.json');
    fs.writeFileSync(marker, JSON.stringify({ last: T0.toISOString() }));
    return { mp, clock };
  };
  const d = await run({ days: 1 });                                        // default sweepDays 7
  d.clock.t = new Date(T0.getTime() + 6 * DAY + 23 * 3_600_000);
  assert.equal(await d.mp._autoSweep(), null, 'under 7 days: skipped');
  d.clock.t = new Date(T0.getTime() + 7 * DAY);
  assert.deepEqual(await d.mp._autoSweep(), { removed: 1, attachments: 0 }, 'at 7 days: runs');
  const c = await run({ days: 1, sweepDays: 3 });
  c.clock.t = new Date(T0.getTime() + 2 * DAY + 23 * 3_600_000);
  assert.equal(await c.mp._autoSweep(), null);
  c.clock.t = new Date(T0.getTime() + 3 * DAY);
  assert.notEqual(await c.mp._autoSweep(), null);
});

test('constructor validates content options', () => {
  const bad = (content, re) => assert.throws(() => new Mailproof({ trailDir: '/x', content }), re);
  bad(null, /content must be an object/);
  bad([], /content must be an object/);
  bad({ store: 'yes' }, /content\.store must be a boolean/);
  bad({ attachments: 1 }, /content\.attachments must be a boolean/);
  bad({ days: 0 }, /positive integer/);
  bad({ days: 1.5 }, /positive integer/);
  bad({ days: '30' }, /positive integer/);
  bad({ days: -3 }, /positive integer/);
  bad({ sweepDays: 0 }, /content\.sweepDays must be a positive integer/);
  bad({ sweepDays: 1.5 }, /content\.sweepDays must be a positive integer/);
  bad({ sweepDays: '7' }, /content\.sweepDays must be a positive integer/);
  bad({ sweepDays: -1 }, /content\.sweepDays must be a positive integer/);
  bad({ keep: true }, /unknown content option "keep"/);
  const ok = new Mailproof({ trailDir: '/x', content: { days: 30 } });
  assert.deepEqual(ok.content, { store: true, attachments: true, days: 30, sweepDays: 7 });
  assert.equal(new Mailproof({ trailDir: '/x', content: { sweepDays: 3 } }).content.sweepDays, 3);
  assert.deepEqual(new Mailproof({ trailDir: '/x' }).content, { store: true, attachments: true, days: 730, sweepDays: 7 });
});

// ---- expiry and forget scan WITHOUT the trail lock; the lock is held for the deletions only ----

/** Two mails sharing PDF (same signer), for the mid-scan tests. */
async function pair() {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'c2.pdf', bytes: PDF } });
  return { a, b };
}
/** Fail fast instead of hanging when the call under test is blocked behind a lock. */
const within = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('blocked: did not finish while the scan was in progress')), ms).unref())]);

test('a record() during the unlocked scan completes at once, and an attachment only it references survives', async () => {
  const { a, b } = await pair();
  const { mp, clock } = setup(a, { content: { days: 10 } });
  const ra = await mp.record(a.raw, { direction: 'in' });
  clock.t = new Date(T0.getTime() + 11 * DAY);
  let rb;
  let ran = 0;
  mp._scanHooks.afterScan = async () => { ran++; rb = await within(mp.record(b.raw, { direction: 'in' })); };   // would deadlock if expiry held the trail lock here
  const res = await mp.expireContent();
  assert.equal(ran, 1);
  assert.deepEqual(res, { removed: 1, attachments: 0 });
  assert.equal(await mp.rawEmail(ra.id), null);
  assert.deepEqual(await mp.rawEmail(rb.id), b.raw);
  assert.deepEqual(await mp.attachment(sha(PDF)), PDF, 'referenced only by the record committed mid-scan');
});

test('a raw backfilled mid-scan keeps its attachment', async () => {
  const { a, b } = await pair();
  const { mp, dir, clock } = setup(a, { content: { days: 10 } });
  const ra = await mp.record(a.raw, { direction: 'in' });
  clock.t = new Date(T0.getTime() + 8 * DAY);
  const off = new Mailproof({ trailDir: dir, resolver: a.resolver, worker: { size: 0 }, now: () => clock.t, content: { store: false } });
  const rb = await off.record(b.raw, { direction: 'in' });   // record exists, no raw stored
  clock.t = new Date(T0.getTime() + 11 * DAY);
  mp._scanHooks.afterScan = async () => { assert.equal((await within(mp.record(b.raw, { direction: 'in' }))).content.stored, true); };
  assert.deepEqual(await mp.expireContent(), { removed: 1, attachments: 0 });
  assert.equal(await mp.rawEmail(ra.id), null);
  assert.deepEqual(await mp.rawEmail(rb.id), b.raw);
  assert.deepEqual(await mp.attachment(sha(PDF)), PDF);
});

test('a trail rewritten during the scan: nothing is deleted this round, the next run deletes', async () => {
  const m = await signedMail({ signTime: T0, attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, root, clock } = setup(m, { content: { days: 10 } });
  const r = await mp.record(m.raw, { direction: 'in' });
  clock.t = new Date(T0.getTime() + 11 * DAY);
  mp._scanHooks.afterScan = async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'], { cwd: root });
  };
  assert.deepEqual(await mp.expireContent(), { removed: 0, attachments: 0 });
  assert.ok(await mp.rawEmail(r.id));
  assert.ok(await mp.attachment(sha(PDF)));
  mp._scanHooks.afterScan = undefined;
  assert.deepEqual(await mp.expireContent(), { removed: 1, attachments: 1 });
});

test('forget scans without the lock too, and a record committed mid-scan keeps the shared attachment', async () => {
  const { a, b } = await pair();
  const { mp } = setup(a);
  const ra = await mp.record(a.raw, { direction: 'in' });
  let rb;
  mp._scanHooks.afterScan = async () => { rb = await within(mp.record(b.raw, { direction: 'in' })); };
  assert.deepEqual(await mp.forget(ra.id), { removed: 1, attachments: 0 });
  assert.deepEqual(await mp.attachment(sha(PDF)), PDF);
  mp._scanHooks.afterScan = undefined;
  assert.deepEqual(await mp.forget(rb.id), { removed: 1, attachments: 1 });
});

test('the automatic sweep (sync) runs at most once per sweepDays, by the injected clock; explicit expireContent always runs', async () => {
  const m = await signedMail({ signTime: T0 });
  const m2 = await signedMail({ signTime: T0, body: 'later\r\n', domain: m.domain, signers: [{ domain: m.domain, selector: 'sel1', key: m.signers[0].key }] });
  const { mp, clock, dir } = setup(m, { content: { days: 1, sweepDays: 1 } });
  assert.equal(await mp._autoSweep(), null, 'no content directory: skipped, nothing created');
  assert.equal(fs.readdirSync(dir).length, 0);
  const r = await mp.record(m.raw, { direction: 'in' });
  const marker = path.join(dir, '.default.content-sweep.json');

  clock.t = new Date(T0.getTime() + 3 * DAY);                       // first ever: runs
  assert.deepEqual(await mp._autoSweep(), { removed: 1, attachments: 0 });
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).last, clock.t.toISOString());
  const r2 = await mp.record(m2.raw, { direction: 'in' });          // captured at day 3
  clock.t = new Date(T0.getTime() + 3 * DAY + 3_600_000);            // +1 h: skipped
  assert.equal(await mp._autoSweep(), null);
  clock.t = new Date(T0.getTime() + 4 * DAY + 3_600_000);            // +25 h: runs (r2 is 25 h old, past 1 day)
  assert.deepEqual(await mp._autoSweep(), { removed: 1, attachments: 0 });
  assert.equal(await mp.rawEmail(r2.id), null);
  assert.ok(r);

  fs.writeFileSync(marker, JSON.stringify({ last: new Date(clock.t.getTime() + DAY).toISOString() }));   // dated in the future: runs
  assert.notEqual(await mp._autoSweep(), null);
  fs.writeFileSync(marker, 'garbage');                              // unreadable: runs
  assert.notEqual(await mp._autoSweep(), null);
  fs.writeFileSync(marker, JSON.stringify({ last: clock.t.toISOString() }));
  assert.equal(await mp._autoSweep(), null);
  await mp.expireContent();                                          // explicit: always runs, and refreshes the marker
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes('.tmp-')));
});

test('forget by counterparty: an Reply-To is matched; a record of an old trail (no addresses field) still finds an unsigned Cc in the stored raw', async () => {
  const dom = 'signer.example';
  const key = (await signedMail({ signTime: T0 })).signers[0];
  const mk = (over) => signedMail({ signTime: T0, domain: dom, signers: [{ domain: dom, selector: 'sel1', key: key.key }], ...over });
  const m1 = await mk({ body: '1\r\n', extraHeaders: ['Reply-To: rt@rt.example'], headerList: ['from', 'to', 'subject', 'date', 'message-id'] });
  const m2 = await mk({ body: '2\r\n', to: 'x@x.example', extraHeaders: ['Cc: old@old.example'], headerList: ['from', 'to', 'subject', 'date', 'message-id'] });
  const { mp, root } = setup(m1);
  const r1 = (await mp.record(m1.raw, { direction: 'in' })).record;
  const r2 = (await mp.record(m2.raw, { direction: 'in' })).record;
  // make r2 an old record: drop the field from the working-tree file (the index is not involved in forget)
  const f = path.join(root, recordPath(r2.id));
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Array.isArray(rec.addresses));
  delete rec.addresses;
  fs.writeFileSync(f, JSON.stringify(rec));
  assert.deepEqual(await mp.forget({ with: 'old@old.example' }), { removed: 1, attachments: 0 });
  assert.equal(await mp.rawEmail(r2.id), null);
  assert.notEqual(await mp.rawEmail(r1.id), null);
  assert.deepEqual(await mp.forget({ with: 'rt@rt.example' }), { removed: 1, attachments: 0 });
});

test('expireContent removes a stray attachment temp file a crashed write left, and touches no real attachment', async () => {
  const m = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const { mp, cdir } = setup(m, { content: { days: 365000 } });
  await mp.record(m.raw, { direction: 'in' });
  const real = attFile(cdir, sha(PDF));
  assert.ok(fs.existsSync(real), 'the real attachment is stored');
  const stray = `${real}.tmp-4242-deadbeef`;
  fs.writeFileSync(stray, 'partial bytes');
  const strayRaw = path.join(cdir, 'raw', 'ab', `${'ab'.repeat(16)}.eml.tmp-4242-deadbeef`);
  fs.mkdirSync(path.dirname(strayRaw), { recursive: true });
  fs.writeFileSync(strayRaw, 'partial raw');
  await mp.expireContent();
  assert.ok(!fs.existsSync(stray), 'the att temp file is gone');
  assert.ok(!fs.existsSync(strayRaw), 'the raw temp file is gone (already so)');
  assert.deepEqual(fs.readFileSync(real), PDF, 'the real attachment is untouched');
});

test('forget({ dryRun }): the preview names ids, counts what would go, and deletes nothing (SPEC B12.5)', async () => {
  const a = await signedMail({ signTime: T0, body: 'one\r\n', attachment: { filename: 'c.pdf', bytes: PDF } });
  const b = await signedMail({ signTime: T0, body: 'two\r\n', domain: a.domain, signers: [{ domain: a.domain, selector: 'sel1', key: a.signers[0].key }], attachment: { filename: 'c2.pdf', bytes: PDF } });
  const { mp, cdir } = setup(a);
  const [ra, rb] = [await mp.record(a.raw, { direction: 'in' }), await mp.record(b.raw, { direction: 'in' })];
  const before = files(cdir).sort();
  const row = (/** @type {string} */ id) => ({ id, captured: '2026-11-01T10:00:00.000Z', direction: 'in', from: 'me@signer.example', subject: 'Re: please sign' });
  assert.deepEqual(await mp.forget(ra.id, { dryRun: true }), { removed: 1, attachments: 0, dryRun: true, ids: [ra.id], selection: [row(ra.id)], selectionMore: 0 }, 'b still references the attachment');
  const two = await mp.forget([ra.id, rb.id, '1'.repeat(32)], { dryRun: true });
  assert.deepEqual({ ...two, selection: undefined }, { removed: 2, attachments: 1, dryRun: true, ids: [ra.id, rb.id, '1'.repeat(32)], selection: undefined, selectionMore: 0 });
  assert.deepEqual(two.selection.map((r) => r.id), [ra.id, rb.id], 'rows only for ids that exist');
  for (const r of two.selection) assert.deepEqual(r, row(r.id));
  assert.deepEqual(files(cdir).sort(), before, 'nothing deleted');
  assert.deepEqual(await mp.forget([ra.id, rb.id]), { removed: 2, attachments: 1 }, 'the same call for real removes exactly what the preview said');
  await assert.rejects(mp.forget(ra.id, { dryRun: 'yes' }), TypeError);
  await assert.rejects(mp.forget(ra.id, { nope: 1 }), TypeError);
});

test('forget({ dryRun }) by counterparty, and with no content directory', async () => {
  const m = await signedMail({ signTime: T0, to: 'bob@gmail.com' });
  const { mp } = setup(m);
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.deepEqual(await mp.forget({ with: 'bob@gmail.com' }, { dryRun: true }), { removed: 1, attachments: 0, dryRun: true, ids: [r.id], selection: [{ id: r.id, captured: '2026-11-01T10:00:00.000Z', direction: 'in', from: 'me@signer.example', subject: 'Re: please sign' }], selectionMore: 0 });
  assert.ok(await mp.rawEmail(r.id));
  const dir = makeTmpDir('mp-content-');
  const none = new Mailproof({ trailDir: path.join(dir, 'nested'), worker: { size: 0 } });
  assert.deepEqual(await none.forget('a'.repeat(32), { dryRun: true }), { removed: 0, attachments: 0, dryRun: true, ids: ['a'.repeat(32)], selection: [], selectionMore: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'nested')), false);
});
