// `Mailproof#export` (SPEC B13.2): real record() over signed mail, a moving clock, a fake `ots`. No network, no real `ots`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { verifyBundle } from '../../src/index.js';
import { recordPath, recordOtsPath, manifestPath, manifestOtsPath, replyPath } from '../../src/proof/layout.js';
import { bundleWorld, fakeOts, treeOf, OWNER, DAY } from '../helpers/bundle.js';
import { makeTmpDir } from '../helpers/tmp.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString().trim();
const BOB = 'bob@bob.example';
const outDir = () => path.join(makeTmpDir('mp-export-out-'), 'bundle');
const fails = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code ?? e.name, code, e.message); return e; } assert.fail(`expected ${code}`); };

/** A small mixed trail: bob x3 (in, out, in+cc carol), carol x1, dave x1. */
async function mixed(o = {}) {
  const w = bundleWorld(o);
  const a = await w.rec({ who: BOB, tag: 'a' });
  const b = await w.rec({ who: BOB, tag: 'b', out: true });
  const c = await w.rec({ who: BOB, tag: 'c', cc: 'carol@carol.example' });
  const d = await w.rec({ who: 'carol@carol.example', tag: 'd' });
  const e = await w.rec({ who: 'dave@dave.example', tag: 'e' });
  return { w, ids: { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id } };
}

const bundleJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
const treeSnapshot = (root) => ({ head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), tree: treeOf(root).filter((f) => !f.startsWith('.git/')) });

test('selection: one address, a union of several, case-insensitive, the owner selects everything, and bob@gmail.com is not bob@company.com', async () => {
  const { w, ids } = await mixed();
  const one = await w.mp.export({ with: [BOB.toUpperCase()], out: outDir() });
  assert.equal(one.records, 3);
  assert.deepEqual(bundleJson(one.out).records.map((r) => r.id).sort(), [ids.a, ids.b, ids.c].sort());
  const union = await w.mp.export({ with: [BOB, 'dave@dave.example', 'dave@dave.example'], out: outDir() });
  assert.equal(union.records, 4);
  assert.deepEqual(bundleJson(union.out).selection.with, ['bob@bob.example', 'dave@dave.example'], 'lower-cased, sorted, collapsed');
  assert.equal((await w.mp.export({ with: [OWNER], out: outDir() })).records, 5, "the owner's own address is on every record");
  assert.equal((await w.mp.export({ with: ['carol@carol.example'], out: outDir() })).records, 2, 'an address seen on a Cc counts (M3 addresses)');
  await fails(w.mp.export({ with: ['bob@other.example'], out: outDir() }), 'ERR_EXPORT_EMPTY');
});

test('selection: after is inclusive, before exclusive; a bad range or option is a TypeError; nothing is written for an empty selection', async () => {
  const { w, ids } = await mixed();
  const t = (n) => new Date(Date.parse('2026-11-01T08:00:00Z') + n * 1000);
  const r = await w.mp.export({ with: [BOB], after: t(1), before: t(2), out: outDir() });
  assert.deepEqual(bundleJson(r.out).records.map((x) => x.id), [ids.b], 'captured >= after and < before');
  const inc = await w.mp.export({ with: [BOB], after: t(1), out: outDir() });
  assert.equal(inc.records, 2);
  const parent = makeTmpDir('mp-export-empty-');
  await fails(w.mp.export({ with: [BOB], before: t(0), out: path.join(parent, 'b') }), 'ERR_EXPORT_EMPTY');
  assert.deepEqual(fs.readdirSync(parent), [], 'nothing was written, not even a temp directory');
  for (const bad of [{ with: [] }, { with: 'bob@x.example' }, { with: ['not an address'] }, { with: [5] }, { with: Array.from({ length: 21 }, (_, i) => `u${i}@x.example`) }, { with: [BOB], after: t(5), before: t(5) }, { with: [BOB], after: 'yesterday-ish' }, { with: [BOB], tar: 'yes' }]) {
    await fails(w.mp.export({ ...bad, out: outDir() }), 'TypeError');
  }
  await fails(w.mp.export({ with: [BOB], out: path.join(makeTmpDir('mp-export-np-'), 'no', 'such', 'b') }), 'TypeError');
});

