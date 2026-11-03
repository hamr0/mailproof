// sync.js against an in-memory fake session (SPEC B4.8, layer 1). Real Mailproof, real git trail, worker.size 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { runSync, effectiveCaps } from '../../src/proof/sync.js';
import { MAX_TOTAL_BYTES, SYNC_MAX_MESSAGES, SYNC_MAX_BYTES } from '../../src/proof/limits.js';
import { signedMail } from '../helpers/proof.js';
import { makeFake, drop } from '../helpers/fake-imap-session.js';
import { makeTmpDir } from '../helpers/tmp.js';

const SECRET = 'Sup3r-Secret-App-Pass-7f3a';
const base = { host: 'imap.account.test', user: 'acct.owner@account.test', auth: { pass: SECRET }, sent: false };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const commits = (root) => !fs.existsSync(path.join(root, '.git')) ? [] : git(root, 'log', '--format=%s').split('\n').filter((s) => s.startsWith('record '));
const noSleep = (log) => async (ms) => { log?.push(ms); };

async function mails(n, prefix = 'm') {
  const map = {};
  const list = [];
  for (let i = 0; i < n; i++) {
    const m = await signedMail({ body: `${prefix} ${i}\r\n`, domain: `d${prefix}${i}.example` });
    Object.assign(map, m.map);
    list.push(m.raw);
  }
  const resolver = async (name, type) => {
    if ((type || 'TXT').toUpperCase() !== 'TXT') throw Object.assign(new Error('only TXT'), { code: 'ENODATA' });
    if (map[name] === undefined) throw Object.assign(new Error('no record ' + name), { code: 'ENOTFOUND' });
    return [[map[name]]];
  };
  return { list, resolver };
}

/** A trail + instance + helpers. `uids` lets a test leave holes. */
async function setup({ n = 5, uids, lockTimeoutMs, extra = {} } = {}) {
  const { list, resolver } = await mails(n);
  const trailDir = makeTmpDir('mp-sync-');
  const mp = new Mailproof({ trailDir, trail: 't', resolver, worker: { size: 0 }, ...(lockTimeoutMs ? { lockTimeoutMs } : {}), ...extra });
  const msgs = list.map((raw, i) => ({ uid: uids ? uids[i] : i + 1, raw }));
  const host = (m = mp) => ({ root: m.root, trail: m.trail, record: m.record, recordDigest: (d, c) => m._recordDigest(d, c) });
  const cursorFile = path.join(trailDir, '.t.sync.json');
  const cursor = () => JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  return { mp, trailDir, msgs, list, host, cursorFile, cursor, root: mp.root };
}
const run = (s, fake, opts = {}, deps = {}, m = s.mp) => runSync(s.host(m), { ...base, ...opts }, { openSession: fake.openSession, sleep: noSleep(), ...deps });

test('1. fresh run records everything and moves the cursor; the re-run fetches nothing', async () => {
  const s = await setup();
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } } });
  const r1 = await run(s, fake);
  assert.equal(r1.complete, true);
  const f = r1.folders[0];
  assert.deepEqual([f.seen, f.recorded, f.duplicate, f.over_limit, f.complete, f.last_uid, f.error, f.reset], [5, 5, 0, 0, true, 5, null, null]);
  assert.equal(f.uidvalidity, '1');
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid, 5);
  assert.equal(commits(s.root).length, 5);
  const fetched = fake.log.fetches.length;
  const r2 = await run(s, fake);
  assert.equal(fake.log.fetches.length, fetched, 'no message fetched on the re-run');
  assert.deepEqual([r2.folders[0].seen, r2.folders[0].recorded, r2.folders[0].duplicate, r2.complete], [0, 0, 0, true]);
  assert.equal(commits(s.root).length, 5);
});

