// bin/mailproof.js spawned against a temp config and a real fixture trail (SPEC B11.13): every read command's exit code
// and --json shape, the destructive guards, update/export/mcp. IMAP is never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const T = await buildThread();
const world = makeWorld({ accounts: { test: account(T.dir) } });
const sp = (argv, o) => world.spawn(argv, o);
const json = (r) => JSON.parse(r.stdout);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const id = (name) => T.r[name].id;

test('--version, help, help <command>, <command> --help; unknown command and flag are 64', async () => {
  const v = await sp(['--version']);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^mailproof \d+\.\d+\.\d+\n$/);
  const h = await sp(['help']);
  assert.equal(h.code, 0);
  for (const c of ['sync', 'watch', 'list', 'show', 'verify', 'replies', 'check', 'forget', 'prune', 'backup', 'status', 'update', 'config', 'export']) assert.match(h.stdout, new RegExp(`^  ${c} `, 'm'));
  const hl = await sp(['help', 'list']);
  assert.equal(hl.code, 0);
  assert.match(hl.stdout, /^Usage: mailproof list \[flags\]/);
  assert.match(hl.stdout, /--with <address>/);
  assert.equal((await sp(['list', '--help'])).stdout, hl.stdout);
  const bad = await sp(['frobnicate']);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /unknown command "frobnicate"\nsee: mailproof help\n$/);
  const flag = await sp(['list', '--bogus']);
  assert.equal(flag.code, 64);
  assert.match(flag.stderr, /bogus/);
  assert.match(flag.stderr, /see: mailproof help list/);
  assert.equal((await sp(['help', 'nope'])).code, 64);
  // no command and no terminal: the help and 64 (a script that forgot its subcommand must not hang on a prompt)
  const none = await sp([]);
  assert.equal(none.code, 64);
  assert.match(none.stdout, /^Usage: mailproof/);
});

test('list: text, filters, --json is one array; a bad date, address or role is 64', async () => {
  const all = json(await sp(['list', '--json']));
  assert.equal(all.length, 6);
  assert.deepEqual(Object.keys(all[0]).sort(), ['captured', 'direction', 'id', 'live', 'message_id', 'portable']);
  const text = await sp(['list']);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trim().split('\n').length, 6);
  assert.match(text.stdout, new RegExp(`  ${id('plain').slice(0, 12)}$`, 'm'));
  assert.equal(json(await sp(['list', '--json', '--limit', '2'])).length, 2);
  assert.equal(json(await sp(['list', '--json', '--limit', '0'])).length, 6);
  assert.equal(json(await sp(['list', '--json', '--direction', 'out'])).length, 1);
  assert.equal(json(await sp(['list', '--json', '--with', 'bob@beta.example'])).length, 4);
  assert.equal(json(await sp(['list', '--json', '--with', 'bob@beta.example', '--role', 'from'])).length, 2);
  assert.equal(json(await sp(['--json', 'list', '--after', '2026-11-02'])).length, 0, 'a global flag before the command');
  for (const bad of [['--before', 'yesterday'], ['--with', 'not-an-address'], ['--with', 'a@b.example', '--role', 'boss'], ['--role', 'to'], ['--limit', '-1'], ['--direction', 'sideways']]) {
    const r = await sp(['list', ...bad]);
    assert.equal(r.code, 64, bad.join(' '));
    assert.equal(r.stdout, '', 'nothing on stdout on an error');
  }
});

