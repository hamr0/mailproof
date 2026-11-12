// MCP parity with the CLI (SPEC B12.3, owner decision 2026-11-12): status, stamp, verifyBundle, export and backup, and the library
// methods behind them (`status()`, `backup()`, `export({ dryRun })`). In-process MCP over a throwaway trail of synthetic signed mail;
// `ots` is a script, the push goes to a local bare repository or a closed local port: IMAP and the network are never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof, verifyBundle } from '../../src/index.js';
import { redactUrl, remoteHost } from '../../src/proof/backup.js';
import { bundleWorld, fakeOts, treeOf } from '../helpers/bundle.js';
import { makeWorld, account } from '../helpers/cli.js';
import { inProcess } from '../helpers/mcp.js';
import { makeTmpDir } from '../helpers/tmp.js';

const BOB = 'bob@bob.example';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A trail of three mails with Bob (one sent), a sealed first batch, and an MCP server over it. */
async function setup({ remote, mcp, otsBin, ots = fakeOts() } = {}) {
  const w = bundleWorld({ otsBin: otsBin === undefined ? ots.bin : otsBin });
  await w.rec({ who: BOB, tag: 'a', subject: 'Contract draft' });
  await w.rec({ who: BOB, tag: 'b', out: true, subject: 'Re: Contract draft' });
  await w.rec({ who: 'carol@carol.example', tag: 'c' });
  const inDir = makeTmpDir('mp-par-in-');
  const outDir = makeTmpDir('mp-par-out-');
  const world = makeWorld({ config: { v: 1, accounts: { work: account(w.trailDir, { ...(remote ? { backupRemote: remote } : {}) }) }, mcp: mcp ?? { inputDirs: [inDir], outputDir: outDir } } });
  const m = await inProcess(world, { deps: { makeMailproof: () => w.mp, now: w.now } });
  return { w, m, world, ots, inDir, outDir, realOut: fs.realpathSync(outDir) };
}
const finish = async (s) => { await s.m.close(); };

// ---- library: status() ----

test('status(): an empty trail, a populated trail without an index, a current index, the seal off, the content store off', async () => {
  const dir = makeTmpDir('mp-par-empty-');
  const empty = new Mailproof({ trailDir: dir, worker: { size: 0 } });
  const e = await empty.status();
  assert.equal(e.trail, path.join(dir, 'default'));
  assert.equal(e.records, null);
  assert.equal(e.index, 'absent');
  assert.equal(e.pendingStamps, null);
  assert.deepEqual(e.content, { files: 0, bytes: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'default')), false, 'status creates nothing');
  await empty.close();

  const s = await setup();
  const idx = path.join(s.w.trailDir, '.default.index.sqlite');
  const before = await s.w.mp.status();
  assert.equal(before.index, 'absent');
  assert.deepEqual(before.records, { total: 3, totalSource: 'git', in: null, out: null, oldest: null, newest: null, verified: null, unverified: null });
  assert.equal(before.content.files, 3);
  assert.equal(before.pendingStamps, 0);
  assert.equal(before.seal.enabled, true);
  assert.equal(fs.existsSync(idx), false, 'status never builds the index');
  await s.w.mp.list();
  const after = await s.w.mp.status();
  assert.equal(after.index, 'present');
  assert.equal(after.records.totalSource, 'index');
  assert.equal(after.records.total, 3); assert.equal(after.records.in, 2); assert.equal(after.records.out, 1);
  assert.equal(after.records.verified + after.records.unverified, after.records.in, 'the verified counts are of received mail');
  assert.match(after.records.oldest, /^2026-11-01T/);
  // seal and content switched off
  const off = new Mailproof({ trailDir: s.w.trailDir, worker: { size: 0 }, otsBin: null, content: { store: false } });
  const o = await off.status();
  assert.equal(o.content, 'off'); assert.equal(o.pendingStamps, null); assert.equal(o.seal.enabled, false);
  await off.close(); await finish(s);
});

test('status(): a damaged index file is reported, never thrown', async () => {
  const s = await setup();
  await s.w.mp.list();
  fs.writeFileSync(path.join(s.w.trailDir, '.default.index.sqlite'), 'not sqlite');
  const st = await s.w.mp.status();
  assert.ok(['unreadable', 'stale', 'unknown'].includes(st.index), st.index);
  assert.equal(st.records.total, 3);
  await finish(s);
});