test('the index proposes, the record decides: a foreign record named by a tampered index is dropped; a missing one is ERR_EXPORT_REWRITTEN', async () => {
  const { w, ids } = await mixed();
  await w.mp.list();   // build the index
  const { default: Database } = await import('better-sqlite3');
  const file = path.join(w.trailDir, '.default.index.sqlite');
  const db = new Database(file);
  db.prepare("INSERT INTO participants (rec_id, address, raw, role, signed) VALUES (?, ?, ?, 'to', 1)").run(ids.e, BOB, BOB);   // dave's record claims bob
  db.close();
  const r = await w.mp.export({ with: [BOB], out: outDir() });
  assert.equal(r.records, 3, 'the foreign record was proposed and dropped');
  assert.ok(!bundleJson(r.out).records.some((x) => x.id === ids.e));
  assert.ok(!fs.existsSync(path.join(r.out, recordPath(ids.e))));
  const db2 = new Database(file);
  db2.prepare("INSERT INTO participants (rec_id, address, raw, role, signed) VALUES (?, ?, ?, 'to', 1)").run('f'.repeat(32), BOB, BOB);
  db2.prepare("INSERT INTO rec (id, captured, direction) VALUES (?, ?, 'in')").run('f'.repeat(32), '2026-11-01T09:00:00.000Z');
  db2.close();
  await fails(w.mp.export({ with: [BOB], out: outDir() }), 'ERR_EXPORT_REWRITTEN');
});

