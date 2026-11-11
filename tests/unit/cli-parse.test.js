// Validators, the watch backoff, the secret-source helpers and the backup helpers of the CLI (SPEC B11.1, B11.5, B11.9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDate, parseAddress, parseDuration, parseLimit, parseSent, parseFolders, parseChoice, resolveId, messageIdOf, MIN_INTERVAL_MS } from '../../src/cli/parse.js';
import { UsageError, PermError, exitFor, exitForError } from '../../src/cli/errors.js';
import { splitCommand, passwordAuth, resolveAuth } from '../../src/cli/secrets.js';
import { nextWait } from '../../src/cli/watch.js';
import { redactUrl, classifyPush, defaultBundlePath } from '../../src/cli/backup.js';
import { recordPath } from '../../src/proof/layout.js';
import { makeTmpDir } from '../helpers/tmp.js';

test('dates: YYYY-MM-DD is UTC midnight, a full ISO time needs a zone, everything else is a UsageError naming the flag', () => {
  assert.equal(parseDate('2026-08-19', '--before').toISOString(), '2026-08-19T00:00:00.000Z');
  assert.equal(parseDate('2026-08-19T10:00:00Z', '--at').toISOString(), '2026-08-19T10:00:00.000Z');
  assert.equal(parseDate('2026-08-19T10:00:00+02:00', '--at').toISOString(), '2026-08-19T08:00:00.000Z');
  for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '19/08/2026', '2026-08-19T10:00:00', '', '2026-8-19']) {
    assert.throws(() => parseDate(bad, '--before'), (e) => e instanceof UsageError && /--before/.test(e.message), bad);
  }
});

test('addresses, limits, sent, folders, choices', () => {
  assert.equal(parseAddress(' bob@example.org ', '--with'), 'bob@example.org');
  for (const bad of ['bob', '@x.org', 'a b@c.d', 'Bob <b@c.d>', 'a@b,c@d']) assert.throws(() => parseAddress(bad, '--with'), UsageError, bad);
  assert.equal(parseLimit('0', '--limit'), 0);
  assert.equal(parseLimit('50', '--limit'), 50);
  for (const bad of ['-1', '1.5', 'x', '']) assert.throws(() => parseLimit(bad, '--limit'), UsageError);
  assert.equal(parseSent('on'), true);
  assert.equal(parseSent('OFF'), false);
  assert.equal(parseSent('[Gmail]/Sent Mail'), '[Gmail]/Sent Mail');
  assert.deepEqual(parseFolders('INBOX, Archive ,'), ['INBOX', 'Archive']);
  assert.throws(() => parseFolders(' , '), UsageError);
  assert.equal(parseChoice('IN', '--direction', 'in', 'out'), 'in');
  assert.throws(() => parseChoice('up', '--direction', 'in', 'out'), /use in, out/);
  assert.equal(messageIdOf('a@b'), '<a@b>');
  assert.equal(messageIdOf(' <a@b> '), '<a@b>');
  assert.throws(() => messageIdOf(' '), UsageError);
});

test('durations: 30s, 5m, 1h; below the minimum or malformed is refused', () => {
  assert.equal(parseDuration('30s', '--interval'), 30_000);
  assert.equal(parseDuration('5m', '--interval'), 300_000);
  assert.equal(parseDuration('1h', '--interval'), 3_600_000);
  assert.equal(MIN_INTERVAL_MS, 30_000);
  assert.throws(() => parseDuration('29s', '--interval'), /minimum is 30s/);
  assert.throws(() => parseDuration('1d', '--interval'), /not a duration/);
  assert.throws(() => parseDuration('5', '--interval'), UsageError);
  assert.equal(parseDuration('1s', '--interval', 1000), 1000, 'tests may lower the floor');
});

test('watch backoff: the interval, doubled per consecutive failure, capped at one hour, never below the interval', () => {
  assert.equal(nextWait(300_000, 0), 300_000);
  assert.equal(nextWait(300_000, 1), 600_000);
  assert.equal(nextWait(300_000, 2), 1_200_000);
  assert.equal(nextWait(300_000, 3), 2_400_000);
  assert.equal(nextWait(300_000, 4), 3_600_000);
  assert.equal(nextWait(300_000, 40), 3_600_000);
  assert.equal(nextWait(7_200_000, 3), 7_200_000, 'an interval over an hour is not shortened');
});

test('record ids: a full id, or a unique prefix of 8 or more found in the shard directory', async () => {
  const root = makeTmpDir('mp-cli-ids-');
  const ids = ['ab12cd34ef56ab12cd34ef56ab12cd34', 'ab12cd34ef5600000000000000000000', 'ab99999999999999999999999999999a'];
  for (const id of ids) { fs.mkdirSync(path.join(root, path.dirname(recordPath(id))), { recursive: true }); fs.writeFileSync(path.join(root, recordPath(id)), '{}'); }
  assert.equal(await resolveId(ids[0], root), ids[0]);
  assert.equal(await resolveId(ids[0].toUpperCase(), root), ids[0]);
  assert.equal(await resolveId('ab99999999', root), ids[2]);
  await assert.rejects(resolveId('ab12cd34', root), (e) => e instanceof UsageError && /ambiguous/.test(e.message) && e.message.includes(ids[0]) && e.message.includes(ids[1]));
  await assert.rejects(resolveId('ab12cd3', root), /at least 8/);
  await assert.rejects(resolveId('cd12cd34ef', root), /no record has an id starting with/);
  await assert.rejects(resolveId('xyz', root), UsageError);
});