test('2. the N:* quirk: a server that ignores the range is filtered; the repeated messages are neither fetched nor counted; no list call has *', async () => {
  const s = await setup({ n: 5 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs.slice(0, 4) } }, ignoreRange: true });
  await run(s, fake);
  const fetched = fake.log.fetches.length;
  assert.equal(fetched, 4);
  fake.folders.INBOX.msgs.push(s.msgs[4]); // one new message; the fake answers every list with ALL messages
  const r2 = await run(s, fake);
  assert.equal(fake.log.fetches.length - fetched, 1, 'only the new message is fetched');
  assert.deepEqual([r2.folders[0].seen, r2.folders[0].duplicate, r2.folders[0].recorded], [1, 0, 1]);
  assert.ok(fake.log.lists.length >= 2);
  for (const [, lo, hi] of fake.log.lists) { assert.ok(Number.isInteger(lo) && Number.isInteger(hi), 'explicit numeric range, never *'); assert.ok(lo <= hi); }
});

test('3. crash window: a cursor write that fails after the commit re-fetches that message as a duplicate; nothing lost or doubled', async () => {
  const s = await setup({ n: 3 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } } });
  let writes = 0;
  // writes: 1 = first cursor (uidvalidity, last 0); 2 = after message 1; 3 = after message 2 -> die here (record 2 is committed)
  const failing = async (file, text) => { if (++writes === 3) throw new Error('disk gone'); await fs.promises.writeFile(file, text); };
  const r1 = await run(s, fake, {}, { writeCursorFile: failing });
  assert.equal(r1.folders[0].error.code, 'ERR_SYNC_CURSOR');
  assert.equal(commits(s.root).length, 2, 'record 2 is committed before its cursor write');
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid, 1, 'the cursor is one message behind, never ahead');
  const r2 = await run(s, fake);
  const f = r2.folders[0];
  assert.deepEqual([f.duplicate, f.recorded, f.complete], [1, 1, true]);
  assert.equal(commits(s.root).length, 3, 'exactly one commit per distinct message');
});

test('4. a record() failure stops the run: cursor below it, later folders not attempted, next run records the rest', async () => {
  const s = await setup({ n: 5, lockTimeoutMs: 150 });
  const other = await mails(1, 'o');
  const lockFile = path.join(s.trailDir, '.t.lock');
  const hold = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() });
  let held = false;
  // hold the trail lock from outside, once, while the 3rd message is being fetched
  const fake = makeFake({
    folders: { INBOX: { msgs: s.msgs }, Archive: { msgs: [{ uid: 1, raw: other.list[0] }] } },
    onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 3 && !held) { held = true; fs.writeFileSync(lockFile, hold); } },
  });
  const r1 = await run(s, fake, { folders: ['INBOX', 'Archive'] });
  assert.equal(r1.complete, false);
  assert.equal(r1.folders[0].error.code, 'ERR_TRAIL_LOCKED');
  assert.equal(r1.folders[0].last_uid, 2);
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid, 2);
  assert.equal(r1.folders[1].attempted, false);
  assert.equal(commits(s.root).length, 2, 'messages 3-5 are not recorded');
  fs.rmSync(lockFile);
  const r2 = await run(s, fake, { folders: ['INBOX', 'Archive'] });
  assert.equal(r2.complete, true);
  assert.deepEqual([r2.folders[0].recorded, r2.folders[0].duplicate], [3, 0]);
  assert.equal(commits(s.root).length, 6);
});

test('5. UIDVALIDITY: a change resets and rescans (all duplicates); values that differ only above 2^53 differ', async () => {
  const s = await setup({ n: 3 });
  const fake = makeFake({ folders: { INBOX: { uidvalidity: '9007199254740993', msgs: s.msgs } } });
  await run(s, fake);
  fake.uidvalidity.INBOX = '9007199254740992';
  const fetchedBefore = fake.log.fetches.length;
  const r = await run(s, fake);
  const f = r.folders[0];
  assert.equal(f.reset, 'uidvalidity', 'compared as strings, not Numbers (both are 9007199254740992 as a Number)');
  assert.equal(fake.log.fetches.length - fetchedBefore, 3, 'every message is fetched again');
  assert.deepEqual([f.recorded, f.duplicate], [0, 3]);
  assert.equal(f.uidvalidity, '9007199254740992');
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.uidvalidity, '9007199254740992');
  assert.equal(commits(s.root).length, 3);
});