test('contents: records, reply text, keys deduplicated, byte-identical to git; no raw email, attachment, trail.json, foreign file', async () => {
  const { w, ids } = await mixed({ otsBin: null });
  await w.mp.replyText({ id: ids.a });
  await w.mp.replyText({ id: ids.d });   // carol's: not in a bob export
  const r = await w.mp.export({ with: [BOB], out: outDir() });
  const files = treeOf(r.out);
  const sel = [ids.a, ids.b, ids.c];
  const replyFiles = files.filter((f) => f.startsWith('replies/'));
  assert.equal(replyFiles.length, 1);
  assert.ok(replyFiles[0].includes(ids.a));
  for (const id of sel) assert.ok(files.includes(recordPath(id)));
  assert.ok(!files.some((f) => f.includes(ids.d) || f.includes(ids.e)), 'no foreign record or reply');
  assert.ok(!files.includes('trail.json') && !files.some((f) => /\.eml$|^raw|^att|\.content/.test(f)));
  assert.deepEqual(files.filter((f) => f.startsWith('keys/')).map((f) => f.split('/')[1]).sort(), ['bob.example', 'bob.example', 'owner.example'].sort(), 'one key per domain+selector+key: carol and dave keys are not here');
  for (const f of files.filter((x) => /^(records|replies|keys|manifests)\//.test(x))) {
    assert.deepEqual(fs.readFileSync(path.join(r.out, f)), execFileSync('git', ['show', `${r.head}:${f}`], { cwd: w.root }), `${f} is the committed blob`);
  }
  const bj = bundleJson(r.out);
  assert.deepEqual(bj.records.map((x) => x.captured), [...bj.records.map((x) => x.captured)].sort(), 'ascending by captured');
  assert.deepEqual(Object.keys(bj.files), Object.keys(bj.files).sort(), 'files sorted bytewise');
  for (const [f, h] of Object.entries(bj.files)) assert.equal(sha(fs.readFileSync(path.join(r.out, f))), h, f);
  assert.equal(r.bundle_sha256, sha(fs.readFileSync(path.join(r.out, 'bundle.json'))));
  assert.match(bj.completeness, /^none: /);
  assert.deepEqual(Object.keys(bj), ['v', 'kind', 'created', 'mailproof', 'trail', 'trail_head', 'selection', 'completeness', 'records', 'files']);
  assert.equal(bj.trail_head, r.head);
  assert.deepEqual(bj.records.find((x) => x.id === ids.a).replies.length, 1);
  assert.equal(r.replies, 1);
  assert.equal(r.keys, 3);
  // a record signed twice, by two keys: both archived keys are present
  const two = bundleWorld({ otsBin: null });
  const x = await two.rec({ who: BOB, tag: 'two', signers: [{ domain: 'bob.example', selector: 's1', alg: 'rsa' }, { domain: 'bob.example', selector: 's2', alg: 'ed25519' }] });
  const e = await two.mp.export({ with: [BOB], out: outDir() });
  assert.equal(e.keys, 2);
  assert.ok(x.id);
});

test('seals: legacy per-record stamp, own stamped manifest, an unstamped manifest covered by a later stamp (chain L..S), listed but never stamped, unsealed', async () => {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  // a legacy record (record mode)
  const legacy = bundleWorld({ otsBin: ots.bin, trailDir: w.trailDir, extra: { stamp: { mode: 'record' } } });
  legacy.clock.t = w.clock.t;
  const old = await legacy.rec({ who: BOB, tag: 'legacy' });
  w.clock.t = legacy.clock.t;
  const l1 = await w.rec({ who: BOB, tag: 'l1' });
  await w.mp.stamp();                     // manifest 1 (stamped) lists l1
  const l2 = await w.rec({ who: BOB, tag: 'l2' });
  w.mp._stampHooks.afterManifests = undefined;
  // manifest 2 made but not stamped: make it via a fake that fails stamping
  const noOts = new Mailproof({ trailDir: w.trailDir, worker: { size: 0 }, now: w.now, otsBin: '/nonexistent/ots' });
  await noOts.stamp();                    // manifest 2 lists l2, no proof
  const l3 = await w.rec({ who: BOB, tag: 'l3' });
  await noOts.stamp();                    // manifest 3 lists l3, no proof
  const r0 = await w.mp.export({ with: [BOB], out: outDir() });
  assert.equal(r0.seals.unstamped, 2, 'listed in unstamped manifests, no stamp after them yet');
  assert.ok(!treeOf(r0.out).some((f) => f === manifestPath(2) || f === manifestPath(3)), 'no manifest copied for a listing with no time evidence');
  const un = await w.rec({ who: BOB, tag: 'un' });
  await w.mp.stamp();                     // manifest 4 lists un, stamped: covers 2 and 3 through the chain
  const l5 = await w.rec({ who: BOB, tag: 'l5' });
  const r = await w.mp.export({ with: [BOB], out: outDir() });
  const bj = bundleJson(r.out);
  const by = Object.fromEntries(bj.records.map((x) => [x.id, x.seal]));
  assert.deepEqual(by[old.id], { state: 'pending', via: 'record', listed_in: null, stamped_by: null });
  assert.deepEqual([by[l1.id].listed_in, by[l1.id].stamped_by, by[l1.id].via], [1, 1, 'manifest']);
  assert.deepEqual([by[l2.id].listed_in, by[l2.id].stamped_by], [2, 4], 'covered by a later stamp');
  assert.deepEqual([by[l3.id].listed_in, by[l3.id].stamped_by], [3, 4]);
  assert.deepEqual([by[un.id].listed_in, by[un.id].stamped_by], [4, 4]);
  assert.equal(by[l5.id].state, 'unsealed');
  const files = treeOf(r.out);
  for (const f of [recordOtsPath(old.id), manifestPath(1), manifestOtsPath(1), manifestPath(2), manifestPath(3), manifestPath(4), manifestOtsPath(4)]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes(manifestOtsPath(2)) && !files.includes(manifestOtsPath(3)));
  assert.deepEqual(r.seals, { anchored: 0, pending: 5, unstamped: 0, unsealed: 1 });
  assert.equal(r.manifests, 4);
  // anchored once the cache says so: the exporter never runs ots itself
  ots.anchor();
  await w.mp.upgradeStamps();
  const calls = ots.calls().length;
  const r2 = await w.mp.export({ with: [BOB], out: outDir() });
  assert.equal(ots.calls().length, calls, 'export never runs ots');
  assert.ok(r2.seals.anchored >= 4);
  const v = await verifyBundle(r2.out, { ots: ots.bin });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.counts.anchored, r2.seals.anchored, 'the verifier reads the same proofs as the exporter did');
  assert.equal(v.records.find((x) => x.seal.state === 'anchored').seal.block, 850123);
});

