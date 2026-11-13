// `config add-account` (SPEC B11.2, B11.12): scripted stdin in, a config file out. Nothing is written before the final
// yes; the file is 0600, written atomically, other accounts kept; a password is never asked for or stored.
import test from 'node:test';
import { stripStyle } from '../../src/cli/style.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

// provider 3 (other IMAP): provider, name, user, host, port, secret kind, secret, folders, sent, trailDir, store, days, ots, advanced?, test login?, write?
const ALL_DEFAULTS = ['3', 'personal', 'ana@example.com', 'imap.example.org', '', '1', 'pass show mailproof/personal', '', '', '', '', '', '', '', 'n', 'y'];
const script = (lines) => `${lines.join('\n')}\n`;
const read = (w) => JSON.parse(fs.readFileSync(w.configFile, 'utf8'));
const mode = (p) => fs.statSync(p).mode & 0o777;

test('a fresh config: the file and its directory are created 0700/0600 with the account, defaults left out', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(read(w), { v: 1, accounts: { personal: { user: 'ana@example.com', host: 'imap.example.org', trailDir: '~/mailproof/personal', passCommand: 'pass show mailproof/personal' } } });
  assert.equal(mode(w.configFile), 0o600);
  assert.equal(mode(path.dirname(w.configFile)), 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(w.configFile)), ['config.json'], 'no temp file left');
  assert.match(r.stdout, /it does not exist yet/);
  assert.match(r.stdout, /^ok written .*config\.json \(mode 0600\)$/m);
  // and it is a valid config for every other command
  assert.equal((await w.run(['config', 'validate'])).code, 0);
});

test('every field: the prompts show label, example and default; non-default answers land in the account', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], {
    input: script(['3', 'biz', 'ana@corp.example.net', 'imap.corp.example.net', '1143', '3', 'oauth-token --account biz', 'INBOX, Archive', '[Gmail]/Sent Mail', '/srv/mp/biz', 'y', '90', 'n', 'y', 'main', 'n', 'git@git.example.org:ana/biz.git', 'n', 'y']),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(read(w).accounts.biz, {
    user: 'ana@corp.example.net', host: 'imap.corp.example.net', port: 1143, folders: ['INBOX', 'Archive'], sent: '[Gmail]/Sent Mail', trailDir: '/srv/mp/biz', trail: 'main',
    accessTokenCommand: 'oauth-token --account biz', content: { attachments: false, days: 90 }, ots: false, backupRemote: 'git@git.example.org:ana/biz.git',
  });
  for (const hint of ['Mail provider (1 = Gmail, 2 = Outlook/Hotmail, 3 = other IMAP, q = back) [1]', 'Account name (letters, digits', 'IMAP host (e.g. imap.example.org, empty = back)', 'Port (q = back) [993]', 'Folders to read (comma separated, q = back) [INBOX]', 'Trail folder (q = back) [~/mailproof/biz]', 'Where does the password come from (1 = a command, 2 = a file, 3 = an OAuth2 token command, q = back) [1]', 'Advanced settings']) {
    assert.ok(r.stdout.includes(hint), hint);
  }
  assert.match(r.stdout, /"accessTokenCommand": "oauth-token --account biz"/, 'the JSON is shown before the question');
});

test('it never asks for a password and never stores one: the only secret fields are a command, a file or a token command', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 5), '2', '/home/ana/.pw', 'n', ...ALL_DEFAULTS.slice(7)]) });
  assert.equal(r.code, 0);
  assert.equal(read(w).accounts.personal.passFile, '/home/ana/.pw');
  assert.ok(!/password:/i.test(r.stdout.replace(/Where does the password come from/g, '')), 'no prompt asks for the password itself');
  assert.match(r.stdout, /Never type the password here|never stores a password|not the password itself/i);
  const keys = JSON.stringify(read(w));
  assert.ok(!/"(pass|password|secret)"/.test(keys));
  // a file path must be absolute
  const w2 = makeWorld({ config: null });
  const r2 = await w2.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 5), '2', 'relative.pw', '/abs/pw', 'n', ...ALL_DEFAULTS.slice(7)]) });
  assert.match(r2.stdout, /give an absolute path/);
  assert.equal(read(w2).accounts.personal.passFile, '/abs/pw');
});