// ---- MCP: status ----

test('MCP status: deep-equals the library for the trail, adds the account facts, config check and version; read-only', async () => {
  const s = await setup();
  const lib = await s.w.mp.status();
  const r = await s.m.call('status');
  assert.equal(r.isError, false, r.text);
  for (const k of Object.keys(lib)) assert.deepEqual(r.json[k], lib[k], k);
  assert.equal(r.json.user, 'me@owner.example');
  assert.equal(r.json.lastSync, null); assert.equal(r.json.lastBackup, null); assert.deepEqual(r.json.watch, { running: false });
  assert.deepEqual(r.json.config, { path: s.world.configFile, ok: true });
  assert.equal(r.json.version, 'test');
  assert.match(r.json.updateCommand, /^npm install -g mailproof@latest$/);
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'status');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, undefined);
  assert.equal(fs.existsSync(s.m.mcp.auditFile), false, 'a read tool writes no audit line');
  await finish(s);
});

test('MCP status: a config that no longer validates is reported, not thrown', async () => {
  const s = await setup();
  fs.chmodSync(s.world.configFile, 0o644);
  const r = await s.m.call('status');
  assert.equal(r.isError, false);
  assert.equal(r.json.config.ok, false); assert.match(r.json.config.error, /./);
  await finish(s);
});

// ---- MCP: stamp ----

test('MCP stamp: seals through the (fake) ots, same shape as the library, only `ots stamp` runs, audited, idempotent', async () => {
  const s = await setup();
  const r = await s.m.call('stamp');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.enabled, true); assert.equal(r.json.ran, true);
  assert.equal(r.json.manifests.length, 1); assert.equal(r.json.manifests[0].records, 3); assert.equal(r.json.stamped, 1);
  assert.deepEqual(Object.keys(r.json).sort(), Object.keys(await s.w.mp.stamp()).sort(), 'the library result, unchanged');
  assert.ok(s.ots.calls().every((c) => /^(stamp|upgrade) /.test(c)), s.ots.calls().join(','));
  const again = await s.m.call('stamp');
  assert.equal(again.json.manifests.length, 0, 'nothing new: no new manifest');
  assert.match(fs.readFileSync(s.m.mcp.auditFile, 'utf8'), /"tool":"stamp"/);
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'stamp');
  assert.deepEqual({ ...tool.annotations, title: undefined }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: undefined });
  assert.match(tool.description, /32-byte hash/);
  await finish(s);
});

test('MCP stamp: a missing ots is a result with error, not a failure; the seal off does nothing', async () => {
  const missing = await setup({ otsBin: path.join(makeTmpDir('mp-par-noots-'), 'ots') });
  const r = await missing.m.call('stamp');
  assert.equal(r.isError, false); assert.match(r.json.error, /ots not installed/);
  await finish(missing);
  const off = await setup({ otsBin: null });
  const o = await off.m.call('stamp');
  assert.equal(o.json.enabled, false);
  await finish(off);
});

// ---- MCP: verifyBundle ----

test('MCP verifyBundle: a bundle inside an input folder is checked; outside, relative, a file, a symlink out, are refused', async () => {
  const s = await setup();
  const bundle = path.join(s.inDir, 'b');
  const made = await s.w.mp.export({ with: [BOB], out: bundle });
  const lib = await verifyBundle(bundle, { ots: null });
  const r = await s.m.call('verifyBundle', { dir: bundle });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.ok, lib.ok); assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.counts.records, lib.counts.records);
  assert.equal(r.json.bundle.sha256 ?? made.bundle_sha256, made.bundle_sha256);
  assert.equal((await s.m.call('verifyBundle', { dir: bundle, expect: made.bundle_sha256 })).json.ok, true);
  assert.equal((await s.m.call('verifyBundle', { dir: bundle, expect: '0'.repeat(64) })).json.ok, false, 'a wrong --expect fails the check');
  assert.equal((await s.m.call('verifyBundle', { dir: bundle, expect: 'xyz' })).error.code, 'ERR_BAD_ARGUMENT');
  assert.equal((await s.m.call('verifyBundle', { dir: bundle, strict: true })).json.ok, false, 'strict: unsealed records fail');

  const outside = path.join(makeTmpDir('mp-par-outside-'), 'b');
  await s.w.mp.export({ with: [BOB], out: outside });
  assert.equal((await s.m.call('verifyBundle', { dir: outside })).error.code, 'ERR_PATH_NOT_ALLOWED');
  assert.equal((await s.m.call('verifyBundle', { dir: path.join(s.inDir, '..', path.basename(path.dirname(outside)), 'b') })).error.code, 'ERR_PATH_NOT_ALLOWED', '.. resolving outside is refused');
  assert.equal((await s.m.call('verifyBundle', { dir: 'b' })).error.code, 'ERR_BAD_ARGUMENT');
  assert.equal((await s.m.call('verifyBundle', { dir: path.join(bundle, 'bundle.json') })).error.code, 'ERR_PATH_NOT_ALLOWED', 'a file is not a bundle folder');
  fs.symlinkSync(outside, path.join(s.inDir, 'link'));
  assert.equal((await s.m.call('verifyBundle', { dir: path.join(s.inDir, 'link') })).error.code, 'ERR_PATH_NOT_ALLOWED', 'a symlink out of the folder is refused');
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'verifyBundle');
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.inputSchema.properties.account, undefined, 'account-free');
  await finish(s);
});

