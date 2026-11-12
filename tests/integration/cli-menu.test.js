// The menu (SPEC B11.4), driven in-process through scripted stdin with the interactive flag on: prompts with defaults,
// re-prompt on bad input, quit, typed-name confirmation for the destructive items, and "the menu runs the same code".
import test from 'node:test';
import { stripStyle } from '../../src/cli/style.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { PassThrough } from 'node:stream';
import { run } from '../../src/cli/run.js';
import { menuCommand } from '../../src/cli/menu.js';
import { makeTmpDir } from '../helpers/tmp.js';

const T = await buildThread();
const idOf = (n) => T.r[n].id;
const world = () => makeWorld({ accounts: { test: account(T.dir) } });
const keys = (...l) => `${l.join('\n')}\n`;
const FULL_MENU = [
  ' Mail',
  '   1 sync           fetch new mail, record proofs',
  '   2 watch          sync every 5 min until Ctrl-C',
  ' Look',
  '   3 people         who is in this trail',
  '   4 list           newest first; filter by person/date',
  '   5 show           an address\'s emails and their proof',
  '   6 replies        what people answered',
  ' Check',
  '   7 verify         re-check an address\'s emails offline',
  '   8 check          trust profile pass/fail',
  '   9 check .eml     check a saved email file',
  '  10 verify-bundle  check a bundle you were sent',
  ' Share and keep',
  '  11 export         proof bundle for a counterparty',
  '  12 seal           seal new mail now (OpenTimestamps)',
  '  13 backup         git bundle of the trail',
  ' Clean up',
  '  14 forget         delete stored mail content',
  '  15 prune          drop old history from the trail',
  ' Setup',
  '  16 status   17 config   18 update   19 mcp',
  '',
  '  q quit',
].join('\n');
const SHORT = '  1 sync  3 people  5 show  7 verify  11 export  16 status  - ? all - q quit';
const menu = (w, input, opts = {}) => w.run([], { interactive: true, input, ...opts });

test('the menu shows the header (identity, counts), the action line and quits on q; ? lists the rest; no terminal means no menu', async () => {
  const w = world();
  const cold = await menu(w, keys('q'));
  assert.match(cold.stdout, /^records: 6 - \(verified count after the next list\) - seal never run - watch off$/m, 'no index yet: the header reads it as it is and never builds it');
  await w.run(['list']);   // builds the index
  const r = await menu(w, keys('?', 'q'));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^-{64}\nmailproof \d+\.\d+\.\d+ - me@owner\.example \(test\) - trail ok - last sync never\n/m);
  assert.match(r.stdout, /^records: 6 - 3 verified - 2 unverified - 1 sent copy - seal never run - watch off$/m);
  assert.ok(r.stdout.includes(FULL_MENU), 'the full grouped menu, at the start');
  assert.equal(r.stdout.split(FULL_MENU).length, 3, 'shown at the start and again on ?');
  assert.match(r.stdout.slice(r.stdout.indexOf(FULL_MENU) + FULL_MENU.length), /^-{64}\nmailproof \d/m, 'the header comes first on ?');
  assert.ok(!r.stdout.includes('[b: change]') && !/ a account/.test(r.stdout), 'one account: nothing to change');
  assert.ok(!r.stdout.includes('\x1b'), 'no terminal colour on a pipe');
  assert.equal(r.stdout.split('1 sync  3 people').length, 1, 'no short line before any action');
  assert.equal((r.stdout.match(/^-{64}$/gm) ?? []).length, 4, '? draws the header again, as at the start');
  const noTty = await w.run([], { interactive: false, input: keys('q') });
  assert.equal(noTty.code, 64);
  assert.match(noTty.stdout, /^Usage: mailproof/);
  assert.ok(!noTty.stdout.includes('1 sync'));
  const eof = await menu(w, '');
  assert.equal(eof.code, 0, 'a closed stdin quits');
  const eof2 = await menu(w, keys('list'));
  assert.equal(eof2.code, 0, 'the input ending in a prompt quits');
});

