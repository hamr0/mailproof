// `mailproof export` and the bundle README (SPEC B13.2.9, B13.2.10): flags, exit codes, --json, --tar, the menu path is in cli-menu.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, account } from '../helpers/cli.js';
import { bundleWorld, fakeOts, treeOf } from '../helpers/bundle.js';
import { emailBlock, readmeText, wrap } from '../../src/proof/bundle-readme.js';
import { makeTmpDir } from '../helpers/tmp.js';

const BOB = 'bob@bob.example';

async function cliWorld(o = {}) {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin, ...o });
  await w.rec({ who: BOB, tag: 'a' });
  await w.rec({ who: BOB, tag: 'b', out: true });
  await w.mp.stamp();
  await w.rec({ who: BOB, tag: 'c' });
  const cli = makeWorld({ accounts: { work: account(w.trailDir, { ots: false }) } });
  const dir = makeTmpDir('mp-cli-export-');
  return { w, cli, dir, ots };
}

test('export: human output, --json is the ExportResult, the pending warning goes to stderr, exit 0', async () => {
  const { cli, dir } = await cliWorld();
  const out = path.join(dir, 'b');
  const r = await cli.run(['export', '--with', BOB, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^wrote .*b \(3 records, 0 replies, \d+ keys, \d+ manifests, [\d.]+ (KiB|bytes)\)$/m);
  assert.match(r.stdout, /^bundle sha256 ([0-9a-f]{64})  \(tell the recipient this out of band; they can run: mailproof verify-bundle --expect \1 <dir>\)$/m);
  assert.match(r.stdout, /^seals: 0 anchored, \d+ pending, 0 unstamped, 1 unsealed$/m);
  assert.match(r.stdout, /^raw emails still stored: 3 of 3$/m);
  assert.match(r.stderr, /3 of 3 records are not anchored yet.*mailproof stamp/);
  const j = await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'b2'), '--json']);
  const doc = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(doc), ['out', 'bytes', 'files', 'head', 'bundle_sha256', 'records', 'replies', 'keys', 'manifests', 'seals', 'content']);
  assert.equal(j.stdout.trim().split('\n').length, 1);
  const v = await cli.run(['verify-bundle', out, '--expect', JSON.parse((await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'b3'), '--json'])).stdout).bundle_sha256]);
  assert.equal(v.code, 2, 'a different bundle_sha256 (created time differs) is a failed --expect');
  assert.match(v.stdout, /^FAILED: expect/);
});

test('export: exit codes (64 usage and ERR_EXPORT_EXISTS, 1 empty), the default out in the current directory form, --tar', async () => {
  const { cli, dir, w } = await cliWorld();
  assert.equal((await cli.run(['export'])).code, 64);
  assert.match((await cli.run(['export'])).stderr, /export needs --with/);
  assert.equal((await cli.run(['export', '--with', 'not-an-address', '--out', path.join(dir, 'x')])).code, 64);
  assert.equal((await cli.run(['export', '--with', BOB, '--after', 'soon', '--out', path.join(dir, 'x')])).code, 64);
  assert.equal((await cli.run(['export', '--with', BOB, '--after', '2026-12-01', '--before', '2026-11-01', '--out', path.join(dir, 'x')])).code, 64);
  assert.equal((await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'no', 'parent')])).code, 64);
  const ok = await cli.run(['export', '--with', `${BOB}, bob@other.example`, '--out', path.join(dir, 'ok')]);
  assert.equal(ok.code, 0, ok.stderr);
  const again = await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'ok')]);
  assert.equal(again.code, 64, 'an existing, non-empty out is refused');
  assert.match(again.stderr, /never overwrites/);
  assert.equal((await cli.run(['export', '--with', BOB, '--out', path.join(w.root, 'in-trail')])).code, 64);
  const none = await cli.run(['export', '--with', 'nobody@nowhere.example', '--out', path.join(dir, 'none')]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /nothing to export/);
  assert.ok(!fs.existsSync(path.join(dir, 'none')));
  const tar = await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'p.tar'), '--tar']);
  assert.equal(tar.code, 0, tar.stderr);
  assert.ok(fs.statSync(path.join(dir, 'p.tar')).isFile());
  const oldPath = process.env.PATH;
  process.env.PATH = makeTmpDir('mp-cli-nopath-');   // the library runs `tar` with the process environment
  let noTar;
  try { noTar = await cli.run(['export', '--with', BOB, '--out', path.join(dir, 'q.tar'), '--tar']); } finally { process.env.PATH = oldPath; }
  assert.equal(noTar.code, 1);
  assert.match(noTar.stderr, /tar not found/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('q') || f.startsWith('.mailproof-export-')), [], 'nothing was built');
  // the default out is ./mailproof-bundle-<account>-<UTC yyyymmdd-hhmmss>
  const cwd = process.cwd();
  const here = makeTmpDir('mp-cli-export-cwd-');
  process.chdir(here);
  try {
    const d = await cli.run(['export', '--with', BOB], { deps: { now: () => new Date('2026-11-12T09:30:00Z') } });
    assert.equal(d.code, 0, d.stderr);
    assert.deepEqual(fs.readdirSync(here), ['mailproof-bundle-work-20261112-093000']);
  } finally { process.chdir(cwd); }
});

