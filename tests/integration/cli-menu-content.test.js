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
