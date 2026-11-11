// Prune before date (SPEC B9, M3 step 3). Real git trails built through `record()`, a checker that recomputes the
// expected result from the old trail (tests/helpers/prune-check.js), crash recovery with real killed processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { runSync } from '../../src/proof/sync.js';
import { withTrailLock, syncLockFile, SYNC_LOCK } from '../../src/proof/trail.js';
import { recordPath } from '../../src/proof/layout.js';
import { signedMail } from '../helpers/proof.js';
import { makeFake } from '../helpers/fake-imap-session.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { makeTrail, DAY, T0 } from '../helpers/prune-trail.js';
import { checkPruned, parseNotice } from '../helpers/prune-check.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ls = (root, rev = 'HEAD') => git(root, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
const exists = (p) => fs.existsSync(p);
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => /prune-tmp|prune-build|\.prune\.json$/.test(f));
const PROC = new URL('../helpers/prune-proc.js', import.meta.url).pathname;
const NOTHING = '2000-01-01';

test('1. prune: the result, the notice, the files kept and removed, byte-identical kept proofs (the ported checker passes)', async () => {
  const t = await makeTrail();
  const before = git(t.root, 'rev-parse', 'HEAD');
  const oldCount = Number(git(t.root, 'rev-list', '--count', 'HEAD'));
  const r = await t.mp.prune({ before: t.cutoff });
  assert.equal(r.noop, false);
  assert.equal(r.cutoff, t.cutoff);
  assert.equal(r.previousHead, before);
  assert.equal(r.head, git(t.root, 'rev-parse', 'HEAD'));
  assert.deepEqual([r.removed, r.kept, r.dropped, r.keysCarried], [5, 5, 1, 1]);
  assert.deepEqual(r.stragglers, [t.recs[8].id]);
  assert.deepEqual(r.reverify, { ok: 5, failed: [] });
  assert.deepEqual(r.content, { removed: 5, attachments: 1 });
  assert.equal(r.backup, path.join(t.dir, 'default.pre-prune-2026-01-21'));
  assert.ok(r.timing.lockMs >= 0 && r.timing.totalMs >= r.timing.lockMs);
  assert.deepEqual(leftovers(t.dir), []);
  assert.equal(git(t.root, 'status', '--porcelain'), '');

  // the old trail is intact in the backup (it still holds everything that was pruned)
  assert.equal(git(r.backup, 'rev-parse', 'HEAD'), before);
  assert.equal(Number(git(r.backup, 'rev-list', '--count', 'HEAD')), oldCount);

  // the checker, written separately from the code under test
  const c = checkPruned(r.backup, t.cutoff, t.root);
  assert.deepEqual(c.problems, []);
  assert.equal(c.keptCommits, 6);   // five kept records and the reply-text commit for a kept record
  assert.equal(c.dropped, 1);       // the reply-text commit for a removed record

  // records: pruned gone, kept there and still verify offline from the record alone
  for (const [i, rec] of t.recs.entries()) {
    const got = await t.mp.get(rec.id);
    if (i < 5 && i !== 8) { assert.equal(got, null, `record ${i} is pruned`); continue; }
    assert.ok(got, `record ${i} is kept`);
    assert.equal((await t.mp.verify(rec.id)).ok, true);
  }
  // the straggler (captured on day 2, committed after day 7) is kept and reported
  assert.equal((await t.mp.get(t.recs[8].id)).captured, new Date(T0 + 2 * DAY).toISOString());

  // the notice: the root commit, with the counts
  const root = git(t.root, 'rev-list', '--max-parents=0', 'HEAD');
  const n = parseNotice(git(t.root, 'log', '-1', '--format=%B', root));
  assert.deepEqual([n.cutoff, n['previous-head'], n.removed, n.kept, n.stragglers, n.dropped], [t.cutoff, before, '5', '5', '1', '1']);
  assert.equal(n['pruned-at'], new Date(T0 + 20 * DAY).toISOString());
  assert.equal(git(t.root, 'log', '-1', '--format=%s', root), `prune notice: everything captured before ${t.cutoff} removed`);

  // keys: B's key (first committed with a pruned record, named by a kept one) is in the notice tree; A's (pruned only) is gone; C's stays
  const keyOf = (s) => ls(t.root).filter((p) => p.startsWith(`keys/send${s.toLowerCase()}.example/`));
  assert.equal(keyOf('A').length, 0);
  assert.equal(keyOf('B').length, 1);
  assert.equal(keyOf('C').length, 1);
  assert.deepEqual(ls(t.root, root).sort(), ['trail.json', ...keyOf('B')].sort());
  assert.equal(ls(t.root, root).length, 2);

  // content: raw emails of pruned ids are gone, the attachment only they had is gone, the shared one stays
  for (const [i, rec] of t.recs.entries()) assert.equal((await t.mp.rawEmail(rec.id)) === null, i < 5 && i !== 8, `raw ${i}`);
  assert.equal(await t.mp.attachment(sha(Buffer.from('%PDF-1.4 only a pruned mail has this\n'.repeat(10)))), null);
  assert.ok(await t.mp.attachment(sha(Buffer.from('%PDF-1.4 shared contract\n'.repeat(10)))));

  // the trail index follows by itself
  const listed = (await t.mp.list()).map((x) => x.id).sort();
  assert.deepEqual(listed, t.recs.filter((_, i) => i >= 5 || i === 8).map((x) => x.id).sort());
  assert.equal((await t.mp.copies(t.recs[6].id)).copies.length, 1);

  // the pruned trail is a normal trail: a new record lands on it
  t.clock.t += DAY;
  const fresh = await t.mp.record(await t.mailFor('B', 'after'), { direction: 'in' });
  assert.equal(fresh.duplicate, false);
  assert.equal(git(t.root, 'status', '--porcelain'), '');
});

