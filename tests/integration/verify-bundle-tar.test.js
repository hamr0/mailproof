// `verifyBundle` on the `.tar` that `export --tar` writes (SPEC B13.3.6): the library, the CLI and the MCP tool take it directly. The tar is
// hostile input, so hand-built tars with a link, a device, `..`, an absolute path, a lying size, too many entries and too many bytes are refused
// with a reason and nothing is left in the temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyBundle } from '../../src/index.js';
import { bundleWorld } from '../helpers/bundle.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const BOB = 'bob@bob.example';

/** A world with a real exported tar. */
async function exported() {
  const w = bundleWorld({ otsBin: null });
  await w.rec({ who: BOB, tag: 'a' });
  await w.rec({ who: BOB, tag: 'b', out: true });
  const dir = makeTmpDir('mp-vbt-');
  const r = await w.mp.export({ with: [BOB], out: path.join(dir, 'pair.tar'), tar: true });
  return { w, dir, r };
}
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mailproof-vb-'));

/** One ustar entry by hand. */
function header(name, { type = '0', size = 0, linkname = '' } = {}) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148);
  b.write(type, 156); b.write(linkname, 157, 100); b.write('ustar\0', 257); b.write('00', 263);
  let sum = 0; for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}
const entry = (name, data = '', o = {}) => {
  const d = Buffer.from(data);
  return Buffer.concat([header(name, { size: d.length, ...o }), d, Buffer.alloc((512 - (d.length % 512)) % 512)]);
};
const tarOf = (...parts) => { const f = path.join(makeTmpDir('mp-vbt-h-'), 'x.tar'); fs.writeFileSync(f, Buffer.concat([...parts, Buffer.alloc(1024)])); return f; };
const why = (v) => v.files.problems.map((p) => p.why).join('; ');

test('the .tar export writes verifies directly, like its folder; the temp folder is removed', async () => {
  const { w, dir, r } = await exported();
  const before = leftovers();
  const v = await verifyBundle(r.out, { ots: null, expect: r.bundle_sha256 });
  assert.ok(v.ok, JSON.stringify(v.problems));
  assert.equal(v.counts.records, 2);
  assert.deepEqual(leftovers(), before, 'nothing left in the temp folder');
  const x = path.join(dir, 'x'); fs.mkdirSync(x);
  execFileSync('tar', ['-xf', r.out, '-C', x]);
  const folder = await verifyBundle(path.join(x, 'pair'), { ots: null, expect: r.bundle_sha256 });
  assert.deepEqual(v.counts, folder.counts, 'the same answer as the extracted folder');
  assert.ok(w);
});

test('a tampered file inside the tar fails the same checks as in a folder', async () => {
  const { dir, r } = await exported();
  const x = path.join(dir, 'x'); fs.mkdirSync(x);
  execFileSync('tar', ['-xf', r.out, '-C', x]);
  const rec = execFileSync('find', [x, '-name', '*.json', '-path', '*records*']).toString().trim().split('\n')[0];
  fs.appendFileSync(rec, ' ');
  const bad = path.join(dir, 'bad.tar');
  execFileSync('tar', ['-cf', bad, '-C', x, 'pair']);
  const v = await verifyBundle(bad, { ots: null });
  assert.equal(v.ok, false);
  assert.ok(v.failed.includes('files') || v.failed.includes('records'), v.failed.join());
});

test('hostile tars are refused with a reason, never extracted, nothing left behind', async () => {
  const before = leftovers();
  const cases = [
    ['symlink', tarOf(entry('b/', '', { type: '5' }), entry('b/evil', '', { type: '2', linkname: '/etc/passwd' })), /not a plain file/],
    ['hard link', tarOf(entry('b/', '', { type: '5' }), entry('b/h', '', { type: '1', linkname: 'b/x' })), /not a plain file/],
    ['device', tarOf(entry('b/', '', { type: '5' }), entry('b/dev', '', { type: '3' })), /not a plain file/],
    ['fifo', tarOf(entry('b/', '', { type: '5' }), entry('b/f', '', { type: '6' })), /not a plain file/],
    ['dotdot', tarOf(entry('b/', '', { type: '5' }), entry('b/../../escape', 'x')), /\.\./],
    ['absolute', tarOf(entry('/tmp/escape', 'x')), /absolute/],
    ['two tops', tarOf(entry('a/x', 'x'), entry('b/y', 'y')), /one top-level folder/],
    ['file at top', tarOf(entry('x', 'x')), /top-level folder/],
    ['size lies', tarOf(header('b/f', { size: 10_000_000 })), /cut short/],
    ['duplicate', tarOf(entry('b/f', 'x'), entry('b/f', 'y')), /twice|cannot be unpacked/],
    ['garbage', (() => { const f = path.join(makeTmpDir('mp-vbt-g-'), 'g.tar'); fs.writeFileSync(f, Buffer.alloc(2048, 7)); return f; })(), /damaged/],
  ];
  for (const [name, f, re] of cases) {
    const v = await verifyBundle(f, { ots: null });
    assert.equal(v.ok, false, name);
    assert.ok(v.failed.includes('files'), `${name}: ${v.failed}`);
    assert.match(why(v), re, name);
  }
  assert.deepEqual(leftovers(), before);
  assert.ok(!fs.existsSync('/tmp/escape'));
});

test('the bounds of a bundle folder hold for a tar: entry count and total bytes', async () => {
  const many = tarOf(entry('b/', '', { type: '5' }), ...Array.from({ length: 5 }, (_, i) => entry(`b/f${i}`, 'x')));
  const v = await verifyBundle(many, { ots: null, _limits: { BUNDLE_MAX_FILES: 3 } });
  assert.match(why(v), /more than 3 entries/);
  const big = tarOf(entry('b/a', 'x'.repeat(600)), entry('b/b', 'x'.repeat(600)));
  const v2 = await verifyBundle(big, { ots: null, _limits: { BUNDLE_MAX_BYTES: 1000 } });
  assert.match(why(v2), /over 1000 bytes/);
});

test('a file that is not a .tar is still refused as before', async () => {
  const f = path.join(makeTmpDir('mp-vbt-n-'), 'notes.txt'); fs.writeFileSync(f, 'x');
  await assert.rejects(verifyBundle(f, { ots: null }), /not a directory or a \.tar file/);
});

test('CLI: verify-bundle <file.tar> works and exits 0', async () => {
  const { dir, r, w } = await exported();
  const cli = makeWorld({ accounts: { work: account(w.trailDir, { ots: false }) } });
  const v = await cli.run(['verify-bundle', r.out, '--expect', r.bundle_sha256]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /VERIFIED/);
  assert.ok(dir);
});
