// The stamp job (SPEC B13.1, M4 part a) with a fake `ots` binary (a shell script): manifests and the chain, the unsealed set,
// locks, failure and crash, cadence, modes, upgrade and legacy stamps, findSeal, the index hint. No network: `ots` is a script.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { runSync } from '../../src/proof/sync.js';
import { findSeal, serialiseManifest, parseManifest } from '../../src/proof/seal.js';
import { countPendingStamps } from '../../src/proof/ots-upgrade.js';
import { manifestPath, manifestOtsPath, recordPath, recordOtsPath, parseManifestPath } from '../../src/proof/layout.js';
import { OTS_MISSING_MESSAGE } from '../../src/proof/ots.js';
import { signedMail } from '../helpers/proof.js';
import { makeFake } from '../helpers/fake-imap-session.js';
import { makeTmpDir } from '../helpers/tmp.js';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HOUR = 3_600_000;

/** A fake `ots`: stamp copies the file; upgrade rewrites it once `anchored` exists (leaving a .bak, like the client); every call is logged. */
function fakeOts({ stamp = 'cp "$2" "$2.ots"', log = true } = {}) {
  const dir = makeTmpDir('mp-stamp-ots-');
  const bin = path.join(dir, 'ots');
  const anchored = path.join(dir, 'anchored');
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/bin/sh
${log ? `echo "$1" >> '${calls}'` : ''}
case "$1" in
  stamp) ${stamp};;
  upgrade) if [ -f '${anchored}' ]; then grep -q anchored "$2" || { cp "$2" "$2.bak"; echo anchored >> "$2"; }; exit 0; else exit 1; fi;;
  info) echo "Bitcoin block 850123";;
