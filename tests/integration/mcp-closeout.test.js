// The CLI/MCP parity close-out (owner decision 2026-11-12): trust profiles by name and a listing (one definition for the CLI and MCP),
// status counts through the library's `status({ refresh: true })`, the install facts, and the MCP folders being the CLI's `~/mailproof/*`
// folders by default. In-process MCP over a throwaway trail of synthetic signed mail; IMAP and the network are never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyBundle } from '../../src/index.js';
import { bundleWorld, fakeOts } from '../helpers/bundle.js';
import { makeWorld, account } from '../helpers/cli.js';
import { inProcess } from '../helpers/mcp.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { loadProfile, listProfiles, resolveProfile, profilesDir } from '../../src/cli/profiles.js';
import { installInfo, installFacts } from '../../src/cli/install.js';
import { mcpSettings, validateConfig } from '../../src/cli/config.js';
import { mcpFacts, mcpStatusLines } from '../../src/cli/mcp-setup.js';
import { styleOf } from '../../src/cli/style.js';

const BOB = 'bob@bob.example';

async function setup({ mcp, deps = {}, profiles = {} } = {}) {
  const w = bundleWorld({ otsBin: fakeOts().bin });
  await w.rec({ who: BOB, tag: 'a', subject: 'Contract draft' });
  await w.rec({ who: BOB, tag: 'b', out: true, subject: 'Re: Contract draft' });
  await w.rec({ who: 'carol@carol.example', tag: 'c' });
  const world = makeWorld({ config: { v: 1, accounts: { work: account(w.trailDir) }, ...(mcp === undefined ? {} : { mcp }) } });
  const pdir = path.join(world.cfgDir, 'mailproof', 'profiles');
  if (Object.keys(profiles).length) fs.mkdirSync(pdir, { recursive: true });
  for (const [n, body] of Object.entries(profiles)) fs.writeFileSync(path.join(pdir, `${n}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  const m = await inProcess(world, { deps: { makeMailproof: () => w.mp, now: w.now, ...deps } });
  return { w, m, world, home: world.home };
}

// ---- 1. profiles: one definition ----

test('profiles module: built-in default, named files, a listing with one-line meanings; resolveProfile takes undefined, a name or an object', async () => {
  const world = makeWorld({ accounts: {} });
  const dir = profilesDir(world.env);
  assert.equal(dir, path.join(world.cfgDir, 'mailproof', 'profiles'));
  assert.deepEqual(await listProfiles(world.env), [{ name: 'default', summary: 'DKIM signature verifies and covers the From', builtin: true }]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'strict.json'), JSON.stringify({ body: 'proven' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  assert.deepEqual((await listProfiles(world.env)).map((p) => p.name), ['default', 'broken', 'strict']);
  assert.deepEqual(await resolveProfile(undefined, world.env), { checks: { dkimAligned: true } });
  assert.deepEqual(await resolveProfile('strict', world.env), { body: 'proven' });
  const inline = { senders: ['@a.example'] };
  assert.equal(await resolveProfile(inline, world.env), inline);
  await assert.rejects(resolveProfile('nope', world.env), /nope/);
  await assert.rejects(resolveProfile('../strict', world.env), /name/, 'a name only: never a path');
  await assert.rejects(resolveProfile(5, world.env), /name or an object/);
  assert.deepEqual(await loadProfile('strict', world.env), { body: 'proven' });
});

test('MCP checkProfile: by name, by default (omitted), inline; an unknown name or a path is refused; profile is no longer required', async () => {
  const s = await setup({ profiles: { strict: { body: 'proven', link: ['signed'] } } });
  const id = (await s.m.call('list')).json[0].id;
  const byDefault = await s.m.call('checkProfile', { id });
  assert.equal(byDefault.isError, false, byDefault.text);
  assert.deepEqual(byDefault.json.rules, (await s.m.call('checkProfile', { id, profile: 'default' })).json.rules);
  const named = await s.m.call('checkProfile', { id, profile: 'strict' });
  assert.equal(named.isError, false, named.text);
  assert.deepEqual(named.json.failed.map((f) => f.rule).sort(), (await s.m.call('checkProfile', { id, profile: { body: 'proven', link: ['signed'] } })).json.failed.map((f) => f.rule).sort(), 'a name and the same profile inline agree');
  assert.equal((await s.m.call('checkProfile', { id, profile: { senders: ['@nobody.example'] } })).json.ok, false);
  assert.equal((await s.m.call('checkProfile', { id, profile: 'nope' })).error.code, 'ERR_BAD_ARGUMENT');
  assert.equal((await s.m.call('checkProfile', { id, profile: '/etc/passwd' })).error.code, 'ERR_BAD_ARGUMENT');
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'checkProfile');
  assert.deepEqual(tool.inputSchema.required, ['id']);
  assert.deepEqual(tool.inputSchema.properties.profile.type, ['string', 'object']);
  await s.m.close();
});

test('MCP profiles: the listing the CLI shows, read-only, no account', async () => {
  const s = await setup({ profiles: { strict: { body: 'proven' }, bad: '{nope' } });
  const r = await s.m.call('profiles');
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json, { dir: '~/.config/mailproof/profiles'.replace('~/.config', s.world.cfgDir), profiles: await listProfiles(s.world.env) });
  assert.equal(r.json.profiles[0].name, 'default'); assert.equal(r.json.profiles[0].builtin, true);
  assert.equal(r.json.profiles.find((p) => p.name === 'strict').summary, 'body proven');
  const tool = (await s.m.request('tools/list')).result.tools.find((t) => t.name === 'profiles');
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.inputSchema.properties.account, undefined);
  assert.equal(fs.existsSync(s.m.mcp.auditFile), false, 'a read writes no audit line');
  await s.m.close();
});

// ---- 2. status counts ----

test('library status({ refresh: true }) catches the index up; status() alone stays read-only; bad options throw', async () => {
  const s = await setup();
  const idx = path.join(s.w.trailDir, '.default.index.sqlite');
  assert.equal(fs.existsSync(idx), false);
  assert.equal((await s.w.mp.status()).records.in, null, 'no refresh: counts stay null');
  assert.equal(fs.existsSync(idx), false, 'and nothing is built');
  const r = await s.w.mp.status({ refresh: true });
  assert.equal(r.index, 'present');
  assert.deepEqual([r.records.total, r.records.in, r.records.out, r.records.verified + r.records.unverified], [3, 2, 1, 2]);
  assert.match(r.records.oldest, /^2026-/);
  await assert.rejects(s.w.mp.status({ refresh: 'yes' }), TypeError);
  await assert.rejects(s.w.mp.status({ nope: 1 }), TypeError);
  await s.m.close();
});

test('MCP status carries the same counts the CLI prints (refreshed), and the install facts', async () => {
  const s = await setup({ deps: { installInfo: () => ({ dev: true, dir: '/tmp/x/mailproof' }) } });
  const r = await s.m.call('status');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.index, 'present');
  assert.deepEqual([r.json.records.total, r.json.records.in, r.json.records.out], [3, 2, 1]);
  assert.equal(typeof r.json.records.verified, 'number'); assert.equal(typeof r.json.records.unverified, 'number');
  assert.deepEqual(r.json.install, { kind: 'dev-link', path: '/tmp/x/mailproof' });
  assert.match(r.json.updateCommand, /^npm install/);
  await s.m.close();
});

// ---- 3. install facts ----

test('installFacts: one detection (installInfo) for update and status; the path is tilded; kind dev-link or npm', () => {
  const env = { HOME: '/home/ana' };
  assert.deepEqual(installFacts({ installInfo: () => ({ dev: true, dir: '/home/ana/src/mailproof' }) }, env), { kind: 'dev-link', path: '~/src/mailproof' });
  assert.deepEqual(installFacts({ installInfo: () => ({ dev: false, dir: '/usr/lib/node_modules/mailproof' }) }, env), { kind: 'npm', path: '/usr/lib/node_modules/mailproof' });
  const real = installInfo();
  assert.equal(real.dev, true, 'this checkout is a development link');
  assert.deepEqual(installFacts({}, env).kind, 'dev-link');
});

// ---- 4. folders ----

test('mcpSettings: no block or no keys = the ~/mailproof defaults; outputDir null and inputDirs [] turn them off; explicit values win', () => {
  const env = { HOME: '/home/ana' };
  const cfg = (mcp) => validateConfig({ v: 1, accounts: { a: { user: 'a@b.example', trailDir: '/t', passCommand: 'x' } }, ...(mcp === undefined ? {} : { mcp }) }, env);
  const dflt = { inputDirs: ['/home/ana/mailproof'], outputDir: undefined };
  for (const mcp of [undefined, {}, { maxResponseBytes: 2048 }]) {
    const { config, problems } = cfg(mcp);
    assert.deepEqual(problems, []);
    const s = mcpSettings(config, env);
    assert.deepEqual([s.inputDirs, s.outputDir], [dflt.inputDirs, dflt.outputDir]);
  }
  const off = cfg({ outputDir: null, inputDirs: [] });
  assert.deepEqual(off.problems, []);
  const o = mcpSettings(off.config, env);
  assert.deepEqual([o.inputDirs, o.outputDir], [[], null]);
  const set = mcpSettings(cfg({ outputDir: '~/out', inputDirs: ['~/in'] }).config, env);
  assert.deepEqual([set.inputDirs, set.outputDir], [['/home/ana/in'], '/home/ana/out']);
  assert.ok(cfg({ outputDir: false }).problems.some((p) => p.startsWith('mcp.outputDir:')), 'null is the one way to turn it off');
});

test('MCP export by default: preview and confirm use ~/mailproof/exports (created 0700); a plain name only; the bundle verifies', async () => {
  const s = await setup();
  const exportsDir = path.join(s.home, 'mailproof', 'exports');
  const p = await s.m.call('export', { with: [BOB], out: 'bob-bundle' });
  assert.equal(p.isError, false, p.text);
  assert.equal(p.json.executed, false);
  assert.equal(p.json.preview.out, path.join(fs.realpathSync(s.home), 'mailproof', 'exports', 'bob-bundle'));
  assert.equal(fs.statSync(exportsDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(exportsDir), [], 'a preview writes no bundle');
  const c = await s.m.call('export', { with: [BOB], out: 'bob-bundle', confirm: true });
  assert.equal(c.json.executed, true, c.text);
  assert.deepEqual(fs.readdirSync(exportsDir), ['bob-bundle']);
  assert.equal((await verifyBundle(path.join(exportsDir, 'bob-bundle'), { ots: null })).ok, true);
  for (const bad of ['/tmp/x', '../x', 'a/b']) assert.equal((await s.m.call('export', { with: [BOB], out: bad, confirm: true })).error.code, 'ERR_BAD_ARGUMENT', bad);
  assert.equal((await s.m.call('export', { with: [BOB], confirm: true })).isError, false, 'the default name is used');
  assert.match(fs.readFileSync(s.m.mcp.auditFile, 'utf8'), /"tool":"export"/);
  // the bundle it wrote can be checked from the default read folder
  assert.equal((await s.m.call('verifyBundle', { dir: path.join(exportsDir, 'bob-bundle') })).json.ok, true);
  await s.m.close();
});

test('MCP backup and rawEmail saveTo by default: ~/mailproof/backups and ~/mailproof/saved', async () => {
  const s = await setup();
  const b = await s.m.call('backup', { out: 'x', confirm: true });
  assert.equal(b.isError, false, b.text);
  assert.deepEqual(fs.readdirSync(path.join(s.home, 'mailproof', 'backups')), ['x.bundle']);
  const id = (await s.m.call('list')).json[0].id;
  const r = await s.m.call('rawEmail', { id, saveTo: 'a.eml' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.saved, path.join(fs.realpathSync(s.home), 'mailproof', 'saved', 'a.eml'));
  assert.equal(fs.statSync(path.join(s.home, 'mailproof', 'saved')).mode & 0o777, 0o700);
  assert.equal((await s.m.call('rawEmail', { id, saveTo: 'a.eml' })).error.code, 'ERR_PATH_NOT_ALLOWED', 'never overwrites');
  assert.equal((await s.m.call('rawEmail', { id, saveTo: '../a.eml' })).error.code, 'ERR_BAD_ARGUMENT');
  await s.m.close();
});

test('MCP reads by default: a file under ~/mailproof, not elsewhere in the home; a symlink out of it is refused', async () => {
  const s = await setup();
  const inside = path.join(s.home, 'mailproof', 'saved'); fs.mkdirSync(inside, { recursive: true });
  const eml = Buffer.from('From: Z <z@z.example>\r\nTo: me@owner.example\r\nMessage-ID: <z@z.example>\r\n\r\nhi\r\n');
  fs.writeFileSync(path.join(inside, 'm.eml'), eml);
  assert.equal((await s.m.call('check', { path: path.join(inside, 'm.eml') })).isError, false);
  fs.writeFileSync(path.join(s.home, 'other.eml'), eml);
  assert.equal((await s.m.call('check', { path: path.join(s.home, 'other.eml') })).error.code, 'ERR_PATH_NOT_ALLOWED');
  fs.symlinkSync(path.join(s.home, 'other.eml'), path.join(inside, 'link.eml'));
  assert.equal((await s.m.call('check', { path: path.join(inside, 'link.eml') })).error.code, 'ERR_PATH_NOT_ALLOWED');
  await s.m.close();
});

test('turning them off and overriding: outputDir null refuses writes, inputDirs [] refuses paths, explicit folders replace the defaults', async () => {
  const off = await setup({ mcp: { outputDir: null, inputDirs: [] } });
  const e = await off.m.call('export', { with: [BOB], out: 'x' });
  assert.equal(e.error.code, 'ERR_PATH_NOT_ALLOWED'); assert.match(e.error.message, /mcp\.outputDir/);
  assert.equal((await off.m.call('backup', {})).error.code, 'ERR_PATH_NOT_ALLOWED');
  const d = path.join(off.home, 'mailproof', 'saved'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'm.eml'), 'x');
  const r = await off.m.call('check', { path: path.join(d, 'm.eml') });
  assert.equal(r.error.code, 'ERR_PATH_NOT_ALLOWED'); assert.match(r.error.message, /mcp\.inputDirs/);
  assert.equal(fs.existsSync(path.join(off.home, 'mailproof', 'exports')), false, 'nothing is created when off');
  await off.m.close();
  const outDir = makeTmpDir('mp-co-out-');
  const set = await setup({ mcp: { outputDir: outDir } });
  assert.equal((await set.m.call('export', { with: [BOB], out: 'x', confirm: true })).isError, false);
  assert.deepEqual(fs.readdirSync(outDir), ['x']);
  assert.equal(fs.existsSync(path.join(set.home, 'mailproof', 'exports')), false, 'an explicit folder replaces the default');
  await set.m.close();
});

test('the mcp screen shows the effective folders: the defaults, an explicit pair, and off', async () => {
  const env = { HOME: '/home/ana' };
  const st = styleOf({ stdout: {}, env });
  const lines = (mcp) => {
    const { config } = validateConfig({ v: 1, accounts: { a: { user: 'a@b.example', trailDir: '/t', passCommand: 'x' } }, ...(mcp ? { mcp } : {}) }, env);
    return mcpFacts({ env, deps: { claude: async () => null } }, config).then((f) => mcpStatusLines(f, st, env, '/home/ana/c.json').join('\n'));
  };
  assert.match(await lines(), /^Input dirs +~\/mailproof \(default\)$/m);
  assert.match(await lines(), /^Output dir +~\/mailproof\/\{exports,backups,saved\} \(default\)$/m);
  assert.match(await lines({ outputDir: '~/o', inputDirs: ['~/i'] }), /^Output dir +~\/o$/m);
  assert.match(await lines({ outputDir: null, inputDirs: [] }), /^Output dir +none/m);
  assert.match(await lines({ outputDir: null, inputDirs: [] }), /^Input dirs +none/m);
});