test('show: text, --json {record, proof, links}, an id prefix, --raw bytes; unknown and ambiguous ids', async () => {
  const j = json(await sp(['show', id('signed'), '--json']));
  assert.deepEqual(Object.keys(j).sort(), ['facts', 'links', 'proof', 'record', 'seal']);
  assert.equal(j.seal, null, 'recorded but not sealed yet');
  assert.equal(j.record.id, id('signed'));
  assert.equal(j.proof.email.ok, true);
  assert.equal(j.links.parents[0].strength, 'signed');
  const text = await sp(['show', id('signed').slice(0, 10)]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, new RegExp(`^id +${id('signed')}$`, 'm'));
  assert.match(text.stdout, /^in-reply-to +<req@owner.example>, link signed$/m);
  const raw = await sp(['show', id('signed'), '--raw']);
  assert.equal(raw.code, 0);
  assert.deepEqual(raw.stdoutBytes, T.mails.signed.raw, 'the stored raw email, byte for byte');
  assert.equal((await sp(['show', id('signed'), '--raw', '--json'])).code, 64);
  assert.equal((await sp(['show', 'ab'.repeat(16)])).code, 1, 'a well-formed id with no record');
  const short = await sp(['show', id('signed').slice(0, 7)]);
  assert.equal(short.code, 64);
  assert.match(short.stderr, /8 or more hex characters/);
  const none = await sp(['show', '0'.repeat(10)]);
  assert.equal(none.code, 64);
  assert.match(none.stderr, /no record has an id starting with/);
  assert.equal((await sp(['show'])).code, 64);
});

test('verify: exit 0 when ok, 2 when it does not (a tampered signature), --json shape', async () => {
  const ok = await sp(['verify', id('signed'), '--json']);
  assert.equal(ok.code, 0);
  const o = json(ok);
  assert.equal(o.ok, true);
  assert.deepEqual(Object.keys(o).sort(), ['at', 'basis', 'engine', 'id', 'ok', 'signatures', 'trust']);
  const no = await sp(['verify', id('failing')]);
  assert.equal(no.code, 2);
  assert.match(no.stdout, /^NOT OK/);
  assert.equal(json(await sp(['verify', id('failing'), '--json'])).ok, false);
  assert.equal((await sp(['verify', id('signed'), '--at', '2026-13-45'])).code, 64);
  assert.equal(json(await sp(['verify', id('signed'), '--at', '2026-11-01T10:30:00Z', '--json'])).ok, true);
});

test('replies: the flat bundles; none is a message and exit 0', async () => {
  const rows = json(await sp(['replies', '<req@owner.example>', '--json']));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].recordId, id('signed'));
  assert.equal(rows[0].link, 'signed');
  assert.equal(json(await sp(['replies', 'req@owner.example', '--json'])).length, 3, 'brackets are optional');
  const text = await sp(['replies', '<req@owner.example>']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /bob@beta.example/);
  const none = await sp(['replies', '<nobody@x.example>']);
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), 'no replies recorded');
});