test('5b. UIDVALIDITY changing on a reconnect inside the run is ERR_IMAP_UIDVALIDITY and records nothing more', async () => {
  const s = await setup({ n: 4 });
  const fake = makeFake({
    folders: { INBOX: { msgs: s.msgs } },
    onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 3) { fake.uidvalidity.INBOX = '2'; throw drop(); } },
  });
  const r = await run(s, fake);
  assert.equal(r.folders[0].error.code, 'ERR_IMAP_UIDVALIDITY');
  assert.equal(commits(s.root).length, 2);
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid, 2);
});

test('6. oversize, honest size: streamed and hashed (never buffered), recorded over limit with the id the pipe path gives', async () => {
  const s = await setup({ n: 0 });
  const big = Buffer.alloc(MAX_TOTAL_BYTES + 1024 * 1024, 0x61); // ~26 MiB
  const fake = makeFake({ folders: { INBOX: { msgs: [{ uid: 1, raw: big }] } } });
  const r = await run(s, fake);
  const f = r.folders[0];
  assert.deepEqual([f.recorded, f.over_limit, f.complete], [1, 1, true]);
  assert.equal(fake.stats.fetchBytes, 0, 'never fetched into a buffer');
  assert.equal(fake.stats.hashBytes, big.length);
  assert.equal(f.bytes, big.length);
  const id = crypto.createHash('sha256').update(big).digest('hex').slice(0, 32);
  const rec = await s.mp.get(id);
  assert.equal(rec.verdicts.live.reason, 'over limit: total_bytes');
  assert.equal(rec.message.size, big.length);
  assert.equal(rec.source, 'imap:INBOX');
  assert.equal((await s.mp.record(big, { direction: 'in', source: 'pipe' })).duplicate, true, 'the pipe path finds the same id');
});

test('7. oversize, lying size: at most MAX_TOTAL_BYTES + 1 is read, then it is hashed; above SYNC_MAX_MESSAGE_BYTES it is skipped', async () => {
  const s = await setup({ n: 0 });
  const big = Buffer.alloc(MAX_TOTAL_BYTES + 1024 * 1024, 0x62);
  const fake = makeFake({ folders: { INBOX: { msgs: [{ uid: 1, raw: big, size: 1024 }] } } });
  const r = await run(s, fake);
  assert.equal(fake.log.fetches.length, 1);
  assert.equal(fake.log.fetches[0][2], MAX_TOTAL_BYTES + 1, 'asked for no more than the gate limit plus one byte');
  assert.equal(fake.stats.fetchBytes, MAX_TOTAL_BYTES + 1);
  assert.equal(fake.stats.hashBytes, big.length);
  const id = crypto.createHash('sha256').update(big).digest('hex').slice(0, 32);
  assert.equal(r.folders[0].over_limit, 1);
  assert.equal((await s.mp.get(id)).verdicts.live.reason, 'over limit: total_bytes');
  assert.equal((await s.mp.get(id)).message.size, big.length, 'the true length, not the truncated one');

  // above SYNC_MAX_MESSAGE_BYTES (lowered): skipped and not recorded, the cursor moves; also when the listed size lies
  const s2 = await setup({ n: 0 });
  const fake2 = makeFake({ folders: { INBOX: { msgs: [{ uid: 1, raw: big }, { uid: 2, raw: big, size: 10 }] } } });
  const r2 = await run(s2, fake2, {}, { limits: { SYNC_MAX_MESSAGE_BYTES: MAX_TOTAL_BYTES + 10 } });
  const f = r2.folders[0];
  assert.equal(f.recorded, 0);
  assert.deepEqual(f.skipped.map((x) => x.uid), [1, 2]);
  assert.equal(f.last_uid, 2);
  assert.equal(f.complete, true);
  assert.equal(commits(s2.root).length, 0);
});

