// `backup` (SPEC B11.6): a git bundle that verifies and clones, the content archive through tar, and a push that never
// forces (proved against a local bare repository after a prune rewrote the history).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const json = (r) => JSON.parse(r.stdout);

test('the bundle: default path under ~/mailproof/backups, verifies, clones to the same history; --json shape; mode 0600', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const root = path.join(T.dir, 'default');
  const r = await w.run(['backup', '--json'], { deps: { now: () => new Date('2026-11-10T10:15:30Z') } });
  assert.equal(r.code, 0, r.stderr);
  const j = json(r);
  assert.deepEqual(Object.keys(j).sort(), ['bytes', 'bundle', 'commits', 'content', 'pushed'].sort());
  assert.equal(j.bundle, path.join(w.home, 'mailproof', 'backups', 'acme-20261110T101530Z.bundle'));
  assert.equal(j.content, null);
  assert.equal(j.pushed, null);
  assert.equal(j.bytes, fs.statSync(j.bundle).size);
  assert.equal(fs.statSync(j.bundle).mode & 0o777, 0o600);
  assert.equal(j.commits, Number(git(root, 'rev-list', '--count', 'HEAD')));
  git(root, 'bundle', 'verify', j.bundle);
  // restore: a clone of the bundle is the trail
  const clone = path.join(makeTmpDir('mp-cli-restore-'), 'default');
  git(path.dirname(clone), 'clone', '-q', j.bundle, clone);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'HEAD'));
  const w2 = makeWorld({ accounts: { acme: account(path.dirname(clone)) } });
  const list = json(await w2.run(['list', '--json']));
  assert.equal(list.length, 6);
  assert.equal(json(await w2.run(['verify', T.r.signed.id, '--json'])).ok, true, 'the restored records verify offline');
  // the text output names the path and how to restore
  const t = await w.run(['backup'], { deps: { now: () => new Date('2026-11-10T11:00:00Z') } });
  assert.match(t.stdout, /^(ok|✓) saved to ~\/mailproof\/backups\/acme-20261110T110000Z\.bundle$/m);
  assert.match(t.stdout, /^ {2}[\d.]+ KiB, \d+ commits$/m, 'size in KiB and the commit count');
  assert.match(t.stdout, /^restore with:\n {2}git clone ~\/mailproof\/backups\/acme-20261110T110000Z\.bundle <dir>$/m, 'the restore command on its own line');
  // last backup is remembered for status
  assert.match(json(await w.run(['status', '--json'])).acme.lastBackup.path, /acme-20261110T110000Z\.bundle$/);
});