test('check: a profile file or a name; 0 pass, 2 fail with the failed rules; a bad profile is 64', async () => {
  const f = path.join(makeTmpDir('mp-cli-prof-'), 'p.json');
  fs.writeFileSync(f, JSON.stringify({ senders: ['@beta.example'], checks: { dkimAligned: true }, body: 'any' }));
  const pass = await sp(['check', id('signed'), '--profile', f, '--json']);
  assert.equal(pass.code, 0);
  assert.equal(json(pass).ok, true);
  fs.writeFileSync(f, JSON.stringify({ senders: ['@gamma.example'] }));
  const fail = await sp(['check', id('signed'), '--profile', f]);
  assert.equal(fail.code, 2);
  assert.match(fail.stdout, /^FAIL\n  sender/m);
  // a bare name is looked up in <configDir>/profiles/<name>.json
  fs.mkdirSync(path.join(world.cfgDir, 'mailproof', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(world.cfgDir, 'mailproof', 'profiles', 'beta.json'), JSON.stringify({ senders: ['@beta.example'] }));
  assert.equal((await sp(['check', id('signed'), '--profile', 'beta'])).code, 0);
  // the link rule needs the request
  fs.writeFileSync(f, JSON.stringify({ link: ['signed'] }));
  assert.equal((await sp(['check', id('signed'), '--profile', f, '--parent', '<req@owner.example>'])).code, 0);
  assert.equal((await sp(['check', id('unsigned'), '--profile', f, '--parent', '<req@owner.example>'])).code, 2);
  assert.equal((await sp(['check', id('signed')])).code, 64, '--profile is required');
  assert.equal((await sp(['check', id('signed'), '--profile', 'missing-name'])).code, 64);
  fs.writeFileSync(f, JSON.stringify({ bogus: 1 }));
  assert.equal((await sp(['check', id('signed'), '--profile', f])).code, 64, 'an invalid profile');
  fs.writeFileSync(f, '{not json');
  assert.equal((await sp(['check', id('signed'), '--profile', f])).code, 64);
});

test('status: one account, --json keyed by account, read-only (HEAD and tree unchanged), never contacts IMAP', async () => {
  const head = git(T.dir + '/default', 'rev-parse', 'HEAD');
  const j = json(await sp(['status', '--json']));
  assert.deepEqual(Object.keys(j), ['test']);
  assert.equal(j.test.records.total, 6);
  assert.deepEqual([j.test.records.in, j.test.records.out], [5, 1]);
  assert.ok(j.test.content.files >= 6);
  assert.equal(j.test.pendingStamps, 0, 'ots is on by default: nothing stamped yet');
  assert.deepEqual([j.test.seal.enabled, j.test.seal.mode, j.test.seal.everyHours, j.test.seal.last, j.test.seal.manifests, j.test.seal.chain], [true, 'batch', 6, null, 0, 'ok']);
  assert.equal(j.test.lastSync, null);
  assert.equal(j.test.watch.running, false);
  assert.equal(j.test.index, 'present');
  const text = await sp(['status']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^test\n  trail /);
  assert.match(text.stdout, /records +6 \(5 in, 1 out\)/);
  assert.equal(git(T.dir + '/default', 'rev-parse', 'HEAD'), head);
  assert.equal(git(T.dir + '/default', 'status', '--porcelain'), '');
});

test('forget: refuses without --yes (64, nothing changed), --dry-run prints and changes nothing, --yes forgets content only', async () => {
  const before = await sp(['show', id('plain'), '--raw']);
  assert.equal(before.code, 0);
  const no = await sp(['forget', id('plain')]);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /1 record\(s\), 1 with a stored raw email/);
  assert.match(no.stderr, /add --yes to proceed/);
  assert.equal(no.stdout, '');
  const dry = await sp(['forget', id('plain'), '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /1 record\(s\)/);
  assert.equal((await sp(['show', id('plain'), '--raw'])).code, 0, 'still there');
  assert.equal((await sp(['forget'])).code, 64, 'no target: there is no "forget everything"');
  assert.equal((await sp(['forget', '--yes'])).code, 64);
  assert.equal((await sp(['forget', id('plain'), '--with', 'zed@zed.example', '--yes'])).code, 64, 'ids or --with, not both');
  assert.equal((await sp(['forget', '--before', '2026-01-01', '--yes'])).code, 64, '--before needs --with');
  const yes = await sp(['forget', '--with', 'zed@zed.example', '--yes', '--json']);
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(json(yes), { removed: 1, attachments: 0 });
  assert.equal((await sp(['show', id('plain'), '--raw'])).code, 1, 'the content is gone');
  assert.equal(json(await sp(['verify', id('plain'), '--json'])).ok, false, 'unsigned mail never verified');
  assert.equal(json(await sp(['show', id('plain'), '--json'])).record.id, id('plain'), 'the proof stays');
});

test('prune: refuses without --yes, --dry-run changes nothing, --yes prunes and keeps the backup', async () => {
  const root = T.dir + '/default';
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal((await sp(['prune'])).code, 64, '--before is required');
  assert.equal((await sp(['prune', '--before', 'soon'])).code, 64);
  const no = await sp(['prune', '--before', '2026-11-01T10:04:00Z']);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /records removed 3, kept 3/);
  assert.match(no.stderr, /add --yes to proceed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  const dry = json(await sp(['prune', '--before', '2026-11-01T10:04:00Z', '--dry-run', '--json']));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.removed, 3);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.ok(!fs.readdirSync(T.dir).some((f) => f.includes('pre-prune')));
  const none = await sp(['prune', '--before', '2000-01-01']);
  assert.equal(none.code, 0, 'a cutoff that removes nothing needs no --yes');
  const yes = await sp(['prune', '--before', '2026-11-01T10:04:00Z', '--yes', '--json']);
  assert.equal(yes.code, 0, yes.stderr);
  const r = json(yes);
  assert.equal(r.removed, 3);
  assert.equal(r.dryRun, false);
  assert.ok(fs.existsSync(r.backup), 'the old trail is kept');
  assert.equal(json(await sp(['list', '--json'])).length, 3);
});

test('update: prints the command and never runs npm without --run; --run runs exactly npm install -g mailproof@latest', async () => {
  const bin = makeTmpDir('mp-cli-fakenpm-');
  const mark = path.join(bin, 'ran.txt');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${mark}"\nexit \${FAKE_NPM_EXIT:-0}\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const p = await sp(['update'], { env });
  assert.equal(p.code, 0);
  assert.match(p.stdout, /^mailproof \d+\.\d+\.\d+ installed\. To upgrade: npm install -g mailproof@latest\n$/);
  assert.ok(!fs.existsSync(mark), 'npm was not spawned');
  assert.deepEqual(json(await sp(['update', '--json'], { env })).command, 'npm install -g mailproof@latest');
  assert.ok(!fs.existsSync(mark));
  const r = await sp(['update', '--run'], { env });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(mark, 'utf8'), 'install -g mailproof@latest\n');
  assert.equal((await sp(['update', '--run'], { env: { ...env, FAKE_NPM_EXIT: '3' } })).code, 1, 'npm failing is exit 1');
});

