// The CLI look (SPEC B11.7a): header colour and plain, NO_COLOR, pipes, ASCII fallback, links, escape-before-style, widths, progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { stripStyle } from '../../src/cli/style.js';

const T = await buildThread();
const w = makeWorld({ accounts: { test: account(T.dir) } });
await w.run(['list']);   // builds the index so the header has counts
const keys = (...l) => `${l.join('\n')}\n`;
const menu = (opts = {}) => w.run([], { interactive: true, input: keys('q'), ...opts });
const UTF = { LANG: 'en_US.UTF-8' };

test('header: FORCE_COLOR styles it; stripping the styles gives exactly the plain text; NO_COLOR and a pipe have no ANSI', async () => {
  const plain = await menu({ env: UTF });
  const color = await menu({ env: { ...UTF, FORCE_COLOR: '1' } });
  assert.ok(color.stdout.includes('\x1b[32m3 verified\x1b[0m'), 'verified in green, with its word');
  assert.ok(color.stdout.includes('\x1b[36m1\x1b[0m sync'), 'keys in cyan');
  assert.ok(color.stdout.includes('\x1b[1mmailproof\x1b[0m'));
  assert.ok(!plain.stdout.includes('\x1b'));
  assert.equal(stripStyle(color.stdout), plain.stdout, 'same content, no colour');
  assert.match(plain.stdout, /^─{64}\nmailproof \d+\.\d+\.\d+ · me@owner\.example \(test\) · trail ✓ · last sync never\nrecords: 6 · 3 verified · 2 unverified · 1 sent copy · seal never run · watch off\n/m);
  const no = await menu({ env: { ...UTF, FORCE_COLOR: '1', NO_COLOR: '1' } });
  assert.equal(no.stdout, plain.stdout);
  const tty = await menu({ env: UTF, tty: true });
  assert.ok(tty.stdout.includes('\x1b[32m'), 'a terminal gets colour');
  const dumb = await menu({ env: { ...UTF, TERM: 'dumb' }, tty: true });
  assert.equal(dumb.stdout, plain.stdout);
});

test('ASCII fallback in a non-UTF-8 locale: words and plain dashes, still one meaning per symbol', async () => {
  const r = await menu({ env: { LANG: 'C' } });
  assert.match(r.stdout, /^-{64}\nmailproof \S+ - me@owner\.example \(test\) - trail ok - last sync never$/m);
  assert.ok(!/[✓✗·─]/.test(r.stdout));
  const v = await w.run(['verify', 'bob@beta.example'], { env: { LANG: 'C' } });
  assert.match(v.stdout, /x NOT OK/);
  assert.match(v.stdout, /x NOT VERIFIED/);
});

test('verify: the verdict is an inverse badge only on the last line, with a symbol and words; colour never stands alone', async () => {
  const c = await w.run(['verify', 'bob@beta.example'], { env: { ...UTF, FORCE_COLOR: '1' } });
  assert.ok(c.stdout.includes('\x1b[7;31m✗ NOT VERIFIED\x1b[0m'));
  assert.equal(c.stdout.split('\x1b[7;').length, 2, 'one badge');
  assert.ok(c.stdout.includes('\x1b[31m✗ NOT OK\x1b[0m'), 'red cross and the words NOT OK');
  const p = await w.run(['verify', 'bob@beta.example'], { env: UTF });
  assert.equal(stripStyle(c.stdout), p.stdout);
  const j = await w.run(['verify', 'bob@beta.example', '--json'], { env: { ...UTF, FORCE_COLOR: '1' }, tty: true });
  assert.ok(!j.stdout.includes('\x1b'), '--json never carries ANSI');
  assert.deepEqual(JSON.parse(j.stdout), JSON.parse((await w.run(['verify', 'bob@beta.example', '--json'])).stdout));
});

test('--json of every styled command is byte-identical with and without colour', async () => {
  for (const argv of [['list', '--json'], ['people', '--json'], ['status', '--json'], ['show', 'bob@beta.example', '--json'], ['verify', 'bob@beta.example', '--json']]) {
    const a = await w.run(argv);
    const b = await w.run(argv, { env: { FORCE_COLOR: '1', ...UTF }, tty: true, columns: 200 });
    assert.equal(b.stdout, a.stdout, argv.join(' '));
  }
});