test('8. caps: a capped folder is incomplete, the cursor is where it stopped, the next run continues with no duplicates', async () => {
  const s = await setup({ n: 5 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } } });
  const r1 = await run(s, fake, { maxMessages: 2 });
  assert.deepEqual([r1.folders[0].recorded, r1.folders[0].complete, r1.folders[0].last_uid, r1.complete], [2, false, 2, false]);
  const r2 = await run(s, fake, { maxMessages: 2 });
  assert.deepEqual([r2.folders[0].recorded, r2.folders[0].duplicate, r2.folders[0].last_uid], [2, 0, 4]);
  const r3 = await run(s, fake, { maxMessages: 2 });
  assert.deepEqual([r3.folders[0].recorded, r3.folders[0].complete, r3.complete], [1, true, true]);
  assert.equal(commits(s.root).length, 5);

  // bytes cap
  const s2 = await setup({ n: 4 });
  const fake2 = makeFake({ folders: { INBOX: { msgs: s2.msgs } } });
  const one = s2.msgs[0].raw.length;
  const rb = await run(s2, fake2, { maxBytes: one + 1 });
  assert.equal(rb.folders[0].complete, false);
  assert.ok(rb.folders[0].recorded >= 1 && rb.folders[0].recorded < 4);

  // time cap: a clock that jumps past SYNC_MAX_MS
  const s3 = await setup({ n: 3 });
  const fake3 = makeFake({ folders: { INBOX: { msgs: s3.msgs }, Other: { msgs: [] } } });
  let t = 0;
  const rt = await run(s3, fake3, { folders: ['INBOX', 'Other'] }, { limits: { SYNC_MAX_MS: 1000 }, clock: () => (t += 400) });
  assert.equal(rt.complete, false);
  assert.equal(rt.folders[0].complete, false);
  assert.equal(rt.folders[1].attempted, false, 'a run past its time cap does not start the next folder');

  // clamp: an option can only lower the constant
  assert.deepEqual(effectiveCaps({ maxMessages: 10 ** 9, maxBytes: 10 ** 15 }), { maxMessages: SYNC_MAX_MESSAGES, maxBytes: SYNC_MAX_BYTES });
  assert.deepEqual(effectiveCaps({ maxMessages: 3, maxBytes: 5 }), { maxMessages: 3, maxBytes: 5 });
  assert.deepEqual(effectiveCaps({}), { maxMessages: SYNC_MAX_MESSAGES, maxBytes: SYNC_MAX_BYTES });
  // and the clamp is what runSync uses: a huge option cannot lift the (lowered) limit
  const s4 = await setup({ n: 4 });
  const fake4 = makeFake({ folders: { INBOX: { msgs: s4.msgs } } });
  const rc = await run(s4, fake4, { maxMessages: 10 ** 9 }, { limits: { SYNC_MAX_MESSAGES: 2 } });
  assert.deepEqual([rc.folders[0].recorded, rc.folders[0].complete], [2, false]);
});

test('8b. windows: more messages than SYNC_UID_WINDOW are listed window by window, with holes in the UIDs', async () => {
  const s = await setup({ n: 5, uids: [2, 3, 7, 8, 12] });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs, uidNext: 20 } } });
  const r = await run(s, fake, {}, { limits: { SYNC_UID_WINDOW: 5 } });
  assert.deepEqual(fake.log.lists.map(([, lo, hi]) => [lo, hi]), [[1, 5], [6, 10], [11, 15], [16, 19]]);
  assert.deepEqual([r.folders[0].recorded, r.folders[0].last_uid, r.folders[0].complete], [5, 19, true]);
  const again = await run(s, fake, {}, { limits: { SYNC_UID_WINDOW: 5 } });
  assert.equal(again.folders[0].seen, 0);
});

