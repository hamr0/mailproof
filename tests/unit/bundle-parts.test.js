// The small shared parts of the pair bundle (SPEC B13.2, B13.3): the one pure seal decision, the layout parsers, the content stat helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideSeal } from '../../src/proof/seal-core.js';
import { parseBundlePath, parseKeyPath, keyPath, recordPath, replyPath, manifestPath, manifestOtsPath } from '../../src/proof/layout.js';
import { storedStatus, rawPathOf, attPathOf } from '../../src/proof/content.js';
import { otsOptionFromEnv } from '../../src/cli/secrets.js';
import { makeTmpDir } from '../helpers/tmp.js';

/** manifests: seq -> { ots, lists }, each with the hash of its bytes `h<seq>` and the previous one's in `previous_sha256`. */
const chain = (spec) => (seq) => {
  const s = spec[seq];
  return s ? { m: { v: 1, seq, previous_sha256: s.prev ?? (spec[seq - 1] ? `h${seq - 1}` : null), created: '', records: [], replies: [] }, sha256: `h${seq}`, ots: !!s.ots } : null;
};

test('decideSeal: own proof, own stamp, a later stamp through verified links, no stamp, a broken link, unsealed', async () => {
  const lists = (m) => m.seq === 2;
  const run = (spec, extra = {}) => decideSeal({ order: Object.keys(spec).map(Number).reverse(), load: chain(spec), lists, ...extra });
  assert.deepEqual(await run({ 2: {} }, { own: true }), { via: 'record' });
  assert.deepEqual(await run({ 1: {}, 2: { ots: true } }), { via: 'manifest', seq: 2, stamp: { seq: 2, own: true } });
  assert.deepEqual(await run({ 2: {}, 3: {}, 4: { ots: true } }), { via: 'manifest', seq: 2, stamp: { seq: 4, own: false } });
  assert.deepEqual(await run({ 2: {}, 3: {} }), { via: 'manifest', seq: 2, stamp: null });
  assert.deepEqual(await run({ 2: {}, 3: { prev: 'wrong' }, 4: { ots: true } }), { via: 'manifest', seq: 2, stamp: null }, 'a link that does not verify ends the walk');
  assert.deepEqual(await run({ 2: {}, 4: { ots: true } }), { via: 'manifest', seq: 2, stamp: null }, 'a missing manifest ends the walk');
  assert.equal(await run({ 1: {}, 3: { ots: true } }), null, 'listed nowhere');
  assert.deepEqual(await decideSeal({ order: [2], load: async (s) => chain({ 2: { ots: true } })(s), lists }), { via: 'manifest', seq: 2, stamp: { seq: 2, own: true } }, 'the loader may be async');
});

test('layout: key paths and the bundle path classifier use the one set of parsers', () => {
  const p = keyPath('Example.COM', 'Sel1', 'abc');
  assert.match(p, /^keys\/example\.com\/sel1\/[0-9a-f]{16}\.json$/);
  assert.deepEqual(parseKeyPath(p), { domain: 'example.com', selector: 'sel1', h16: p.slice(-21, -5) });
  for (const bad of ['keys/Example.com/s/0123456789abcdef.json', 'keys/../s/0123456789abcdef.json', 'keys/a/b/0123456789abcdeg.json', 'keys/a/b/c/0123456789abcdef.json', 'keys/.a/b/0123456789abcdef.json', 'keys/a/b..c/0123456789abcdef.json']) assert.equal(parseKeyPath(bad), null, bad);
  const id = 'ab'.repeat(16);
  assert.deepEqual(parseBundlePath('README.txt'), { kind: 'readme' });
  assert.deepEqual(parseBundlePath('bundle.json'), { kind: 'bundle' });
  assert.deepEqual(parseBundlePath(recordPath(id)), { kind: 'record', id, ots: false });
  assert.deepEqual(parseBundlePath(`${recordPath(id)}.ots`), { kind: 'record', id, ots: true });
  assert.deepEqual(parseBundlePath(replyPath(id, 'reply-text-1')), { kind: 'reply', id, slug: 'reply-text-1' });
  assert.deepEqual(parseBundlePath(manifestPath(7)), { kind: 'manifest', seq: 7, ots: false });
  assert.deepEqual(parseBundlePath(manifestOtsPath(7)), { kind: 'manifest', seq: 7, ots: true });
  for (const bad of ['', '../README.txt', '/etc/passwd', 'records/00/' + id + '.json', `records/AB/${'AB'.repeat(16)}.json`, 'trail.json', 'manifests/0.json', 'manifests/00000000.json', 'README.TXT', 'a/b']) assert.equal(parseBundlePath(bad), null, bad);
});

test('storedStatus is a stat: present, absent, a corrupted file still counts, a malformed hash never does', async () => {
  const dir = makeTmpDir('mp-stored-');
  const id = 'cd'.repeat(16);
  const hex = 'e1'.repeat(32);
  assert.deepEqual(await storedStatus(dir, id, [hex]), { raw: false, attachments: [false] });
  fs.mkdirSync(path.dirname(rawPathOf(dir, id)), { recursive: true });
  fs.writeFileSync(rawPathOf(dir, id), 'not the right bytes');
  fs.mkdirSync(path.dirname(attPathOf(dir, hex)), { recursive: true });
  fs.writeFileSync(attPathOf(dir, hex), 'x');
  assert.deepEqual(await storedStatus(dir, id, [hex, 'nothex', hex.replace('e1', 'e2')]), { raw: true, attachments: [true, false, false] });
  assert.deepEqual(await storedStatus(dir, '../x', []), { raw: false, attachments: [] });
});

test('MAILPROOF_OTS: off, an absolute path, unset or anything else', () => {
  assert.deepEqual(otsOptionFromEnv({}), {});
  assert.deepEqual(otsOptionFromEnv({ MAILPROOF_OTS: '' }), {});
  for (const v of ['off', 'OFF', 'false', '0', 'no']) assert.deepEqual(otsOptionFromEnv({ MAILPROOF_OTS: v }), { otsBin: null });
  assert.deepEqual(otsOptionFromEnv({ MAILPROOF_OTS: '/usr/bin/ots' }), { otsBin: '/usr/bin/ots' });
  assert.deepEqual(otsOptionFromEnv({ MAILPROOF_OTS: 'ots' }), {});
});