test('2. a cutoff that removes nothing is a no-op: no rewrite, no backup', async () => {
  const t = await makeTrail();
  const head = git(t.root, 'rev-parse', 'HEAD');
  const r = await t.mp.prune({ before: NOTHING });
  assert.equal(r.noop, true);
  assert.deepEqual([r.removed, r.kept, r.dropped, r.backup, r.previousHead, r.head], [0, 10, 0, null, head, head]);
  assert.equal(git(t.root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['default', 'default.content']);
  // a trail that does not exist yet is a no-op too, and creates nothing
  const empty = new Mailproof({ trailDir: makeTmpDir('mp-prune-empty-'), worker: { size: 0 } });
  assert.equal((await empty.prune({ before: NOTHING })).noop, true);
  assert.deepEqual(fs.readdirSync(path.dirname(empty.root)), []);
});

test('3. a cutoff after the last record would empty the trail: refused, nothing changed', async () => {
  const t = await makeTrail();
  const head = git(t.root, 'rev-parse', 'HEAD');
  await assert.rejects(t.mp.prune({ before: new Date(T0 + 400 * DAY) }), (e) => e.code === 'ERR_PRUNE_CUTOFF');
  assert.equal(git(t.root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['default', 'default.content']);
});

test('4. options are validated before anything is read', async () => {
  const t = await makeTrail({ n: 1 });
  for (const bad of [undefined, null, {}, { before: 'not a date' }, { before: {} }, { before: NaN }]) {
    await assert.rejects(t.mp.prune(bad), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(t.mp.prune({ before: NOTHING, deleteBackup: 'yes' }), TypeError);
  await assert.rejects(t.mp.prune({ before: NOTHING, now: 'x' }), TypeError);
  await assert.rejects(t.mp.prune({ before: NOTHING, nope: 1 }), /unknown option/);
  // a Date, a timestamp and an ISO string all work
  for (const before of [new Date(NOTHING), Date.parse(NOTHING), NOTHING]) assert.equal((await t.mp.prune({ before })).noop, true);
});

test('5. OpenTimestamps stamps of kept records stay byte-identical; those of removed records go', async () => {
  const bin = path.join(makeTmpDir('mp-prune-ots-'), 'ots');
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = stamp ] && cp "$2" "$2.ots"\n', { mode: 0o755 });
  const t = await makeTrail({ extra: { otsBin: bin, stamp: { mode: 'record' } } });
  assert.equal(ls(t.root).filter((p) => p.endsWith('.ots')).length, 10);
  const stamps = new Map(ls(t.root).filter((p) => p.endsWith('.ots')).map((p) => [p, fs.readFileSync(path.join(t.root, p))]));
  const r = await t.mp.prune({ before: t.cutoff });
  const after = ls(t.root).filter((p) => p.endsWith('.ots'));
  assert.equal(after.length, 5);
  for (const p of after) assert.deepEqual(fs.readFileSync(path.join(t.root, p)), stamps.get(p));
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
});

test('6. a second and a third prune: the notices chain (cumulative), the checker passes each time', async () => {
  const t = await makeTrail();
  const r1 = await t.mp.prune({ before: t.cutoff });
  t.clock.t += DAY;
  const cut2 = new Date(T0 + 8 * DAY).toISOString();
  const r2 = await t.mp.prune({ before: cut2 });
  assert.equal(r2.backup, path.join(t.dir, 'default.pre-prune-2026-01-22'));
  assert.deepEqual(checkPruned(r2.backup, cut2, t.root).problems, []);
  // records 5, 6, 7 and the straggler 8 are before day 8; only record 9 remains
  assert.deepEqual([r2.removed, r2.kept], [4, 1]);
  const n2 = parseNotice(git(t.root, 'log', '--max-parents=0', '-1', '--format=%B'));
  assert.equal(n2.cutoff, cut2);
  assert.deepEqual([n2['earlier-1-cutoff'], n2['earlier-1-removed'], n2['earlier-1-previous-head']], [t.cutoff, '5', r1.previousHead]);
  assert.equal(n2['earlier-2-cutoff'], undefined);

  t.clock.t += DAY;
  const cut3 = new Date(T0 + 9.5 * DAY).toISOString();
  await t.mp.record(await t.mailFor('C', 'again'), { direction: 'in' });   // captured on day 22: after
  const r3 = await t.mp.prune({ before: cut3 });
  assert.equal(r3.removed, 1);
  const n3 = parseNotice(git(t.root, 'log', '--max-parents=0', '-1', '--format=%B'));
  assert.deepEqual([n3['earlier-1-cutoff'], n3['earlier-2-cutoff'], n3['earlier-2-removed']], [cut2, t.cutoff, '5']);
  assert.deepEqual(checkPruned(r3.backup, cut3, t.root).problems, []);
  assert.equal(r3.backup, path.join(t.dir, 'default.pre-prune-2026-01-23'));
});

test('7. a kept record that does not verify is reported, never a reason to stop', async () => {
  const t = await makeTrail();
  const plain = Buffer.from('From: nobody@nowhere.example\r\nTo: me@x.example\r\nSubject: unsigned\r\nMessage-ID: <u1@nowhere.example>\r\n\r\nno signature at all\r\n');
  t.clock.t = T0 + 12 * DAY;
  const un = await t.mp.record(plain, { direction: 'in' });
  // and a kept record whose stored signed headers were edited after the fact
  const file = path.join(t.root, recordPath(t.recs[6].id));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.signatures[0].signed_headers[0] = Buffer.from('Subject: edited\r\n').toString('base64');
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  git(t.root, 'commit', '-qam', 'edit a record');
  const r = await t.mp.prune({ before: t.cutoff });
  assert.deepEqual(r.reverify.failed.sort(), [un.id, t.recs[6].id].sort());
  assert.equal(r.reverify.ok, r.kept - 2);
  assert.equal(r.noop, false);
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);   // byte-identical, so nothing changed for it
});

test('8. commits made while the pruned trail is built are carried over (the lock is not held during the build)', async () => {
  const t = await makeTrail({ extra: { lockTimeoutMs: 2000 } });   // a held lock would turn the hook records into ERR_TRAIL_LOCKED
  const snapshot = git(t.root, 'rev-parse', 'HEAD');
  const late = {};
  t.mp._pruneHooks.afterPlan = async () => {
    t.clock.t = T0 + 19 * DAY;
    late.c = await t.mp.record(await t.mailFor('C', 'late-c'), { direction: 'in' });
  };
  t.mp._pruneHooks.afterBuild = async () => {
    t.clock.t = T0 + 19 * DAY + 3600_000;
    // sender A's key was first committed in the pruned prefix and no kept record names it: this record needs it
    late.a = await t.mp.record(await t.mailFor('A', 'late-a'), { direction: 'in' });
    await t.mp.replyText({ id: t.recs[0].id });   // a reply-text commit for a removed record: dropped
    t.clock.t = T0 + 1 * DAY;                     // captured before the cutoff, committed last: a straggler
    late.s = await t.mp.record(await t.mailFor('C', 'late-s'), { direction: 'in' });
  };
  const r = await t.mp.prune({ before: t.cutoff });
  assert.deepEqual([r.removed, r.kept, r.dropped, r.keysCarried], [5, 8, 2, 2]);
  assert.deepEqual(r.stragglers, [t.recs[8].id, late.s.id]);
  assert.deepEqual(r.reverify, { ok: 8, failed: [] });
  assert.equal(r.previousHead, git(r.backup, 'rev-parse', 'HEAD'));
  assert.notEqual(r.previousHead, snapshot);
  assert.equal(r.head, git(t.root, 'rev-parse', 'HEAD'));
  for (const x of [late.c, late.a, late.s]) assert.ok(await t.mp.get(x.id), 'the late record is in the pruned trail');
  const keyA = (await t.mp.get(late.a.id)).signatures[0].key_file;
  assert.ok(ls(t.root).includes(keyA), 'the key the late record names was added to the commit that needs it');
  const c = checkPruned(r.backup, t.cutoff, t.root, { lateKeys: [keyA], expectPreviousHead: snapshot });
  assert.deepEqual(c.problems, []);
  assert.equal(git(t.root, 'status', '--porcelain'), '');
  assert.equal((await t.mp.verify(late.a.id)).ok, true);
});

test('9. history rewritten while the pruned trail is built: abort, nothing changed', async () => {
  const t = await makeTrail();
  t.mp._pruneHooks.afterBuild = async () => { git(t.root, 'reset', '-q', '--hard', 'HEAD~1'); };
  await assert.rejects(t.mp.prune({ before: t.cutoff }), (e) => e.code === 'ERR_PRUNE_REWRITTEN');
  const head = git(t.root, 'rev-parse', 'HEAD');
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['default', 'default.content']);
  assert.equal(git(t.root, 'status', '--porcelain'), '');
  assert.ok(await t.mp.rawEmail(t.recs[0].id), 'no content was deleted');
  // and a failure anywhere in the build leaves the same picture
  t.mp._pruneHooks.afterBuild = () => { throw new Error('boom'); };
  await assert.rejects(t.mp.prune({ before: t.cutoff }), /boom/);
  assert.equal(git(t.root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['default', 'default.content']);
});

test('10. the trail lock is held only for the append and the swap', async () => {
  const t = await makeTrail({ extra: { lockTimeoutMs: 1500 } });
  let during = null;
  t.mp._pruneHooks.afterPlan = async () => { during = await t.mp.record(await t.mailFor('C', 'x'), { direction: 'in' }); };
  const r = await t.mp.prune({ before: t.cutoff });
  assert.equal(during.duplicate, false);   // would be ERR_TRAIL_LOCKED if the plan held the lock
  assert.ok(r.timing.buildMs >= 0 && r.timing.lockMs < 10_000);
  // the lock hold time is recorded for the swap alone
  assert.ok(r.timing.lockMs <= r.timing.totalMs);
});

test('11. a second prune at the same time is refused at once; a running sync makes the swap wait, and give up cleanly', async () => {
  const t = await makeTrail();
  let second = null;
  t.mp._pruneHooks.afterPlan = async () => { second = await t.mp.prune({ before: t.cutoff }).then(() => null, (e) => e); };
  await t.mp.prune({ before: t.cutoff });
  assert.equal(second?.code, 'ERR_PRUNE_RUNNING');

  // a sync that outlasts the wait: the prune fails with ERR_SYNC_LOCKED and changes nothing
  const u = await makeTrail();
  const head = git(u.root, 'rev-parse', 'HEAD');
  u.mp._pruneHooks.syncWaitMs = 300;
  await assert.rejects(withTrailLock(u.root, syncLockFile('default'), 0, () => u.mp.prune({ before: u.cutoff }), SYNC_LOCK), (e) => e.code === 'ERR_SYNC_LOCKED');
  assert.equal(git(u.root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(u.dir).sort(), ['default', 'default.content']);
  // a sync that ends in time: the prune goes ahead
  const v = await makeTrail();
  v.mp._pruneHooks.syncWaitMs = 5000;
  let release;
  const held = withTrailLock(v.root, syncLockFile('default'), 0, () => new Promise((r) => { release = r; }), SYNC_LOCK);
  const pruning = v.mp.prune({ before: v.cutoff });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(Number(git(v.root, 'rev-list', '--count', 'HEAD')) > 5, true, 'still waiting for the sync');
  release();
  await held;
  assert.equal((await pruning).removed, 5);
});

test('12. crash recovery: killed at every point, the next lock holder leaves exactly the old trail or exactly the pruned one', async (tc) => {
  for (const at of ['afterBuild', 'journal', 'renamed-live', 'renamed-tmp', 'cursor', 'swapped']) {
    await tc.test(at, async () => {
      const t = await makeTrail();
      const oldHead = git(t.root, 'rev-parse', 'HEAD');
      const cursor = path.join(t.dir, '.default.sync.json');
      fs.writeFileSync(cursor, JSON.stringify({ v: 1, head: oldHead, accounts: { 'h/u': { INBOX: { uidvalidity: '1', last_uid: 9, updated: 'x' } } } }));
      const res = spawnSync(process.execPath, [PROC, t.dir, t.cutoff, at], { encoding: 'utf8' });
      assert.equal(res.signal, 'SIGKILL', `the child must die at ${at}: ${res.stdout} ${res.stderr}`);
      const backup = path.join(t.dir, 'default.pre-prune-2026-02-01');
      if (at === 'renamed-live') { assert.equal(exists(t.root), false, 'the gap: no live trail'); assert.ok(exists(`${t.root}.prune-tmp`)); }
      if (at === 'afterBuild') assert.ok(exists(`${t.root}.prune-tmp`), 'a finished build was left behind');
      else assert.ok(exists(path.join(t.dir, '.default.prune.json')));

      // the next call that takes the trail lock repairs it (a no-op prune is the plainest such call)
      assert.equal((await t.mp.prune({ before: NOTHING })).noop, true);
      assert.deepEqual(leftovers(t.dir), [], 'no tmp, build or journal left');
      assert.equal(git(t.root, 'status', '--porcelain'), '');
      git(t.root, 'fsck', '--strict', '--no-dangling');
      const head = git(t.root, 'rev-parse', 'HEAD');
      const cur = JSON.parse(fs.readFileSync(cursor, 'utf8'));
      if (at === 'afterBuild') {
        assert.equal(head, oldHead, 'exactly the old trail');
        assert.equal(exists(backup), false);
        assert.equal(cur.head, oldHead);
        assert.ok(await t.mp.rawEmail(t.recs[0].id));
      } else {
        assert.notEqual(head, oldHead, 'exactly the pruned trail');
        assert.equal(git(backup, 'rev-parse', 'HEAD'), oldHead);
        assert.deepEqual(checkPruned(backup, t.cutoff, t.root).problems, []);
        assert.equal(cur.head, head, 'the sync cursor follows the new head');
        assert.equal(cur.accounts['h/u'].INBOX.last_uid, 9);
        assert.equal(await t.mp.rawEmail(t.recs[0].id), null, 'content of the removed records is swept');
        assert.ok(await t.mp.rawEmail(t.recs[6].id));
        assert.equal((await t.mp.list()).length, 5);
      }
    });
  }
});

test('13. a writer arriving in the gap between the two renames does not create an empty trail', async () => {
  const t = await makeTrail();
  const res = spawnSync(process.execPath, [PROC, t.dir, t.cutoff, 'renamed-live'], { encoding: 'utf8' });
  assert.equal(res.signal, 'SIGKILL');
  assert.equal(exists(t.root), false);
  t.clock.t += DAY;
  const w = await t.mp.record(await t.mailFor('C', 'in the gap'), { direction: 'in' });
  assert.equal(w.duplicate, false);
  const subjects = git(t.root, 'log', '--format=%s').split('\n');
  assert.ok(subjects.some((s) => s.startsWith('prune notice')), 'the pruned history is there');
  assert.equal(subjects.includes('trail created'), false, 'no fresh trail was made');
  assert.equal(subjects.length, 8);   // notice + 5 kept records + 1 reply-text + the new record
  assert.ok(await t.mp.get(t.recs[6].id));
  assert.equal(await t.mp.get(t.recs[0].id), null);
  assert.deepEqual(leftovers(t.dir), []);
});

test('14. the sync cursor follows the new head: the next sync does not record the removed mail again', async () => {
  const trailDir = makeTmpDir('mp-prune-sync-');
  const clock = { t: T0 };
  const msgs = [];
  const map = {};
  for (let i = 0; i < 6; i++) {
    const m = await signedMail({ body: `sync mail ${i}\r\n`, domain: `s${i}.example`, alg: 'ed25519' });
    Object.assign(map, m.map);
    msgs.push({ uid: i + 1, raw: m.raw });
  }
  const resolver = async (name, type) => {
    if ((type || 'TXT').toUpperCase() !== 'TXT') throw Object.assign(new Error('only TXT'), { code: 'ENODATA' });
    if (map[name] === undefined) throw Object.assign(new Error('no record ' + name), { code: 'ENOTFOUND' });
    return [[map[name]]];
  };
  const mp = new Mailproof({ trailDir, trail: 't', resolver, worker: { size: 0 }, now: () => new Date(clock.t) });
  const fake = makeFake({ folders: { INBOX: { msgs } }, onCall: ({ op }) => { if (op === 'fetch') clock.t += DAY; } });
  const host = { root: mp.root, trail: 't', record: mp.record, recordDigest: (d, c) => mp._recordDigest(d, c) };
  const opts = { host: 'imap.account.test', user: 'me@account.test', auth: { pass: 'secret-pass' }, sent: false };
  const run = () => runSync(host, opts, { openSession: fake.openSession, sleep: async () => {} });
  const first = await run();
  assert.equal(first.folders[0].recorded, 6);
  const cut = new Date(T0 + 3.5 * DAY).toISOString();   // mails 1-3 are before, 4-6 after
  const r = await mp.prune({ before: cut });
  assert.deepEqual([r.removed, r.kept], [3, 3]);
  const cursorFile = path.join(trailDir, '.t.sync.json');
  assert.equal(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).head, r.head);
  const again = await run();
  const f = again.folders[0];
  assert.equal(f.reset, null, 'the cursor is consistent with the pruned trail, so no rescan');
  assert.deepEqual([f.seen, f.recorded, f.duplicate], [0, 0, 0]);
  assert.equal((await mp.list()).length, 3);
});

test('15. prune.backup: deleteBackup removes it after the swap; a second prune on the same day gets a suffix', async () => {
  const t = await makeTrail();
  const r = await t.mp.prune({ before: t.cutoff, deleteBackup: true });
  assert.equal(r.backup, null);
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['default', 'default.content']);
  assert.equal(r.removed, 5);
  // a failed prune never deletes anything: the cutoff-after-everything refusal with deleteBackup keeps the trail
  await assert.rejects(t.mp.prune({ before: new Date(T0 + 400 * DAY), deleteBackup: true }), (e) => e.code === 'ERR_PRUNE_CUTOFF');
  assert.equal((await t.mp.list()).length, 5);
  // two prunes on one day: the second backup does not overwrite the first
  const u = await makeTrail();
  const a = await u.mp.prune({ before: u.cutoff });
  const b = await u.mp.prune({ before: new Date(T0 + 8 * DAY) });
  assert.equal(path.basename(a.backup), 'default.pre-prune-2026-01-21');
  assert.equal(path.basename(b.backup), 'default.pre-prune-2026-01-21-2');
  assert.ok(exists(a.backup) && exists(b.backup));
});

test('16. the journal of a prune that is still running is left to it; a journal nobody can read stops writers, loudly', async () => {
  const t = await makeTrail();
  const journal = path.join(t.dir, '.default.prune.json');
  fs.writeFileSync(journal, JSON.stringify({ v: 1, state: 'swapped', pid: process.pid, host: os.hostname(), updated: new Date().toISOString(), backup: 'default.pre-prune-2026-01-01', cutoff: 'c', previous_head: 'a', new_head: 'b' }));
  assert.equal((await t.mp.prune({ before: NOTHING })).noop, true);
  assert.ok(exists(journal), 'owner alive: not touched');
  fs.writeFileSync(journal, '{ not json');
  const head = git(t.root, 'rev-parse', 'HEAD');
  await assert.rejects(t.mp.record(await t.mailFor('C', 'blocked'), { direction: 'in' }), (e) => e.code === 'ERR_PRUNE_JOURNAL');
  assert.equal(git(t.root, 'rev-parse', 'HEAD'), head);
  fs.rmSync(journal);
  assert.equal((await t.mp.record(await t.mailFor('C', 'unblocked'), { direction: 'in' })).duplicate, false);
});

test('17. the checker can fail (negative control)', async () => {
  const t = await makeTrail();
  const r = await t.mp.prune({ before: t.cutoff });
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
  // a changed commit message
  git(t.root, 'commit', '--amend', '-q', '-m', 'changed');
  assert.notDeepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
  git(t.root, 'reset', '-q', '--hard', r.head);
  git(t.root, 'reflog', 'expire', '--expire=now', '--all');
  git(t.root, 'gc', '-q', '--prune=now');
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
  // a pruned record put back
  const gone = recordPath(t.recs[0].id);
  fs.mkdirSync(path.dirname(path.join(t.root, gone)), { recursive: true });
  fs.copyFileSync(path.join(r.backup, gone), path.join(t.root, gone));
  git(t.root, 'add', '-A');
  git(t.root, 'commit', '-qm', 'tamper');
  assert.notDeepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
});

test('18. a flat (pre-M3) trail is refused like everywhere else', async () => {
  const dir = makeTmpDir('mp-prune-flat-');
  const root = path.join(dir, 'default');
  fs.mkdirSync(path.join(root, 'records'), { recursive: true });
  fs.writeFileSync(path.join(root, 'records', 'a'.repeat(32) + '.json'), '{}');
  const mp = new Mailproof({ trailDir: dir, worker: { size: 0 } });
  await assert.rejects(mp.prune({ before: NOTHING }), (e) => e.code === 'ERR_TRAIL_LAYOUT');
});

test('19. a file the library does not manage, committed before the cutoff, is carried in the notice commit', async () => {
  const t = await makeTrail({ n: 3 });
  fs.writeFileSync(path.join(t.root, 'notes.txt'), 'kept by the owner\n');
  git(t.root, 'add', 'notes.txt');
  git(t.root, 'commit', '-qm', 'owner note');
  for (const day of [6, 7]) { t.clock.t = T0 + day * DAY; await t.mp.record(await t.mailFor('B', `d${day}`), { direction: 'in' }); }
  const r = await t.mp.prune({ before: t.cutoff });
  assert.deepEqual([r.removed, r.kept], [3, 2]);
  const root = git(t.root, 'rev-list', '--max-parents=0', 'HEAD');
  assert.ok(ls(t.root, root).includes('notes.txt'));
  assert.equal(fs.readFileSync(path.join(t.root, 'notes.txt'), 'utf8'), 'kept by the owner\n');
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root).problems, []);
});

