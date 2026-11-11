// The config file (SPEC B11.2, B11.3): strict validation, the permission check, account selection, profile lookup,
// the atomic write. Every file is under makeTmpDir; the real ~/.config is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateConfig, parseConfig, loadConfig, selectAccount, mailproofOptions, configPath, configDir, expandHome, loadProfile, writeConfigAtomic, TEMPLATE, ConfigError,
} from '../../src/cli/config.js';
import { UsageError, PermError } from '../../src/cli/errors.js';
import { makeTmpDir } from '../helpers/tmp.js';

const env = { HOME: '/home/ana', XDG_CONFIG_HOME: undefined };
const acct = (extra = {}) => ({ user: 'a@b.example', trailDir: '/t/one', passCommand: 'pass show x', ...extra });
const cfg = (accounts) => ({ v: 1, accounts });
const problems = (json) => validateConfig(json, env).problems;

test('a minimal account gets the documented defaults; the template validates', () => {
  const { config } = validateConfig(cfg({ personal: acct() }), env);
  assert.deepEqual(config.accounts.personal, {
    name: 'personal', user: 'a@b.example', host: 'imap.gmail.com', port: 993, folders: ['INBOX'], sent: true, trailDir: '/t/one', trail: 'default',
    secret: { passCommand: 'pass show x' }, content: {}, otsBin: 'ots', stamp: {}, backupRemote: null,
  });
  assert.deepEqual(validateConfig(TEMPLATE, env).problems, []);
  assert.equal(validateConfig(TEMPLATE, env).config.accounts.personal.otsBin, 'ots');
  assert.deepEqual(mailproofOptions(config.accounts.personal), { trailDir: '/t/one', trail: 'default', otsBin: 'ots' }, 'ots is on by default');
  const full = validateConfig(TEMPLATE, env).config.accounts.personal;
  assert.deepEqual(mailproofOptions(full), { trailDir: '/home/ana/mailproof/personal', trail: 'default', otsBin: 'ots', content: { store: true, attachments: true, days: 730, sweepDays: 7 } });
});

test('ots and stamp (SPEC B13.1.1): ots false is the off switch (otsBin null is passed on), stamp is validated', () => {
  const a = (extra) => validateConfig(cfg({ a: acct(extra) }), env);
  assert.equal(a({ ots: false }).config.accounts.a.otsBin, null);
  assert.deepEqual(mailproofOptions(a({ ots: false }).config.accounts.a), { trailDir: '/t/one', trail: 'default', otsBin: null });
  assert.equal(a({ ots: true }).config.accounts.a.otsBin, 'ots');
  assert.deepEqual(a({ stamp: { mode: 'record', everyHours: 12 } }).config.accounts.a.stamp, { mode: 'record', everyHours: 12 });
  assert.deepEqual(mailproofOptions(a({ stamp: { everyHours: 1 } }).config.accounts.a).stamp, { everyHours: 1 });
  assert.ok(problems(cfg({ a: acct({ stamp: { nope: 1 } }) })).includes('accounts.a.stamp.nope: unknown key'));
  assert.ok(problems(cfg({ a: acct({ stamp: { mode: 'x' }, }) })).includes('accounts.a.stamp.mode: must be "batch" or "record"'));
  for (const h of [0, 721, 1.5, '6']) assert.ok(problems(cfg({ a: acct({ stamp: { everyHours: h } }) })).some((p) => p.startsWith('accounts.a.stamp.everyHours:')), String(h));
  assert.ok(problems(cfg({ a: acct({ stamp: 'batch' }) })).includes('accounts.a.stamp: must be an object'));
});

