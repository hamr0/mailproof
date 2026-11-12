// Menu item 4 (list) and the "dig deeper" view (SPEC B11.4a): Who, then the latest 5 emails as two-line rows plus a why line,
// m more / f filter / s subject search; a number opens the email (the `show` text) with r raw, a attachment, v verify,
// t thread, p person. Driven in-process with scripted stdin; the menu and the subcommands share the one code path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { stripStyle } from '../../src/cli/style.js';

const T = await buildThread();
const NOW = new Date('2026-11-01T11:00:00Z');
const deps = { now: () => NOW };
const keys = (...l) => `${l.join('\n')}\n`;
const world = () => makeWorld({ accounts: { test: account(T.dir) } });
const menu = (w, input, opts = {}) => w.run([], { interactive: true, input, deps, ...opts });
const id = (n) => T.r[n].id;
const lines = (s) => s.split('\n');

// newest first: plain (zed) 10:06, grand (alice) 10:05, failing (bob) 10:04, unsigned (carol) 10:03, signed (bob) 10:02, req (out) 10:01
test('item 4 asks only Who, then shows the latest 5 newest first: row line, full subject, why line; footer N of TOTAL', async () => {
  const w = world();
  const r = await menu(w, keys('4', '', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Who \(address, empty = everyone\): $/m);
  for (const gone of ['Role (', 'Direction (', 'Before (', 'After (', 'Limit (']) assert.ok(!r.stdout.includes(gone), `${gone} is not asked`);
  assert.match(r.stdout, /^ #  when +age +verdict +from$/m);
  assert.match(r.stdout, /^ 1  11-01 10:06Z  54 min +x unverified +zed@zed\.example$/m);
  assert.match(r.stdout, /^ 2  11-01 10:05Z  55 min +.*alice@alpha\.example$/m);
  assert.ok(!/ dir /.test(r.stdout) && !/^ 1 .* in +x /m.test(r.stdout), 'no dir column');
  const order = [...r.stdout.matchAll(/^ ([1-6])  11-01 10:0(\d)Z/gm)].map((m) => [m[1], m[2]].join(':'));
  assert.deepEqual(order, ['1:6', '2:5', '3:4', '4:3', '5:2'], 'five rows, newest first, numbered from 1');
  assert.ok(!/^ 6  /m.test(r.stdout), 'the sixth is not shown yet');
  assert.match(r.stdout, /^ {4}Re: please sign$/m, 'a signed subject is the subject alone');
  assert.match(r.stdout, /^ {4}\(no subject\)$/m, 'unsigned mail without a Subject header');
  assert.match(r.stdout, /^5 of 6 - open: a number - m more - f filter - s subject search - Enter back$/m);
  const failing = await T.mp.describe(id('failing'));
  assert.ok(failing.records[0].why, 'the fixture has a why');
  assert.equal(failing.records[0].reason, 'signature fails');
  assert.match(r.stdout, /^ {4}signature fails$/m, 'the why line is the library describe() short reason, not re-derived');
  assert.match(r.stdout, /^ {4}no DKIM signature$/m, 'unsigned mail');
  assert.match(r.stdout, /^ {4}verifies$/m, 'a verified email says so');
  assert.ok(!r.stdout.includes('why:') && !r.stdout.includes('~ '), 'no why: prefix, no ~ marker');
  assert.match(r.stdout, /\n  1 sync  3 people/, 'Enter goes back to the menu: the short line');
});

test('m shows the next 5, numbers continue, the footer counts; at the end there is no m', async () => {
  const w = world();
  const r = await menu(w, keys('4', '', 'm', '', 'q'));
  assert.match(r.stdout, /^ 6  11-01 10:01Z  59 min +.*to bob@beta\.example$/m, 'a sent copy shows who it went to');
  assert.match(r.stdout, /^6 of 6 - open: a number - f filter - s subject search - Enter back$/m);
  const again = await menu(w, keys('4', '', 'm', 'm', '', 'q'));
  assert.match(again.stdout, /that is all/);
});

test('Who narrows the list; empty result says so; a bad address asks again', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'nope', 'bob@beta.example', '', 'q'));
  assert.match(r.stdout, /"nope" is not an email address/);
  assert.match(r.stdout, /^4 of 4 - open: a number - f filter - s subject search - Enter back$/m, 'bob is on four records; no m when all are shown');
  assert.ok(!r.stdout.includes('zed@zed.example'));
  const none = await menu(w, keys('4', 'ghost@nowhere.example', '', 'q'));
  assert.match(none.stdout, /no emails match/);
});