test('export: a trail lock held in the index catch-up is exit 75', async () => {
  const { cli, dir, w } = await cliWorld();
  const lock = path.join(w.trailDir, '.default.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), started: new Date().toISOString() }));
  try {
    const mp = (await import('../../src/proof/mailproof.js')).Mailproof;
    const fast = new mp({ trailDir: w.trailDir, lockTimeoutMs: 100, worker: { size: 0 } });
    await assert.rejects(fast.export({ with: [BOB], out: path.join(dir, 'locked') }), (e) => e.code === 'ERR_TRAIL_LOCKED');
  } finally { fs.rmSync(lock, { force: true }); }
});

test('the README: 80 columns, LF, escapes ESC and bidi, cuts a 5,000-character subject, says what it must, never the owner\'s free text', async () => {
  const w = bundleWorld({ otsBin: null });
  await w.rec({ who: BOB, tag: 'weird', subject: `evil \u001b[31mred‮${'x'.repeat(5000)}` });
  const out = path.join(makeTmpDir('mp-readme-'), 'b');
  await w.mp.export({ with: [BOB], out });
  const text = fs.readFileSync(path.join(out, 'README.txt'), 'utf8');
  assert.ok(!text.includes('\u001b') && !text.includes('‮'), 'escaped');
  assert.match(text, /\\x1b\[31mred\\u202e/);
  assert.ok(text.split('\n').every((l) => l.length <= 80), 'every line is at most 80 columns');
  assert.ok(!text.includes('x'.repeat(250)), 'a long subject is cut');
  assert.ok(!text.includes('\r'));
  for (const must of ['WHAT IS PROVEN', 'WHAT IS BEST EFFORT, NOT PROVEN', 'COMPLETENESS: not proven', 'PRIVACY', 'npx mailproof verify-bundle', 'verify-bundle does not check that']) assert.ok(text.includes(must), must);
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /Made 2026-11-0\dT\S+ by mailproof \d+\.\d+\.\d+ from the trail "default" \(commit [0-9a-f]{12}\)\./);
  assert.match(flat, /Selection: emails that name bob@bob\.example on From, To, Cc or Reply-To, captured from the beginning to now\./);
  assert.deepEqual(treeOf(out).filter((f) => f === 'README.txt'), ['README.txt']);
});

test('README blocks: every state and body status, an unsigned email, a pending seal, content absent, a reply record', () => {
  const base = { id: 'a'.repeat(32), direction: 'in', captured: '2026-11-01T08:00:00.000Z', from: [{ address: 'bob@x.example', signed: true }], to: [{ address: 'me@y.example', signed: false }, { address: 'z@y.example', signed: true }], cc: [], replyTo: [], subject: 'hi', date: null, messageId: '<m@x>', inReplyTo: '<p@x>', inReplyToSigned: false, dkim: 'unsigned', body: 'partial', partialBytes: '100', raw: 'b'.repeat(64) };
  const content = { raw: { sha256: 'b'.repeat(64), stored: false }, attachments: [{ filename: 'f\u001b.pdf', size: 3, sha256: 'c'.repeat(64), stored: true }] };
  const b = emailBlock(1, base, { state: 'pending', via: 'manifest', listed_in: 3, stamped_by: 4 }, content, [{ slug: 'reply-text-1', sha256: 'd'.repeat(64) }]).join('\n');
  const flat = b.replace(/\s+/g, ' ');
  assert.match(flat, /Seal : pending at export \(manifest 3 listed it, manifest 4 stamped\)/);
  assert.match(flat, /Body : partial \(the signature covers only the first 100 bytes\)/);
  assert.match(b, /To\s+: me@y\.example \(unsigned\), z@y\.example \(signed\)/);
  assert.match(b, /Date\s+: not recorded/);
  assert.match(b, /In-Reply-To: <p@x> \(unsigned\)/);
  assert.match(flat, /attachment f\\x1b\.pdf, 3 bytes, sha256 c+ \(stored\)/);
  assert.match(flat, /Reply text : reply-text-1 recorded \(sha256 d+\)/);
  for (const [state, want] of [['unstamped', 'listed but not stamped at export'], ['unsealed', 'not sealed at export'], ['anchored', 'anchored at export (the record\'s own stamp)']]) {
    const t = emailBlock(2, { ...base, body: 'mismatch' }, { state, via: state === 'anchored' ? 'record' : null, listed_in: null, stamped_by: null }, content, []).join('\n');
    assert.ok(t.replace(/\s+/g, ' ').includes(want), want);
    assert.match(t, /Body\s+: mismatch/);
  }
  assert.ok(readmeText({ created: 'c', version: '1', trail: 't', head: 'f'.repeat(40), with: ['a@b.c'], after: '2026-01-01T00:00:00.000Z', before: null, records: 1, blocks: [[b]] }).replace(/\s+/g, ' ').includes('captured from 2026-01-01T00:00:00.000Z to now'));
  assert.ok(wrap('  Label: ', 'w '.repeat(100)).every((l) => l.length <= 80));
  assert.ok(wrap('  L: ', 'x'.repeat(300)).every((l) => l.length <= 80), 'a long word is broken hard');
});