test('strict: unknown keys at every level, wrong types, bad names, a missing v, no accounts: each names its JSON path', () => {
  assert.ok(problems({ v: 1, accounts: { a: acct() }, extra: 1 }).includes('extra: unknown key'));
  assert.ok(problems(cfg({ a: acct({ colour: 'red' }) })).includes('accounts.a.colour: unknown key'));
  assert.ok(problems(cfg({ a: acct({ content: { days: 5, forever: true } }) })).includes('accounts.a.content.forever: unknown key'));
  assert.ok(problems({ accounts: { a: acct() } }).includes('v: must be 1'));
  assert.ok(problems({ v: 2, accounts: { a: acct() } }).includes('v: must be 1'));
  assert.ok(problems({ v: 1, accounts: {} }).some((p) => /at least one account/.test(p)));
  assert.ok(problems(cfg({ 'Bad Name': acct() })).some((p) => p.startsWith('accounts.Bad Name:')));
  assert.ok(problems(cfg({ a: acct({ port: '993' }) })).includes('accounts.a.port: must be an integer 1-65535'));
  assert.ok(problems(cfg({ a: acct({ port: 70000 }) })).includes('accounts.a.port: must be an integer 1-65535'));
  assert.ok(problems(cfg({ a: acct({ folders: [] }) })).some((p) => p.startsWith('accounts.a.folders:')));
  assert.ok(problems(cfg({ a: acct({ sent: 5 }) })).some((p) => p.startsWith('accounts.a.sent:')));
  assert.ok(problems(cfg({ a: acct({ trailDir: 'relative/dir' }) })).some((p) => /accounts.a.trailDir: must be an absolute path/.test(p)));
  assert.ok(problems(cfg({ a: acct({ trail: 'Bad Trail' }) })).some((p) => p.startsWith('accounts.a.trail:')));
  assert.ok(problems(cfg({ a: acct({ content: { days: 0 } }) })).includes('accounts.a.content.days: must be a positive integer'));
  assert.ok(problems(cfg({ a: acct({ content: { store: 'yes' } }) })).includes('accounts.a.content.store: must be true or false'));
  assert.ok(problems(cfg({ a: acct({ ots: 'ots' }) })).some((p) => p.startsWith('accounts.a.ots:')), 'a string must be an absolute path');
  assert.equal(validateConfig(cfg({ a: acct({ ots: '/usr/local/bin/ots' }) }), env).config.accounts.a.otsBin, '/usr/local/bin/ots');
  assert.ok(problems(cfg({ a: { trailDir: '/t', passCommand: 'x' } })).includes('accounts.a.user: required'));
  assert.ok(problems(cfg({ a: { user: 'u', passCommand: 'x' } })).includes('accounts.a.trailDir: required'));
  assert.ok(problems(null).length && problems([]).length && problems('x').length);
});

test('exactly one secret source; a plaintext password key anywhere is refused with the advice', () => {
  assert.ok(problems(cfg({ a: { user: 'u', trailDir: '/t' } })).some((p) => /exactly one of passCommand, passFile, accessTokenCommand/.test(p)));
  assert.ok(problems(cfg({ a: acct({ passFile: '/x' }) })).some((p) => /exactly one of .*found passCommand, passFile/.test(p)));
  for (const key of ['pass', 'password', 'secret', 'Password']) {
    const p = problems(cfg({ a: acct({ [key]: 'hunter2' }) }));
    assert.ok(p.some((x) => x.startsWith(`accounts.a.${key}:`) && /password manager and use passCommand/.test(x)), key);
  }
  assert.ok(problems(cfg({ a: acct({ content: { password: 'x' } }) })).some((x) => x.startsWith('accounts.a.content.password:')), 'nested too');
  assert.ok(!JSON.stringify(problems(cfg({ a: acct({ password: 'hunter2' }) }))).includes('hunter2'), 'the value is never echoed');
  const e = assert.throws(() => parseConfig(JSON.stringify(cfg({ a: acct({ password: 'hunter2' }) })), env, '/c.json'), (x) => x instanceof ConfigError && x instanceof UsageError);
  void e;
});

test('two accounts must not share trailDir and trail; a different trail name in one dir is fine', () => {
  assert.ok(problems(cfg({ a: acct(), b: acct() })).some((p) => /accounts.b: shares trailDir and trail with account "a"/.test(p)));
  assert.deepEqual(problems(cfg({ a: acct(), b: acct({ trail: 'other' }) })), []);
  assert.ok(problems(cfg({ a: acct({ trailDir: '/t/x' }), b: acct({ trailDir: '/t/x/../x' }) })).length > 0, 'the same directory spelled differently');
});

test('~ in trailDir is expanded against HOME; paths: --config wins, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(validateConfig(cfg({ a: acct({ trailDir: '~/mp/a' }) }), env).config.accounts.a.trailDir, '/home/ana/mp/a');
  assert.equal(expandHome('~', env), '/home/ana');
  assert.equal(expandHome('~other/x', env), '~other/x');
  assert.equal(configPath(undefined, env), '/home/ana/.config/mailproof/config.json');
  assert.equal(configPath(undefined, { ...env, XDG_CONFIG_HOME: '/x/cfg' }), '/x/cfg/mailproof/config.json');
  assert.equal(configPath(undefined, { ...env, XDG_CONFIG_HOME: 'relative' }), '/home/ana/.config/mailproof/config.json', 'a relative XDG value is ignored');
  assert.equal(configPath('/y/c.json', env), '/y/c.json');
  assert.equal(configDir({ ...env, XDG_CONFIG_HOME: '/x/cfg' }), '/x/cfg/mailproof');
});