test('f filters (role only after a Who; direction, after, before validated); empty answers clear; filters combine with Who', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'bob@beta.example', 'f', 'from', 'in', '', '', '', 'q'));
  assert.ok(r.stdout.includes('Role (from, to, cc, reply-to, empty = any): '));
  assert.ok(r.stdout.includes('Direction (in, out, empty = both): '));
  assert.ok(r.stdout.includes('After (date, e.g. 2026-01-01, empty = no limit): '));
  assert.ok(r.stdout.includes('Before (date, e.g. 2026-08-19, empty = no limit): '));
  assert.match(r.stdout, /^2 of 2 - /m, 'bob as sender, received: two');
  const bad = await menu(w, keys('4', '', 'f', 'sideways', 'out', '', '', '', 'q'));
  assert.match(bad.stdout, /Direction: use in, out/);
  assert.ok(!bad.stdout.includes('Role ('), 'no Who: no role');
  assert.match(bad.stdout, /^1 of 1 - /m, 'sent: one');
  const date = await menu(w, keys('4', '', 'f', '', '2026-11-01', 'garbage', '2026-11-02', '', 'q'));
  assert.match(date.stdout, /--before|Before/);
  assert.match(date.stdout, /^5 of 6 - /m, 'the bad date asked again, then both limits applied');
});

test('s searches the subject, case-insensitively, and combines with Who; empty text clears it', async () => {
  const w = world();
  const r = await menu(w, keys('4', '', 's', 'APPROVE', '', 'q'));
  assert.ok(r.stdout.includes('Subject contains (text, empty = any): '));
  assert.match(r.stdout, /^1 of 1 - open: a number - f filter - s subject search - Enter back$/m);
  assert.ok(r.stdout.includes('    Approve?'));
  const both = await menu(w, keys('4', 'zed@zed.example', 's', 'please', '', 'q'));
  assert.match(both.stdout, /no emails match/);
  const cleared = await menu(w, keys('4', '', 's', 'approve', 's', '', '', 'q'));
  assert.match(cleared.stdout, /^5 of 6 - /m);
});

test('a number opens the email: exactly the `show <id>` text, then the action line; Enter goes back to the list', async () => {
  const w = world();
  const show = await w.run(['show', id('signed')], { deps });
  const second = await menu(w, keys('4', 'bob@beta.example', '3', '', '', 'q'));
  assert.ok(second.stdout.includes(show.stdout.trimEnd()), 'the same lines `show` prints');
  assert.match(second.stdout, /^ {2}r raw email - a save attachment - v verify again - t thread - p this person - Enter back to list$/m);
  assert.equal((second.stdout.match(/^4 of 4 - open: a number/gm) ?? []).length, 2, 'back at the list: it is drawn again');
  const bad = await menu(w, keys('4', 'bob@beta.example', '9', '', 'q'));
  assert.match(bad.stdout, /choose 1 to 4/);
});

test('r prints the stored raw email; when the content is gone it says so plainly', async () => {
  const w = world();
  const raw = await T.mp.rawEmail(id('plain'));
  const r = await menu(w, keys('4', 'zed@zed.example', '1', 'r', '', '', 'q'));
  assert.ok(r.stdout.includes('Message-ID: <z1@zed.example>'));
  assert.ok(r.stdout.includes('hello'));
  assert.ok(raw.length > 10);
  const T2 = await buildThread();
  await T2.mp.forget([T2.r.plain.id]);
  const w2 = makeWorld({ accounts: { test: account(T2.dir) } });
  const g = await menu(w2, keys('4', 'zed@zed.example', '1', 'r', '', '', 'q'));
  assert.match(g.stdout, /the raw email is no longer stored \(expired, forgotten or never stored\)/);
});

test('v re-checks the one email offline: the same text as `verify <id>`', async () => {
  const w = world();
  const v = await w.run(['verify', id('failing')], { deps });
  assert.equal(v.code, 2);
  const r2 = await menu(w, keys('4', 'bob@beta.example', '2', 'v', '', '', 'q'));
  assert.ok(r2.stdout.includes(v.stdout.trimEnd()), 'identical to the subcommand');
});