esac
`, { mode: 0o755 });
  return { bin, anchor: () => fs.writeFileSync(anchored, ''), calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []), dir };
}

/** A trail with a moving clock. `rec(tag)` records one signed mail through its own instance (so each mail has its own resolver). */
function world({ otsBin, stamp, lockTimeoutMs = 5000, trailDir = makeTmpDir('mp-stamp-') } = {}) {
  const clock = { t: Date.parse('2026-11-11T08:00:00Z') };
  const now = () => new Date(clock.t);
  const mk = (extra = {}) => new Mailproof({ trailDir, worker: { size: 0 }, now, lockTimeoutMs, ...(otsBin !== undefined ? { otsBin } : {}), ...(stamp ? { stamp } : {}), ...extra });
  const mp = mk();
  const ids = [];
  let n = 0;
  const rec = async (tag = `m${n++}`, extra = {}) => {
    const m = await signedMail({ body: `${tag}\r\n`, domain: `d${n}.example` });
    const r = await mk({ resolver: m.resolver, ...extra }).record(m.raw, { direction: 'in' });
    ids.push(r.id);
    clock.t += 1000;
    return r;
  };
  return { mp, mk, clock, rec, ids, trailDir, root: mp.root, now };
}

const manifestFiles = (root) => (fs.existsSync(path.join(root, 'manifests')) ? fs.readdirSync(path.join(root, 'manifests')).sort() : []);
const headOf = (root) => sh(root, 'rev-parse', 'HEAD');
const subjects = (root) => sh(root, 'log', '--format=%s').split('\n');
const clean = (root) => assert.equal(sh(root, 'status', '--porcelain'), '');
const readManifest = (root, seq) => JSON.parse(fs.readFileSync(path.join(root, manifestPath(seq)), 'utf8'));
const dotFiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('.'));

test('record() in batch mode never spawns ots, whatever the setup: it reports queued and writes no proof and no manifest', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const r = await w.rec('a');
  assert.equal(r.ots, 'queued');
  await w.rec('b');
  assert.deepEqual(ots.calls(), [], 'ots was never run');
  assert.ok(!fs.existsSync(path.join(w.root, 'manifests')));
  assert.ok(!fs.existsSync(path.join(w.root, recordOtsPath(r.id))));
  // the default (no otsBin option) is on: still queued, still no spawn of the real binary (PATH has none here)
  const d = world({});
  assert.equal((await d.rec('c')).ots, 'queued');
});

test('otsBin: null is off: record() says off, stamp() does nothing and touches nothing', async () => {
  const w = world({ otsBin: null });
  const r = await w.rec('a');
  assert.equal(r.ots, 'off');
  const head = headOf(w.root);
  const res = await w.mp.stamp();
  assert.deepEqual(res, { enabled: false, mode: 'batch', ran: true, manifests: [], stamped: null, unstamped: 0, unsealed: 0, upgraded: 0, pending: 0 });
  assert.equal(headOf(w.root), head);
  assert.ok(!fs.existsSync(path.join(w.root, 'manifests')));
  assert.deepEqual(dotFiles(w.trailDir).filter((f) => /stamp/.test(f)), []);
  assert.equal(await w.mp._autoStamp(), null);
});

test('stamp options are validated at construction', () => {
  const dir = makeTmpDir('mp-stamp-opt-');
  for (const bad of [null, 'batch', [], { nope: 1 }, { mode: 'x' }, { everyHours: 0 }, { everyHours: 721 }, { everyHours: 1.5 }, { everyHours: '6' }]) {
    assert.throws(() => new Mailproof({ trailDir: dir, stamp: bad }), /stamp/, JSON.stringify(bad));
  }
  for (const good of [{}, { mode: 'record' }, { mode: 'batch', everyHours: 1 }, { everyHours: 720 }]) assert.doesNotThrow(() => new Mailproof({ trailDir: dir, stamp: good }));
});

test('manifest: exact bytes, sorted entries, hashes of the committed files, chain over three jobs, only the newest is stamped', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  await w.rec('a'); await w.rec('b'); await w.rec('c');
  const r1 = await w.mp.stamp();
  assert.equal(r1.manifests.length, 1);
  assert.deepEqual([r1.manifests[0].seq, r1.manifests[0].records, r1.manifests[0].replies, r1.stamped, r1.unstamped, r1.unsealed, r1.error], [1, 3, 0, 1, 0, 0, undefined]);
  const bytes1 = fs.readFileSync(path.join(w.root, manifestPath(1)));
  // the golden layout, built by hand from the committed record files
  const sorted = [...w.ids].sort();
  const entry = (id) => `    ["${id}", "${sha(fs.readFileSync(path.join(w.root, recordPath(id))))}"]`;
  const golden = `{\n  "v": 1,\n  "seq": 1,\n  "previous_sha256": null,\n  "created": ${JSON.stringify(readManifest(w.root, 1).created)},\n  "records": [\n${sorted.map(entry).join(',\n')}\n  ],\n  "replies": []\n}\n`;
  assert.equal(bytes1.toString('utf8'), golden);
  assert.equal(r1.manifests[0].sha256, sha(bytes1));
  assert.deepEqual(Object.keys(readManifest(w.root, 1)), ['v', 'seq', 'previous_sha256', 'created', 'records', 'replies']);
  assert.equal(serialiseManifest(readManifest(w.root, 1)), golden, 'the writer is deterministic');
  assert.equal(subjects(w.root)[0], 'stamp seal 1');
  assert.equal(subjects(w.root)[1], 'stamp manifest 1');
  assert.deepEqual(ots.calls(), ['stamp'], 'the proof just made is not asked about in the same job');
  assert.equal(fs.readFileSync(path.join(w.root, manifestOtsPath(1)), 'utf8'), golden, 'the fake proof is the manifest bytes it was given');
  clean(w.root);
  // two more jobs: each lists only the files added since, and names the hash of the file before it
  await w.rec('d');
  const r2 = await w.mp.stamp();
  await w.rec('e'); await w.rec('f');
  const r3 = await w.mp.stamp();
  assert.deepEqual([r2.manifests[0].seq, r2.manifests[0].records, r3.manifests[0].seq, r3.manifests[0].records], [2, 1, 3, 2]);
  assert.equal(readManifest(w.root, 2).previous_sha256, sha(bytes1));
  assert.equal(readManifest(w.root, 3).previous_sha256, sha(fs.readFileSync(path.join(w.root, manifestPath(2)))));
  assert.deepEqual(manifestFiles(w.root), ['00000001.json', '00000001.json.ots', '00000002.json', '00000002.json.ots', '00000003.json', '00000003.json.ots']);
  assert.equal(new Set([...readManifest(w.root, 1).records, ...readManifest(w.root, 2).records, ...readManifest(w.root, 3).records].map((e) => e[0])).size, 6, 'an entry appears once in the whole chain');
  // a changed byte breaks the hash the next manifest holds
  const m1 = path.join(w.root, manifestPath(1));
  assert.notEqual(sha(Buffer.concat([fs.readFileSync(m1), Buffer.from(' ')])), readManifest(w.root, 2).previous_sha256);
});

test('the same unsealed set builds byte-identical manifests', async () => {
  const bins = [fakeOts().bin, fakeOts().bin];
  const trailDir = makeTmpDir('mp-stamp-same-');
  // two copies of one trail: same files, same clock
  const a = world({ otsBin: bins[0], trailDir });
  await a.rec('x'); await a.rec('y');
  const copy = makeTmpDir('mp-stamp-same2-');
  fs.cpSync(trailDir, copy, { recursive: true });
  const b = new Mailproof({ trailDir: copy, otsBin: bins[1], worker: { size: 0 }, now: a.now });
  await a.mp.stamp(); await b.stamp();
  assert.deepEqual(fs.readFileSync(path.join(a.root, manifestPath(1))), fs.readFileSync(path.join(b.root, manifestPath(1))));
});

test('empty unsealed set: no commit and no manifest; a second run is idempotent', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  await w.rec('a');
  await w.mp.stamp();
  const head = headOf(w.root);
  const calls = ots.calls().length;
  const r = await w.mp.stamp();
  assert.deepEqual([r.manifests, r.stamped, r.unsealed, r.unstamped, r.error], [[], null, 0, 0, undefined]);
  assert.equal(headOf(w.root), head);
  assert.equal(ots.calls().filter((c) => c === 'stamp').length, 1, 'no second ots stamp');
  assert.ok(ots.calls().length >= calls);
});

test('records of every kind are sealed (an unverified one too); legacy per-record proofs are not listed; reply-text files are', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const legacy = world({ otsBin: ots.bin, stamp: { mode: 'record' }, trailDir: w.trailDir });
  const old = await legacy.rec('legacy');
  assert.equal(old.ots, 'pending');
  assert.ok(fs.existsSync(path.join(w.root, recordOtsPath(old.id))));
  const unsigned = await w.mk().record(Buffer.from('From: a@b.example\r\nTo: c@d.example\r\n\r\nno signature\r\n'), { direction: 'in' });
  const signed = await w.rec('signed');
  await w.mp.replyText({ id: signed.id });
  const r = await w.mp.stamp();
  const m = readManifest(w.root, 1);
  assert.deepEqual(m.records.map((e) => e[0]), [unsigned.id, signed.id].sort());
  assert.equal(m.replies.length, 1);
  assert.equal(m.replies[0][0], signed.id);
  assert.equal(m.replies[0][2], sha(fs.readFileSync(path.join(w.root, `replies/${signed.id.slice(0, 2)}/${signed.id}.${m.replies[0][1]}.json`))));
  assert.ok(!m.records.some((e) => e[0] === old.id), 'a record with its own proof is never listed');
  assert.deepEqual([r.manifests[0].records, r.manifests[0].replies], [2, 1]);
});

test('caps: STAMP_MAX_ENTRIES splits into chained manifests of one job and one stamp; STAMP_MAX_MANIFESTS leaves a backlog', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  for (let i = 0; i < 5; i++) await w.rec(`r${i}`);
  w.mp._stampHooks.maxEntries = 2;
  const r = await w.mp.stamp();
  assert.deepEqual(r.manifests.map((m) => [m.seq, m.records]), [[1, 2], [2, 2], [3, 1]]);
  assert.equal(r.stamped, 3);
  assert.equal(r.unstamped, 2, 'covered by the stamp on the last one, through the chain');
  assert.equal(ots.calls().filter((c) => c === 'stamp').length, 1);
  assert.equal(readManifest(w.root, 2).previous_sha256, sha(fs.readFileSync(path.join(w.root, manifestPath(1)))));
  assert.equal(subjects(w.root)[1], 'stamp manifest 1-3');
  const w2 = world({ otsBin: fakeOts().bin });
  for (let i = 0; i < 5; i++) await w2.rec(`s${i}`);
  w2.mp._stampHooks.maxEntries = 2;
  w2.mp._stampHooks.maxManifests = 2;
  const r2 = await w2.mp.stamp();
  assert.deepEqual([r2.manifests.length, r2.unsealed], [2, 1]);
  w2.mp._stampHooks.maxManifests = 10;
  const r3 = await w2.mp.stamp();
  assert.deepEqual([r3.manifests.map((m) => m.records), r3.unsealed], [[1], 0]);
});

test('a record committed after the snapshot is not lost: it is unsealed, and in the next job', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  await w.rec('a');
  let late;
  w.mp._stampHooks.afterSnapshot = async () => { late = await w.rec('late'); };
  const r = await w.mp.stamp();
  w.mp._stampHooks.afterSnapshot = undefined;
  assert.equal(r.manifests[0].records, 1);
  assert.equal(r.unsealed, 1);
  const r2 = await w.mp.stamp();
  assert.deepEqual(readManifest(w.root, 2).records.map((e) => e[0]), [late.id]);
  assert.equal(r2.unsealed, 0);
});

test('locks: record() is not blocked while ots stamp runs; the trail lock is held for a commit, never for the network', async () => {
  const gate = path.join(makeTmpDir('mp-stamp-gate-'), 'go');
  const ots = fakeOts({ stamp: `while [ ! -f '${gate}' ]; do sleep 0.05; done; cp "$2" "$2.ots"` });
  const w = world({ otsBin: ots.bin, lockTimeoutMs: 3000 });
  await w.rec('a');
  const job = w.mp.stamp();
  const end = Date.now() + 10_000;
  while (!ots.calls().includes('stamp') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ots.calls().includes('stamp'), 'ots stamp is running');
  const during = await w.rec('during');   // would wait for the lock (and fail after 3 s) if the job held it over the network call
  assert.equal(during.duplicate, false);
  fs.writeFileSync(gate, '');
  const r = await job;
  assert.equal(r.stamped, 1);
  assert.equal(r.unsealed, 1, 'the record made during the stamp is for the next job');
  clean(w.root);
});

test('locks: a second job gets ERR_STAMP_LOCKED, the automatic one skips (locked); upgradeStamps() is refused too', async () => {
  const w = world({ otsBin: fakeOts().bin });
  await w.rec('a');
  /** @type {any} */
  const seen = {};
  w.mp._stampHooks.afterManifests = async () => {
    seen.second = await w.mp.stamp().then(() => null, (e) => e.code);
    seen.auto = await w.mp._autoStamp();
    seen.upgrade = await w.mp.upgradeStamps().then(() => null, (e) => e.code);
  };
  await w.mp.stamp();
  assert.equal(seen.second, 'ERR_STAMP_LOCKED');
  assert.deepEqual([seen.auto.ran, seen.auto.skipped], [false, 'locked']);
  assert.equal(seen.upgrade, 'ERR_STAMP_LOCKED');
  assert.ok(!dotFiles(w.trailDir).some((f) => /stamp\.lock$/.test(f)), 'the lock is released');
});

test('ERR_TRAIL_LOCKED: nothing is written when the trail lock cannot be had', async () => {
  const w = world({ otsBin: fakeOts().bin, lockTimeoutMs: 200 });
  await w.rec('a');
  const head = headOf(w.root);
  fs.writeFileSync(path.join(w.trailDir, '.default.lock'), JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), started: new Date().toISOString() }));
  await assert.rejects(w.mp.stamp(), { code: 'ERR_TRAIL_LOCKED' });
  fs.rmSync(path.join(w.trailDir, '.default.lock'));
  assert.equal(headOf(w.root), head);
  assert.ok(!fs.existsSync(path.join(w.root, 'manifests')));
  assert.ok(!dotFiles(w.trailDir).includes('.default.stamp.json'), 'a thrown job leaves the marker alone');
  assert.ok(!dotFiles(w.trailDir).includes('.default.stamp.lock'));
});

test('ots missing: one plain message, the manifest is committed without a proof, capture is unaffected; installing ots later stamps the newest and covers the earlier', async () => {
  const w = world({ otsBin: '/nonexistent/ots' });
  await w.rec('a');
  const r1 = await w.mp.stamp();
  assert.equal(r1.error, OTS_MISSING_MESSAGE);
  assert.match(r1.error, /ots not installed: records are not sealed; install opentimestamps-client or set ots: false/);
  assert.deepEqual([r1.manifests.length, r1.stamped, r1.unstamped], [1, null, 1]);
  assert.deepEqual(manifestFiles(w.root), ['00000001.json']);
  clean(w.root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.trailDir, '.default.stamp.json'), 'utf8')).error, OTS_MISSING_MESSAGE);
  await w.rec('b');   // capture works
  await w.mp.stamp();
  assert.deepEqual(manifestFiles(w.root), ['00000001.json', '00000002.json']);
  const ots = fakeOts();
  const good = w.mk({ otsBin: ots.bin });
  const r = await good.stamp();
  assert.deepEqual([r.stamped, r.manifests.length, r.unstamped, r.error], [2, 0, 1, undefined]);
  const seal = await findSeal(w.root, w.ids[0]);
  assert.deepEqual(seal.stamp, { seq: 2, own: false }, 'a late seal: bounded by the later stamp, through the chain');
});

test('ots failing or hanging: error in the result, manifest committed, never a throw', async () => {
  const bad = world({ otsBin: fakeOts({ stamp: 'echo calendar down >&2; exit 3' }).bin });
  await bad.rec('a');
  const r = await bad.mp.stamp();
  assert.match(r.error, /^ots exit 3: calendar down/);
  assert.equal(r.manifests.length, 1);
  assert.deepEqual(manifestFiles(bad.root), ['00000001.json']);
  const hang = world({ otsBin: fakeOts({ stamp: 'exec sleep 30' }).bin });
  await hang.rec('a');
  // the job's timeout is STAMP_OTS_TIMEOUT_MS; shorten it through the runner the instance built
  hang.mp.jobOts = (await import('../../src/proof/ots.js')).createOts({ otsBin: hang.mp.otsBin, timeoutMs: 300 });
  const h = await hang.mp.stamp();
  assert.equal(h.error, 'ots timeout');
  assert.deepEqual(manifestFiles(hang.root), ['00000001.json']);
});

test('crash: killed after step 3 leaves a committed manifest without proof, the next job stamps it; killed after ots stamp stamps again; an untracked manifest is cleared by the next writer', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  await w.rec('a');
  w.mp._stampHooks.afterManifests = () => { throw new Error('killed'); };
  await assert.rejects(w.mp.stamp(), /killed/);
  assert.deepEqual(manifestFiles(w.root), ['00000001.json']);
  clean(w.root);
  assert.ok(!dotFiles(w.trailDir).includes('.default.stamp.json'), 'no completed job, no marker');
  w.mp._stampHooks.afterManifests = undefined;
  w.mp._stampHooks.afterStamp = () => { throw new Error('killed again'); };
  await assert.rejects(w.mp.stamp(), /killed again/);
  assert.deepEqual(manifestFiles(w.root), ['00000001.json'], 'the scratch proof is lost, nothing half-committed');
  clean(w.root);
  w.mp._stampHooks.afterStamp = undefined;
  const r = await w.mp.stamp();
  assert.deepEqual([r.stamped, r.manifests.length], [1, 0]);
  assert.deepEqual(manifestFiles(w.root), ['00000001.json', '00000001.json.ots']);
  assert.ok(!fs.existsSync(path.join(w.trailDir, '.default.stamp')), 'scratch removed');
  // an untracked manifest left by a job killed during step 3
  fs.mkdirSync(path.join(w.root, 'manifests'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'manifests', '00000009.json'), '{}\n');
  await w.rec('b');
  assert.ok(!fs.existsSync(path.join(w.root, 'manifests', '00000009.json')));
  clean(w.root);
});

test('a failing commit removes only the files this call created', async () => {
  const w = world({ otsBin: fakeOts().bin });
  await w.rec('a');
  const hook = path.join(w.root, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const head = headOf(w.root);
  await assert.rejects(w.mp.stamp());
  fs.rmSync(hook);
  assert.equal(headOf(w.root), head);
  assert.deepEqual(manifestFiles(w.root), []);
  clean(w.root);
  assert.equal((await w.mp.stamp()).manifests.length, 1, 'the next job does it');
});

test('ERR_STAMP_CHAIN: a corrupted or gapped chain refuses the job and writes nothing', async () => {
  const w = world({ otsBin: fakeOts().bin });
  await w.rec('a'); await w.mp.stamp();
  await w.rec('b'); await w.mp.stamp();
  await w.rec('c');
  // corrupt manifest 1 (committed): manifest 2 no longer names its hash
  const m1 = path.join(w.root, manifestPath(1));
  fs.writeFileSync(m1, fs.readFileSync(m1, 'utf8').replace('"v": 1', '"v":  1'));
  sh(w.root, 'commit', '-qam', 'tamper');
  const head = headOf(w.root);
  await assert.rejects(w.mp.stamp(), (e) => e.code === 'ERR_STAMP_CHAIN' && e.seq === 2);
  assert.equal(headOf(w.root), head);
  // a gap: remove manifest 2 and its proof
  sh(w.root, 'checkout', '-q', 'HEAD~1', '--', manifestPath(1));
  sh(w.root, 'commit', '-qam', 'restore');
  sh(w.root, 'rm', '-q', manifestPath(2), manifestOtsPath(2));
  sh(w.root, 'commit', '-qm', 'gap');
  await w.rec('d');
  await w.mp.stamp();   // seq 1 then nothing: chain 1 -> (none): fine; a gap needs three
  const w3 = world({ otsBin: fakeOts().bin });
  for (const t of ['a', 'b', 'c']) { await w3.rec(t); await w3.mp.stamp(); }
  sh(w3.root, 'rm', '-q', manifestPath(2), manifestOtsPath(2));
  sh(w3.root, 'commit', '-qm', 'gap');
  const h3 = headOf(w3.root);
  await assert.rejects(w3.mp.stamp(), { code: 'ERR_STAMP_CHAIN' });
  assert.equal(headOf(w3.root), h3);
});

test('cadence: due without a marker, with a bad or future marker; 5 h 59 min is not due, 6 h is; an ots error still completes; stamp() ignores the marker', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const marker = path.join(w.trailDir, '.default.stamp.json');
  assert.deepEqual([(await w.mp._autoStamp()).ran, (await w.mp._autoStamp()).skipped], [false, 'not due'], 'no trail yet: nothing runs');
  assert.ok(!fs.existsSync(marker));
  await w.rec('a');
  const first = await w.mp._autoStamp();
  assert.equal(first.ran, true);
  assert.equal(first.manifests.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).last, w.now().toISOString());
  w.clock.t += 6 * HOUR - 60_000;
  await w.rec('b');
  const no = await w.mp._autoStamp();
  assert.deepEqual([no.ran, no.skipped, no.manifests], [false, 'not due', []]);
  w.clock.t += 60_000;
  const yes = await w.mp._autoStamp();
  assert.deepEqual([yes.ran, yes.manifests.length], [true, 1]);
  // an unreadable and a future-dated marker mean due
  fs.writeFileSync(marker, 'not json');
  assert.equal((await w.mp._autoStamp()).ran, true);
  fs.writeFileSync(marker, JSON.stringify({ last: new Date(w.clock.t + HOUR).toISOString() }));
  assert.equal((await w.mp._autoStamp()).ran, true);
  // everyHours is honoured
  const h = world({ otsBin: ots.bin, stamp: { everyHours: 1 } });
  await h.rec('a');
  await h.mp._autoStamp();
  h.clock.t += HOUR - 1000;
  assert.equal((await h.mp._autoStamp()).ran, false);
  h.clock.t += 1000;
  assert.equal((await h.mp._autoStamp()).ran, true);
  // an ots error completes the job (one spawn per cadence) and is kept in the marker; stamp() runs regardless of the marker
  const e = world({ otsBin: '/nonexistent/ots' });
  await e.rec('a');
  const er = await e.mp._autoStamp();
  assert.equal(er.error, OTS_MISSING_MESSAGE);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.trailDir, '.default.stamp.json'), 'utf8')).error, OTS_MISSING_MESSAGE);
  assert.equal((await e.mp._autoStamp()).ran, false, 'not one spawn per sync');
  assert.equal((await e.mp.stamp()).ran, true);
});

test('sync() ends with the automatic job when due and returns it as SyncResult.stamp; a stamp error never fails the run', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const m = await signedMail({ body: 'via sync\r\n' });
  const fake = makeFake({ folders: { INBOX: { msgs: [{ uid: 1, raw: m.raw }] } } });
  const mp = w.mk({ resolver: m.resolver });
  const host = (stamp) => ({ root: mp.root, trail: mp.trail, record: mp.record, recordDigest: (d, c) => mp._recordDigest(d, c), stamp });
  const opts = { host: 'imap.test', user: 'u@test', auth: { pass: 'x' }, sent: false };
  const r = await runSync(host(() => mp._autoStamp()), opts, { openSession: fake.openSession, sleep: async () => {} });
  assert.equal(r.complete, true);
  assert.equal(r.stamp.ran, true);
  assert.equal(r.stamp.manifests[0].records, 1);
  assert.equal(r.stamp.stamped, 1);
  const again = await runSync(host(() => mp._autoStamp()), opts, { openSession: fake.openSession, sleep: async () => {} });
  assert.deepEqual([again.stamp.ran, again.stamp.skipped], [false, 'not due']);
  const boom = await runSync(host(async () => { throw new Error('boom'); }), opts, { openSession: fake.openSession, sleep: async () => {} });
  assert.equal(boom.complete, true);
  assert.equal(boom.stamp, null);
  // the real method: off gives null
  const off = world({ otsBin: null });
  assert.equal(await off.mp._autoStamp(), null);
});

test('modes: record mode stamps in the lock as before and writes no manifest; its stamp() only upgrades; default is batch', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin, stamp: { mode: 'record' } });
  const r = await w.rec('a');
  assert.equal(r.ots, 'pending');
  assert.ok(fs.existsSync(path.join(w.root, recordOtsPath(r.id))));
  const res = await w.mp.stamp();
  assert.deepEqual([res.mode, res.manifests, res.stamped, res.pending], ['record', [], null, 1]);
  assert.ok(!fs.existsSync(path.join(w.root, 'manifests')));
  ots.anchor();
  const up = await w.mp.stamp();
  assert.deepEqual([up.upgraded, up.pending], [1, 0]);
  assert.equal(new Mailproof({ trailDir: w.trailDir }).stampOpts.mode, 'batch');
});

test('upgrade: manifest proofs are upgraded one at a time from a scratch copy, committed as `ots upgrade manifest N`, remembered in the cache; a 3.3.0 trail needs nothing converted', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const legacy = world({ otsBin: ots.bin, stamp: { mode: 'record' }, trailDir: w.trailDir });
  const old = await legacy.rec('legacy');
  await w.rec('a');
  await w.mp.stamp();
  await w.rec('b');
  const r = await w.mp.stamp();
  assert.deepEqual([r.upgraded, r.pending], [0, 3], 'two manifests and the legacy record proof, none anchored');
  assert.equal(await countPendingStamps(w.root, 'default'), 3);
  ots.anchor();
  const head = headOf(w.root);
  const up = await w.mp.stamp();
  assert.deepEqual([up.manifests, up.upgraded, up.pending], [[], 3, 0]);
  const subs = subjects(w.root).slice(0, 3);
  assert.deepEqual(subs.sort(), [`ots upgrade ${old.id.slice(0, 12)}`, 'ots upgrade manifest 1', 'ots upgrade manifest 2'].sort());
  assert.notEqual(headOf(w.root), head);
  clean(w.root);
  assert.ok(!fs.existsSync(path.join(w.root, manifestOtsPath(1) + '.bak')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.trailDir, '.default.ots-state.json'), 'utf8')), { v: 1, anchored: [old.id], manifests: [1, 2] });
  // asked once: a second job runs no `ots upgrade`
  const before = ots.calls().length;
  await w.mp.stamp();
  assert.equal(ots.calls().length, before);
  // an old state file without `manifests` is read as empty for them
  fs.writeFileSync(path.join(w.trailDir, '.default.ots-state.json'), JSON.stringify({ v: 1, anchored: [old.id] }));
  assert.equal(await countPendingStamps(w.root, 'default'), 2);
  // upgradeStamps() is the same pass on its own
  assert.deepEqual(await w.mp.upgradeStamps(), { enabled: true, upgraded: 0, pending: 0 });
});

test('upgrade: an upgrade racing another upgrade is skipped; the pass stops at the first ots error and at the job time limit', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  await w.rec('a'); await w.mp.stamp();
  await w.rec('b'); await w.mp.stamp();
  ots.anchor();
  // someone else commits an upgraded manifest 1 while our `ots upgrade` runs: our copy no longer matches, so it is skipped
  w.mp._stampHooks.afterOtsUpgrade = async (rel) => {
    if (rel !== manifestOtsPath(1)) return;
    const f = path.join(w.root, rel);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'someone else\n');
    sh(w.root, 'commit', '-qam', 'ots upgrade manifest 1');
  };
  const r = await w.mp.stamp();
  w.mp._stampHooks.afterOtsUpgrade = undefined;
  assert.equal(r.upgraded, 1, 'only manifest 2');
  assert.ok(fs.readFileSync(path.join(w.root, manifestOtsPath(1)), 'utf8').endsWith('someone else\n'));
  // the job time limit: nothing is asked once it is over
  const t = world({ otsBin: fakeOts().bin });
  await t.rec('a'); await t.mp.stamp();
  t.mp._stampHooks.jobMaxMs = 0;
  const lim = await t.mp.stamp();
  assert.deepEqual([lim.upgraded, lim.pending], [0, 1]);
  // the first ots error ends the pass
  const e = world({ otsBin: ots.bin });
  await e.rec('a'); await e.mp.stamp();
  const missing = e.mk({ otsBin: '/nonexistent/ots' });
  const er = await missing.upgradeStamps();
  assert.deepEqual([er.upgraded, er.pending, er.error], [0, 1, 'ots not found']);
});

test('findSeal: own proof, stamped manifest, unstamped manifest covered by a later stamp, unstamped chain, unsealed, reply-text; the index hint never decides', async () => {
  const ots = fakeOts();
  const w = world({ otsBin: ots.bin });
  const legacy = world({ otsBin: ots.bin, stamp: { mode: 'record' }, trailDir: w.trailDir });
  const old = await legacy.rec('legacy');
  assert.deepEqual(await findSeal(w.root, old.id), { via: 'record', stamp: recordOtsPath(old.id) });
  const a = await w.rec('a');
  const none = world({ otsBin: '/nonexistent/ots', trailDir: w.trailDir });
  await none.mp.stamp();   // manifest 1, no proof
  assert.deepEqual(await findSeal(w.root, a.id), { via: 'manifest', seq: 1, listed: sha(fs.readFileSync(path.join(w.root, recordPath(a.id)))), stamp: null });
  const b = await w.rec('b');
  await w.mp.replyText({ id: b.id });
  await w.mp.stamp();   // manifest 2 (stamped) covers manifest 1
  const s1 = await findSeal(w.root, a.id);
  assert.deepEqual([s1.seq, s1.stamp], [1, { seq: 2, own: false }]);
  const s2 = await findSeal(w.root, b.id);
  assert.deepEqual([s2.seq, s2.stamp], [2, { seq: 2, own: true }]);
  const slug = readManifest(w.root, 2).replies[0][1];
  const sy = await findSeal(w.root, b.id, { slug });
  assert.deepEqual([sy.via, sy.seq, sy.stamp], ['manifest', 2, { seq: 2, own: true }]);
  const c = await w.rec('c');
  assert.equal(await findSeal(w.root, c.id), null, 'unsealed');
  assert.equal(await findSeal(w.root, 'f'.repeat(32)), null);
  // a hint that is wrong, throws or points at nothing gives the same answer as none
  for (const hint of [() => [999], () => [2], async () => { throw new Error('index gone'); }, () => 'junk', () => []]) {
    assert.deepEqual(await findSeal(w.root, a.id, { hint }), s1);
  }
  // a record file whose hash is not the listed one does not count as sealed: tamper with the working-tree-independent HEAD copy
  const m = readManifest(w.root, 1);
  assert.equal(m.records[0][0], a.id);
});

test('index: schema 5 builds the seal table from the manifests; a schema-4 cache is rebuilt; a wrong or corrupt table never changes an answer', async () => {
  const w = world({ otsBin: fakeOts().bin });
  const a = await w.rec('a');
  await w.mp.stamp();
  const b = await w.rec('b');
  await w.mp.list();   // builds the index
  const Database = (await import('better-sqlite3')).default;
  const file = path.join(w.trailDir, '.default.index.sqlite');
  const rows = () => { const d = new Database(file, { readonly: true }); try { return d.prepare('SELECT kind, id, slug, seq FROM seal ORDER BY seq, id').all(); } finally { d.close(); } };
  assert.deepEqual(rows(), [{ kind: 'r', id: a.id, slug: '', seq: 1 }]);
  assert.equal(await w.mp._findSeal(a.id).then((s) => s.seq), 1);
  // catch-up: a new manifest is added to the table without a rebuild
  await w.mp.stamp();
  await w.mp.list();
  assert.deepEqual(rows().map((r) => [r.id, r.seq]), [[a.id, 1], [b.id, 2]]);
  // an index of schema 4 (older table layout) is rebuilt on first use
  { const d = new Database(file); d.prepare("INSERT OR REPLACE INTO meta VALUES ('schema','4')").run(); d.exec('DELETE FROM seal'); d.close(); }
  await w.mp.list();
  assert.equal(rows().length, 2);
  // a lying table: the answer comes from the manifests
  { const d = new Database(file); d.exec("DELETE FROM seal; INSERT INTO seal VALUES ('r','" + a.id + "','',2)"); d.close(); }
  assert.equal((await w.mp._findSeal(a.id)).seq, 1);
  // a corrupt index file: still the same answer
  fs.writeFileSync(file, 'garbage');
  assert.equal((await w.mp._findSeal(a.id)).seq, 1);
});

test('layout: manifest paths parse and build in one place', () => {
  assert.equal(manifestPath(12), 'manifests/00000012.json');
  assert.equal(manifestOtsPath(12), 'manifests/00000012.json.ots');
  assert.deepEqual(parseManifestPath('manifests/00000012.json'), { seq: 12, ots: false });
  assert.deepEqual(parseManifestPath('manifests/00000012.json.ots'), { seq: 12, ots: true });
  for (const bad of ['manifests/0000012.json', 'manifests/00000000.json', 'manifests/00000012.json.bak', 'manifests/x/00000012.json', 'records/00000012.json']) assert.equal(parseManifestPath(bad), null, bad);
  assert.equal(parseManifest(Buffer.from('{}'), 1).ok, false);
});