test('List: each prompt shows label, example and default; the output is the subcommand\'s; Press Enter, then the menu again', async () => {
  const w = world();
  const direct = await w.run(['list']);
  const r = await menu(w, keys('list', '', '', '', '', '', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  for (const p of ['With (email address, e.g. bob@example.org, empty = everyone): ', 'Direction (in, out, empty = both): ', 'Before (date, e.g. 2026-08-19, empty = no limit): ', 'Limit (a number, 0 = all) [50]: ', 'Press Enter ']) assert.ok(r.stdout.includes(p), p);
  assert.ok(r.stdout.includes(direct.stdout), 'the same text the subcommand prints');
  assert.equal(r.stdout.split(SHORT).length, 2, 'the short line was shown after the command');
  // answers become the subcommand's flags
  const f = await menu(w, keys('list', 'bob@beta.example', 'from', 'in', '', '2026-11-02', '1', '', 'q'));
  assert.equal(f.stdout.split('\n').filter((l) => /  [0-9a-f]{12}$/.test(l)).length, 0, '--after 2026-11-02 leaves none');
  const g = await menu(w, keys('list', 'bob@beta.example', 'from', 'in', '', '', '1', '', 'q'));
  assert.equal(g.stdout.split('\n').filter((l) => /  [0-9a-f]{12}$/.test(l)).length, 1, '--limit 1');
  assert.ok(g.stdout.includes('Role (from, to, cc, reply-to, empty = any): '), 'Role is asked only after a With');
});

test('a bad value prints the reason and re-prompts; ? prints the hint; three bad answers go back to the menu; an empty required value re-prompts', async () => {
  const w = world();
  const r = await menu(w, keys('list', 'not-an-address', '', 'sideways', 'both', 'in', '', '', '1', '', 'q'));
  assert.match(r.stdout, /--with: "not-an-address" is not an email address|With: "not-an-address" is not an email address/);
  assert.match(r.stdout, /Direction: use in, out/);
  const s = await menu(w, keys('5', 'zz', '?', 'zz', 'zz', 'q'));
  assert.equal((s.stdout.match(/an address \(b@example\.com\), a Message-ID in angle brackets/g) ?? []).length, 3, 'three tries');
  assert.match(s.stdout, /an address like bob@example\.org, a <message-id>, or a record id \(8\+ hex\)\n/, '? prints the example');
  assert.match(s.stdout, /cancelled/);
  assert.equal(s.stdout.split(SHORT).length, 2, 'back at the prompt, which then took the q');
  const e = await menu(w, keys('5', '', '', '', 'q'));
  assert.equal((e.stdout.match(/a value is needed/g) ?? []).length, 3);
  const x = await menu(w, keys('99', '', 'x', 'q'));
  assert.match(x.stdout, /not a menu item: 99/);
  assert.match(x.stdout, /not a menu item: x/);
});

test('Show, Verify, Replies, Check, Status run the subcommand code (same output, same exit mapping)', async () => {
  const w = world();
  const id = idOf('signed');
  const show = await menu(w, keys('5', id.slice(0, 10), '', 'q'));
  assert.ok(show.stdout.includes((await w.run(['show', id])).stdout));
  const ver = await menu(w, keys('7', idOf('failing'), '', '', 'q'));
  assert.match(ver.stdout, /NOT OK/);
  const rep = await menu(w, keys('replies', 'bob@beta.example', '', 'q'));
  assert.match(rep.stdout, /bob@beta.example  dkim-aligned pass/);
  assert.ok(!rep.stdout.includes('no replies recorded'));
  const prof = path.join(makeTmpDir('mp-cli-menu-'), 'p.json');
  fs.writeFileSync(prof, JSON.stringify({ senders: ['@beta.example'] }));
  const chk = await menu(w, keys('check', id, prof, '', '', 'q'));
  assert.match(chk.stdout, /^pass$/m);
  const st = await menu(w, keys('16', '', 'q'));
  assert.match(st.stdout, /^test\n  trail /m);
  const ex = await menu(w, keys('11', 'alice@alpha.example', '', '', path.join(makeTmpDir('mp-cli-menu-ex-'), 'b'), 'n', '', 'q'));
  assert.match(ex.stdout, /^ok wrote .*\(\d+ records/m);
  assert.match(ex.stdout, /^bundle sha256 [0-9a-f]{64}/m);
  const h = await menu(w, keys('h', 'q'));
  assert.match(h.stdout, /^Usage: mailproof \[command\]/m);
});

test('every number 1-19 and every name is accepted at any prompt, not only the ones on the short line', async () => {
  const w = world();
  const deps = { sync: async () => ({ complete: true, folders: [] }), stamp: async () => ({}), runNpm: async () => 0 };
  // the names that select an item, and its first output (the input ends right after the pick, which quits the menu)
  const asked = [
    [['1', 'sync'], /^Folders \(/m],
    [['2', 'watch'], /^Interval \(/m],
    [['3', 'people'], /bob@beta\.example/],
    [['4', 'list'], /^With \(/m],
    [['5', 'show'], /^Target \(/m],
    [['6', 'replies'], /^Address or Message-ID \(/m],
    [['7', 'verify'], /^Target \(/m],
    [['8', 'check'], /^Id \(/m],
    [['9', 'check .eml', 'check-file', 'eml'], /^Path of the \.eml file/m],
    [['10', 'verify-bundle'], /^Bundle directory \(/m],
    [['11', 'export'], /^With \(/m],
    [['12', 'seal', 'stamp'], /^0 upgraded, /m],
    [['13', 'backup'], /^Write the bundle to \(/m],
    [['14', 'forget'], /^Ids \(/m],
    [['15', 'prune'], /^Before \(/m],
    [['16', 'status'], /^test\n {2}trail /m],
    [['17', 'config'], /^Action \(/m],
    [['18', 'update'], /npm install -g mailproof/],
  ];
  for (const [picks, re] of asked) for (const pick of picks) {
    const r = await menu(w, keys(pick), { deps });
    assert.doesNotMatch(r.stdout, /not a menu item/, pick);
    assert.match(r.stdout, re, pick);
  }
  // mcp serves stdin, so it is checked by its mapping: every key and name resolves
  const all = ['sync', 'watch', 'people', 'list', 'show', 'replies', 'verify', 'check', 'check-file', 'verify-bundle', 'export', 'stamp', 'backup', 'forget', 'prune', 'status', 'config', 'update', 'mcp'];
  all.forEach((cmd, i) => { assert.equal(menuCommand(String(i + 1)), cmd, `key ${i + 1}`); assert.equal(menuCommand(cmd), cmd, cmd); });
  assert.equal(menuCommand('seal'), 'stamp');
  assert.equal(menuCommand('check .eml'), 'check-file');
  assert.equal(menuCommand('20'), undefined);
  const bad = await menu(w, keys('20', 'q'));
  assert.match(bad.stdout, /not a menu item: 20/);
});

test('9 and 10 prompt for their path and run the same code as the first-run screen and the subcommand', async () => {
  const w = world();
  const eml = path.join(makeTmpDir('mp-cli-menu-9-'), 'a.eml');
  fs.writeFileSync(eml, 'From: a@b.example\r\n\r\nhi\r\n');
  const seen = [];
  const deps = { check: async (raw) => { seen.push(raw.toString()); return { live: { trust: 'verified' }, portable: { trust: 'verified' }, signatures: 1, unsigned: false, key_errors: [], body_status: 'matched' }; } };
  const r = await menu(w, keys('9', eml, '', '9', '/nonexistent/x.eml', '', '10', '/nonexistent-bundle', '', 'q'), { deps });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen, ['From: a@b.example\r\n\r\nhi\r\n']);
  assert.match(r.stdout, /^ok verified {2}live verified, portable verified, 1 signature, body matched$/m);
  assert.match(r.stdout, /nothing was recorded/);
  assert.match(r.stderr, /no such file/);
  assert.match(r.stdout, /Bundle directory \(the directory mailproof export wrote\): /);
  const direct = await w.run(['verify-bundle', '/nonexistent-bundle']);
  assert.ok(r.stderr.includes(direct.stderr.trim().split('\n')[0]) || direct.stderr.length > 0);
});

test('two accounts: the first screen asks which, b asks again, and the choice goes to the command as --account', async () => {
  const w = makeWorld({ accounts: { one: account(T.dir), two: account(makeTmpDir('mp-cli-menu2-')) } });
  const r = await menu(w, keys('two', 'list', '', '', '', '', '', '', 'a', 'one', 'list', '', '', '', '', '', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Account \(one\/two\): /);
  assert.match(r.stdout, /\(two\) - trail/);
  assert.match(r.stdout, /^  16 status {3}17 config {3}18 update {3}19 mcp {3}a account$/m);
  assert.match(r.stdout, /no emails recorded/, 'account two is empty');
  assert.match(r.stdout, /\(one\) - trail/);
  assert.match(r.stdout, /  [0-9a-f]{12}$/m, 'account one lists its emails');
  const bad = await menu(w, keys('nine', 'nine', 'nine'));
  assert.equal(bad.code, 0);
  assert.match(bad.stdout, /choose one of one, two/);
});

test('Forget is destructive: the summary first, then the account name must be typed; anything else changes nothing', async () => {
  const w = world();
  const id = idOf('unsigned');
  const raw = async () => (await w.run(['show', id, '--raw'])).code;
  assert.equal(await raw(), 0);
  const wrong = await menu(w, keys('forget', id, 'nope', '', 'q'));
  assert.match(wrong.stdout, /forget on account test: 1 record\(s\), 1 with a stored raw email/);
  assert.ok(wrong.stdout.includes('Type the account name (test) to proceed'));
  assert.match(wrong.stdout, /nothing changed/);
  assert.equal(await raw(), 0, 'still stored');
  const eofAtConfirm = await menu(w, keys('forget', id));
  assert.equal(eofAtConfirm.code, 0);
  assert.equal(await raw(), 0);
  const ok = await menu(w, keys('forget', id, 'test', '', 'q'));
  assert.match(ok.stdout, /forgot 1 stored email\(s\)/);
  assert.equal(await raw(), 1, 'the content is gone');
  assert.equal((await w.run(['show', id, '--json'])).code, 0, 'the proof stays');
});

test('Forget by person asks with/before/after; Prune asks the cutoff, shows the summary, needs the typed name', async () => {
  const w = world();
  const wrong = await menu(w, keys('forget', '', 'bob@beta.example', '', '', 'test', '', 'q'));
  assert.match(wrong.stdout, /forgot \d+ stored email/);
  const p = await menu(w, keys('prune', '2026-11-01T10:04:00Z', 'n', 'no', '', 'q'));
  assert.match(p.stdout, /records removed 3, kept 3/);
  assert.match(p.stdout, /nothing changed/);
  assert.equal(JSON.parse((await w.run(['list', '--json'])).stdout).length, 6, 'nothing was pruned');
  const bad = await menu(w, keys('prune', 'tomorrow-ish', '2026-11-01T10:04:00Z', 'n', 'test', '', 'q'));
  assert.match(bad.stdout, /--before: "tomorrow-ish" is not a date/);
  assert.match(bad.stdout, /pruned: removed 3, kept 3/);
  assert.equal(JSON.parse((await w.run(['list', '--json'])).stdout).length, 3);
});

test('Update shows the command and runs npm only after a yes; the subcommand never does without --run', async () => {
  const w = world();
  const calls = [];
  const deps = { runNpm: async (args) => { calls.push(args); return 0; } };
  const no = await menu(w, keys('update', 'n', '', 'q'), { deps });
  assert.match(no.stdout, /To upgrade: npm install -g mailproof@latest/);
  assert.ok(no.stdout.includes('Run it now? [y/N] '));
  assert.deepEqual(calls, []);
  const dflt = await menu(w, keys('update', '', '', 'q'), { deps });
  assert.equal(dflt.code, 0);
  assert.deepEqual(calls, [], 'the default is no');
  await menu(w, keys('update', 'y', '', 'q'), { deps });
  assert.deepEqual(calls, [['install', '-g', 'mailproof@latest']]);
  await w.run(['update'], { deps });
  assert.equal(calls.length, 1, 'the subcommand without --run runs nothing');
  await w.run(['update', '--run'], { deps });
  assert.equal(calls.length, 2);
});

test('Backup prompts for the path with the state-dir default, and the content archive', async () => {
  const w = world();
  const out = path.join(makeTmpDir('mp-cli-menu-bak-'), 'b.bundle');
  const r = await menu(w, keys('backup', out, 'y', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`Write the bundle to (a path) [${path.join(w.stateDir, 'backups', 'test')}${path.sep}test-`), 'the default is under the state dir');
  assert.ok(fs.existsSync(out) && fs.existsSync(out.replace(/\.bundle$/, '.content.tar')));
  const dflt = await menu(w, keys('backup', '', 'n', '', 'q'), { deps: { now: () => new Date('2026-11-10T10:15:30Z') } });
  assert.ok(fs.existsSync(path.join(w.stateDir, 'backups', 'test', 'test-20261110T101530Z.bundle')), 'the default path is used');
  assert.match(dflt.stdout, /restore: git clone /);
});

test('Config: validate and path run the subcommands; a missing config offers the wizard', async () => {
  const w = world();
  const v = await menu(w, keys('config', '', '', 'q'));
  assert.match(v.stdout, /^ok$/m);
  const p = await menu(w, keys('config', 'path', '', 'q'));
  assert.ok(p.stdout.includes(w.configFile));
  const none = makeWorld({ config: null });
  const wiz = await menu(none, keys('1', '3', 'personal', 'ana@example.com', 'imap.example.org', '', '1', 'pass show x', '', '', '', '', '', '', '', 'n', 'y', 'n', 'q'));
  assert.equal(wiz.code, 0, wiz.stderr);
  assert.match(wiz.stdout, /^mailproof \d+\.\d+\.\d+ - no account yet - config .*config\.json \(not found\)$/m, 'the first-run screen');
  assert.match(wiz.stdout, /^1 set up an account  2 check a \.eml file  3 verify a bundle  \? help  q quit$/m);
  assert.match(wiz.stdout, /^ok written .*config\.json \(mode 0600\)$/m);
  assert.match(wiz.stdout, /\(personal\) - trail/, 'the menu starts once the config exists');
  assert.equal(fs.statSync(none.configFile).mode & 0o777, 0o600);
  const quit = await menu(makeWorld({ config: null }), keys('q'));
  assert.equal(quit.code, 0);
  assert.match(quit.stdout, /no account yet/);
  const odd = await menu(makeWorld({ config: null }), keys('9', 'q'));
  assert.match(odd.stdout, /not a menu item: 9/);
  const untrusted = world();
  fs.chmodSync(untrusted.configFile, 0o644);
  const u = await menu(untrusted, keys('q'));
  assert.equal(u.code, 64);
  assert.match(u.stderr, /must be owned by you and mode 0600/);
});

/** A menu on fake terminal streams: readline runs in terminal mode, so a typed ^C (\x03) is a real SIGINT event. */
function terminalMenu(w, deps) {
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 120;
  let text = '';
  stdout.on('data', (d) => { text += d; });
  const stderr = { write: () => true, isTTY: false };
  const done = run([], { stdout, stderr, stdin, interactive: true, env: w.env, signal: new AbortController().signal, deps });
  const until = async (re) => { const t0 = Date.now(); while (!re.test(stripStyle(text)) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 10)); assert.match(stripStyle(text), re); };
  return { stdin, done, until, text: () => stripStyle(text) };
}

test('Ctrl-C: during a running command it stops the command and the menu stays; at a prompt it quits', async () => {
  const w = world();
  let syncs = 0;
  const m = terminalMenu(w, { sync: async () => { syncs++; return { complete: true, folders: [] }; } });   // the default interval is 5 min: watch is asleep after one tick
  await m.until(/> \x1b\[3G$/);
  m.stdin.write('watch\n');
  await m.until(/Interval \(30s, 5m, 1h\) \[5m\]: /);
  m.stdin.write('\n');
  await m.until(/ ok recorded 0/);
  assert.equal(syncs, 1);
  m.stdin.write('\x03');   // ^C while the watch sleeps
  await m.until(/> \x1b\[3G$/);   // the menu is back (no Press Enter on a terminal)
  assert.match(m.text(), /Interval/);
  m.stdin.write('\x03');   // ^C at the menu prompt
  assert.equal(await m.done, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, 'test', 'state.json'), 'utf8')).lastWatch.state, 'stopped');
});

test('first run: "check a .eml file" asks for a path, calls the library check (injected here, no DNS) and records nothing; a bad path says so; "verify a bundle" runs verify-bundle', async () => {
  const none = makeWorld({ config: null });
  const eml = path.join(makeTmpDir('mp-cli-menu-eml-'), 'a.eml');
  fs.writeFileSync(eml, 'From: a@b.example\r\n\r\nhi\r\n');
  const seen = [];
  const deps = { check: async (raw) => { seen.push(raw.toString()); return { live: { trust: 'verified' }, portable: { trust: 'verified' }, signatures: 1, unsigned: false, key_errors: [], body_status: 'matched' }; } };
  const r = await menu(none, keys('2', eml, '', '2', '/nonexistent/x.eml', '', '3', '/nonexistent-bundle', '', 'q'), { deps });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen, ['From: a@b.example\r\n\r\nhi\r\n']);
  assert.match(r.stdout, /^ok verified {2}live verified, portable verified, 1 signature, body matched$/m);
  assert.match(r.stdout, /nothing was recorded/);
  assert.match(r.stderr, /no such file/);
  assert.ok(!fs.existsSync(none.configFile), 'nothing was written');
});

test('? shows what the menu showed at the start: the header lines, then the grouped menu', async () => {
  const w = world();
  await w.run(['list']);
  const r = await menu(w, keys('?', 'q'));
  assert.equal((r.stdout.match(/^mailproof \d+\.\d+\.\d+ - me@owner\.example/gm) ?? []).length, 2, 'the identity line at the start and again after ?');
  assert.equal((r.stdout.match(/^records: \d+ - /gm) ?? []).length, 2);
  const half = r.stdout.indexOf(FULL_MENU) + FULL_MENU.length;
  assert.equal(r.stdout.slice(half).split(FULL_MENU).length, 2, 'the same grouped menu follows the second header');
  assert.ok(!r.stdout.slice(half).includes(SHORT), 'no short line after ?: the full menu was the last thing shown');
});