test('20. only a dropped commit during the build: the pruned trail is the built one, and a journal cannot aim a rename elsewhere', async () => {
  const t = await makeTrail();
  const snapshot = git(t.root, 'rev-parse', 'HEAD');
  t.mp._pruneHooks.afterBuild = async () => { await t.mp.replyText({ id: t.recs[0].id }); };   // touches only a removed record
  const r = await t.mp.prune({ before: t.cutoff });
  assert.deepEqual([r.removed, r.kept, r.dropped], [5, 5, 2]);
  assert.notEqual(r.previousHead, snapshot);
  assert.deepEqual(checkPruned(r.backup, t.cutoff, t.root, { expectPreviousHead: snapshot }).problems, []);
  // a journal naming a directory outside the trail's own backup names is refused, not obeyed
  const journal = path.join(t.dir, '.default.prune.json');
  fs.writeFileSync(journal, JSON.stringify({ v: 1, state: 'swapping', pid: 1, host: 'elsewhere', updated: new Date().toISOString(), backup: '..', cutoff: 'c', previous_head: 'a', new_head: 'b' }));
  await assert.rejects(t.mp.record(await t.mailFor('C', 'x'), { direction: 'in' }), (e) => e.code === 'ERR_PRUNE_JOURNAL');
  fs.rmSync(journal);
});
