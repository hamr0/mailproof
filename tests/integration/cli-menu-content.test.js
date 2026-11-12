// What each menu screen says (SPEC B11.4c, Part B of the 2026-11-12 walkthrough): plain words, browse rows, previews before anything is written.
// In-process on scripted stdin; IMAP and DNS are never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const T = await buildThread();
const world = () => makeWorld({ accounts: { test: account(T.dir) } });
const keys = (...l) => `${l.join('\n')}\n`;
const menu = (w, input, opts = {}) => w.run([], { interactive: true, input, ...opts });

test('B1 sync: choosing 1 just syncs the account\'s folders (no Folders/Sent questions); the overrides stay on the subcommand', async () => {
  const w = world();
  const seen = [];
  const deps = { sync: async (mp, opts) => { seen.push(opts); return { complete: true, folders: [] }; } };
  const r = await menu(w, keys('1', 'q'), { deps });
  assert.equal(seen.length, 1);
  assert.ok(!/Folders \(|Sent \(/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /^complete$/m);
  await w.run(['sync', '--folders', 'A', '--sent', 'off'], { deps });
  assert.deepEqual([seen[1].folders, seen[1].sent], [['A'], false]);
});

test('B13 the add-account wizard backs out on an empty answer or q, never "a value is needed"; B14 paths in errors show as ~/', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { interactive: true, input: keys('', 'q') });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('a value is needed'));
  assert.match(r.stdout, /Account name \(.*empty = back/);
  assert.match(r.stdout, /nothing written/);
  assert.ok(!fs.existsSync(w.configFile));
  const x = await w.run(['config', 'add-account'], { interactive: true, input: keys('', 'my-acct', 'q') });
  assert.match(x.stdout, /Email address \(.*empty = back/);
  const w2 = world();
  const e = await w2.run(['check', 'aaaaaaaa', '--profile', '~/nope.json']);
  assert.equal(e.code, 64);
  assert.ok(e.stderr.includes('cannot read ~/nope.json'), e.stderr);
  assert.ok(!e.stderr.includes(w2.home), 'the home path is never printed');
});

const plain = (s) => s;

test('B3 replies: browse rows (when, age, verdict, from; the reply text; the link and the short reason); no library field names', async () => {
  const w = world();
  const r = await menu(w, keys('6', 'bob@beta.example', '', 'q'));
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  assert.match(r.stdout, /^ 1 {2}\d\d-\d\d \d\d:\d\dZ .* (✓|ok) verified +bob@beta\.example$/m);
  assert.match(r.stdout, /^ {4}I confirm\.$/m, 'the new text of the reply, indented');
  assert.match(r.stdout, /^ {4}link signed [·-] verifies$/m);
  assert.match(r.stdout, /^ {4}link not signed [·-] signature fails$/m, 'an unsigned link and the short reason');
  assert.ok(!/dkim-aligned|unverified\/unverified|verified\/verified|body proven/.test(r.stdout), 'no field names');
});

test('B4 verify <address>: browse rows, the long reason wrapped under its row, blank lines before the totals and the final verdict', async () => {
  const w = world();
  const r = await menu(w, keys('7', 'bob@beta.example', '', '', 'q'));
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  const lines = r.stdout.split('\n');
  const i = lines.findIndex((l) => /^ 2 {2}/.test(l));
  assert.match(lines[i + 1], /^ {4}Re: please sign/, 'the subject under the row');
  const why = lines.slice(i + 2, i + 6).filter((l) => /^ {4}\S/.test(l));
  assert.ok(why.length >= 2 && why.every((l) => [...l].length <= 80), `the long why wraps and is indented: ${JSON.stringify(why)}`);
  assert.ok(r.stdout.includes('\n\nreceived: 2 verified, 1 not'));
  assert.ok(r.stdout.includes('\n\nx NOT VERIFIED'), 'a blank line before the final verdict');
});

test('B5 check: Who, that person\'s latest five as rows, pick by number, the profiles listed, the default profile, one line per rule', async () => {
  const w = world();
  const r = await menu(w, keys('8', 'alice@alpha.example', '1', '', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Who \(an address like bob@example\.org, or a record id, empty = back\): /m);
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  assert.match(r.stdout, /^Email \(a number 1 to \d, or a record id, empty = back\): /m);
  assert.match(r.stdout, /^Profiles \(what must hold for the email to pass\):$/m);
  assert.match(r.stdout, /^ {2}default {2}DKIM signature verifies and covers the From {2}\(built in\)$/m);
  assert.match(r.stdout, /^Profile \(a name above, or the path of a JSON file, q = back\) \[default\]: /m);
  assert.match(r.stdout, /^(ok|✓) pass\n {2}(ok|✓) DKIM signature verifies and covers the From$/m);
  const bad = await menu(w, keys('8', 'bob@beta.example', '9', '1', '', '', 'q'));
  assert.match(bad.stdout, /choose 1 to \d/);
  // another profile from the profiles directory is listed with its meaning and can be picked; a failing rule gets a plain reason
  fs.mkdirSync(path.join(w.cfgDir, 'mailproof', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(w.cfgDir, 'mailproof', 'profiles', 'gamma.json'), JSON.stringify({ senders: ['@gamma.example'], checks: { dkimAligned: true } }));
  const g = await menu(w, keys('8', T.r.signed.id, 'gamma', '', 'q'));
  assert.match(g.stdout, /^ {2}gamma {2}sender @gamma\.example; DKIM signature verifies and covers the From$/m);
  assert.match(g.stdout, /^(x|✗) FAIL\n {2}(x|✗) sender .* is not @gamma\.example\n {2}(ok|✓) DKIM signature/m);
});

test('B6 check .eml: the verdict in plain words, then From, Subject, signatures, body, one per line; "checked only, not recorded" when an account exists', async () => {
  const w = world();
  const eml = path.join(makeTmpDir('mp-cli-b6-'), 'a.eml');
  fs.writeFileSync(eml, 'From: Ann <ann@example.org>\r\nSubject: =?utf-8?q?caf=C3=A9?=\r\n\r\nhi\r\n');
  const deps = { check: async () => ({ live: { trust: 'unverified' }, portable: { trust: 'unverified' }, signatures: 0, unsigned: true, key_errors: [], body_status: 'not-checked' }) };
  const r = await menu(w, keys('9', eml, '', 'q'), { deps });
  assert.match(r.stdout, /^(x|✗) not verified: this email has no DKIM signature$/m);
  assert.match(r.stdout, /^ {2}From {8}Ann <ann@example\.org>$/m);
  assert.match(r.stdout, /^ {2}Subject {5}café$/m);
  assert.match(r.stdout, /^ {2}Signatures +0 \(unsigned\)$/m);
  assert.match(r.stdout, /^ {2}Body +not-checked$/m);
  assert.match(r.stdout, /^checked only, not recorded$/m);
  assert.ok(!r.stdout.includes('set up an account'));
  assert.ok(r.stdout.includes('\n\nchecked only, not recorded'), 'a blank line before the closing line');
});

test('B7 export: the preview first (browse rows, what it reveals), then Write it? [y/N]; n writes nothing; the result block is saved to ~/mailproof/exports/', async () => {
  const w = world();
  const dir = path.join(w.home, 'mailproof', 'exports');
  const no = await menu(w, keys('11', 'alice@alpha.example', '', '', '', 'n', 'n', 'q'));
  assert.equal(no.code, 0, no.stderr);
  assert.match(no.stdout, /^This would export 1 email with alice@alpha\.example$/m, '1 email, not 1 emails');
  assert.match(no.stdout, /^ #  when +age +verdict +from$/m);
  assert.match(no.stdout, /addresses and subjects; your other mail appears only as hashes/);
  assert.ok(no.stdout.indexOf('This would export') < no.stdout.indexOf('Write it? '), 'the preview comes before the question');
  assert.match(no.stdout, /Write it\? \[y\/N\] /);
  assert.match(no.stdout, /^nothing written$/m);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'nothing was written');
  const yes = await menu(w, keys('11', 'alice@alpha.example', '', '', '', 'n', 'y', '', 'q'));
  assert.match(yes.stdout, /^(ok|✓) saved to ~\/mailproof\/exports\/mailproof-bundle-test-\d{8}-\d{6}$/m);
  assert.match(yes.stdout, /^ {2}1 record, 0 replies, \d+ keys?, \d+ manifests?, [\d.]+ (KiB|bytes)$/m);
  assert.match(yes.stdout, /^sha256 [0-9a-f]{64} {2}\(tell the recipient this, by another channel\)$/m);
  assert.match(yes.stdout, /^they run: mailproof verify-bundle --expect [0-9a-f]{64} mailproof-bundle-test-/m);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('B8 seal: plain words for a run and the one-line no-op; B9 backup: path, size, commits, the restore command on its own line', async () => {
  const w = world();
  const s = await menu(w, keys('12', '', 'q'));
  assert.match(s.stdout, /^(ok|✓) sealed 6 new records$/m);
  assert.match(s.stdout, /^the Bitcoin anchor is pending \(usually a few hours\); it completes on the next sync or seal$/m);
  const again = await menu(w, keys('12', '', 'q'));
  assert.match(again.stdout, /^nothing new to seal$|^the Bitcoin anchor is pending/m, 'a second run: the no-op line or the pending note');
  const b = await menu(w, keys('13', '', 'n', '', 'q'));
  assert.match(b.stdout, /Save a copy of the trail as one file you can keep or restore/);
  assert.match(b.stdout, /^(ok|✓) saved to ~\/mailproof\/backups\/test-\d{8}T\d{6}Z\.bundle$/m);
  assert.match(b.stdout, /^ {2}[\d.]+ KiB, \d+ commits$/m);
  assert.match(b.stdout, /^restore with:\n {2}git clone ~\/mailproof\/backups\/test-\S+\.bundle <dir>$/m);
});

test('B12 status: the account line, bold labels, ~/ paths, short relative times, human sizes, plain plurals, the real counts (the index is caught up by status itself)', async () => {
  const F = await buildThread();   // a fresh trail: no index, no seal run yet
  const w = makeWorld({ accounts: { test: account(F.dir) } });
  const s = await w.run(['status'], { tty: true, columns: 80, env: { FORCE_COLOR: '1', LANG: 'en_US.UTF-8' }, deps: { now: () => new Date('2026-11-12T14:00:00Z') } });
  assert.ok(s.stdout.includes('\x1b[1mrecords     \x1b[0m'), 'labels are bold');
  const t = s.stdout.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07\x1b]*(\x1b\\|\x07)/g, '');
  assert.match(t, /^test · me@owner\.example$/m, 'the account line');
  assert.match(t, /^ {2}records {6}6 \(5 in, 1 out\) · 3 verified, 2 unverified · 2026-11-01 to 2026-11-01$/m);
  assert.match(t, /^ {2}content {6}6 files, [\d.]+ KiB$/m, 'human sizes');
  assert.match(t, /^ {2}seal {9}one batch every 6 h; never run \(due at the next sync or `mailproof seal`\); 0 manifests$/m);
  const home = makeWorld({ accounts: { h: account('~/mailproof/h') } });
  const h = await home.run(['status']);
  assert.match(h.stdout, /^ {2}trail {8}~\/mailproof\/h\/default$/m, 'a path under HOME prints as ~/');
  assert.match(h.stdout, /no trail yet/);
});

test('B12 header: the "(verified count after the next list)" placeholder is gone; the real counts show once the index is current; status brings it up to date', async () => {
  const F = await buildThread();
  const w = makeWorld({ accounts: { test: account(F.dir) } });
  const cold = await menu(w, keys('q'));
  assert.ok(!cold.stdout.includes('verified count after the next list'));
  assert.match(cold.stdout, /^records: 6 - seal never run/m);
  const warm = await menu(w, keys('16', '', 'q'));   // status catches the index up
  assert.match(warm.stdout, /^records: 6 - 3 verified - 2 unverified - 1 sent copy - /m, 'the header after status has the real counts');
});

test('B10 forget: Who first, then dates; the preview in browse rows shown once, then the account-name confirmation, then the result with plain counts; ids are the advanced way', async () => {
  const F = await buildThread();
  const w = makeWorld({ accounts: { test: account(F.dir) } });
  const r = await menu(w, keys('14', 'bob@beta.example', '', '', 'test', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Who \(an address like bob@example\.org, or ids to give record ids \(advanced\), empty = back\): /m);
  assert.ok(r.stdout.indexOf('Who (') < r.stdout.indexOf('Before ('), 'who before the dates');
  assert.match(r.stdout, /^Forget on account test: 4 emails, 4 with a stored raw email\./m);
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  assert.match(r.stdout, /^ {4}Re: please sign/m, 'the subject under each row');
  assert.match(r.stdout, /^and 0 more|^$/m);
  assert.equal((r.stdout.match(/Forget on account test/g) ?? []).length, 1, 'shown once');
  assert.ok(r.stdout.indexOf('Forget on account') < r.stdout.indexOf('Type the account name'), 'preview, then the confirmation');
  assert.ok(r.stdout.indexOf('Type the account name') < r.stdout.indexOf('forgot '), 'then the result');
  assert.match(r.stdout, /^forgot 4 stored emails and \d+ attachment files; the proofs are unchanged$/m);
  assert.ok(!/\(s\)/.test(r.stdout), 'no (s)');
});

test('B11 prune: the date, then the preview (count, span, rows); nothing to remove says so and stops (no confirmation); then the backup question, then the confirmation; dates as 2026-08-19', async () => {
  const F = await buildThread();
  const w = makeWorld({ accounts: { test: account(F.dir) } });
  const none = await menu(w, keys('15', '2000-01-01', '', 'q'));
  assert.match(none.stdout, /Permanently remove proofs captured before a date \(forget only removes content\)/);
  assert.match(none.stdout, /^nothing is captured before 2000-01-01: nothing to prune$/m);
  assert.ok(!none.stdout.includes('Also delete the pre-prune backup') && !none.stdout.includes('Type the account name'), 'nothing to prune: no more questions');
  const r = await menu(w, keys('15', '2026-11-01T10:04:00Z', 'n', 'test', '', 'q'));
  assert.match(r.stdout, /^Prune would permanently remove 3 proofs captured before 2026-11-01 \(2026-11-01 to 2026-11-01\) and keep 3\.$/m);
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  const at = (s) => r.stdout.indexOf(s);
  assert.ok(at('Prune would') < at('Also delete the pre-prune backup') && at('Also delete the pre-prune backup') < at('Type the account name') && at('Type the account name') < at('pruned: removed'), 'preview, backup option, confirmation, result');
  assert.equal((r.stdout.match(/Prune would permanently remove/g) ?? []).length, 1, 'the preview is shown once');
  assert.match(r.stdout, /^pruned: removed 3 proofs, kept 3; new head \w+; content of 3 emails removed; the old trail is kept as /m);
});