test('--out: the directory must exist, an existing file is never overwritten, a bad trail is 1', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const dir = makeTmpDir('mp-cli-out-');
  const out = path.join(dir, 'mine.bundle');
  assert.equal((await w.run(['backup', '--out', path.join(dir, 'nope', 'x.bundle')])).code, 64);
  const ok = await w.run(['backup', '--out', out, '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(json(ok).bundle, out);
  const again = await w.run(['backup', '--out', out]);
  assert.equal(again.code, 64);
  assert.match(again.stderr, /already exists; a backup is never overwritten/);
  const w2 = makeWorld({ accounts: { empty: account(makeTmpDir('mp-cli-emptytrail-')) } });
  const e = await w2.run(['backup']);
  assert.equal(e.code, 1);
  assert.match(e.stderr, /no records yet/);
});

test('--with-content: a second file made by tar; restoring it with tar gives back the raw emails; the bundle never holds content', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const out = path.join(makeTmpDir('mp-cli-content-'), 'b.bundle');
  const r = await w.run(['backup', '--out', out, '--with-content', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = json(r);
  assert.equal(j.content.path, out.replace(/\.bundle$/, '.content.tar'));
  assert.equal(j.content.bytes, fs.statSync(j.content.path).size);
  assert.equal(fs.statSync(j.content.path).mode & 0o777, 0o600);
  const listing = execFileSync('tar', ['-tf', j.content.path], { encoding: 'utf8' });
  assert.match(listing, /raw\/[0-9a-f]{2}\/[0-9a-f]{32}\.eml/);
  const dest = makeTmpDir('mp-cli-untar-');
  execFileSync('tar', ['-C', dest, '-xf', j.content.path]);
  const id = T.r.signed.id;
  assert.deepEqual(fs.readFileSync(path.join(dest, 'raw', id.slice(0, 2), `${id}.eml`)), T.mails.signed.raw, 'the raw email, byte for byte');
  assert.ok(!execFileSync('git', ['bundle', 'list-heads', out], { cwd: path.join(T.dir, 'default'), encoding: 'utf8' }).includes('.eml'));
  // the content store off: a note, no archive, still exit 0
  const off = await buildThread({ content: { store: false } });
  const w2 = makeWorld({ accounts: { acme: account(off.dir, { content: { store: false } }) } });
  const n = await w2.run(['backup', '--out', path.join(makeTmpDir('mp-cli-off-'), 'b.bundle'), '--with-content']);
  assert.equal(n.code, 0, n.stderr);
  assert.match(n.stdout, /the content store is off or empty: no content archive written/);
  assert.ok(!/^content /m.test(n.stdout));
});

test('--with-content with no tar on PATH: exit 1 with the message, the bundle is kept', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const bin = makeTmpDir('mp-cli-gitonly-');
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const out = path.join(makeTmpDir('mp-cli-notar-'), 'b.bundle');
  const r = await w.spawn(['backup', '--out', out, '--with-content'], { env: { PATH: bin } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tar not found: install tar or run backup without --with-content/);
  assert.ok(fs.existsSync(out), 'the bundle was kept');
  assert.ok(!fs.existsSync(out.replace(/\.bundle$/, '.content.tar')));
});

test('--push: needs backupRemote (64), needs --yes (64, nothing pushed), pushes everything with no force; the content store is never pushed', async () => {
  const T = await buildThread();
  const remote = path.join(makeTmpDir('mp-cli-remote-'), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  const w = makeWorld({ accounts: { acme: account(T.dir, { backupRemote: remote }), plain: account(makeTmpDir('mp-cli-plain-')) } });
  const root = path.join(T.dir, 'default');
  const none = await w.run(['backup', '--push', '--yes', '--account', 'plain']);
  assert.equal(none.code, 64);
  assert.match(none.stderr, /no backupRemote/);
  const outs = () => path.join(makeTmpDir('mp-cli-pushout-'), 'b.bundle');
  const no = await w.run(['backup', '--push', '--account', 'acme', '--out', outs()]);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /Proof records contain the signed headers of your mail/);
  assert.match(no.stderr, /\d+ commits would be pushed/);
  assert.match(no.stderr, /add --yes to proceed/);
  assert.equal(git(remote, 'branch', '--list'), '', 'nothing was pushed');
  const yes = await w.run(['backup', '--push', '--yes', '--account', 'acme', '--out', outs(), '--json']);
  assert.equal(yes.code, 0, yes.stderr);
  const j = json(yes);
  assert.equal(j.pushed.remote, remote);
  assert.ok(j.pushed.refs.some((r) => /refs\/heads\/main/.test(r)));
  assert.equal(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'));
  assert.ok(!git(remote, 'ls-tree', '-r', '--name-only', 'main').includes('.eml'), 'no content went to the remote');
  const text = await w.run(['backup', '--push', '--yes', '--account', 'acme', '--out', outs()]);
  assert.match(text.stdout, /^Proof records contain the signed headers/m, 'the warning is printed before a push');
  assert.match(text.stdout, /^ {2}pushed to /m);
});

test('after a prune the push is rejected, mailproof never forces, the remote keeps its history and the user is told why', async () => {
  const T = await buildThread();
  const remote = path.join(makeTmpDir('mp-cli-remote2-'), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  const w = makeWorld({ accounts: { acme: account(T.dir, { backupRemote: remote }) } });
  const root = path.join(T.dir, 'default');
  const outDir = makeTmpDir('mp-cli-rej-');
  assert.equal((await w.run(['backup', '--push', '--yes', '--out', path.join(outDir, '1.bundle')])).code, 0);
  const remoteHead = git(remote, 'rev-parse', 'main');
  assert.equal(remoteHead, git(root, 'rev-parse', 'HEAD'));
  const pruned = await w.run(['prune', '--before', '2026-11-01T10:04:00Z', '--yes']);
  assert.equal(pruned.code, 0, pruned.stderr);
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), remoteHead, 'the history was rewritten');
  const r = await w.run(['backup', '--push', '--yes', '--out', path.join(outDir, '2.bundle')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected/);
  assert.match(r.stderr, /mailproof never forces a push/);
  assert.match(r.stderr, /remote keeps its history as an archive/);
  assert.ok(fs.existsSync(path.join(outDir, '2.bundle')), 'the local bundle was still written');
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead, 'the remote still holds the pre-prune history');
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes(`records/${T.r.req.id.slice(0, 2)}/${T.r.req.id}.json`), 'pruned records are still in the remote');
  // and the JSON mode keeps stdout empty on the failure
  const jr = await w.run(['backup', '--push', '--yes', '--json', '--out', path.join(outDir, '3.bundle')]);
  assert.equal(jr.code, 1);
  assert.equal(jr.stdout, '');
});

test('a push to an unreachable remote is 75 (a config with a credential in the URL no longer loads, see cli-config.test.js)', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir, { backupRemote: 'https://127.0.0.1:1/nope.git' }) } });
  const no = await w.run(['backup', '--push', '--out', path.join(makeTmpDir('mp-cli-net-'), '1.bundle')]);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /https:\/\/127\.0\.0\.1:1\/nope\.git/);
  const r = await w.run(['backup', '--push', '--yes', '--out', path.join(makeTmpDir('mp-cli-net-'), '2.bundle')]);
  assert.equal(r.code, 75, r.stderr);
});