test('9. direction, source, Sent, NO_SENT; the account is in no record', async () => {
  const s = await setup({ n: 2 });
  // a provider's Sent copy is unsigned (F3, F17)
  const sentMsgs = [{ uid: 1, raw: Buffer.from('From: me@example.test\r\nTo: you@example.test\r\nSubject: sent\r\nMessage-ID: <sent1@example.test>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nsent body\r\n') }];
  const mp = s.mp;
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs }, '[Gmail]/Sent Mail': { msgs: sentMsgs } }, sent: '[Gmail]/Sent Mail' });
  // the Sent folder is also listed in `folders`: out, and synced once
  const r = await run(s, fake, { sent: true, folders: ['INBOX', '[Gmail]/Sent Mail'] }, {}, mp);
  assert.deepEqual(r.folders.map((f) => [f.folder, f.direction]), [['INBOX', 'in'], ['[Gmail]/Sent Mail', 'out']]);
  const inbox = await mp.list({ direction: 'in' });
  const out = await mp.list({ direction: 'out' });
  assert.equal(inbox.length, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].live, 'unverified');
  const rec = await mp.get(inbox[0].id);
  assert.equal(rec.source, 'imap:INBOX');
  const srec = await mp.get(out[0].id);
  assert.equal(srec.source, 'imap:[Gmail]/Sent Mail');
  assert.deepEqual([srec.signatures.length, srec.verdicts.live.trust, srec.verdicts.portable.trust], [0, 'unverified', 'unverified']);
  for (const id of [...inbox, ...out].map((x) => x.id)) {
    const text = fs.readFileSync(path.join(mp.root, 'records', `${id}.json`), 'utf8');
    assert.ok(!text.includes('imap.account.test') && !text.includes('acct.owner'), 'no account in the record');
  }
  // no \Sent folder: ERR_IMAP_NO_SENT on its own entry while INBOX still succeeds
  const s2 = await setup({ n: 2 });
  const fake2 = makeFake({ folders: { INBOX: { msgs: s2.msgs } }, sent: null });
  const r2 = await run(s2, fake2, { sent: true });
  assert.equal(r2.folders[0].complete, true);
  assert.deepEqual([r2.folders[1].folder, r2.folders[1].error.code], ['\\Sent', 'ERR_IMAP_NO_SENT']);
  assert.equal(r2.complete, false);
  // a missing folder is that folder's error and the run goes on
  const r3 = await run(s2, fake2, { folders: ['Nope', 'INBOX'] });
  assert.equal(r3.folders[0].error.code, 'ERR_IMAP_NO_FOLDER');
  assert.equal(r3.folders[1].attempted, true);
  assert.equal(r3.folders[1].complete, true);
});

test('10. concurrency: a second sync gets ERR_SYNC_LOCKED at once; a separate instance records while sync runs; a stale lock is taken over', async () => {
  const s = await setup({ n: 4 });
  const extra = await signedMail({ body: 'pipe mail\r\n', domain: 'pipe.example' });
  const resolver = async (n, t) => { try { return await s.mp.resolver(n, t); } catch { return extra.resolver(n, t); } };
  const other = new Mailproof({ trailDir: s.trailDir, trail: 't', resolver, worker: { size: 0 } });
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const inFetch = new Promise((r) => { reached = r; });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } }, onCall: async ({ op, uid }) => { if (op === 'fetch' && uid === 2) { reached(); await gate; } } });
  const first = run(s, fake);
  await inFetch;
  await assert.rejects(() => run(s, makeFake({ folders: { INBOX: { msgs: [] } } })), { code: 'ERR_SYNC_LOCKED' });
  assert.equal(s.cursor().accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid, 1, 'the refused call left the cursor alone');
  const piped = await other.record(extra.raw, { direction: 'in', source: 'pipe' });
  assert.equal(piped.duplicate, false);
  release();
  const r = await first;
  assert.equal(r.complete, true);
  assert.equal(commits(s.root).length, 5, 'all records present, none lost');
  assert.equal(fs.existsSync(path.join(s.trailDir, '.t.sync.lock')), false);
  // stale lock from a dead pid on this host
  const dead = (await import('node:child_process')).spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise((rr) => dead.on('close', rr));
  fs.writeFileSync(path.join(s.trailDir, '.t.sync.lock'), JSON.stringify({ pid, host: os.hostname(), started: new Date().toISOString() }));
  const r2 = await run(s, fake);
  assert.equal(r2.complete, true);
});

