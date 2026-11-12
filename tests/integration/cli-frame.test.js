// The shared screen frame of the menu (SPEC B11.4b): crumb and job line the moment an item is chosen (before its questions), a blank
// line and a dim rule between every result and the options, the status block with its rules, prompts that back out on an empty
// answer or q, ~/mailproof/<kind>/ defaults that are the name written, `~` expansion in every path argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { run } from '../../src/cli/run.js';
import { stripStyle, makeStyle } from '../../src/cli/style.js';
import { MENU_ITEMS, SCREEN_JOBS, mainHeader } from '../../src/cli/menu-header.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';

const T = await buildThread();
const world = () => makeWorld({ accounts: { test: account(T.dir) } });
const keys = (...l) => `${l.join('\n')}\n`;
const menu = (w, input, opts = {}) => w.run([], { interactive: true, input, ...opts });
const SHORT = '  1 sync  3 people  5 show  7 verify  11 export  16 status  - ? all - q quit';

/** A menu on fake terminal streams (the compact line, the pager and the header block as a person sees them). */
function terminalMenu(w, deps = {}, env = {}) {
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 120; stdout.rows = 60;
  let text = '';
  stdout.on('data', (d) => { text += d; });
  const done = run([], { stdout, stderr: { write: () => true, isTTY: false }, stdin, interactive: true, env: { ...w.env, ...env }, signal: new AbortController().signal, deps });
  const until = async (re) => { const t0 = Date.now(); while (!re.test(stripStyle(text)) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 10)); assert.match(stripStyle(text), re); };
  return { stdin, done, until, text: () => stripStyle(text) };
}

test('every menu item has a one-sentence job line, from the one menu table; the sub-screens have theirs', () => {
  assert.equal(MENU_ITEMS.length, 19);
  for (const i of MENU_ITEMS) assert.match(i.job, /^[A-Z].{15,100}[.)]$/, `${i.cmd}: ${i.job}`);
  for (const k of ['open', 'raw', 'attachment', 'verify', 'thread', 'person', 'more', 'filter', 'subject']) assert.match(SCREEN_JOBS[k], /^[A-Z].{10,100}\.$/, k);
});

test('the crumb and the job line print the moment an item is chosen, before its first question', async () => {
  const w = world();
  const r = await menu(w, keys('5', '', 'q'));
  const show = MENU_ITEMS.find((i) => i.cmd === 'show');
  const at = r.stdout.indexOf('-- mailproof > 5 show ');
  assert.ok(at >= 0, r.stdout);
  assert.ok(r.stdout.indexOf('Target (') > at, 'the question comes after the crumb');
  assert.match(r.stdout, new RegExp(`\\n-- mailproof > 5 show -+\\n${show.job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nTarget \\(`));
  const eml = await menu(w, keys('9', '', 'q'));
  assert.match(eml.stdout, /-- mailproof > 9 check \.eml -+\n.+\n\nPath of the \.eml file/, 'the same for check .eml');
});