test('show: section headers in order, hashes cut to 12 unless --full, relative time beside the date, ids dim', async () => {
  const id = T.r.signed.id;
  const p = await w.run(['show', id], { env: UTF });
  assert.deepEqual(p.stdout.split('\n').filter((l) => ['Message', 'People', 'Proof', 'Content', 'Seal'].includes(l)), ['Message', 'People', 'Proof', 'Content', 'Seal']);
  assert.match(p.stdout, /^captured +2026-11-01T10:02:00\.000Z \(\d+ (d|mo|y) ago; this machine's clock\)$/m);
  assert.match(p.stdout, /^content +raw email stored \(sha256:[0-9a-f]{12}\)$/m);
  const full = await w.run(['show', id, '--full'], { env: UTF });
  assert.match(full.stdout, /^content +raw email stored \(sha256:[0-9a-f]{64}\)$/m);
  const c = await w.run(['show', id], { env: { ...UTF, FORCE_COLOR: '1' } });
  assert.ok(c.stdout.includes(`\x1b[2m${id}\x1b[0m`), 'the id is dim');
  assert.ok(/\x1b\[1m[^\x1b]*@[^\x1b]*\x1b\[0m \(signed\)/i.test(c.stdout), 'an address a verifying signature covers is bold');
  assert.match(c.stdout, /\x1b\[1mMessage\x1b\[0m/);
  assert.equal(stripStyle(c.stdout), (await w.run(['show', id], { env: UTF })).stdout);
});

test('links: OSC 8 only when colour is on and not disabled; a pipe and NO_COLOR never carry one', async () => {
  const out = `${T.dir}`;
  const on = await w.run(['status'], { env: { ...UTF, FORCE_COLOR: '1' } });
  assert.match(on.stdout, /\x1b\]8;id=[0-9a-f]{12};file:\/\/[^\x1b]*\x1b\\[^\x1b]*\x1b\]8;;\x1b\\/);
  const off = await w.run(['status'], { env: { ...UTF, FORCE_COLOR: '1', MAILPROOF_NO_LINKS: '1' } });
  assert.ok(!off.stdout.includes('\x1b]8'));
  assert.ok(off.stdout.includes('\x1b[2m'), 'colour stays when only links are off');
  const pipe = await w.run(['status'], { env: UTF });
  assert.ok(!pipe.stdout.includes('\x1b'));
  assert.ok(pipe.stdout.includes(out));
});

test('escape before style: a subject with a colour code and a forged OSC 8 link is shown as text, never run', async () => {
  const { Mailproof } = await import('../../src/proof/mailproof.js');
  const { signedMail } = await import('../helpers/proof.js');
  const { makeTmpDir } = await import('../helpers/tmp.js');
  const dir = makeTmpDir('mp-cli-style-');
  const subj = 'hi \x1b[31mRED\x1b[0m \x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\ end';
  const m = await signedMail({ domain: 'ok.example', from: 'ann@ok.example', to: 'me@owner.example', subject: subj.replace(/[\r\n]/g, ''), headerList: ['from', 'to', 'subject', 'date', 'message-id'], signTime: new Date('2026-11-05T09:00:00Z') });
  const mp = new Mailproof({ trailDir: dir, worker: { size: 0 }, resolver: m.resolver, now: () => new Date('2026-11-05T10:00:00Z') });
  await mp.record(m.raw, { direction: 'in', source: 'test' });
  await mp.close();
  const w2 = makeWorld({ accounts: { x: account(dir) } });
  for (const cmd of [['list'], ['show', 'ann@ok.example'], ['verify', 'ann@ok.example']]) {
    const r = await w2.run(cmd, { env: { ...UTF, FORCE_COLOR: '1' }, columns: 200 });
    const text = r.stdout;
    assert.ok(!text.includes('\x1b[31mRED'), `${cmd[0]}: the forged colour is not run`);
    assert.ok(!text.includes('\x1b]8;;https://evil'), `${cmd[0]}: the forged link is not run`);
    assert.ok(!/\x1b\]8;id=[0-9a-f]{12};https:\/\/evil/.test(text));
  }
  const l = await w2.run(['list'], { env: { ...UTF, FORCE_COLOR: '1' }, columns: 200 });
  assert.ok(l.stdout.includes('\\x1b[31mRED'), 'it is visible as an escape');
});

test('width: tables fit stdout.columns (80 when unknown), cutting with an ellipsis', async () => {
  for (const columns of [80, 100, 120]) {
    const r = await w.run(['list'], { env: UTF, columns });
    for (const l of r.stdout.split('\n').filter(Boolean)) assert.ok([...l].length <= columns, `${columns}: ${l.length} ${l}`);
  }
  const narrow = await w.run(['list'], { env: UTF, columns: 80 });
  assert.match(narrow.stdout, /…/);
  const pipe = await w.run(['list'], { env: UTF });
  assert.equal(pipe.stdout, narrow.stdout, 'no columns means 80');
  const pe = await w.run(['people'], { env: UTF, columns: 60 });
  for (const l of pe.stdout.split('\n').filter(Boolean)) assert.ok([...l].length <= 60, l);
});

test('sync: the progress line is one overwriting line on a terminal stderr, silent otherwise, and the summary still prints', async () => {
  const deps = {
    sync: async (mp, opts) => {
      assert.equal(typeof opts.onProgress, 'function' === typeof opts.onProgress ? 'function' : 'undefined');
      opts.onProgress?.({ folder: 'INBOX', direction: 'in', done: 312, uid: 312, uidMax: 1000 });
      return { complete: true, folders: [{ folder: 'INBOX', direction: 'in', attempted: true, uidvalidity: '1', reset: null, last_uid: 312, seen: 312, recorded: 312, duplicate: 0, over_limit: 0, skipped: [], bytes: 1, complete: true, error: null }] };
    },
  };
  const tty = await w.run(['sync'], { deps, stderrTty: true, env: UTF });
  assert.match(tty.stderr, /\r\x1b\[K(\x1b\[2m)?INBOX 312 read · 31% · \d+ s/);
  assert.ok(tty.stderr.endsWith('\r\x1b[K'), 'cleared before the summary');
  assert.match(tty.stdout, /^✓ +INBOX +in +seen 312/m);
  const quiet = await w.run(['sync'], { deps, env: UTF });
  assert.ok(!quiet.stderr.includes('\r') && !quiet.stderr.includes('INBOX'), 'nothing on a non-TTY');
  const json = await w.run(['sync', '--json'], { deps, stderrTty: true, env: UTF });
  assert.doesNotThrow(() => JSON.parse(json.stdout));
});