test('--with-content: an existing <out>.content.tar is refused and left intact; the new tar exists 0600 before tar writes to it', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const dir = makeTmpDir('mp-cli-tarwx-');
  const out = path.join(dir, 'b.bundle');
  const tarPath = path.join(dir, 'b.content.tar');
  fs.writeFileSync(tarPath, 'older backup');
  const r = await w.run(['backup', '--out', out, '--with-content']);
  assert.equal(r.code, 64, r.stderr);
  assert.match(r.stderr, /a backup is never overwritten/);
  assert.equal(fs.readFileSync(tarPath, 'utf8'), 'older backup', 'left intact');

  // a tar shim records the mode of the target file at the moment tar starts
  const bin = makeTmpDir('mp-cli-tarshim-');
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
  const seen = path.join(bin, 'seen');
  const realStat = execFileSync('which', ['stat'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\n("${realStat}" -c %a "$4" 2>/dev/null || echo none) > "${seen}"\nexec "${realTar}" "$@"\n`, { mode: 0o755 });
  const out2 = path.join(makeTmpDir('mp-cli-tarmode-'), 'b.bundle');
  const ok = await w.spawn(['backup', '--out', out2, '--with-content'], { env: { PATH: bin } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), '600', 'created 0600 before tar writes');
  assert.equal(fs.statSync(out2.replace(/\.bundle$/, '.content.tar')).mode & 0o777, 0o600);
});

test('the bundle is written in a private 0700 directory next to --out and moved into place 0600; no temp dir is left, on success or failure', async () => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const realStat = execFileSync('which', ['stat'], { encoding: 'utf8' }).trim();
  const leftovers = (d) => fs.readdirSync(d).filter((n) => n.startsWith('.mailproof-bundle-'));

  // a git shim records the mode of the directory the bundle is created in, then runs the real git
  const bin = makeTmpDir('mp-cli-gitshim-');
  const seen = path.join(bin, 'seen');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = bundle ] && [ "$2" = create ]; then\n  "${realStat}" -c %a "$(dirname "$3")" > "${seen}"\nfi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const dir = makeTmpDir('mp-cli-bundledir-');
  fs.chmodSync(dir, 0o755); // a shared directory: the bundle must still never be readable by others
  const out = path.join(dir, 'b.bundle');
  const ok = await w.spawn(['backup', '--out', out], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), '700', 'the bundle directory is private while it is written');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(dir), []);

  // a failing `bundle create`: the same exit code and message as before, and no temp dir left
  const bad = makeTmpDir('mp-cli-gitfail-');
  fs.writeFileSync(path.join(bad, 'git'), `#!/bin/sh\nif [ "$1" = bundle ] && [ "$2" = create ]; then echo boom >&2; exit 1; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const dir2 = makeTmpDir('mp-cli-bundlefail-');
  const out2 = path.join(dir2, 'b.bundle');
  const r = await w.spawn(['backup', '--out', out2], { env: { PATH: `${bad}:${process.env.PATH}` } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /git bundle failed: .*boom/);
  assert.deepEqual(fs.readdirSync(dir2), [], 'nothing left behind');

  // a failing `bundle verify`: removed, same warning, no temp dir left
  const badv = makeTmpDir('mp-cli-gitverify-');
  fs.writeFileSync(path.join(badv, 'git'), `#!/bin/sh\nif [ "$1" = bundle ] && [ "$2" = verify ]; then echo nope >&2; exit 1; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const dir3 = makeTmpDir('mp-cli-verifyfail-');
  const r3 = await w.spawn(['backup', '--out', path.join(dir3, 'b.bundle')], { env: { PATH: `${badv}:${process.env.PATH}` } });
  assert.equal(r3.code, 1, r3.stderr);
  assert.match(r3.stderr, /the bundle did not verify and was removed: nope/);
  assert.deepEqual(fs.readdirSync(dir3), []);
});

for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EMLINK']) {
  test(`--out where hard links are refused (${code}): falls back to an exclusive copy, 0600, verified, no temp left, never overwrites`, async (t) => {
    const T = await buildThread();
    const w = makeWorld({ accounts: { acme: account(T.dir) } });
    const root = path.join(T.dir, 'default');
    const dir = makeTmpDir('mp-cli-nolink-');
    const out = path.join(dir, 'x.bundle');
    const linkMock = mock.method(fsp, 'link', async () => { throw Object.assign(new Error('no links here'), { code }); });
    t.after(() => linkMock.mock.restore());
    const r = await w.run(['backup', '--out', out, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(linkMock.mock.callCount() >= 1, 'fs.link was attempted (and refused)');
    assert.equal(json(r).bundle, out);
    git(root, 'bundle', 'verify', out);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['x.bundle'], 'no .mailproof-bundle-* left');
    const before = fs.readFileSync(out);
    const again = await w.run(['backup', '--out', out]);
    assert.equal(again.code, 64);
    assert.match(again.stderr, /already exists; a backup is never overwritten/);
    assert.deepEqual(fs.readFileSync(out), before);
  });
}

test('--out: a link error that is not a no-hard-links code still fails and leaves nothing behind', async (t) => {
  const T = await buildThread();
  const w = makeWorld({ accounts: { acme: account(T.dir) } });
  const dir = makeTmpDir('mp-cli-linkerr-');
  const out = path.join(dir, 'x.bundle');
  const linkMock = mock.method(fsp, 'link', async () => { throw Object.assign(new Error('disk on fire'), { code: 'EIO' }); });
  t.after(() => linkMock.mock.restore());
  const r = await w.run(['backup', '--out', out]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing left, no copy fallback');
});

test('--push: a backupRemote that starts with "-" is a bad remote, never an option', async () => {
  const T = await buildThread();
  const remote = path.join(makeTmpDir('mp-cli-remote-'), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  // as an option, --repo=<bare> would make the push succeed
  const w = makeWorld({ accounts: { acme: account(T.dir, { backupRemote: `--repo=${remote}` }) } });
  const r = await w.run(['backup', '--push', '--yes', '--out', path.join(makeTmpDir('mp-cli-pushout-'), 'b.bundle'), '--json']);
  assert.notEqual(r.code, 0, 'the push failed as a bad remote');
  assert.equal(git(remote, 'branch', '--list'), '', 'no option took effect: nothing was pushed');
});