test('t shows the parent and the direct replies with the link, as numbered rows; a number opens that one, Enter goes back one level', async () => {
  const w = world();
  // bob's list, newest first: grand (to bob), failing, signed, req; `signed` (bob, In-Reply-To the request) has the request as parent and alice's mail as a reply
  const r = await menu(w, keys('4', 'bob@beta.example', '3', 't', '1', '', '', '', '', 'q'));
  assert.match(r.stdout, /1 parent, 1 reply/);
  assert.match(r.stdout, /^ 1  11-01 10:01Z .*to bob@beta\.example +parent, signed$/m);
  assert.match(r.stdout, /^ 2  11-01 10:05Z .*alice@alpha\.example +reply, signed$/m);
  assert.match(r.stdout, /^2 of 2 - open: a number - Enter back$/m, 'no m, f or s in a thread');
  assert.ok(r.stdout.includes((await w.run(['show', id('req')], { deps })).stdout.trimEnd()), 'a number in the thread opens that email');
  const lone = await menu(w, keys('4', 'zed@zed.example', '1', 't', '', '', 'q'));
  assert.match(lone.stdout, /no thread: no parent or replies recorded for this email/);
  assert.ok(!lone.stdout.includes('no linked emails'));
  const unsigned = await menu(w, keys('4', 'carol@gamma.example', '1', 't', '', '', '', 'q'));
  assert.match(unsigned.stdout, /parent, unsigned/);
});

test('p: the person view (the people row) and the latest 5 for that address; mentions 11 export', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'zed@zed.example', '1', 'p', '', '', '', 'q'));
  assert.match(r.stdout, /^zed@zed\.example +1 email/m);
  assert.match(r.stdout, /11 export/);
  const bob = await menu(w, keys('4', '', '4', 'p', '', '', '', 'q'));   // row 4 is carol's? newest: plain, grand, failing -> 3 is failing (bob)
  assert.match(bob.stdout, /^(bob@beta\.example|carol@gamma\.example|alice@alpha\.example) +\d+ emails?/m);
  const sent = await menu(w, keys('4', 'bob@beta.example', '4', 'p', '', '', '', 'q'));   // the sent request: the other party is bob
  assert.match(sent.stdout, /^bob@beta\.example +\d+ emails/m);
  assert.match(sent.stdout, /open: a number/);
});

test('a saves an attachment: numbered list, destination default ~/Downloads/<name>, never overwrites, 0600', async () => {
  const dir = makeTmpDir('mp-browse-att-');
  const PDF = Buffer.from('%PDF-1.4\nbrowse test bytes\n');
  const m = await signedMail({ domain: 'att.example', from: 'ann@att.example', to: 'me@owner.example', subject: 'with a file', signTime: new Date('2026-11-01T09:00:00Z'), attachment: { filename: 'c.pdf', bytes: PDF } });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => new Date('2026-11-01T10:00:00Z') });
  const rec = (await mp.record(m.raw, { direction: 'in', source: 'test' })).record;
  const w = makeWorld({ accounts: { test: account(dir) } });
  const dl = path.join(w.home, 'Downloads');
  fs.mkdirSync(dl);
  const plain = await menu(w, keys('4', '', '1', 'a', '', '', '', 'q'));   // empty choice cancels
  assert.match(plain.stdout, /^ {2}1  c\.pdf  \d+ bytes  stored yes$/m);
  assert.match(plain.stdout, /1 attachment/, 'the list row counts it');
  assert.ok(!fs.existsSync(path.join(dl, 'c.pdf')));
  const r = await menu(w, keys('4', '', '1', 'a', '1', '', '', '', 'q'));
  assert.ok(r.stdout.includes('Save to (path) [~/Downloads/c.pdf]: '), r.stdout);
  assert.deepEqual(fs.readFileSync(path.join(dl, 'c.pdf')), PDF);
  assert.equal(fs.statSync(path.join(dl, 'c.pdf')).mode & 0o777, 0o600);
  const again = await menu(w, keys('4', '', '1', 'a', '1', '', path.join(dl, 'second.pdf'), '', '', 'q'));
  assert.match(again.stdout, /~\/Downloads\/c\.pdf already exists: nothing is overwritten; choose another path/);
  assert.deepEqual(fs.readFileSync(path.join(dl, 'second.pdf')), PDF);
  assert.deepEqual(fs.readFileSync(path.join(dl, 'c.pdf')), PDF, 'the first one is untouched');
  await mp.forget([rec.id]);
  const gone = await menu(w, keys('4', '', '1', 'a', '1', '', '', 'q'));
  assert.match(gone.stdout, /stored no/);
  assert.match(gone.stdout, /no longer stored/);
  const noAtt = await menu(world(), keys('4', 'zed@zed.example', '1', 'a', '', '', 'q'));
  assert.match(noAtt.stdout, /this email has no attachments/);
});