test('MCP verifyBundle: with no input folders configured, paths are refused', async () => {
  const s = await setup({ mcp: { outputDir: makeTmpDir('mp-par-out-') } });
  assert.equal((await s.m.call('verifyBundle', { dir: '/tmp' })).error.code, 'ERR_PATH_NOT_ALLOWED');
  await finish(s);
});

// ---- library: export({ dryRun }) ----

test('export({ dryRun }): the same summary as the real export, a selection list, and nothing written or left behind', async () => {
  const s = await setup();
  const parent = makeTmpDir('mp-par-dry-');
  const out = path.join(parent, 'b');
  const dry = await s.w.mp.export({ with: [BOB], out, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(fs.readdirSync(parent), [], 'no bundle, no temp directory');
  assert.deepEqual(dry.selection.map((x) => [x.direction, x.subject]), [['in', 'Contract draft'], ['out', 'Re: Contract draft']]);
  for (const x of dry.selection) assert.match(x.id, /^[0-9a-f]{32}$/);
  assert.match(dry.selection[0].from, /bob@bob\.example/);
  const real = await s.w.mp.export({ with: [BOB], out });
  const { dryRun, selection, ...rest } = dry;
  assert.deepEqual(rest, real, 'dry run and real export agree on everything, including bundle_sha256');
  assert.equal(real.dryRun, undefined);
  // refusals still apply to a dry run
  await assert.rejects(s.w.mp.export({ with: [BOB], out, dryRun: true }), { code: 'ERR_EXPORT_EXISTS' });
  await assert.rejects(s.w.mp.export({ with: ['nobody@nowhere.example'], out: path.join(parent, 'z'), dryRun: true }), { code: 'ERR_EXPORT_EMPTY' });
  await assert.rejects(s.w.mp.export({ with: [BOB], out: path.join(parent, 'y'), dryRun: 'yes' }), TypeError);
  await finish(s);
});

// ---- MCP: export ----

test('MCP export: without confirm a preview and no files; with confirm the bundle lands under the output folder, equal to the library', async () => {
  const s = await setup();
  const args = { with: [BOB], out: 'bob-bundle' };
  const p = await s.m.call('export', args);
  assert.equal(p.isError, false, p.text);
  assert.equal(p.json.executed, false);
  assert.equal(p.json.preview.records, 2);
  assert.equal(p.json.preview.out, path.join(s.realOut, 'bob-bundle'));
  assert.equal(p.json.preview.selection.length, 2);
  assert.deepEqual(Object.keys(p.json.preview.selection[0]).sort(), ['captured', 'direction', 'from', 'id', 'subject']);
  assert.match(p.json.preview.disclosure, /addresses/); assert.match(p.json.preview.disclosure, /hash/); assert.match(p.json.preview.disclosure, /completeness/);
  assert.match(p.json.next, /confirm: true/);
  assert.deepEqual(fs.readdirSync(s.outDir), [], 'a preview changes nothing: no bundle, no temp directory');
  assert.deepEqual((await s.m.call('export', { ...args, confirm: false })).json.executed, false);
  assert.deepEqual(fs.readdirSync(s.outDir), []);

  const c = await s.m.call('export', { ...args, confirm: true });
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.executed, true);
  const res = c.json.result;
  assert.equal(res.out, path.join(s.realOut, 'bob-bundle'));
  assert.deepEqual(fs.readdirSync(s.outDir), ['bob-bundle']);
  assert.equal(res.bundle_sha256, sha(fs.readFileSync(path.join(res.out, 'bundle.json'))));
  assert.equal((await verifyBundle(res.out, { ots: null })).ok, true);
  const lib = await s.w.mp.export({ with: [BOB], out: path.join(makeTmpDir('mp-par-lib-'), 'x') });
  const { out: _a, ...a } = res; const { out: _b, ...b } = lib;
  assert.deepEqual(a, b, 'the result is the library\'s');
  assert.equal(c.json.result.records, 2);
  assert.match(fs.readFileSync(s.m.mcp.auditFile, 'utf8'), /"tool":"export"/);
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'export');
  assert.deepEqual({ ...tool.annotations, title: undefined }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: undefined });
  await finish(s);
});

