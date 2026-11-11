// `config add-account` (SPEC B11.2, B11.12): scripted stdin in, a config file out. Nothing is written before the final
// yes; the file is 0600, written atomically, other accounts kept; a password is never asked for or stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

// name, user, host, port, folders, sent, trailDir, trail, secret kind, secret, store, attachments, days, ots, remote, write?
const ALL_DEFAULTS = ['personal', 'ana@example.com', '', '', '', '', '', '', '', 'pass show mailproof/personal', '', '', '', '', '', 'y'];
const script = (lines) => `${lines.join('\n')}\n`;
const read = (w) => JSON.parse(fs.readFileSync(w.configFile, 'utf8'));
const mode = (p) => fs.statSync(p).mode & 0o777;

test('a fresh config: the file and its directory are created 0700/0600 with the account, defaults left out', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script(ALL_DEFAULTS) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(read(w), { v: 1, accounts: { personal: { user: 'ana@example.com', host: 'imap.gmail.com', trailDir: '~/mailproof/personal', passCommand: 'pass show mailproof/personal' } } });
  assert.equal(mode(w.configFile), 0o600);
  assert.equal(mode(path.dirname(w.configFile)), 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(w.configFile)), ['config.json'], 'no temp file left');
  assert.match(r.stdout, /it does not exist yet/);
  assert.match(r.stdout, /written: .*config\.json \(mode 0600\)/);
  // and it is a valid config for every other command
  assert.equal((await w.run(['config', 'validate'])).code, 0);
});

test('every field: the prompts show label, example and default; non-default answers land in the account', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], {
    input: script(['biz', 'ana@corp.example.net', 'imap.corp.example.net', '1143', 'INBOX, Archive', '[Gmail]/Sent Mail', '/srv/mp/biz', 'main', '3', 'oauth-token --account biz', 'y', 'n', '90', 'n', 'git@git.example.org:ana/biz.git', 'y']),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(read(w).accounts.biz, {
    user: 'ana@corp.example.net', host: 'imap.corp.example.net', port: 1143, folders: ['INBOX', 'Archive'], sent: '[Gmail]/Sent Mail', trailDir: '/srv/mp/biz', trail: 'main',
    accessTokenCommand: 'oauth-token --account biz', content: { attachments: false, days: 90 }, ots: false, backupRemote: 'git@git.example.org:ana/biz.git',
  });
  for (const hint of ['Account name (letters, digits', 'IMAP host [imap.gmail.com]', 'Port [993]', 'Folders to read (comma separated) [INBOX]', 'Trail directory [~/mailproof/biz]', 'Where does the password come from (1 = a command, 2 = a file, 3 = an OAuth2 token command) [1]']) {
    assert.ok(r.stdout.includes(hint), hint);
  }
  assert.match(r.stdout, /"accessTokenCommand": "oauth-token --account biz"/, 'the JSON is shown before the question');
});

test('it never asks for a password and never stores one: the only secret fields are a command, a file or a token command', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 8), '2', '/home/ana/.pw', ...ALL_DEFAULTS.slice(10)]) });
  assert.equal(r.code, 0);
  assert.equal(read(w).accounts.personal.passFile, '/home/ana/.pw');
  assert.ok(!/password:/i.test(r.stdout.replace(/Where does the password come from/g, '')), 'no prompt asks for the password itself');
  assert.match(r.stdout, /Never type the password here|not the password itself/i);
  const keys = JSON.stringify(read(w));
  assert.ok(!/"(pass|password|secret)"/.test(keys));
  // a file path must be absolute
  const w2 = makeWorld({ config: null });
  const r2 = await w2.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 8), '2', 'relative.pw', '/abs/pw', ...ALL_DEFAULTS.slice(10)]) });
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
  const no = await w.run(['config', 'add-account'], { input: script(['personal', 'n']) });
  assert.equal(no.code, 0);
  assert.match(no.stdout, /An account named "personal" already exists\. Replace it\? \[y\/N\]/);
  assert.match(no.stdout, /nothing changed/);
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  const empty = await w.run(['config', 'add-account'], { input: script(['personal', '']) });
  assert.match(empty.stdout, /nothing changed/, 'the default answer is no');
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  const yes = await w.run(['config', 'add-account'], { input: script(['personal', 'y', ...ALL_DEFAULTS.slice(1)]) });
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
  const r = await w.run(['config', 'add-account'], { input: script(['Bad Name', 'personal', 'ana@example.com', '', 'abc', '99999', '993', ...ALL_DEFAULTS.slice(4)]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /use \[a-z0-9\]\[a-z0-9_-\]\{0,31\}/);
  assert.match(r.stdout, /a whole number 1-65535/);
  assert.equal(read(w).accounts.personal.port, undefined, 'the default port is left out');
  const w2 = makeWorld({ config: null });
  const bad = await w2.run(['config', 'add-account'], { input: script(['X!', 'Y!', 'Z!', 'personal']) });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /too many invalid answers/);
  assert.ok(!fs.existsSync(w2.configFile));
  const help = await makeWorld({ config: null }).run(['config', 'add-account'], { input: script(['?', 'personal', 'ana@example.com', '?', ...ALL_DEFAULTS.slice(2)]) });
  assert.match(help.stdout, /Gmail: imap\.gmail\.com\. Microsoft 365/, '? prints the hint');
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
  const r = await w.run(['config', 'add-account'], { input: script(['personal', 'ana@example.com', '', '', '', '', '/t/shared', ...ALL_DEFAULTS.slice(7)]) });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /shares trailDir and trail with account "old"/);
  assert.deepEqual(fs.readFileSync(w.configFile), bytes);
  void makeTmpDir;
});

test('the password-file prompt shows a copy-pasteable default built from the real home and the account name', async () => {
  const w = makeWorld({ config: null });
  const r = await w.run(['config', 'add-account'], { input: script([...ALL_DEFAULTS.slice(0, 8), '2', '~/p.pass', ...ALL_DEFAULTS.slice(10)]) });
  assert.ok(r.stdout.includes(path.join(w.env.HOME, '.config', 'mailproof', 'personal.pass')), r.stdout);
  assert.ok(!r.stdout.includes('/home/ana'));
});