test('an existing config: other accounts are kept, mode stays 0600, the file is replaced atomically', async () => {
  const w = makeWorld({ accounts: { old: account('/t/old') } });
  const before = fs.statSync(w.configFile).ino;
  const r = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(read(w).accounts), ['old', 'personal']);
  assert.equal(read(w).accounts.old.trailDir, '/t/old');
  assert.equal(mode(w.configFile), 0o600);
  assert.notEqual(fs.statSync(w.configFile).ino, before, 'a rename, not an edit in place');
  assert.deepEqual(fs.readdirSync(path.dirname(w.configFile)), ['config.json']);
});

test('an existing account name is not overwritten without a confirmation; no leaves the file byte-identical; yes replaces it', async () => {
  const w = makeWorld({ accounts: { personal: account('/t/old', { user: 'keep@me.example' }) } });
  const bytes = fs.readFileSync(w.configFile);
  const no = await w.run(['config', 'add-account'], { input: script(['3', 'personal', 'n']) });
  assert.equal(no.code, 0);
  assert.match(no.stdout, /An account named "personal" already exists\. Replace it\? \[y\/N\]/);
  assert.match(no.stdout, /nothing changed/);
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  const empty = await w.run(['config', 'add-account'], { input: script(['3', 'personal', '']) });
  assert.match(empty.stdout, /nothing changed/, 'the default answer is no');
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  const yes = await w.run(['config', 'add-account'], { input: script(['3', 'personal', 'y', ...ALL_DEFAULTS.slice(2)]) });
  assert.equal(yes.code, 0, yes.stderr);
  assert.equal(read(w).accounts.personal.user, 'ana@example.com');
});

test('declining the final question, or the input ending, writes nothing', async () => {
  const w = makeWorld({ config: null });
  const no = await w.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 15), 'n']) });
  assert.equal(no.code, 0);
  assert.match(no.stdout, /nothing written/);
  assert.ok(!fs.existsSync(w.configFile) && !fs.existsSync(path.dirname(w.configFile)), 'no file, no directory');
  const cut = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS.slice(0, 5)) });
  assert.equal(cut.code, 64);
  assert.match(cut.stderr, /input ended; nothing was written/);
  assert.ok(!fs.existsSync(w.configFile));
  const none = await w.run(['config', 'add-account']);
  assert.equal(none.code, 64, 'no input at all');
});

test('validation per field: a bad value prints the reason and asks again; three bad answers cancel', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script(['3', 'Bad Name', 'personal', 'ana@example.com', 'imap.example.org', 'abc', '99999', '993', ...ALL_DEFAULTS.slice(5)]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /use \[a-z0-9\]\[a-z0-9_-\]\{0,31\}/);
  assert.match(r.stdout, /a whole number 1-65535/);
  assert.equal(read(w).accounts.personal.port, undefined, 'the default port is left out');
  const w2 = makeWorld({ config: null });
  const bad = await w2.run(['config', 'add-account'], { input: script(['3', 'X!', 'Y!', 'Z!', 'personal']) });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /too many invalid answers/);
  assert.ok(!fs.existsSync(w2.configFile));
  const help = await makeWorld({ config: null }).run(['config', 'add-account'], { input: script(['?', '3', 'personal', 'ana@example.com', 'imap.example.org', '?', ...ALL_DEFAULTS.slice(4)]) });
  assert.match(help.stdout, /1: Gmail with an app password \(the proven path\)/, '? prints the hint');
});

test('a config that is not trusted or not valid is never rewritten', async () => {
  const w = makeWorld({ accounts: { old: account('/t/old') } });
  fs.chmodSync(w.configFile, 0o644);
  const bytes = fs.readFileSync(w.configFile);
  const perm = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) });
  assert.equal(perm.code, 77);
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  fs.chmodSync(w.configFile, 0o600);
  const foreign = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS), euid: process.geteuid() + 1 });
  assert.equal(foreign.code, 77);
  w.write({ v: 1, accounts: { old: { ...account('/t/old'), password: 'hunter2' } } });
  const bad = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /not rewritten/);
  assert.ok(!bad.stderr.includes('hunter2'));
  w.write('{broken');
  assert.equal((await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) })).code, 64);
  assert.equal(fs.readFileSync(w.configFile, 'utf8'), '{broken');
});