test('MCP export: only a plain name under the output folder; absolute, .., nested and symlink targets are refused and nothing is written', async () => {
  const s = await setup();
  const elsewhere = makeTmpDir('mp-par-else-');
  for (const out of [path.join(elsewhere, 'b'), '../escape', 'a/b', '..', '.', 'a\\b', '', '/']) {
    for (const confirm of [false, true]) {
      const r = await s.m.call('export', { with: [BOB], out, confirm });
      assert.equal(r.isError, true, JSON.stringify(out));
      assert.ok(['ERR_BAD_ARGUMENT'].includes(r.error.code), `${JSON.stringify(out)}: ${r.error.code}`);
    }
  }
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(fs.readdirSync(s.outDir), []);
  assert.deepEqual(fs.readdirSync(path.dirname(s.outDir)).filter((n) => n === 'escape'), []);
  // a symlink in the output folder is not followed
  fs.symlinkSync(elsewhere, path.join(s.outDir, 'evil'));
  const sym = await s.m.call('export', { with: [BOB], out: 'evil', confirm: true });
  assert.equal(sym.error.code, 'ERR_EXPORT_EXISTS');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  // an existing bundle is never overwritten; an unknown counterparty is empty
  assert.equal((await s.m.call('export', { with: [BOB], out: 'one', confirm: true })).json.executed, true);
  assert.equal((await s.m.call('export', { with: [BOB], out: 'one', confirm: true })).error.code, 'ERR_EXPORT_EXISTS');
  assert.equal((await s.m.call('export', { with: ['nobody@nowhere.example'], out: 'two' })).error.code, 'ERR_EXPORT_EMPTY');
  assert.equal((await s.m.call('export', { with: ['not an address'], out: 'two' })).error.code, 'ERR_BAD_ARGUMENT');
  assert.equal((await s.m.call('export', { with: [BOB], confirm: true })).isError, false, 'the default name is used');
  assert.ok(fs.readdirSync(s.outDir).some((n) => /^mailproof-bundle-work-\d{8}-\d{6}$/.test(n)));
  // with no output folder configured nothing can be written
  const none = await setup({ mcp: { inputDirs: [makeTmpDir('mp-par-in-')] } });
  assert.equal((await none.m.call('export', { with: [BOB], out: 'x' })).error.code, 'ERR_PATH_NOT_ALLOWED');
  assert.equal((await none.m.call('backup', {})).error.code, 'ERR_PATH_NOT_ALLOWED');
  await finish(none); await finish(s);
});

test('MCP export: tar makes one .tar file; after/before narrow the selection', async () => {
  const s = await setup();
  const t = await s.m.call('export', { with: [BOB], out: 'pack', tar: true, confirm: true });
  assert.equal(t.isError, false, t.text);
  assert.equal(t.json.result.out, path.join(s.realOut, 'pack.tar'));
  assert.ok(fs.statSync(t.json.result.out).isFile());
  const day = (await s.w.mp.list({ with: BOB })).map((r) => r.captured).sort()[1];
  const n = await s.m.call('export', { with: [BOB], after: day, out: 'late' });
  assert.equal(n.json.preview.records, 1);
  assert.equal((await s.m.call('export', { with: [BOB], after: 'yesterdayish', out: 'late' })).error.code, 'ERR_BAD_ARGUMENT');
  await finish(s);
});

// ---- library: backup() ----