test('export needs --with (64); mcp needs a stdin stream (64 without), and ends 0 when it closes', async () => {
  const e = await sp(['export']);
  assert.equal(e.code, 64);
  assert.match(e.stderr, /export needs --with/);
  const m = await world.run(['mcp']);   // no stdin at all (in process): not a stdio server run
  assert.equal(m.code, 64);
  assert.match(m.stderr, /mailproof mcp is a stdio server: register it in your MCP client/);
  assert.equal((await sp(['mcp'])).code, 0, 'a closed stdin is a clean end of the session');
});

test('config: path, validate (no secret is resolved), template parses', async () => {
  assert.equal((await sp(['config', 'path'])).stdout.trim(), world.configFile);
  const v = await sp(['config', 'validate']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout, 'ok\n');
  const t = await sp(['config', 'template']);
  assert.equal(t.code, 0);
  assert.equal(JSON.parse(t.stdout).v, 1);
  assert.equal((await sp(['config', 'bogus'])).code, 64);
  fs.chmodSync(world.configFile, 0o644);
  const perm = await sp(['config', 'validate']);
  assert.equal(perm.code, 77);
  assert.match(perm.stderr, /must be owned by you and mode 0600/);
  assert.equal((await sp(['list'])).code, 77, 'no command runs on a config that is not trusted');
  fs.chmodSync(world.configFile, 0o600);
});

test('--account is required with two accounts, status lists all, an unknown name lists the names', async () => {
  const w = makeWorld({ accounts: { one: account(T.dir), two: account(makeTmpDir('mp-cli-two-')) } });
  const need = await w.spawn(['list']);
  assert.equal(need.code, 64);
  assert.match(need.stderr, /--account \(one, two\)/);
  const unk = await w.spawn(['list', '--account', 'three']);
  assert.equal(unk.code, 64);
  assert.match(unk.stderr, /configured: one, two/);
  assert.equal(JSON.parse((await w.spawn(['list', '--account', 'one', '--json'])).stdout).length, 6 - 3, 'the earlier prune test ran on this trail');
  const all = JSON.parse((await w.spawn(['status', '--json'])).stdout);
  assert.deepEqual(Object.keys(all), ['one', 'two']);
  assert.equal(all.two.records, null, 'an account whose trail does not exist yet');
  assert.equal(JSON.parse((await w.spawn(['status', '--account', 'two', '--json'])).stdout).two.records, null);
});

test('a flat or missing trail is reported, not a crash', async () => {
  const w = makeWorld({ accounts: { empty: account(makeTmpDir('mp-cli-empty-')) } });
  const l = await w.spawn(['list']);
  assert.equal(l.code, 0);
  assert.equal(l.stdout.trim(), 'no emails recorded');
  assert.equal((await w.spawn(['backup'])).code, 1);
});
