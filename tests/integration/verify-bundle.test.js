// `verifyBundle` (SPEC B13.3): bundles made by the real `export` over real trails, then damaged by the test. A fake `ots` scripts the
// `info` output; every argv is logged so the tests can prove `upgrade` and `verify` are never run. The verifier is run with the owner's
// trail renamed away: it needs nothing of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyBundle } from '../../src/index.js';
import { parseOtsInfo } from '../../src/proof/ots.js';
import { recordPath, manifestPath, manifestOtsPath, recordOtsPath } from '../../src/proof/layout.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { bundleWorld, fakeOts, treeOf, MERKLE } from '../helpers/bundle.js';
import { makeTmpDir } from '../helpers/tmp.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BOB = 'bob@bob.example';
const rd = (d, f) => fs.readFileSync(path.join(d, f));
const wr = (d, f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
const json = (d, f) => JSON.parse(rd(d, f).toString('utf8'));

/** Rewrite bundle.json after the test changed files: `files` re-hashed (the forger's step); `edit` may change the document first. */
function regen(d, edit = (j) => j) {
  const j = json(d, 'bundle.json');
  const files = {};
  for (const f of treeOf(d)) if (f !== 'bundle.json') files[f] = sha(rd(d, f));
  j.files = files;
  fs.writeFileSync(path.join(d, 'bundle.json'), `${JSON.stringify(edit(j), null, 2)}\n`);
}
const copy = (src) => { const d = path.join(makeTmpDir('mp-vb-copy-'), 'b'); fs.cpSync(src, d, { recursive: true }); return d; };

/** One shared mixed world: signed, unsigned, legacy stamp, a stamped manifest, an unstamped manifest covered by a later stamp, unstamped, unsealed, reply-text. */
let cached;
async function mixed() {
  if (cached) return cached;
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  const legacy = bundleWorld({ otsBin: ots.bin, trailDir: w.trailDir, extra: { stamp: { mode: 'record' } } });
  const old = await legacy.rec({ who: BOB, tag: 'legacy' });
  w.clock.t = legacy.clock.t;
  const a = await w.rec({ who: BOB, tag: 'a' });
  await w.mp.replyText({ id: a.id });
  await w.mp.stamp();                                      // manifest 1 stamped: a (+ its reply text)
  const unsigned = await w.mk().record(Buffer.from(`From: ${BOB}\r\nTo: owner@owner.example\r\nSubject: unsigned one\r\n\r\nplain\r\n`), { direction: 'in' });
  const noOts = new Mailproof({ trailDir: w.trailDir, worker: { size: 0 }, now: w.now, otsBin: '/nonexistent/ots' });
  await noOts.stamp();                                     // manifest 2, no proof: covered by 3
  const c = await w.rec({ who: BOB, tag: 'c', out: true });
  await w.mp.stamp();                                      // manifest 3 stamped
  const d = await w.rec({ who: BOB, tag: 'd' });
  await noOts.stamp();                                     // manifest 4, no proof, nothing after: unstamped
  const e = await w.rec({ who: BOB, tag: 'e', cc: 'carol@carol.example' });   // unsealed
  const out = path.join(makeTmpDir('mp-vb-base-'), 'bundle');
  const r = await w.mp.export({ with: [BOB], out });
  cached = { ots, w, out, r, ids: { old: old.id, a: a.id, unsigned: unsigned.id, c: c.id, d: d.id, e: e.id } };
  return cached;
}
const calls = (ots) => ots.calls();

test('pass: a mixed bundle verifies with the owner trail gone; counts, shapes, nothing written, two runs identical, nothing but info is run', async () => {
  const m = await mixed();
  const away = makeTmpDir('mp-vb-away-');
  fs.renameSync(m.w.root, path.join(away, 'trail'));
  try {
    const before = treeOf(m.out).map((f) => [f, fs.statSync(path.join(m.out, f)).mtimeMs]);
    const n0 = calls(m.ots).length;
    const v1 = await verifyBundle(m.out, { ots: m.ots.bin, expect: m.r.bundle_sha256 });
    const v2 = await verifyBundle(m.out, { ots: m.ots.bin, expect: m.r.bundle_sha256 });
    assert.ok(v1.ok, JSON.stringify(v1.problems));
    assert.deepEqual(v1, v2, 'byte-identical report');
    assert.deepEqual(v1.failed, []);
    assert.equal(v1.counts.records, 6);
    assert.equal(v1.counts.unverified, 1, 'the unsigned record is reported, not a failure');
    // the exporter's `unstamped` record (listed in a manifest with no stamp) has no manifest in the bundle, so the verifier can only
    // say `unsealed` for it: the bundle entry says `unstamped` at export, the verifier recomputes (SPEC B13.2.4)
    assert.equal(v1.counts.unstamped, 0);
    assert.equal(v1.counts.unsealed, 2);
    assert.equal(m.r.seals.unstamped, 1);
    assert.equal(v1.counts.pending, 4);
    assert.equal(v1.ots, 'used');
    assert.equal(v1.expect.match, true);
    assert.equal(v1.bundle.bundle_sha256, m.r.bundle_sha256);
    assert.deepEqual(v1.chain.runs, [{ from: 1, to: 3 }]);
    assert.equal(v1.records.find((r) => r.id === m.ids.a).replies.length, 1);
    assert.equal(v1.records.find((r) => r.id === m.ids.old).seal.via, 'record');
    assert.deepEqual(treeOf(m.out).map((f) => [f, fs.statSync(path.join(m.out, f)).mtimeMs]), before, 'nothing written, no mtime changed');
    const verbs = new Set(calls(m.ots).slice(n0).map((c) => c.split(' ')[0]));
    assert.deepEqual([...verbs], ['info'], 'only `ots info`: never upgrade or verify');
    // anchored once the proofs say so
    m.ots.anchor();
    const anch = path.join(makeTmpDir('mp-vb-anch-'), 'b');
    fs.cpSync(m.out, anch, { recursive: true });
    for (const f of ['manifests/00000001.json.ots', 'manifests/00000003.json.ots', `records/${m.ids.old.slice(0, 2)}/${m.ids.old}.json.ots`]) {
      if (fs.existsSync(path.join(anch, f))) fs.writeFileSync(path.join(anch, f), `${rd(anch, f).toString('utf8').split('\n')[0]}\nanchored\n`);
    }
    regen(anch);
    const va = await verifyBundle(anch, { ots: m.ots.bin });
    assert.ok(va.ok, JSON.stringify(va.problems));
    assert.equal(va.counts.anchored, 4, 'the legacy proof, a (manifest 1), and two records through manifest 3');
    assert.equal(va.records.find((r) => r.id === m.ids.a).seal.block, 850123);
    assert.equal(va.records.find((r) => r.id === m.ids.a).seal.merkle_root, MERKLE);
    const strict = await verifyBundle(anch, { ots: m.ots.bin, strict: true });
    assert.deepEqual(strict.failed, ['strict:verified', 'strict:anchored']);
  } finally { fs.renameSync(path.join(away, 'trail'), m.w.root); }
});

test('each check, one failure at a time: files', async () => {
  const m = await mixed();
  const bad = async (edit, name = 'files') => {
    const d = copy(m.out);
    edit(d);
    const v = await verifyBundle(d, { ots: null });
    assert.ok(!v.ok);
    assert.ok(v.failed.includes(name), `${name} in ${JSON.stringify(v.failed)}: ${JSON.stringify(v.problems.slice(0, 3))}`);
    return v;
  };
  const rec = recordPath(m.ids.a);
  await bad((d) => { const b = rd(d, rec); b[b.length - 3] ^= 1; wr(d, rec, b); });                          // a flipped byte: hash differs
  await bad((d) => fs.rmSync(path.join(d, rec)));                                                              // a missing file
  await bad((d) => wr(d, 'records/ab/extra.json', '{}'));                                                      // an extra, unexpected file
  await bad((d) => wr(d, `keys/bob.example/sel1/${'0'.repeat(16)}.json`, '{}'));                                // an extra, well-named but unlisted file
  const v = await bad((d) => wr(d, 'README.txt', 'edited'));                                                    // the README is hashed but never trusted
  assert.ok(v.problems.some((p) => /README/.test(p.why) || /sha256 differs/.test(p.why)));
});

test('each check, one failure at a time: bundle.json', async () => {
  const m = await mixed();
  const go = async (edit) => { const d = copy(m.out); edit(d); return verifyBundle(d, { ots: null }); };
  let v = await go((d) => fs.rmSync(path.join(d, 'bundle.json')));
  assert.deepEqual(v.failed.slice(0, 1), ['bundle.json']);
  assert.equal(v.bundle, null);
  v = await go((d) => wr(d, 'bundle.json', 'junk'));
  assert.ok(v.failed.includes('bundle.json'));
  v = await go((d) => regen(d, (j) => ({ ...j, v: 2 })));
  assert.ok(v.problems.some((p) => /unsupported bundle version 2: upgrade mailproof/.test(p.why)));
  v = await go((d) => regen(d, (j) => ({ ...j, kind: 'other' })));
  assert.ok(v.failed.includes('bundle.json'));
  v = await go((d) => regen(d, (j) => ({ ...j, records: [...j.records, j.records[0]] })));
  assert.ok(v.failed.includes('bundle.json'), 'a duplicate id');
  v = await go((d) => regen(d, (j) => { j.records[0].id = 'ABCDEF'.repeat(5) + 'ab'; return j; }));
  assert.ok(v.failed.includes('bundle.json'), 'an id that is not 32 lowercase hex');
  assert.ok(v.problems.length >= 1 && v.records.length === 0, 'later checks that need it are skipped');
});

test('each check, one failure at a time: expect, records, selection', async () => {
  const m = await mixed();
  const good = await verifyBundle(m.out, { ots: null, expect: 'A'.repeat(64) });
  assert.deepEqual(good.failed, ['expect']);
  assert.equal(good.expect.match, false);
  assert.equal((await verifyBundle(m.out, { ots: null, expect: m.r.bundle_sha256.toUpperCase() })).ok, true, 'case-insensitive');
  await assert.rejects(verifyBundle(m.out, { expect: 'nothex' }), /expect/);
  // a record's header line edited, then re-hashed in bundle.json: the signature fails
  const d1 = copy(m.out);
  const rf = recordPath(m.ids.a);
  const rec = json(d1, rf);
  rec.signatures[0].signed_headers[0] = Buffer.from('Subject: forged\r\n').toString('base64');
  wr(d1, rf, `${JSON.stringify(rec, null, 2)}\n`);
  regen(d1);
  let v = await verifyBundle(d1, { ots: null });
  assert.ok(v.failed.includes('records'));
  assert.ok(v.problems.some((p) => /says portable verified but its signatures do not verify/.test(p.why)), JSON.stringify(v.problems));
  // `portable` edited in bundle.json
  const d2 = copy(m.out);
  regen(d2, (j) => { j.records.find((r) => r.id === m.ids.a).portable = 'unverified'; return j; });
  assert.ok((await verifyBundle(d2, { ots: null })).failed.includes('records'));
  // recorded unverified but recomputes verified: a note, not a failure
  const d3 = copy(m.out);   // (an unsealed record: editing a sealed one would break its seal, which is the point of a seal)
  const r3 = json(d3, recordPath(m.ids.e));
  r3.verdicts.portable.trust = 'unverified';
  wr(d3, recordPath(m.ids.e), `${JSON.stringify(r3, null, 2)}\n`);
  regen(d3, (j) => { j.records.find((r) => r.id === m.ids.e).portable = 'unverified'; return j; });
  v = await verifyBundle(d3, { ots: null });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.ok(v.records.find((r) => r.id === m.ids.e).notes.some((n) => /verdict improved/.test(n)));
  // id / file name mismatch, captured edited
  const d4 = copy(m.out);
  const r4 = json(d4, rf);
  r4.captured = '2030-01-01T00:00:00.000Z';
  wr(d4, rf, `${JSON.stringify(r4, null, 2)}\n`);
  regen(d4);
  v = await verifyBundle(d4, { ots: null });
  assert.ok(v.failed.includes('records') && v.problems.some((p) => /captured differs/.test(p.why)));
  const d5 = copy(m.out);
  const r5 = json(d5, rf);
  r5.id = '0'.repeat(32);
  wr(d5, rf, `${JSON.stringify(r5, null, 2)}\n`);
  regen(d5);
  assert.ok((await verifyBundle(d5, { ots: null })).problems.some((p) => /not its file name/.test(p.why)));
  // a record outside the selection
  const d6 = copy(m.out);
  regen(d6, (j) => { j.selection.with = ['someone@else.example']; return j; });
  v = await verifyBundle(d6, { ots: null });
  assert.ok(v.failed.includes('selection'));
  const d7 = copy(m.out);
  regen(d7, (j) => { j.selection.after = '2030-01-01T00:00:00Z'; return j; });
  assert.ok((await verifyBundle(d7, { ots: null })).failed.includes('selection'), 'captured outside the selected range');
});

test('each check, one failure at a time: keys and replies', async () => {
  const m = await mixed();
  const rec = json(m.out, recordPath(m.ids.a));
  const kf = rec.signatures[0].key_file;
  const run = async (edit) => { const d = copy(m.out); edit(d); regen(d); return verifyBundle(d, { ots: null }); };
  let v = await run((d) => { const k = json(d, kf); k.p = 'AAAA'; wr(d, kf, `${JSON.stringify(k)}\n`); });          // a swapped key
  assert.ok(v.failed.includes('keys'));
  assert.equal(v.records.find((r) => r.id === m.ids.a).key, 'mismatch');
  v = await run((d) => { fs.renameSync(path.join(d, kf), path.join(d, kf.replace(/[0-9a-f]{16}\.json$/, `${'1'.repeat(16)}.json`))); });   // wrong h16 path
  assert.ok(v.failed.includes('keys'));
  v = await run((d) => fs.rmSync(path.join(d, kf)));                                                                 // a missing key
  assert.ok(v.failed.includes('keys'));
  assert.equal(v.records.find((r) => r.id === m.ids.a).key, 'missing');
  // replies
  const rp = treeOf(m.out).find((f) => f.startsWith('replies/'));
  v = await run((d) => { const j = json(d, rp); j.record_id = 'f'.repeat(32); wr(d, rp, `${JSON.stringify(j)}\n`); });
  assert.ok(v.failed.includes('replies'));
  v = await run((d) => fs.rmSync(path.join(d, rp)));
  assert.ok(v.failed.includes('replies'), 'the entry lists a reply the bundle does not hold');
  v = await run((d) => wr(d, rp, 'junk'));
  assert.ok(v.failed.includes('replies'));
});

test('each check, one failure at a time: chain and seals', async () => {
  const m = await mixed();
  const run = async (edit, o = {}) => { const d = copy(m.out); edit(d); regen(d); return verifyBundle(d, { ots: m.ots.bin, ...o }); };
  // a manifest with a changed entry: the link to the next one fails
  let v = await run((d) => { const x = rd(d, manifestPath(2)).toString('utf8').replace(/"[0-9a-f]{64}"\]/, `"${'0'.repeat(64)}"]`); wr(d, manifestPath(2), x); });
  assert.ok(v.failed.includes('chain'), JSON.stringify(v.failed));
  // a deleted manifest whose proof remains
  v = await run((d) => fs.rmSync(path.join(d, manifestPath(3))));
  assert.ok(v.failed.includes('chain'));
  // a manifest whose seq is not its file name
  v = await run((d) => { const x = rd(d, manifestPath(1)).toString('utf8').replace('"seq": 1', '"seq": 7'); wr(d, manifestPath(1), x); });
  assert.ok(v.failed.includes('chain'));
  // an unreferenced manifest
  v = await run((d) => { wr(d, manifestPath(9), rd(d, manifestPath(1)).toString('utf8').replace('"seq": 1', '"seq": 9')); });
  assert.ok(v.failed.includes('chain'));
  // a record whose listed hash differs from its file
  v = await run((d) => { const x = rd(d, manifestPath(1)).toString('utf8'); wr(d, manifestPath(1), x.replace(/\["([0-9a-f]{32})", "[0-9a-f]{64}"\]/, '["$1", "' + '0'.repeat(64) + '"]')); });
  assert.ok(v.failed.length > 0);
  // a proof for other bytes
  v = await run((d) => wr(d, manifestOtsPath(3), `${'0'.repeat(64)}\npending\n`));
  assert.ok(v.failed.includes('seals'));
  assert.ok(v.records.some((r) => r.seal.state === 'bad' && /other bytes/.test(r.seal.why)));
  // an unparseable proof
  v = await run((d) => wr(d, manifestOtsPath(3), 'garbage'));
  assert.ok(v.records.some((r) => r.seal.state === 'bad' && /does not parse/.test(r.seal.why)));
  // a swapped .ots (manifest 1's proof placed on manifest 3)
  v = await run((d) => wr(d, manifestOtsPath(3), rd(d, manifestOtsPath(1))));
  assert.ok(v.failed.includes('seals'));
});