test('a trail directory already used by another account is refused before anything is written', async () => {
  const w = makeWorld({ accounts: { old: account('/t/shared') } });
  const bytes = fs.readFileSync(w.configFile);
  const r = await w.run(['config', 'add-account'], { input: script(['3', 'personal', 'ana@example.com', 'imap.example.org', '', '1', 'pass show x', '', '', '/t/shared', ...ALL_DEFAULTS.slice(10)]) });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /shares trailDir and trail with account "old"/);
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  void makeTmpDir;
});


// ---- the provider-first wizard (SPEC B11.12): Gmail, Outlook, other; the password file; the login test; archived mail ----
// Gmail: provider, name, user, password file, [create?, secret], archived mail, sent, trail, store, days, ots, advanced, test login, write, first sync
const SECRET = 'abcd efgh ijkl mnop';
const GMAIL = (over = {}) => ['1', 'gmx', 'ana@gmail.com', '', over.create ?? 'y', SECRET, over.archived ?? 'y', '', '', '', '', '', '', over.test ?? 'n', 'y', over.sync ?? 'n'];

test('Gmail: the missing password file is created 0600 from a hidden answer; the secret is never echoed, printed or stored in the config', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script(GMAIL()) });
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(w.home, '.config', 'mailproof', 'gmx.pass');
  assert.equal(fs.readFileSync(file, 'utf8'), `${SECRET}\n`);
  assert.equal(mode(file), 0o600);
  assert.equal(fs.statSync(file).uid, process.getuid(), 'owned by the user');
  for (const text of [r.stdout, r.stderr, fs.readFileSync(w.configFile, 'utf8')]) assert.ok(!text.includes(SECRET) && !text.includes('abcdefghijklmnop'), 'the secret appears nowhere');
  assert.match(r.stdout, /Paste the password \(hidden\): \n/);
  assert.match(r.stdout, /Password file \(an absolute path or ~\/\.\.\., q = back\) \[~\/\.config\/mailproof\/gmx\.pass\]: \n/);
  assert.match(r.stdout, /not found; create it now\?/);
  assert.deepEqual(read(w).accounts.gmx, { user: 'ana@gmail.com', host: 'imap.gmail.com', folders: ['INBOX', '[Gmail]/All Mail'], trailDir: '~/mailproof/gmx', passFile: '~/.config/mailproof/gmx.pass' });
  assert.equal((await w.run(['config', 'validate'])).code, 0);
});

test('Gmail: an existing password file is not touched or asked about; declining the create offer makes no file; archived mail n keeps INBOX only', async () => {
  const w = makeWorld({ config: null });
  const file = path.join(w.home, '.config', 'mailproof', 'gmx.pass');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'keepme\n', { mode: 0o600 });
  const r = await w.run(['config', 'add-account'], { input: script(['1', 'gmx', 'ana@gmail.com', '', 'n', '', '', '', '', '', '', 'n', 'y', 'n']) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keepme\n');
  assert.ok(!r.stdout.includes('create it now'));
  assert.match(r.stdout, /ok ~\/\.config\/mailproof\/gmx\.pass \(0600, yours\)/);
  assert.equal(read(w).accounts.gmx.folders, undefined, 'INBOX is the default and is left out');
  const w2 = makeWorld({ config: null });
  const r2 = await w2.run(['config', 'add-account'], { input: script(GMAIL({ create: 'n', archived: 'n' }).filter((x) => x !== SECRET)) });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!fs.existsSync(path.join(w2.home, '.config', 'mailproof', 'gmx.pass')));
  assert.match(r2.stdout, /create ~\/\.config\/mailproof\/gmx\.pass before the first sync/);
});

test('Outlook/Hotmail: marked untested with a pointer to the guide; host fixed; the token command is the secret', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script(['2', 'ol', 'ana@outlook.com', 'oauth-token --account ol', '', '', '', '', '', '', '', 'n', 'y', 'n']), env: { FORCE_COLOR: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('\x1b[33m(OAuth2, untested)\x1b[0m'), 'untested in yellow');
  assert.match(r.stdout, /not yet tested with mailproof/);
  assert.match(r.stdout, /docs\/product\/setup-guide\.md section 4/);
  assert.deepEqual(read(w).accounts.ol, { user: 'ana@outlook.com', host: 'outlook.office365.com', trailDir: '~/mailproof/ol', accessTokenCommand: 'oauth-token --account ol' });
  assert.ok(!r.stdout.includes('IMAP host'), 'the host is not asked');
});