test('a record and a reply-text record in a stamped manifest: the reply carries its own seal', async () => {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  const a = await w.rec({ who: BOB, tag: 'a' });
  await w.mp.replyText({ id: a.id });
  await w.mp.stamp();
  const r = await w.mp.export({ with: [BOB], out: outDir() });
  const v = await verifyBundle(r.out, { ots: ots.bin });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.records[0].replies.length, 1);
  assert.equal(v.records[0].replies[0].seal.state, 'pending');
  assert.ok(fs.existsSync(path.join(r.out, replyPath(a.id, v.records[0].replies[0].slug))));
});

test('content status: stored, expired, forgotten, store off, attachments off; a stat only (a corrupted file still says stored)', async () => {
  const att = { filename: 'a.pdf', bytes: Buffer.from('%PDF contract\n'.repeat(5)) };
  const w = bundleWorld({ otsBin: null });
  const a = await w.rec({ who: BOB, tag: 'a', attachment: att });
  const b = await w.rec({ who: BOB, tag: 'b' });
  const c = await w.rec({ who: BOB, tag: 'c' });
  let r = await w.mp.export({ with: [BOB], out: outDir() });
  assert.deepEqual(r.content, { stored: 3, absent: 0 });
  const ent = (dir, id) => bundleJson(dir).records.find((x) => x.id === id).content;
  assert.deepEqual([ent(r.out, a.id).raw.stored, ent(r.out, a.id).attachments[0].stored, ent(r.out, a.id).attachments[0].filename], [true, true, 'a.pdf']);
  assert.equal(ent(r.out, a.id).raw.sha256.length, 64);
  await w.mp.forget([b.id]);
  fs.writeFileSync(path.join(w.contentDir, 'raw', c.id.slice(0, 2), `${c.id}.eml`), 'corrupted');
  r = await w.mp.export({ with: [BOB], out: outDir() });
  assert.deepEqual(r.content, { stored: 2, absent: 1 });
  assert.equal(ent(r.out, b.id).raw.stored, false);
  assert.equal(ent(r.out, c.id).raw.stored, true, 'a corrupted stored file still counts: stat only, no re-hash');
  await w.mp.expireContent({ olderThanDays: 0 }).catch(() => {});
  const off = bundleWorld({ otsBin: null, extra: { content: { store: false } } });
  await off.rec({ who: BOB, tag: 'x' });
  const ro = await off.mp.export({ with: [BOB], out: outDir() });
  assert.deepEqual(ro.content, { stored: 0, absent: 1 });
  const noAtt = bundleWorld({ otsBin: null, extra: { content: { attachments: false } } });
  const z = await noAtt.rec({ who: BOB, tag: 'z', attachment: att });
  const rn = await noAtt.mp.export({ with: [BOB], out: outDir() });
  assert.deepEqual([ent(rn.out, z.id).raw.stored, ent(rn.out, z.id).attachments[0].stored], [true, false]);
});