test('seals: a deleted middle manifest makes the stamp unreachable (bad); a listing with no stamp in the bundle is unstamped', async () => {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  const noOts = new Mailproof({ trailDir: w.trailDir, worker: { size: 0 }, now: w.now, otsBin: '/nonexistent/ots' });
  const r1 = await w.rec({ who: BOB, tag: 'r1' }); await noOts.stamp();
  await w.rec({ who: BOB, tag: 'r2' }); await noOts.stamp();
  await w.rec({ who: BOB, tag: 'r3' }); await w.mp.stamp();
  const out = path.join(makeTmpDir('mp-vb-mid-'), 'b');
  const r = await w.mp.export({ with: [BOB], out });
  assert.deepEqual(treeOf(out).filter((f) => f.startsWith('manifests/')), ['manifests/00000001.json', 'manifests/00000002.json', 'manifests/00000003.json', 'manifests/00000003.json.ots']);
  const ok = await verifyBundle(out, { ots: ots.bin });
  assert.ok(ok.ok, JSON.stringify(ok.problems));
  assert.deepEqual(ok.records.find((x) => x.id === r1.id).seal, { state: 'pending', via: 'manifest', listed_in: 1, stamped_by: 3, sealed_at: '2026-11-01T08:00:03.000Z' });
  const d = copy(out);
  fs.rmSync(path.join(d, manifestPath(2)));
  regen(d);
  const v = await verifyBundle(d, { ots: ots.bin });
  assert.ok(v.failed.includes('seals'), JSON.stringify(v.failed));
  assert.equal(v.records.find((x) => x.id === r1.id).seal.state, 'bad');
  assert.match(v.records.find((x) => x.id === r1.id).seal.why, /no chain of manifests/);
  // no proof at all in the bundle: the listings are `unstamped`, which passes
  const u = copy(out);
  fs.rmSync(path.join(u, manifestOtsPath(3)));
  regen(u);
  const vu = await verifyBundle(u, { ots: ots.bin });
  assert.ok(vu.ok, JSON.stringify(vu.problems));
  assert.equal(vu.counts.unstamped, 3);
  assert.deepEqual((await verifyBundle(u, { ots: ots.bin, strict: true })).failed, ['strict:anchored']);
  assert.ok(r.bundle_sha256);
});