test('test login: ok and failure are shown before the write, with the real settings; the config is still written after a failure and yes', async () => {
  const w = makeWorld({ config: null });
  const calls = [];
  const okDeps = { testLogin: async (o) => { calls.push(o); return { ok: true, folders: [{ folder: 'INBOX', count: 4 }, { folder: '[Gmail]/All Mail', count: 6132 }] }; } };
  const r = await w.run(['config', 'add-account'], { input: script(GMAIL({ test: 'y' })), deps: okDeps });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].host, calls[0].port, calls[0].user, calls[0].auth, calls[0].folders, calls[0].sent], ['imap.gmail.com', 993, 'ana@gmail.com', { pass: 'abcdefghijklmnop' }, ['INBOX', '[Gmail]/All Mail'], true]);
  assert.match(r.stdout, /^ok IMAP login ok - INBOX up to 4 - All Mail up to 6,132$/m);
  assert.ok(r.stdout.indexOf('IMAP login ok') < r.stdout.indexOf('This account would be added'), 'before the JSON and the write');
  const w2 = makeWorld({ config: null });
  const bad = await w2.run(['config', 'add-account'], { input: script(GMAIL({ test: 'y' })), deps: { testLogin: async () => ({ ok: false, code: 'ERR_IMAP_AUTH', message: 'login refused by the server' }) }, env: { FORCE_COLOR: '1' } });
  assert.equal(bad.code, 0);
  assert.ok(bad.stdout.includes('\x1b[31mx login failed\x1b[0m (ERR_IMAP_AUTH): login refused by the server'), 'red cross and the reason');
  assert.ok(fs.existsSync(w2.configFile));
  const w3 = makeWorld({ config: null });
  const no = await w3.run(['config', 'add-account'], { input: script(GMAIL({ test: 'n' })), deps: { testLogin: async () => { throw new Error('must not run'); } } });
  assert.equal(no.code, 0);
});

test('first sync now: yes runs the same `sync` for the new account', async () => {
  const w = makeWorld({ config: null });
  const seen = [];
  const deps = { sync: async (mp, o) => { seen.push(o); return { complete: true, folders: [] }; } };
  const r = await w.run(['config', 'add-account'], { input: script(GMAIL({ sync: 'y' })), deps });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].host, 'imap.gmail.com');
  assert.deepEqual(seen[0].auth, { pass: 'abcdefghijklmnop' });
  assert.match(r.stdout, /^complete$/m);
});

test('on a terminal the typed secret is not echoed (echo off), and it is written to the file', async () => {
  const { PassThrough } = await import('node:stream');
  const { run } = await import('../../src/cli/run.js');
  const w = makeWorld({ config: null });
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 100;
  let text = '';
  stdout.on('data', (d) => { text += d; });
  const done = run(['config', 'add-account'], { stdout, stderr: { write: () => true }, stdin, interactive: true, env: w.env, signal: new AbortController().signal, deps: {} });
  let mark = 0;
  const until = async (re) => { const t0 = Date.now(); while (!re.test(stripStyle(text.slice(mark))) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 10)); assert.match(stripStyle(text.slice(mark)), re); mark = text.length; };
  const say = async (re, line) => { await until(re); stdin.write(`${line}\n`); };
  await say(/Mail provider[^\n]*\[1\]: /, '1');
  await say(/Account name[^\n]*: /, 'gmx');
  await say(/Email address[^\n]*: /, 'ana@gmail.com');
  await say(/Password file[^\n]*: /, '');
  await say(/create it now\?[^\n]*\[Y\/n\] /, '');
  await until(/Paste the password \(hidden\): /);
  stdin.write('s3cr3t-typed-value\n');
  await until(/0600, yours[\s\S]*archived mail/i);
  stdin.end();
  assert.equal(await done, 64, 'the input ended: nothing written');
  assert.ok(!text.includes('s3cr3t'), 'the terminal never saw the secret');
  assert.equal(fs.readFileSync(path.join(w.home, '.config', 'mailproof', 'gmx.pass'), 'utf8'), 's3cr3t-typed-value\n');
});