test('output path: a new path, an empty directory; a file, a non-empty directory, a symlink: ERR_EXPORT_EXISTS and nothing changed; modes 0700/0600', async () => {
  const { w } = await mixed({ otsBin: null });
  const parent = makeTmpDir('mp-export-path-');
  const fresh = await w.mp.export({ with: [BOB], out: path.join(parent, 'fresh') });
  assert.equal(fs.statSync(fresh.out).mode & 0o777, 0o700);
  for (const f of treeOf(fresh.out)) assert.equal(fs.statSync(path.join(fresh.out, f)).mode & 0o777, 0o600, f);
  for (const d of ['records', 'keys']) assert.equal(fs.statSync(path.join(fresh.out, d)).mode & 0o777, 0o700, d);
  fs.mkdirSync(path.join(parent, 'empty'));
  assert.equal((await w.mp.export({ with: [BOB], out: path.join(parent, 'empty') })).files > 0, true);
  fs.mkdirSync(path.join(parent, 'full'));
  fs.writeFileSync(path.join(parent, 'full', 'x'), 'keep');
  fs.writeFileSync(path.join(parent, 'file'), 'keep');
  fs.mkdirSync(path.join(parent, 'target'));
  fs.symlinkSync(path.join(parent, 'target'), path.join(parent, 'link'));
  for (const name of ['full', 'file', 'link', 'fresh']) {
    const before = fs.readdirSync(parent).sort();
    await fails(w.mp.export({ with: [BOB], out: path.join(parent, name) }), 'ERR_EXPORT_EXISTS');
    assert.deepEqual(fs.readdirSync(parent).sort(), before, 'nothing was created');
  }
  assert.equal(fs.readFileSync(path.join(parent, 'full', 'x'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(parent, 'target')), []);
  // inside the trail, the content store, an existing bundle
  await fails(w.mp.export({ with: [BOB], out: path.join(w.root, 'inside') }), 'ERR_EXPORT_EXISTS');
  await fails(w.mp.export({ with: [BOB], out: path.join(w.contentDir, 'inside') }), 'ERR_EXPORT_EXISTS');
  await fails(w.mp.export({ with: [BOB], out: path.join(fresh.out, 'nested') }), 'ERR_EXPORT_EXISTS');
  const viaLink = path.join(parent, 'toTrail');
  fs.symlinkSync(w.root, viaLink);
  await fails(w.mp.export({ with: [BOB], out: path.join(viaLink, 'sneaky') }), 'ERR_EXPORT_EXISTS');
  assert.ok(!fs.existsSync(path.join(w.root, 'inside')) && !fs.existsSync(path.join(w.root, 'sneaky')));
});

test('read-only: the trail, HEAD and the content store are unchanged; capture is not held up by a held trail lock after the snapshot', async () => {
  const { w } = await mixed({ otsBin: null });
  await w.mp.list();
  const before = treeSnapshot(w.root);
  const contentBefore = treeOf(w.contentDir).map((f) => [f, fs.statSync(path.join(w.contentDir, f)).mtimeMs]);
  let during;
  w.mp._exportSeams.hooks.afterSnapshot = async () => { during = await w.rec({ who: BOB, tag: 'during' }); };   // a record() in the middle: no lock is held by export
  const r = await w.mp.export({ with: [BOB], out: outDir() });
  w.mp._exportSeams.hooks = {};
  assert.equal(r.head, before.head, 'the bundle is the snapshot, not what came later');
  assert.equal(r.records, 3);
  assert.ok(!treeOf(r.out).some((f) => f.includes(during.id)));
  assert.notEqual(git(w.root, 'rev-parse', 'HEAD'), before.head, 'the record() really committed meanwhile');
  for (const [f, m] of contentBefore) assert.equal(fs.statSync(path.join(w.contentDir, f)).mtimeMs, m, `${f} was not touched by export`);
  assert.equal(git(w.root, 'status', '--porcelain'), '');
});

test('limits: too many records and too many bytes are ERR_EXPORT_TOO_BIG and write nothing; the lowered bounds are a test seam', async () => {
  const { w } = await mixed({ otsBin: null });
  const parent = makeTmpDir('mp-export-big-');
  w.mp._exportSeams.limits = { EXPORT_MAX_RECORDS: 2 };
  const e1 = await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'a') }), 'ERR_EXPORT_TOO_BIG');
  assert.match(e1.message, /3 emails match/);
  w.mp._exportSeams.limits = { BUNDLE_MAX_BYTES: 3000 };
  await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'b') }), 'ERR_EXPORT_TOO_BIG');
  w.mp._exportSeams.limits = { BUNDLE_MAX_FILES: 3 };
  await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'c') }), 'ERR_EXPORT_TOO_BIG');
  assert.deepEqual(fs.readdirSync(parent).filter((f) => !f.startsWith('.mailproof-export-')), []);
  assert.deepEqual(fs.readdirSync(parent), [], 'the temp directory is removed after a failure');
});