test('seals and ots: absent, off, both attestations, none, a hang, the total budget, MAILPROOF_OTS', async () => {
  const m = await mixed();
  let v = await verifyBundle(m.out, { ots: '/nonexistent/ots' });
  assert.ok(v.ok);
  assert.equal(v.ots, 'absent');
  assert.ok(v.counts.unchecked >= 3 && v.counts.pending === 0);
  assert.deepEqual((await verifyBundle(m.out, { ots: '/nonexistent/ots', strict: true })).failed, ['strict:verified', 'strict:anchored']);
  v = await verifyBundle(m.out, { ots: null });
  assert.equal(v.ots, 'off');
  assert.ok(v.ok && v.counts.unchecked >= 3);
  // scripted info output
  const script = (body) => {
    const dir = makeTmpDir('mp-vb-info-');
    fs.writeFileSync(path.join(dir, 'ots'), `#!/bin/sh\nd=$(sed -n 1p "$2")\ncase "$1" in info) ${body};; esac\n`, { mode: 0o755 });
    return path.join(dir, 'ots');
  };
  const both = script('echo "File sha256 hash: $d"; echo Timestamp:; echo "verify PendingAttestation(\'https://c.example\')"; echo "verify BitcoinBlockHeaderAttestation(900001)"; echo "# Bitcoin block merkle root ' + '9'.repeat(64) + '"');
  v = await verifyBundle(m.out, { ots: both });
  assert.equal(v.counts.anchored, 4, 'anchored wins over pending');
  const none = script('echo "File sha256 hash: $d"; echo Timestamp:');
  v = await verifyBundle(m.out, { ots: none });
  assert.ok(!v.ok && v.counts.bad >= 3 && v.failed.includes('seals'));
  assert.ok(v.records.some((r) => /no attestation|does not parse/.test(r.seal.why ?? '')));
  const hang = script('sleep 30');
  const t0 = Date.now();
  v = await verifyBundle(m.out, { ots: hang, _limits: { BUNDLE_OTS_TIMEOUT_MS: 150 } });
  assert.ok(Date.now() - t0 < 10_000, 'a hanging ots is cut off');
  assert.ok(v.ok && v.counts.unchecked >= 3, 'a hung proof is unchecked, not failed');
  v = await verifyBundle(m.out, { ots: m.ots.bin, _limits: { BUNDLE_OTS_MAX_MS: 0 } });
  assert.equal(v.ots, 'out of time');
  assert.ok(v.counts.unchecked >= 3);
  // MAILPROOF_OTS through the CLI
  const r = spawnSync(process.execPath, [path.resolve('bin/mailproof.js'), 'verify-bundle', m.out, '--json'], { env: { PATH: process.env.PATH, HOME: makeTmpDir('mp-vb-home-'), MAILPROOF_OTS: 'off' } });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(JSON.parse(r.stdout.toString()).ots, 'off');
});