test('splitCommand: argv without a shell; quotes and escapes; an unterminated quote is a UsageError', () => {
  assert.deepEqual(splitCommand('pass show "my site/x" \'a b\' c\\ d'), ['pass', 'show', 'my site/x', 'a b', 'c d']);
  assert.deepEqual(splitCommand('  a   b '), ['a', 'b']);
  assert.deepEqual(splitCommand('a "" b'), ['a', '', 'b']);
  assert.throws(() => splitCommand('a "b'), UsageError);
});

test('secrets: Google app-password spaces removed, any other password only trimmed; a command or file source, never a shell', async () => {
  assert.deepEqual(passwordAuth('abcd efgh ijkl mnop\r'), { pass: 'abcdefghijklmnop' });
  assert.deepEqual(passwordAuth('  p4ss word  '), { pass: 'p4ss word' });
  assert.throws(() => passwordAuth('  '), UsageError);
  const dir = makeTmpDir('mp-cli-sec-');
  fs.writeFileSync(path.join(dir, 'pw'), 'from-file\nsecond\n', { mode: 0o600 });
  assert.deepEqual(await resolveAuth({ passFile: path.join(dir, 'pw') }), { pass: 'from-file' });
  assert.deepEqual(await resolveAuth({ passCommand: `${process.execPath} -e "console.log('from-cmd'); console.log('x')"` }), { pass: 'from-cmd' });
  assert.deepEqual(await resolveAuth({ accessTokenCommand: `${process.execPath} -e "console.log('tok')"` }), { accessToken: 'tok' });
  // no shell: a metacharacter is just an argument
  assert.deepEqual(await resolveAuth({ passCommand: `${process.execPath} -e "console.log(process.argv[1])" ";" echo` }), { pass: ';' });
  await assert.rejects(resolveAuth({ passCommand: '/nonexistent/cmd' }), (e) => e.code === 'EX_SECRET_COMMAND' && !/nonexistent/.test(e.message.replace('pass command failed', '')));
  await assert.rejects(resolveAuth({ passFile: path.join(dir, 'missing') }), UsageError);
  await assert.rejects(resolveAuth({}), UsageError);
});

test('exit codes: library and secret-command codes map as in mailproof-sync (B4.1) plus the CLI classes', () => {
  for (const c of ['ERR_SYNC_LOCKED', 'ERR_TRAIL_LOCKED', 'ERR_IMAP_CONNECT', 'ERR_IMAP_TIMEOUT', 'ERR_IMAP_THROTTLED', 'ERR_IMAP_UIDVALIDITY', 'EX_SECRET_COMMAND']) assert.equal(exitFor(c), 75, c);
  assert.equal(exitFor('ERR_IMAP_AUTH'), 77);
  assert.equal(exitFor('ERR_IMAP_NO_FOLDER'), 1);
  assert.equal(exitFor(undefined), 1);
  assert.equal(exitForError(new UsageError('x')), 64);
  assert.equal(exitForError(new PermError('x')), 77);
  assert.equal(exitForError(new TypeError('bad option')), 64);
  assert.equal(exitForError(Object.assign(new Error('x'), { code: 'ERR_BAD_PROFILE' })), 64);
  assert.equal(exitForError(Object.assign(new Error('x'), { code: 'ERR_TRAIL_LOCKED' })), 75);
  assert.equal(exitForError(new Error('x')), 1);
});

test('backup helpers: credentials in a URL are hidden, a failed push is classified, the default path is under the state dir', () => {
  assert.equal(redactUrl('https://user:tok3n@git.example.org/a.git'), 'https://***@git.example.org/a.git');
  assert.equal(redactUrl('ssh://git@host/a.git'), 'ssh://***@host/a.git');
  assert.equal(redactUrl('git@git.example.org:ana/x.git'), 'git@git.example.org:ana/x.git');
  assert.equal(redactUrl('/srv/git/x.git'), '/srv/git/x.git');
  assert.equal(classifyPush(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs'), 'rejected');
  assert.equal(classifyPush("fatal: unable to access 'https://x/': Could not resolve host: x"), 'network');
  assert.equal(classifyPush('git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'network');
  assert.equal(classifyPush('fatal: something else'), 'other');
  assert.equal(defaultBundlePath('/s', 'personal', new Date('2026-11-10T10:15:30.123Z')), path.join('/s', 'backups', 'personal', 'personal-20261110T101530Z.bundle'));
});

test('passFile: a file with group or other bits is refused with a PermError (not read); mode 0600 is read', async () => {
  const dir = makeTmpDir('mp-cli-secmode-');
  const f = path.join(dir, 'pw');
  fs.writeFileSync(f, 'hunter2-file\n', { mode: 0o600 });
  fs.chmodSync(f, 0o644);
  await assert.rejects(resolveAuth({ passFile: f }), (e) => e instanceof PermError && /mode 0600/.test(e.message) && !/hunter2/.test(e.message));
  fs.chmodSync(f, 0o640);
  await assert.rejects(resolveAuth({ passFile: f }), PermError);
  fs.chmodSync(f, 0o600);
  assert.deepEqual(await resolveAuth({ passFile: f }), { pass: 'hunter2-file' });
});