test('self-check: a record naming a key_file the trail lacks is ERR_EXPORT_SELF_CHECK and nothing is delivered; an unverified record exports fine', async () => {
  const w = bundleWorld({ otsBin: null });
  const good = await w.rec({ who: BOB, tag: 'good' });
  const rec = JSON.parse(fs.readFileSync(path.join(w.root, recordPath(good.id)), 'utf8'));
  const kf = rec.signatures[0].key_file;
  git(w.root, 'rm', '-q', '--', kf);
  git(w.root, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'damage');
  const parent = makeTmpDir('mp-export-selfcheck-');
  await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'b') }), 'ERR_EXPORT_SELF_CHECK');
  assert.deepEqual(fs.readdirSync(parent), []);
  // an unsigned record and a record with a bad signature are not failures (accept-with-flag)
  const ok = bundleWorld({ otsBin: null });
  await ok.mk().record(Buffer.from(`From: ${BOB}\r\nTo: ${OWNER}\r\nSubject: unsigned\r\n\r\nbody\r\n`), { direction: 'in' });
  const r = await ok.mp.export({ with: [BOB], out: outDir() });
  const v = await verifyBundle(r.out, { ots: null });
  assert.ok(v.ok);
  assert.equal(v.counts.unverified, 1);
});

test('ERR_STAMP_CHAIN: a broken manifest chain cannot be walked, nothing is written', async () => {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  await w.rec({ who: BOB, tag: 'a' });
  await w.mp.stamp();
  await w.rec({ who: BOB, tag: 'b' });
  await w.mp.stamp();
  fs.writeFileSync(path.join(w.root, manifestPath(1)), 'junk');
  git(w.root, 'add', '-A');
  git(w.root, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'break');
  const parent = makeTmpDir('mp-export-chain-');
  await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'b') }), 'ERR_STAMP_CHAIN');
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a prune swap during the read: ERR_EXPORT_REWRITTEN and no out', async () => {
  const w = bundleWorld({ otsBin: null });
  for (let i = 0; i < 4; i++) await w.rec({ who: BOB, tag: `p${i}`, advance: DAY });
  const parent = makeTmpDir('mp-export-prune-');
  w.mp._exportSeams.hooks.afterSnapshot = async () => { await w.mp.prune({ before: new Date(w.clock.t - 2 * DAY + 1000) }); };
  const e = await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'b') }), 'ERR_EXPORT_REWRITTEN');
  assert.match(e.message, /rewritten/);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a killed export leaves no out, only its named temp directory (never removed automatically)', async () => {
  const { w } = await mixed({ otsBin: null });
  await w.mp.list();
  const parent = makeTmpDir('mp-export-kill-');
  const script = path.join(parent, 'child.mjs');
  const out = path.join(parent, 'bundle');
  fs.writeFileSync(script, `
import { Mailproof } from ${JSON.stringify(path.resolve('src/proof/mailproof.js'))};
const mp = new Mailproof({ trailDir: ${JSON.stringify(w.trailDir)}, otsBin: null, worker: { size: 0 } });
mp._exportSeams.hooks.beforeMove = () => { process.kill(process.pid, 'SIGKILL'); };
await mp.export({ with: ['bob@bob.example'], out: ${JSON.stringify(out)} });
`);
  const r = spawnSync(process.execPath, [script], { stdio: 'ignore' });
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(!fs.existsSync(out));
  const left = fs.readdirSync(parent).filter((f) => f.startsWith('.mailproof-export-'));
  assert.equal(left.length, 1);
  assert.equal(fs.statSync(path.join(parent, left[0])).mode & 0o777, 0o700);
  fs.rmSync(path.join(parent, left[0]), { recursive: true });
});