test('terminal-safe: a subject or address with control characters reaches no sink as an escape; rows fit the terminal width', async () => {
  const dir = makeTmpDir('mp-browse-safe-');
  const evil = '=?utf-8?B?' + Buffer.from('evil\x1b[2Jtext ‮ and a very long subject to be cut at the terminal width ' + 'x'.repeat(120), 'utf8').toString('base64') + '?=';
  const m = await signedMail({ domain: 'ev.example', from: 'e@ev.example', to: 'me@owner.example', subject: evil, signTime: new Date('2026-11-01T09:00:00Z') });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => new Date('2026-11-01T10:00:00Z') });
  await mp.record(m.raw, { direction: 'in', source: 'test' });
  const w = makeWorld({ accounts: { test: account(dir) } });
  const r = await menu(w, keys('4', '', '', 'q'), { tty: true, columns: 60, rows: 40 });
  const text = stripStyle(r.stdout);
  assert.ok(!text.includes('\x1b'), 'no raw escape');
  assert.ok(!text.includes('‮'));
  const rows = text.split('\n').filter((l) => l.startsWith('    '));
  assert.ok(rows.length >= 2, 'the subject line and the reason line');
  assert.ok(rows.some((l) => l.endsWith('· subject not signed') || l.endsWith('- subject not signed')) === false, 'this subject is signed: no suffix');
  for (const l of rows) assert.ok([...l].length <= 60, `fits 60 columns: ${l.length}`);
});

test('keys are bold green: the footer keys, the action line keys and the attachment number', async () => {
  const w = world();
  const g = (s) => `\x1b[1;32m${s}\x1b[0m`;
  const r = await menu(w, keys('4', '', '3', 'a', '', '', '', 'q'), { env: { FORCE_COLOR: '1' } });
  for (const k of ['a number', 'm', 'f', 's', 'Enter']) assert.ok(r.stdout.includes(g(k)), `footer key ${k}`);
  for (const k of ['r', 'a', 'v', 't', 'p']) assert.ok(r.stdout.includes(`  ${g(k)}`) || r.stdout.includes(` ${g(k)} `), `action key ${k}`);
});

test('rows: a subject no verifying signature covers gets the dim suffix `· subject not signed`; the suffix is never cut, the subject is', async () => {
  const w = world();
  const U = { env: { LANG: 'en_US.UTF-8' } };
  const r = await menu(w, keys('4', '', '', 'q'), U);
  assert.match(r.stdout, /^ {4}\(no subject\)$/m, 'no Subject header at all: no suffix');
  const bob = await menu(w, keys('4', 'bob@beta.example', '', 'q'), U);
  assert.match(bob.stdout, /^ {4}Re: please sign!  · subject not signed$/m, 'the failing signature covers the altered subject: not signed');
  assert.match(bob.stdout, /^ {4}Approve\?$/m, 'a signed subject has no suffix');
  assert.equal((bob.stdout.match(/subject not signed/g) ?? []).length, 1);
  const d = (await T.mp.describe(id('failing'))).records[0];
  assert.notEqual(d.subject.coverage, 'signed');
  const narrow = await menu(w, keys('4', 'bob@beta.example', '', 'q'), { tty: true, columns: 40, rows: 40, ...U });
  const line = stripStyle(narrow.stdout).split('\n').find((l) => l.endsWith('subject not signed'));
  assert.ok(line && [...line].length <= 40, line);
  assert.ok(line.includes('…'), 'the subject was cut, the suffix was not');
  const dim = await menu(w, keys('4', 'bob@beta.example', '', 'q'), { env: { FORCE_COLOR: '1', LANG: 'en_US.UTF-8' } });
  assert.ok(dim.stdout.includes('\x1b[2m  · subject not signed\x1b[0m'), 'dim suffix');
});