test('parseOtsInfo: the two documented outputs, anchored over pending, no digest, no attestation', () => {
  const d = 'a'.repeat(64);
  assert.deepEqual(parseOtsInfo(`File sha256 hash: ${d}\nTimestamp:\nverify PendingAttestation('https://alice.btc.calendar.opentimestamps.org')\n`), { digest: d, block: null, merkleRoot: null, pending: true });
  assert.deepEqual(parseOtsInfo(`File sha256 hash: ${d}\nTimestamp:\nverify BitcoinBlockHeaderAttestation(823840)\n# Bitcoin block merkle root ${'2'.repeat(64)}\n`), { digest: d, block: 823840, merkleRoot: '2'.repeat(64), pending: false });
  assert.equal(parseOtsInfo(`File sha256 hash: ${d}\nTimestamp:\nappend ab\n -> verify BitcoinBlockHeaderAttestation(5)\n`)?.block, 5);
  assert.equal(parseOtsInfo(`Timestamp:\nverify BitcoinBlockHeaderAttestation(5)\n`), null, 'no digest');
  assert.equal(parseOtsInfo(`File sha256 hash: ${d}\nTimestamp:\n`), null, 'no attestation');
  assert.equal(parseOtsInfo(`File sha256 hash: ${d}\nverify BitcoinBlockHeaderAttestation(0)\n`), null);
  assert.equal(parseOtsInfo(null), null);
});