test('a blank line and a dim rule separate every result from the options: the short line, the browse footer, the opened-email action line', async () => {
  const w = world();
  const m = terminalMenu(w);
  await m.until(/> \x1b\[3G$/);
  m.stdin.write('7\n');
  await m.until(/Target \(/);
  m.stdin.write(`${T.r.signed.id}\n`);
  await m.until(/At \(/);
  m.stdin.write('\n');
  await m.until(/1 sync {2}3 people/);
  assert.match(m.text(), /\n\n-{64}\n {2}1 sync {2}3 people {2}5 show/, 'result, blank, rule, short line');
  m.stdin.write('q\n');
  await m.done;
  const l = await menu(w, keys('4', '', '1', '', '', 'q'));
  assert.match(l.stdout, /\n\n-{64}\n5 of 6 - open: a number/, 'list footer');
  assert.match(l.stdout, /\n\n-{64}\n {2}r raw email - a save attachment/, 'opened-email action line');
});

test('the status block after a state-changing action has the rules above and below, and its first line bold', async () => {
  const st = makeStyle({ env: { FORCE_COLOR: '1', LANG: 'en_US.UTF-8' } });
  const h = { version: '3.3.0', user: 'me@x.example', account: 'p', trailOk: true, lastSync: null, records: { total: 2, verified: 1, unverified: 1, out: 0 }, seal: { state: 'off', nextDue: null }, watch: false, manyAccounts: false };
  const lines = mainHeader(st, h, new Date('2026-11-12T10:00:00Z'));
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith('\x1b[1m'), 'the identity line starts bold');
  assert.equal(stripStyle(lines[1]).startsWith('mailproof 3.3.0'), true);
  const w = world();
  const m = terminalMenu(w, { sync: async () => ({ complete: true, folders: [] }), stamp: async () => ({}) });
  await m.until(/> \x1b\[3G$/);
  m.stdin.write('12\n');   // seal: no questions, and it changes the state
  await m.until(/- q quit\n/);
  assert.match(m.text(), /\n\n-{64}\nmailproof \d+\.\d+\.\d+ - me@owner\.example[^\n]*\nrecords: [^\n]*\n-{64}\n {2}1 sync {2}3 people/, 'rule, status lines, rule, short line');
  m.stdin.write('q\n');
  await m.done;
});

test('a prompt backs out: an empty answer or q goes back, a required value never loops; the label says how', async () => {
  const w = world();
  const e = await menu(w, keys('5', '', 'q'));
  assert.ok(!e.stdout.includes('a value is needed'), 'no loop');
  assert.ok(!e.stdout.includes('cancelled'), 'a back is not an error');
  assert.match(e.stdout, /Target \(.*, empty = back\): /);
  assert.equal(e.stdout.split(SHORT).length, 2, 'back at the menu: its options line once, then the prompt took the q');
  const q = await menu(w, keys('5', 'q', 'q'));
  assert.ok(!q.stdout.includes('a value is needed') && !q.stdout.includes('not a choice'));
  assert.equal(q.code, 0);
  let syncs = 0;
  const wt = await menu(w, keys('2', 'q', 'q'), { deps: { sync: async () => { syncs++; return { complete: true, folders: [] }; } } });
  assert.match(wt.stdout, /Interval \(30s, 5m, 1h, q = back\) \[5m\]: /, 'a default: the default plus q = back');
  assert.equal(syncs, 0, 'q went back: no watch');
  const opt = await menu(w, keys('4', 'q', 'q'));
  assert.match(opt.stdout, /Who \(address, empty = everyone, q = back\): /);
  assert.ok(!/^ #  when/m.test(opt.stdout), 'q at an optional prompt also goes back (no list)');
});

test('~/mailproof/<kind>/: the export and backup defaults are the name written (one timestamp), absolute under HOME, 0700, shown with ~/', async () => {
  const w = world();
  let t = Date.parse('2026-11-12T12:57:25Z');
  const deps = { now: () => new Date((t += 7000)) };   // every call is later: a recomputed name would differ
  const ex = await menu(w, keys('11', 'alice@alpha.example', '', '', '', 'n', 'q'), { deps });
  assert.equal(ex.code, 0, ex.stderr);
  const dir = path.join(w.home, 'mailproof', 'exports');
  const written = fs.readdirSync(dir);
  assert.equal(written.length, 1);
  assert.match(written[0], /^mailproof-bundle-test-\d{8}-\d{6}$/);
  assert.ok(ex.stdout.includes(`[~/mailproof/exports/${written[0]}]`), `offered name = written name: ${written[0]}\n${ex.stdout}`);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(!ex.stdout.includes(w.home), 'the absolute home path is never shown');
  const bk = await menu(w, keys('13', '', 'n', 'q'), { deps });
  assert.equal(bk.code, 0, bk.stderr);
  const bdir = path.join(w.home, 'mailproof', 'backups');
  const made = fs.readdirSync(bdir).filter((f) => f.endsWith('.bundle'));
  assert.equal(made.length, 1);
  assert.match(made[0], /^test-\d{8}T\d{6}Z\.bundle$/);
  assert.ok(bk.stdout.includes(`[~/mailproof/backups/${made[0]}]`), `offered backup name = written name\n${bk.stdout}`);
  assert.ok(!bk.stdout.includes(w.home));
  assert.equal(fs.statSync(bdir).mode & 0o777, 0o700);
});

test('the subcommands default to the same folders, whatever the current directory is', async () => {
  const w = world();
  const cwd = process.cwd();
  const ex = await w.run(['export', '--with', 'alice@alpha.example', '--json'], { deps: { now: () => new Date('2026-11-12T13:02:48Z') } });
  assert.equal(ex.code, 0, ex.stderr);
  assert.equal(JSON.parse(ex.stdout).out, path.join(w.home, 'mailproof', 'exports', 'mailproof-bundle-test-20261112-130248'));
  assert.ok(!fs.existsSync(path.join(cwd, 'mailproof-bundle-test-20261112-130248')));
  const bk = await w.run(['backup', '--json'], { deps: { now: () => new Date('2026-11-12T13:02:48Z') } });
  assert.equal(JSON.parse(bk.stdout).bundle, path.join(w.home, 'mailproof', 'backups', 'test-20261112T130248Z.bundle'));
  const text = await w.run(['backup'], { deps: { now: () => new Date('2026-11-12T13:05:00Z') } });
  assert.match(text.stdout, /^bundle {3}~\/mailproof\/backups\/test-20261112T130500Z\.bundle /m);
});

test('~ and ~/x expand in every path argument: export --out, backup --out, verify-bundle, check --profile', async () => {
  const w = world();
  const ex = await w.run(['export', '--with', 'alice@alpha.example', '--out', '~/b1']);
  assert.equal(ex.code, 0, ex.stderr);
  assert.ok(fs.existsSync(path.join(w.home, 'b1', 'bundle.json')));
  assert.ok(!fs.existsSync(path.join(process.cwd(), '~')), 'no folder named ~');
  assert.match(ex.stdout, /^ok wrote ~\/b1 /m, 'the printed path uses ~/');
  const v = await w.run(['verify-bundle', '~/b1']);
  assert.ok(!/no such|cannot read/i.test(v.stderr), v.stderr);
  const bk = await w.run(['backup', '--out', '~/bak.bundle']);
  assert.equal(bk.code, 0, bk.stderr);
  assert.ok(fs.existsSync(path.join(w.home, 'bak.bundle')));
  fs.writeFileSync(path.join(w.home, 'p.json'), JSON.stringify({ senders: ['@beta.example'] }));
  const c = await w.run(['check', T.r.signed.id, '--profile', '~/p.json']);
  assert.equal(c.code, 0, c.stderr);
});

test('a saved attachment goes to ~/mailproof/saved/<name> by default', async () => {
  const dir = makeTmpDir('mp-frame-att-');
  const PDF = Buffer.from('%PDF-1.4\nframe test bytes\n');
  const m = await signedMail({ domain: 'att.example', from: 'ann@att.example', to: 'me@owner.example', subject: 'with a file', signTime: new Date('2026-11-01T09:00:00Z'), attachment: { filename: 'c.pdf', bytes: PDF } });
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, now: () => new Date('2026-11-01T10:00:00Z') });
  await mp.record(m.raw, { direction: 'in', source: 'test' });
  const w = makeWorld({ accounts: { test: account(dir) } });
  const r = await menu(w, keys('4', '', '1', 'a', '1', '', '', '', 'q'));
  assert.ok(r.stdout.includes('Save to (path, q = back) [~/mailproof/saved/c.pdf]: '), r.stdout);
  assert.deepEqual(fs.readFileSync(path.join(w.home, 'mailproof', 'saved', 'c.pdf')), PDF);
  assert.equal(fs.statSync(path.join(w.home, 'mailproof', 'saved')).mode & 0o777, 0o700);
  assert.match(r.stdout, /saved \d+ bytes to ~\/mailproof\/saved\/c\.pdf/);
});

test('a sub-screen has its own crumb and job line: opened email, thread, filter', async () => {
  const w = world();
  const r = await menu(w, keys('4', '', '1', 't', '', 'f', '', '', '', '', 'q'));
  assert.match(r.stdout, new RegExp(`-- mailproof > 4 list > everyone > #1 -+\\n${SCREEN_JOBS.open}\\n`));
  assert.match(r.stdout, new RegExp(`> t thread -+\\n${SCREEN_JOBS.thread}\\n`));
  assert.match(r.stdout, new RegExp(`> f filter -+\\n${SCREEN_JOBS.filter}\\n\\nRole|> f filter -+\\n${SCREEN_JOBS.filter}\\n\\nDirection`), 'the filter crumb comes before its questions');
});