test('backup(): a verified bundle that clones, 0600, never overwrites; the content archive; dryRun writes nothing', async () => {
  const s = await setup();
  const dir = makeTmpDir('mp-par-bk-');
  const out = path.join(dir, 'x.bundle');
  const dry = await s.w.mp.backup({ out, withContent: true, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.bytes, null);
  assert.equal(dry.commits, Number(git(s.w.root, 'rev-list', '--count', 'HEAD')));
  assert.deepEqual(dry.content, { path: path.join(dir, 'x.content.tar'), bytes: null });
  assert.equal(dry.pushed, null);
  assert.deepEqual(fs.readdirSync(dir), [], 'a dry run writes nothing');
  const r = await s.w.mp.backup({ out, withContent: true });
  assert.equal(r.bundle, out); assert.equal(r.bytes, fs.statSync(out).size); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.equal(r.commits, dry.commits);
  assert.equal(r.content.path, dry.content.path); assert.ok(r.content.bytes > 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['x.bundle', 'x.content.tar']);
  git(s.w.root, 'bundle', 'verify', out);
  await assert.rejects(s.w.mp.backup({ out }), { code: 'ERR_BACKUP_EXISTS' });
  await assert.rejects(s.w.mp.backup({ out: path.join(dir, 'nodir', 'y.bundle') }), { code: 'ERR_BACKUP_NO_DIR' });
  const made = await s.w.mp.backup({ out: path.join(dir, 'nodir', 'y.bundle'), mkdir: true });
  assert.ok(fs.existsSync(made.bundle));
  // the default location is beside the trail, created on demand
  const d = await s.w.mp.backup();
  assert.equal(path.dirname(d.bundle), path.join(s.w.trailDir, '.default.backups'));
  assert.match(path.basename(d.bundle), /^default-\d{8}T\d{6}Z\.bundle$/);
  // bad options
  await assert.rejects(s.w.mp.backup({ push: true, out: path.join(dir, 'p.bundle') }), TypeError);
  await assert.rejects(s.w.mp.backup({ nope: 1 }), TypeError);
  await assert.rejects(s.w.mp.backup({ withContent: 'yes' }), TypeError);
  // an empty trail has nothing to back up
  const e = new Mailproof({ trailDir: makeTmpDir('mp-par-bk-empty-'), worker: { size: 0 } });
  await assert.rejects(e.backup({ out: path.join(dir, 'e.bundle') }), { code: 'ERR_BACKUP_EMPTY' });
  await e.close(); await finish(s);
});

test('backup(): credentials in a remote URL never appear in a result, a preview or a failure; the host is named', async () => {
  const s = await setup();
  const dir = makeTmpDir('mp-par-cred-');
  const remote = 'https://alice:s3cret-token@127.0.0.1:1/x.git';
  const dry = await s.w.mp.backup({ out: path.join(dir, 'a.bundle'), push: true, remote, dryRun: true });
  assert.deepEqual(dry.pushed, { remote: 'https://***@127.0.0.1:1/x.git', host: '127.0.0.1', refs: [] });
  const r = await s.w.mp.backup({ out: path.join(dir, 'a.bundle'), push: true, remote });
  assert.equal(r.pushError.kind, 'network');
  assert.ok(fs.existsSync(r.bundle), 'the bundle is kept when the push fails');
  assert.equal(JSON.stringify([dry, r]).includes('s3cret'), false);
  assert.equal(JSON.stringify([dry, r]).includes('alice'), false);
  assert.equal(r.pushed, null);
  assert.equal(redactUrl(remote), 'https://***@127.0.0.1:1/x.git');
  assert.equal(remoteHost('https://u:p@git.example.com/a/b.git'), 'git.example.com');
  assert.equal(remoteHost('ssh://git@git.example.com:2222/a.git'), 'git.example.com');
  assert.equal(remoteHost('git@github.com:me/x.git'), 'github.com');
  assert.equal(remoteHost('/srv/backups/x.git'), null);
  await finish(s);
});

// ---- MCP: backup ----

test('MCP backup: preview writes nothing; confirm writes under the output folder; the state remembers it; push only with confirm', async () => {
  const bare = makeTmpDir('mp-par-bare-');
  git(bare, 'init', '-q', '--bare');
  const s = await setup({ remote: bare });
  const p = await s.m.call('backup', { out: 'mine', push: true });
  assert.equal(p.isError, false, p.text);
  assert.equal(p.json.executed, false);
  assert.equal(p.json.preview.bundle, path.join(s.realOut, 'mine.bundle'));
  assert.deepEqual(p.json.preview.push, { remote: bare, host: null, forced: false });
  assert.match(p.json.preview.disclosure, /signed headers/); assert.match(p.json.preview.disclosure, /Push only to a remote you trust/);
  assert.equal(p.json.preview.commits, Number(git(s.w.root, 'rev-list', '--count', 'HEAD')));
  assert.deepEqual(fs.readdirSync(s.outDir), [], 'a preview writes nothing');
  assert.throws(() => git(bare, 'rev-parse', 'main'), 'and pushes nothing');

  const c = await s.m.call('backup', { out: 'mine', push: true, withContent: true, confirm: true });
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.executed, true);
  assert.equal(c.json.result.bundle, path.join(s.realOut, 'mine.bundle'));
  assert.deepEqual(fs.readdirSync(s.outDir).sort(), ['mine.bundle', 'mine.content.tar']);
  git(s.w.root, 'bundle', 'verify', c.json.result.bundle);
  assert.equal(fs.statSync(c.json.result.bundle).mode & 0o777, 0o600);
  assert.deepEqual(c.json.result.pushed.refs.length > 0, true);
  assert.equal(git(bare, 'rev-parse', 'main'), git(s.w.root, 'rev-parse', 'main'), 'the push reached the remote');
  assert.equal((await s.m.call('status')).json.lastBackup.path, c.json.result.bundle, 'status shows the backup');
  assert.match(fs.readFileSync(s.m.mcp.auditFile, 'utf8'), /"tool":"backup"/);
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'backup');
  assert.deepEqual({ ...tool.annotations, title: undefined }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: undefined });
  await finish(s);
});