test('the real `ots info` on hand-built proofs (skipped when the binary is absent)', async (t) => {
  const probe = spawnSync('ots', ['--version']);
  if (probe.error || probe.status !== 0) return t.skip('ots is not installed');
  const m = await mixed();
  const d = copy(m.out);
  const magic = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
  const uri = Buffer.from('https://alice.btc.calendar.opentimestamps.org');
  const pend = Buffer.concat([Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'), Buffer.from([uri.length + 1, uri.length]), uri]);
  const btc = Buffer.concat([Buffer.from([0x00]), Buffer.from('0588960d73d71901', 'hex'), Buffer.from([3, 0xA0, 0x84, 0x32])]);
  const anchoredTail = Buffer.concat([Buffer.from([0xf0, 4]), Buffer.from('abcd0102', 'hex'), Buffer.from([0x08]), btc]);
  const proofs = treeOf(d).filter((f) => f.endsWith('.ots'));
  const build = (tail, only) => {
    for (const p of proofs) {
      const stamped = rd(d, p.replace(/\.ots$/, ''));
      fs.writeFileSync(path.join(d, p), Buffer.concat([magic, Buffer.from([1, 8]), Buffer.from(sha(stamped), 'hex'), p === only ? anchoredTail : tail]));
    }
    regen(d);
  };
  build(pend);
  const v = await verifyBundle(d, { ots: 'ots' });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.records.find((r) => r.id === m.ids.c).seal.state, 'pending');
  build(pend, manifestOtsPath(3));
  const a = await verifyBundle(d, { ots: 'ots' });
  assert.equal(a.records.find((r) => r.id === m.ids.c).seal.state, 'anchored');
  assert.equal(a.records.find((r) => r.id === m.ids.c).seal.block, 819744);
  assert.equal(a.records.find((r) => r.id === m.ids.a).seal.state, 'pending');
});

test('hostile bundle: symlinks (file, directory, /etc/passwd), a FIFO, an oversize file, path-like names, a file-count cap, an oversize bundle', async () => {
  const m = await mixed();
  const hostile = async (edit, o = {}) => { const d = copy(m.out); edit(d); return { d, v: await verifyBundle(d, { ots: null, ...o }) }; };
  const unsafe = (v) => v.problems.some((p) => /unsafe entry/.test(p.why));
  let r = await hostile((d) => { fs.rmSync(path.join(d, 'README.txt')); fs.symlinkSync('/etc/passwd', path.join(d, 'README.txt')); });
  assert.ok(!r.v.ok && unsafe(r.v));
  r = await hostile((d) => fs.symlinkSync(makeTmpDir('mp-vb-target-'), path.join(d, 'records', 'zz')));
  assert.ok(!r.v.ok && unsafe(r.v));
  r = await hostile((d) => { const f = path.join(d, rdFirstRecord(d)); fs.rmSync(f); fs.symlinkSync('/etc/passwd', f); });
  assert.ok(!r.v.ok && unsafe(r.v));
  r = await hostile((d) => { const mk = spawnSync('mkfifo', [path.join(d, 'records', 'fifo')]); assert.equal(mk.status, 0); });
  const t0 = Date.now();
  assert.ok(!r.v.ok && unsafe(r.v));
  assert.ok(Date.now() - t0 < 5000, 'a FIFO is never opened');
  // the whole bundle as a symlink
  const link = path.join(makeTmpDir('mp-vb-link-'), 'l');
  fs.symlinkSync(m.out, link);
  const lv = await verifyBundle(link, { ots: null });
  assert.ok(!lv.ok && lv.failed.includes('files'));
  // an oversize file is not read
  r = await hostile((d) => { const f = recordPath(m.ids.a); wr(d, f, Buffer.alloc(5000, 32)); }, { _limits: { BUNDLE_MAX_RECORD_BYTES: 1000 } });
  assert.ok(!r.v.ok && r.v.problems.some((p) => /over its size limit/.test(p.why)));
  // an oversize bundle and too many files are refused unread
  r = await hostile(() => {}, { _limits: { BUNDLE_MAX_BYTES: 500 } });
  assert.ok(!r.v.ok && r.v.problems.some((p) => /refused unread/.test(p.why)));
  assert.equal(r.v.records.length, 0);
  r = await hostile(() => {}, { _limits: { BUNDLE_MAX_FILES: 3 } });
  assert.ok(!r.v.ok && r.v.problems.some((p) => /refused unread/.test(p.why)));
  // `files` keys with `..` and absolute paths are never opened
  const sentinel = path.join(makeTmpDir('mp-vb-sentinel-'), 'secret');
  fs.writeFileSync(sentinel, 'x');
  r = await hostile((d) => regen(d, (j) => { j.files['../../etc/passwd'] = '0'.repeat(64); j.files[sentinel] = '0'.repeat(64); return j; }));
  assert.ok(!r.v.ok && r.v.problems.filter((p) => /unexpected path/.test(p.why)).length >= 2);
  // a path that parses as a record path with an uppercase id is an unexpected path
  r = await hostile((d) => wr(d, `records/AB/${'AB'.repeat(16)}.json`, '{}'));
  assert.ok(!r.v.ok && r.v.problems.some((p) => /unexpected path/.test(p.why)));
});
const rdFirstRecord = (d) => treeOf(d).find((x) => /^records\/.*\.json$/.test(x));

test('hostile bundle: control characters and bidi in a record are escaped in text mode; a thousand signatures and a huge manifest are bounded', async () => {
  const m = await mixed();
  const d = copy(m.out);
  const rf = recordPath(m.ids.a);
  const rec = json(d, rf);
  rec.signatures = Array.from({ length: 1000 }, () => rec.signatures[0]);
  wr(d, rf, `${JSON.stringify(rec, null, 2)}\n`);
  regen(d);
  const t0 = process.cpuUsage();
  const v = await verifyBundle(d, { ots: null });
  const cpu = (process.cpuUsage(t0).user) / 1000;
  assert.ok(!v.ok && v.problems.some((p) => /more than 10 signatures/.test(p.why)));
  assert.ok(cpu < 5000, `1000 signatures cost ${cpu} ms CPU: bounded by the cap, not the input`);
  // a manifest over its size cap is not read
  const d2 = copy(m.out);
  wr(d2, manifestPath(1), Buffer.alloc(5000, 32));
  regen(d2);
  const v2 = await verifyBundle(d2, { ots: null, _limits: { BUNDLE_MAX_MANIFEST_BYTES: 1000 } });
  assert.ok(!v2.ok && v2.problems.some((p) => /over its size limit/.test(p.why)));
  // text mode: a filename-like field with ESC and bidi is escaped (the CLI report passes everything through printable)
  const { bundleText } = await import('../../src/cli/bundle.js');
  const d3 = copy(m.out);
  regen(d3, (j) => { j.records[0].file = `records/ab/\u001b[31m‮evil.json`; return j; });
  const v3 = await verifyBundle(d3, { ots: null });
  const text = bundleText(v3);
  assert.ok(!text.includes('\u001b') && !text.includes('‮'), 'escaped');
  assert.match(text, /\\x1b|\\u202e/);
});

test('CLI: exit codes, --expect, --strict, --json is one document, no config and no HOME state needed, works with better-sqlite3 unloadable', async () => {
  const m = await mixed();
  const env = { PATH: process.env.PATH, HOME: makeTmpDir('mp-vb-home-'), MAILPROOF_OTS: 'off' };
  const cli = (...a) => spawnSync(process.execPath, [...(a[0] === '--loader' ? [] : []), path.resolve('bin/mailproof.js'), ...a], { env });
  let r = cli('verify-bundle', m.out);
  assert.equal(r.status, 0, r.stderr.toString());
  const text = r.stdout.toString();
  assert.match(text, /^OK  6 records/);
  assert.match(text, /seals NOT checked: ots is off/);
  assert.match(text, /does not prove completeness/);
  assert.match(text, /not checked against a Bitcoin node/);
  assert.match(text, /owner's clock/);
  assert.equal(cli('verify-bundle', m.out, '--expect', m.r.bundle_sha256).status, 0);
  assert.equal(cli('verify-bundle', m.out, '--expect', 'f'.repeat(64)).status, 2, 'a wrong --expect is a failed check');
  assert.equal(cli('verify-bundle', m.out, '--expect', 'zzz').status, 64);
  assert.equal(cli('verify-bundle', m.out, '--strict').status, 2);
  assert.equal(cli('verify-bundle').status, 64);
  assert.equal(cli('verify-bundle', '/nonexistent/dir').status, 64);
  assert.equal(cli('verify-bundle', path.join(m.out, 'bundle.json')).status, 64, 'a file is not a directory');
  const empty = makeTmpDir('mp-vb-empty-');
  r = cli('verify-bundle', empty, '--json');
  assert.equal(r.status, 2, 'a directory with no bundle.json is a failed check');
  assert.deepEqual(JSON.parse(r.stdout.toString()).failed, ['bundle.json']);
  r = cli('verify-bundle', m.out, '--json');
  assert.equal(r.stdout.toString().trim().split('\n').length, 1, 'exactly one JSON document');
  assert.equal(JSON.parse(r.stdout.toString()).ok, true);
  // better-sqlite3 made unloadable: the verifier never imports it
  const hook = makeTmpDir('mp-vb-hook-');
  fs.writeFileSync(path.join(hook, 'loader.mjs'), "export async function resolve(s, c, n) { if (s === 'better-sqlite3') throw new Error('add-on blocked by test'); return n(s, c); }\n");
  fs.writeFileSync(path.join(hook, 'register.mjs'), `import { register } from 'node:module'; register(${JSON.stringify(`file://${path.join(hook, 'loader.mjs')}`)});\n`);
  r = spawnSync(process.execPath, ['--import', path.join(hook, 'register.mjs'), path.resolve('bin/mailproof.js'), 'verify-bundle', m.out], { env });
  assert.equal(r.status, 0, r.stderr.toString());
});

test('round trip: editing the exported README fails files; pruning the owner trail afterwards leaves the old bundle valid', async () => {
  const m = await mixed();
  const d = copy(m.out);
  fs.appendFileSync(path.join(d, 'README.txt'), 'x');
  const v = await verifyBundle(d, { ots: null });
  assert.deepEqual(v.failed, ['files']);
  const w = bundleWorld({ otsBin: null });
  for (let i = 0; i < 3; i++) await w.rec({ who: BOB, tag: `r${i}`, advance: 86_400_000 });
  const out = path.join(makeTmpDir('mp-vb-prune-'), 'b');
  const r = await w.mp.export({ with: [BOB], out });
  await w.mp.prune({ before: new Date(w.clock.t - 86_400_000) });
  const after = await verifyBundle(out, { ots: null, expect: r.bundle_sha256 });
  assert.ok(after.ok, JSON.stringify(after.problems));
});

test('verifyBundle arguments: a TypeError for a bad dir, expect or opts; never a rejection for a bad bundle', async () => {
  await assert.rejects(verifyBundle(5), TypeError);
  await assert.rejects(verifyBundle('/nonexistent/nowhere'), TypeError);
  await assert.rejects(verifyBundle(makeTmpDir('mp-vb-args-'), { strict: 'yes' }), TypeError);
  await assert.rejects(verifyBundle(makeTmpDir('mp-vb-args2-'), { ots: '' }), TypeError);
  const v = await verifyBundle(makeTmpDir('mp-vb-args3-'));
  assert.equal(v.ok, false);
});

void recordOtsPath;

test('each record carries from, to, subject and whether the subject is signed (data from the record, for the row)', async () => {
  const { out, ids, w } = await mixed();
  const r = await verifyBundle(out, { ots: null });
  const byId = new Map(r.records.map((x) => [x.id, x]));
  const a = byId.get(ids.a);
  assert.equal(a.from, BOB);
  assert.equal(typeof a.subject, 'string');
  assert.equal(a.subject_signed, true);
  const un = byId.get(ids.unsigned);
  assert.equal(un.from, BOB, 'unsigned record: from the record addresses');
  assert.equal(un.subject_signed, false, 'an unsigned subject is flagged');
  const c = byId.get(ids.c);
  assert.equal(c.direction, 'out');
  assert.equal(typeof c.to, 'string', 'an outbound record names who it went to');
  void w;
});