test('11. cursor file: parses after every message, no .tmp left, corrupt file means a full rescan, outside the git repo', async () => {
  const s = await setup({ n: 3 });
  const seen = [];
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } } });
  const spy = async (file, text) => {
    JSON.parse(text);
    assert.ok(text.endsWith('\n'));
    await fs.promises.writeFile(`${file}.tmp`, text);
    await fs.promises.rename(`${file}.tmp`, file);
    seen.push(JSON.parse(fs.readFileSync(file, 'utf8')).accounts['imap.account.test/acct.owner@account.test'].INBOX.last_uid);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  };
  await run(s, fake, {}, { writeCursorFile: spy });
  assert.deepEqual(seen.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(git(s.root, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(s.trailDir, '.t.sync.json.tmp')), false);
  // the real writer: 2-space indent, trailing newline, fixed shape
  const text = fs.readFileSync(s.cursorFile, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(Object.keys(JSON.parse(text)), ['v', 'head', 'accounts']);
  assert.equal(JSON.parse(text).head, git(s.root, 'rev-parse', 'HEAD'), 'the cursor carries the trail HEAD it was written at');
  fs.writeFileSync(s.cursorFile, '{ not json');
  const fetched = fake.log.fetches.length;
  const r = await run(s, fake);
  assert.equal(r.folders[0].reset, 'unreadable');
  assert.equal(fake.log.fetches.length - fetched, 3, 'everything is fetched again');
  assert.deepEqual([r.folders[0].duplicate, r.folders[0].recorded], [3, 0]);
  fs.writeFileSync(s.cursorFile, JSON.stringify({ v: 9, accounts: {} }));
  assert.equal((await run(s, fake)).folders[0].reset, 'unreadable', 'a wrong version counts as unreadable');
  assert.equal(commits(s.root).length, 3);
  assert.equal(git(s.root, 'status', '--porcelain'), '');
});

test('11b. a trail restored to an older commit under a newer cursor is detected and rescanned; nothing is missed', async () => {
  const s = await setup({ n: 5 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs.slice(0, 2) } } });
  await run(s, fake);
  const old = git(s.root, 'rev-parse', 'HEAD'); // the "backup": 2 records
  fake.folders.INBOX.msgs.push(...s.msgs.slice(2));
  await run(s, fake);
  assert.equal(commits(s.root).length, 5);
  git(s.root, 'reset', '--hard', '-q', old); // restore the older trail; the newer sidecar (last_uid 5) stays
  assert.equal(commits(s.root).length, 2);
  const r = await run(s, fake);
  const f = r.folders[0];
  assert.equal(f.reset, 'trail');
  assert.deepEqual([f.recorded, f.duplicate, f.complete, f.last_uid], [3, 2, true, 5]);
  assert.equal(commits(s.root).length, 5, 'the missing mail is back');
  assert.equal((await run(s, fake)).folders[0].reset, null, 'the next run is normal again');
});

test('11c. an emptied or re-initialised trail under a surviving cursor is rescanned', async () => {
  const s = await setup({ n: 3 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } } });
  await run(s, fake);
  fs.rmSync(s.root, { recursive: true, force: true }); // trail directory replaced by nothing
  const r = await run(s, fake);
  assert.equal(r.folders[0].reset, 'trail');
  assert.deepEqual([r.folders[0].recorded, r.folders[0].duplicate, r.complete], [3, 0, true]);
  assert.equal(commits(s.root).length, 3);
});

test('11d. a normal second run (trail grown since, e.g. by the pipe) is not a reset; a cursor written on an empty trail is not stale', async () => {
  const s = await setup({ n: 3 });
  const empty = makeFake({ folders: { INBOX: { msgs: [] } } });
  const e1 = await run(s, empty); // cursor written while the trail has no commits (head: null)
  assert.equal(s.cursor().head, null);
  assert.equal((await run(s, empty)).folders[0].reset, null);
  assert.equal(e1.complete, true);
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs.slice(0, 2) } } });
  assert.equal((await run(s, fake)).folders[0].reset, null);
  await s.mp.record((await mails(1, 'pipe')).list[0], { direction: 'in', source: 'pipe' }); // trail HEAD moves on
  fake.folders.INBOX.msgs.push(s.msgs[2]);
  const r = await run(s, fake);
  assert.equal(r.folders[0].reset, null);
  assert.deepEqual([r.folders[0].recorded, r.folders[0].seen], [1, 1]);
});