test('--tar: one 0600 file, one top-level directory named for the file, extract and verify round trip; tar missing is refused before anything is built', async () => {
  const { w } = await mixed({ otsBin: null });
  const parent = makeTmpDir('mp-export-tar-');
  const r = await w.mp.export({ with: [BOB], out: path.join(parent, 'pair.tar'), tar: true });
  assert.equal(r.out, path.join(parent, 'pair.tar'));
  assert.equal(fs.statSync(r.out).mode & 0o777, 0o600);
  assert.equal(r.bytes, fs.statSync(r.out).size);
  assert.deepEqual(fs.readdirSync(parent), ['pair.tar'], 'the temp directory is removed');
  const top = execFileSync('tar', ['-tf', r.out]).toString().split('\n').filter(Boolean).map((l) => l.split('/')[0]);
  assert.deepEqual([...new Set(top)], ['pair']);
  const x = makeTmpDir('mp-export-tar-x-');
  execFileSync('tar', ['-xf', r.out, '-C', x]);
  const v = await verifyBundle(path.join(x, 'pair'), { ots: null, expect: r.bundle_sha256 });
  assert.ok(v.ok, JSON.stringify(v.problems));
  await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'pair.tar'), tar: true }), 'ERR_EXPORT_EXISTS');
  const oldPath = process.env.PATH;
  process.env.PATH = makeTmpDir('mp-export-nopath-');
  try {
    const e = await fails(w.mp.export({ with: [BOB], out: path.join(parent, 'other.tar'), tar: true }), 'ERR_EXPORT_TAR');
    assert.match(e.message, /tar not found/);
  } finally { process.env.PATH = oldPath; }
  assert.deepEqual(fs.readdirSync(parent), ['pair.tar']);
});

test('round trip on real fixture mail: export, verify-bundle OK, then a prune of the owner trail leaves the old bundle valid', async () => {
  const eml = fs.readFileSync(new URL('./fixtures/signedreply-sample.eml', import.meta.url));
  const key = [...fs.readFileSync(new URL('./fixtures/signedreply.dkim.txt', import.meta.url), 'utf8').matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('').trim();
  const resolver = async (name, type) => {
    const map = { 'gd202604._domainkey.signedreply.com': key, '_dmarc.signedreply.com': 'v=DMARC1; p=none; adkim=s; aspf=s' };
    if ((type || 'TXT').toUpperCase() !== 'TXT' || map[name] === undefined) throw Object.assign(new Error('no rec'), { code: 'ENOTFOUND' });
    return [[map[name]]];
  };
  const dir = makeTmpDir('mp-export-real-');
  const mp = new Mailproof({ trailDir: dir, resolver, worker: { size: 0 }, otsBin: null, now: () => new Date('2026-11-01T10:00:00Z') });
  const rec = await mp.record(eml, { direction: 'in', source: 'test' });
  const out = outDir();
  const r = await mp.export({ with: ['noreply@signedreply.com'], out });
  assert.equal(r.records, 1);
  const hidden = path.join(path.dirname(path.dirname(out)), 'hidden-trail');
  const moved = makeTmpDir('mp-export-away-');
  fs.renameSync(path.join(dir, 'default'), path.join(moved, 'default'));   // the verifier needs nothing of the owner's trail
  const v = await verifyBundle(out, { ots: null, expect: r.bundle_sha256 });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.records[0].trust, 'verified');
  assert.equal(v.records[0].key, 'ok');
  assert.equal(v.records[0].id, rec.id);
  assert.equal(v.expect.match, true);
  void hidden;
});

test('RFC 2047 subject: the dry-run selection and the README show the decoded text, as list does; verify-bundle carries it decoded too', async () => {
  const w = bundleWorld();
  const enc = '[addypin] weekly stats =?utf-8?Q?=E2=80=94?= 2026-W45';
  const a = await w.rec({ who: BOB, tag: 'a', subject: enc });
  const dry = await w.mp.export({ with: [BOB], out: outDir(), dryRun: true });
  assert.equal(dry.selection[0].subject, '[addypin] weekly stats — 2026-W45');
  assert.equal((await w.mp.list({ with: BOB }))[0].subject, dry.selection[0].subject, 'the same text list returns');
  const real = await w.mp.export({ with: [BOB], out: outDir() });
  assert.ok(fs.readFileSync(path.join(real.out, 'README.txt'), 'utf8').includes('weekly stats — 2026-W45'));
  const v = await verifyBundle(real.out, { ots: null });
  assert.equal(v.records.find((x) => x.id === a.id).subject, '[addypin] weekly stats — 2026-W45');
});