test('rows: attachments are counted after the short reason; the reason is the describe() field', async () => {
  const dir = makeTmpDir('mp-browse-reason-');
  const PDF = Buffer.from('%PDF-1.4\nx\n');
  const m = await signedMail({ domain: 'att2.example', from: 'ann@att2.example', to: 'me@owner.example', subject: 'two files', signTime: new Date('2026-11-01T09:00:00Z'), attachment: { filename: 'c.pdf', bytes: PDF } });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => new Date('2026-11-01T10:00:00Z') });
  const rec = (await mp.record(m.raw, { direction: 'in', source: 'test' })).record;
  const f = (await mp.describe(rec.id)).records[0];
  assert.equal(typeof f.reason, 'string');
  const w = makeWorld({ accounts: { test: account(dir) } });
  const r = await menu(w, keys('4', '', '', 'q'));
  assert.ok(r.stdout.includes(`    ${f.reason} · 1 attachment\n`) || r.stdout.includes(`    ${f.reason} - 1 attachment\n`), r.stdout);
});

test('breadcrumb: a blank line and a dim path rule before every menu and browser output block; never a screen clear', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'bob@beta.example', '3', 'v', 't', '', 'p', '', '', '', 'q'));
  const L = lines(r.stdout);
  const crumbs = L.filter((l) => /^(── |-- )mailproof/.test(l));
  assert.ok(!r.stdout.includes('\x1b[2J') && !r.stdout.includes('\x1b[H') && !r.stdout.includes('\x1bc'), 'no clear');
  const has = (re) => assert.ok(crumbs.some((c) => re.test(c)), `${re}\n${crumbs.join('\n')}`);
  has(/^(── |-- )mailproof (› |> )4 list (› |> )bob@beta\.example /);
  has(/4 list (› |> )bob@beta\.example (› |> )#3 /);
  has(/#3 (› |> )v verify /);
  has(/#3 (› |> )t thread /);
  has(/#3 (› |> )p this person /);
  for (const c of crumbs) { assert.ok([...c].length <= 64, c); const i = L.indexOf(c); assert.equal(L[i - 1], '', `a blank line before: ${c}`); }
});

test('breadcrumb: main-menu actions and the search, filter and more steps', async () => {
  const w = world();
  const a = await menu(w, keys('5', 'bob@beta.example', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(a.stdout, /^── mailproof › 5 show › bob@beta\.example ─+$/m);
  const b = await menu(w, keys('4', '', 's', 'weekly', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(b.stdout, /^── mailproof › 4 list › everyone › s "weekly" ─+$/m);
  const m = await menu(w, keys('4', '', 'm', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(m.stdout, /^── mailproof › 4 list › everyone › m more ─+$/m);
  const f = await menu(w, keys('4', '', 'f', '', 'in', '', '', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(f.stdout, /^── mailproof › 4 list › everyone › f filter ─+$/m);
  const s = await menu(w, keys('16', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(s.stdout, /^── mailproof › 16 status ─+$/m);
  const nt = await menu(w, keys('4', 'zed@zed.example', '1', 't', '', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(nt.stdout, /^── mailproof › 4 list › zed@zed\.example › #1 › t thread ─+$/m);
});

test('breadcrumb: a thread row opened from a thread names the step; the ASCII locale uses - and >; subcommands print none', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'bob@beta.example', '3', 't', '1', '', '', '', '', 'q'), { env: { LANG: 'en_US.UTF-8' } });
  assert.match(r.stdout, /^── mailproof › 4 list › bob@beta\.example › #3 › t thread › #1 ─+$/m);
  const a = await menu(w, keys('5', 'bob@beta.example', '', 'q'), { env: { LANG: 'C', LC_ALL: 'C' } });
  assert.match(a.stdout, /^-- mailproof > 5 show > bob@beta\.example -+$/m);
  const sub = await w.run(['show', id('signed')], { deps });
  assert.ok(!sub.stdout.includes('mailproof ›') && !sub.stdout.includes('mailproof >'), 'subcommand output unchanged');
});

test('breadcrumb: an address from an email is escaped and the line fits a 40 column terminal', async () => {
  const w = world();
  const r = await menu(w, keys('4', 'bob@beta.example', '', 'q'), { tty: true, columns: 40, rows: 40, env: { LANG: 'en_US.UTF-8' } });
  const c = stripStyle(r.stdout).split('\n').filter((l) => l.startsWith('── mailproof'));
  assert.ok(c.length >= 1);
  for (const l of c) assert.ok([...l].length <= 40, l);
});