test('11e. sent: false tolerates a failing \\Sent lookup: the listed folders still sync, as `in`', async () => {
  const s = await setup({ n: 2 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } }, findSentError: Object.assign(new Error('LIST failed'), { code: 'ERR_IMAP_THROTTLED' }) });
  const r = await run(s, fake, { sent: false });
  assert.equal(r.complete, true);
  assert.deepEqual([r.folders[0].folder, r.folders[0].direction, r.folders[0].recorded], ['INBOX', 'in', 2]);
});

test('11f. sent requested + a throttled \\Sent lookup: the classified code is on the \\Sent entry, INBOX still syncs; a connect failure still throws', async () => {
  const s = await setup({ n: 2 });
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } }, findSentError: Object.assign(new Error('[THROTTLED] slow down'), { code: 'ERR_IMAP_THROTTLED' }) });
  const r = await run(s, fake, { sent: true });
  assert.equal(r.complete, false);
  assert.deepEqual([r.folders[0].folder, r.folders[0].complete, r.folders[0].recorded], ['INBOX', true, 2]);
  assert.deepEqual([r.folders[1].folder, r.folders[1].direction, r.folders[1].error.code], ['\\Sent', 'out', 'ERR_IMAP_THROTTLED']);
  const bad = makeFake({ folders: { INBOX: { msgs: s.msgs } }, findSentError: Object.assign(new Error('gone'), { code: 'ERR_IMAP_CONNECT' }) });
  await assert.rejects(run(s, bad, { sent: true }), { code: 'ERR_IMAP_CONNECT' });
});

test('12. the secret appears in no result, error, record, trail file or cursor file', async () => {
  const s = await setup({ n: 2 });
  const fake = makeFake({
    folders: { INBOX: { msgs: s.msgs } },
    onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 2) throw Object.assign(new Error(`login failed for ${SECRET}`), { code: 'ERR_IMAP_PROTOCOL' }); },
  });
  const r = await run(s, fake);
  assert.equal(r.folders[0].error.code, 'ERR_IMAP_PROTOCOL');
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.match(r.folders[0].error.message, /\[redacted\]/);
  // a thrown error
  const bad = { async openSession() { throw Object.assign(new Error(`AUTHENTICATIONFAILED ${SECRET}`), { code: 'ERR_IMAP_AUTH' }); } };
  await assert.rejects(() => runSync(s.host(), { ...base }, { openSession: bad.openSession }), (e) => {
    assert.equal(e.code, 'ERR_IMAP_AUTH');
    assert.ok(!String(e.message).includes(SECRET) && !String(e.stack).includes(SECRET));
    return true;
  });
  const grep = (dir) => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, ent.name); if (ent.isDirectory()) grep(p); else assert.ok(!fs.readFileSync(p).includes(SECRET), p); } };
  grep(s.trailDir);
});

test('13. reconnect: a drop mid-message records nothing from partial bytes and the final state equals an uninterrupted run; too many drops fail the folder', async () => {
  const s = await setup({ n: 4 });
  const delays = [];
  let thrown = 0;
  const fake = makeFake({ folders: { INBOX: { msgs: s.msgs } }, onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 3 && thrown < 1) { thrown++; throw drop(); } } });
  const r = await run(s, fake, {}, { sleep: noSleep(delays) });
  assert.equal(fake.log.opens, 2);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual([r.folders[0].recorded, r.folders[0].duplicate, r.folders[0].complete], [4, 0, true]);
  assert.equal(commits(s.root).length, 4);
  assert.equal(fake.log.fetches.filter(([, u]) => u === 3).length, 2, 'the same UID is asked for again');

  const s2 = await setup({ n: 4 });
  const delays2 = [];
  const fake2 = makeFake({ folders: { INBOX: { msgs: s2.msgs } }, onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 3) throw drop(); } });
  const r2 = await run(s2, fake2, {}, { sleep: noSleep(delays2) });
  assert.equal(r2.folders[0].error.code, 'ERR_IMAP_PROTOCOL');
  assert.equal(r2.folders[0].last_uid, 2);
  assert.deepEqual(delays2, [1000, 4000, 16000]);
  assert.equal(fake2.log.opens, 4, '1 + SYNC_MAX_RECONNECTS');
  assert.equal(commits(s2.root).length, 2, 'cursor at the last committed UID');
});