test('MCP backup: a name that is a path, an existing file, no remote for push, an unreachable remote', async () => {
  const s = await setup();
  for (const out of ['/tmp/x', '../x', 'a/b', '..']) assert.equal((await s.m.call('backup', { out, confirm: true })).error.code, 'ERR_BAD_ARGUMENT', out);
  assert.deepEqual(fs.readdirSync(s.outDir), []);
  assert.equal((await s.m.call('backup', { push: true })).error.code, 'ERR_BAD_ARGUMENT', 'no backupRemote in the config');
  assert.equal((await s.m.call('backup', { out: 'x', confirm: true })).json.executed, true);
  assert.equal((await s.m.call('backup', { out: 'x.bundle', confirm: true })).error.code, 'ERR_BACKUP_EXISTS');
  assert.equal((await s.m.call('backup', { confirm: true })).json.executed, true, 'the default name');
  assert.ok(fs.readdirSync(s.outDir).some((n) => /^work-\d{8}T\d{6}Z\.bundle$/.test(n)));
  await finish(s);
  const down = await setup({ remote: 'https://127.0.0.1:1/x.git' });
  const p = await down.m.call('backup', { out: 'b', push: true });
  assert.equal(p.json.preview.push.host, '127.0.0.1');
  const c = await down.m.call('backup', { out: 'b', push: true, confirm: true });
  assert.equal(c.isError, false, 'a failed push is a result, the bundle was written');
  assert.equal(c.json.result.pushError.kind, 'network');
  assert.ok(fs.existsSync(path.join(down.realOut, 'b.bundle')));
  await finish(down);
});

test('MCP backup: an empty trail says so', async () => {
  const w = makeWorld({ config: { v: 1, accounts: { e: account(makeTmpDir('mp-par-e-')) }, mcp: { outputDir: makeTmpDir('mp-par-out-') } } });
  const m = await inProcess(w);
  assert.equal((await m.call('backup', {})).error.code, 'ERR_BACKUP_EMPTY');
  const st = await m.call('status');
  assert.equal(st.json.records, null);
  await m.close();
});

// ---- the output tree is untouched by anything else ----

test('the output folder holds nothing but what the confirmed calls wrote', async () => {
  const s = await setup();
  await s.m.call('export', { with: [BOB], out: 'e1', confirm: true });
  await s.m.call('backup', { out: 'b1', confirm: true });
  const tree = treeOf(s.outDir);
  assert.ok(tree.every((f) => f.startsWith('e1/') || f === 'b1.bundle'), tree.join(','));
  assert.ok(!tree.some((f) => f.includes('.mailproof-')), 'no temp leftovers');
  await finish(s);
});