test('the permission check fails closed: group/other bits, a foreign owner, a missing file; a symlink is followed', async () => {
  const dir = makeTmpDir('mp-cli-perm-');
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify(cfg({ a: acct() })), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  assert.equal((await loadConfig(f, env)).accounts.a.user, 'a@b.example');
  for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o700 | 0o010]) {
    fs.chmodSync(f, mode);
    await assert.rejects(loadConfig(f, env), (e) => e instanceof PermError && /must be owned by you and mode 0600 \(chmod 600 /.test(e.message), mode.toString(8));
  }
  fs.chmodSync(f, 0o400);
  assert.ok(await loadConfig(f, env), '0400 is fine');
  fs.chmodSync(f, 0o600);
  const me = process.geteuid();
  await assert.rejects(loadConfig(f, env, { euid: me + 1 }), PermError, 'a file owned by someone else');
  assert.ok(await loadConfig(f, env, { euid: me }));
  assert.ok(await loadConfig(f, env, { euid: null }), 'no uid on this platform: only the mode counts');
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(f, link);
  assert.ok(await loadConfig(link, env), 'the target is checked, not the link');
  fs.chmodSync(f, 0o644);
  await assert.rejects(loadConfig(link, env), PermError);
  await assert.rejects(loadConfig(path.join(dir, 'nope.json'), env), (e) => e instanceof UsageError && /no config file/.test(e.message) && /config template/.test(e.message));
  fs.chmodSync(f, 0o600);
  fs.writeFileSync(f, '{nope');
  await assert.rejects(loadConfig(f, env), (e) => e instanceof UsageError && /not valid JSON/.test(e.message));
});

test('account selection: one account needs no flag, two or more always do, an unknown name lists the names', () => {
  const one = validateConfig(cfg({ a: acct() }), env).config;
  assert.equal(selectAccount(one, undefined).name, 'a');
  assert.equal(selectAccount(one, 'a').name, 'a');
  const two = validateConfig(cfg({ a: acct(), b: acct({ trailDir: '/t/two' }) }), env).config;
  assert.throws(() => selectAccount(two, undefined), (e) => e instanceof UsageError && /\(a, b\)/.test(e.message));
  assert.equal(selectAccount(two, 'b').name, 'b');
  assert.throws(() => selectAccount(two, 'c'), /unknown account "c"; configured: a, b/);
  assert.throws(() => selectAccount(two, '__proto__'), /unknown account/);
});

test('profiles: a name is looked up in <configDir>/profiles, a path is used as given, no mode rule', async () => {
  const cdir = makeTmpDir('mp-cli-prof-');
  const e = { ...env, XDG_CONFIG_HOME: cdir };
  fs.mkdirSync(path.join(cdir, 'mailproof', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(cdir, 'mailproof', 'profiles', 'strict.json'), '{"body":"proven"}', { mode: 0o644 });
  assert.deepEqual(await loadProfile('strict', e), { body: 'proven' });
  fs.writeFileSync(path.join(cdir, 'p.json'), '{"body":"any"}');
  assert.deepEqual(await loadProfile(path.join(cdir, 'p.json'), e), { body: 'any' });
  await assert.rejects(loadProfile('nope', e), (x) => x instanceof UsageError && /profiles directory/.test(x.message));
  await assert.rejects(loadProfile('./strict.json', e), UsageError, 'a path is not looked up as a name');
});

test('writeConfigAtomic: mode 0600, directory 0700, no temp file left, the old file survives a failed write', async () => {
  const dir = makeTmpDir('mp-cli-write-');
  const f = path.join(dir, 'new', 'mailproof', 'config.json');
  await writeConfigAtomic(f, cfg({ a: acct() }));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['config.json']);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).accounts.a.user, 'a@b.example');
  const ino = fs.statSync(f).ino;
  await writeConfigAtomic(f, cfg({ a: acct({ user: 'z@b.example' }) }));
  assert.notEqual(fs.statSync(f).ino, ino, 'replaced by a rename, never edited in place');
  // the target cannot be replaced (it is a directory): the write fails and leaves nothing behind
  const d = path.join(dir, 'isdir');
  fs.mkdirSync(d);
  await assert.rejects(writeConfigAtomic(d, cfg({ a: acct() })));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['isdir', 'new']);
});

test('backupRemote: credentials in the URL are refused (secrets by reference); ssh and scp-style remotes pass', () => {
  for (const bad of ['https://ana:tok3n@git.example.org/x.git', 'https://ghp_secret@git.example.org/x.git', 'ssh://ana:pw@git.example.org/x.git']) {
    const p = problems(cfg({ a: acct({ backupRemote: bad }) }));
    assert.ok(p.some((x) => x.startsWith('accounts.a.backupRemote:') && /credential helper or an ssh key/.test(x)), bad);
    assert.ok(!JSON.stringify(p).includes('tok3n') && !JSON.stringify(p).includes('ghp_secret') && !JSON.stringify(p).includes('ana:pw'), 'the secret is never echoed');
  }
  for (const ok of ['git@git.example.org:ana/x.git', 'ssh://git@git.example.org/ana/x.git', 'https://git.example.org/ana/x.git', '/srv/backup/x.git']) {
    assert.deepEqual(problems(cfg({ a: acct({ backupRemote: ok }) })), [], ok);
  }
});