test('13b. a reconnect that is refused for auth is ERR_IMAP_AUTH; a hung read is cut off by SYNC_FETCH_MS and counts as a drop', async () => {
  const s = await setup({ n: 2 });
  let opens = 0;
  const flaky = makeFake({ folders: { INBOX: { msgs: s.msgs } }, onCall: ({ op, uid }) => { if (op === 'fetch' && uid === 2) throw drop(); } });
  const openSession = async (a) => { if (++opens === 2) throw Object.assign(new Error('token expired'), { code: 'ERR_IMAP_AUTH' }); return flaky.openSession(a); };
  await assert.rejects(() => runSync(s.host(), { ...base }, { openSession, sleep: noSleep() }), { code: 'ERR_IMAP_AUTH' });

  const s2 = await setup({ n: 2 });
  let hung = 0;
  const slow = makeFake({ folders: { INBOX: { msgs: s2.msgs } }, onCall: async ({ op, uid }) => { if (op === 'fetch' && uid === 2 && hung++ === 0) await new Promise(() => {}); } });
  const r = await run(s2, slow, {}, { limits: { SYNC_FETCH_MS: 50 } });
  assert.equal(r.folders[0].complete, true);
  assert.equal(slow.log.opens, 2);
  assert.ok(slow.log.closes >= 1, 'the stuck connection was closed');
});

test('options are validated before any connection', async () => {
  const s = await setup({ n: 0 });
  const fake = makeFake({ folders: { INBOX: { msgs: [] } } });
  const bad = [
    {}, { host: 'h' }, { ...base, port: 0 }, { ...base, auth: {} }, { ...base, auth: { pass: 'a', accessToken: 'b' } },
    { ...base, folders: 'INBOX' }, { ...base, maxMessages: 0 }, { ...base, tls: { rejectUnauthorized: false } }, { ...base, extra: 1 },
  ];
  for (const o of bad) await assert.rejects(() => runSync(s.host(), o, { openSession: fake.openSession }), TypeError, JSON.stringify(o));
  assert.equal(fake.log.opens, 0);
  // the public method is bound and validates too
  const { sync } = s.mp;
  await assert.rejects(() => sync({}), TypeError);
});

test('a connection that fails on the first open is ERR_IMAP_CONNECT; nothing is written', async () => {
  const s = await setup({ n: 0 });
  await assert.rejects(() => runSync(s.host(), { ...base }, { openSession: async () => { throw Object.assign(new Error('refused'), { code: 'ERR_IMAP_CONNECT' }); } }), { code: 'ERR_IMAP_CONNECT' });
  assert.equal(fs.existsSync(s.cursorFile), false);
  assert.equal(fs.existsSync(path.join(s.trailDir, '.t.sync.lock')), false, 'lock released');
});

test('an empty message is reported as skipped and does not block the folder', async () => {
  const s = await setup({ n: 2 });
  const fake = makeFake({ folders: { INBOX: { msgs: [{ uid: 1, raw: Buffer.alloc(0) }, ...s.msgs.map((m) => ({ ...m, uid: m.uid + 1 }))] } } });
  const r = await run(s, fake);
  assert.deepEqual(r.folders[0].skipped, [{ uid: 1, size: 0, why: 'empty or no longer on the server' }]);
  assert.deepEqual([r.folders[0].recorded, r.folders[0].complete], [2, true]);
});
