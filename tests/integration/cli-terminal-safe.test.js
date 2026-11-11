// Terminal-safe CLI text output (SPEC B11 output, F28, branch-review H1): hostile mail fields (cursor moves, an OSC title,
// a C1 CSI, a bidi-reversed domain, zero-width padding, a hostile attachment filename) are recorded through the real
// library, then every text command runs through the REAL dispatcher. Text output must carry no forbidden code point;
// --json must still carry the values exactly as received; show --raw must be the stored bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { stubResolver } from '../helpers/proof.js';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { hasForbidden } from '../helpers/forbidden.js';

const ESC = '\u001b';
const MID_HOSTILE = `<a${ESC}]0;pwned\u0007b@example.net>`;
const dir = makeTmpDir('mp-cli-termsafe-');
const clock = { t: new Date('2026-11-01T10:00:00Z') };
const mp = new Mailproof({ trailDir: dir, resolver: stubResolver({}), worker: { size: 0 }, now: () => { clock.t = new Date(clock.t.getTime() + 60000); return clock.t; } });

const req = Buffer.from('From: me@owner.example\r\nTo: bob@example.net\r\nSubject: q\r\nMessage-ID: <req@owner.example>\r\n\r\nplease\r\n');
// the reply: ESC in the Message-ID (OSC title), cursor-up + erase + C1 CSI in the first line, a zero-width padded From, bidi + ESC in the filename
const bidiName = encodeURIComponent('‮exe.txt​').replace(/'/g, '%27');
const reply = Buffer.from([
  `From: "Bob" <bob@example.net​>`, 'To: me@owner.example', 'Subject: s', `Message-ID: ${MID_HOSTILE}`,
  'In-Reply-To: <req@owner.example>', 'References: <req@owner.example>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain; charset=utf-8', '', `yes${ESC}[1A${ESC}[2K    link signed  verified/verified  forged${ESC}]0;t\u0007`, '--b1',
  `Content-Type: application/octet-stream; name="x${ESC}]0;t\u0007.txt"`, `Content-Disposition: attachment; filename*=utf-8''${bidiName}`, '', 'hi', '--b1--', '',
].join('\r\n'), 'utf8');
// a second one: C1 U+009B and U+009D in the Message-ID, a bidi-reversed domain in an unsigned From
const c1 = Buffer.from('From: bob@moc.elpmaxe\r\nTo: me@owner.example\r\nSubject: c1\r\nMessage-ID: <c1\u009b2J\u009d0@example.net>\r\nIn-Reply-To: <req@owner.example>\r\n\r\nline\r\n', 'utf8');
await mp.record(req, { direction: 'out' });
const rHostile = (await mp.record(reply, { direction: 'in' })).record;
const rC1 = (await mp.record(c1, { direction: 'in' })).record;
await mp.close();

const w = makeWorld({ accounts: { t: account(dir) } });
const run = (...argv) => w.run(argv);
const noForbidden = (r, what) => { assert.ok(!hasForbidden(r.stdout), `${what}: stdout holds a forbidden code point: ${JSON.stringify(r.stdout)}`); assert.ok(!hasForbidden(r.stderr), `${what}: stderr: ${JSON.stringify(r.stderr)}`); };

test('the fixture really is hostile (--json carries the raw values)', async () => {
  const rows = JSON.parse((await run('list', '--json')).stdout);
  assert.ok(rows.some((r) => r.message_id === MID_HOSTILE), 'the OSC title is in the stored Message-ID');
  assert.ok(rows.some((r) => /\u009b/.test(r.message_id ?? '')), 'the C1 CSI is in a stored Message-ID');
  assert.equal(rows.length, 3);
});

test('list (text): hostile Message-IDs are shown as escapes, nothing forbidden reaches stdout', async () => {
  const r = await w.run(['list'], { columns: 140 });
  assert.equal(r.code, 0, r.stderr);
  noForbidden(r, 'list');
  assert.ok(r.stdout.includes('bob@moc.elpmaxe'), r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 3, 'still one line per record');
});

test('show (text): from, message-id, attachment filename are escaped; links too', async () => {
  const r = await run('show', rHostile.id);
  assert.equal(r.code, 0, r.stderr);
  noForbidden(r, 'show');
  assert.ok(r.stdout.includes('\\x1b]0;pwned\\x07'), r.stdout);
  assert.ok(r.stdout.includes('\\u202eexe.txt\\u200b'), 'the bidi + zero-width filename is visible as escapes');
  assert.match(r.stdout, /^from +bob@example\.net/m);
  const c = await run('show', rC1.id);
  noForbidden(c, 'show c1');
  const parent = await run('show', JSON.parse((await run('list', '--json', '--direction', 'out')).stdout)[0].id);
  noForbidden(parent, 'show parent (children are hostile ids)');
  assert.ok(parent.stdout.includes('children     <a\\x1b]0;pwned'), parent.stdout);
});

test('replies (text): the first line cannot move the cursor, set the title or forge the verdict line', async () => {
  const r = await run('replies', '<req@owner.example>');
  assert.equal(r.code, 0, r.stderr);
  noForbidden(r, 'replies');
  assert.ok(r.stdout.includes('yes\\x1b[1A\\x1b[2K'), r.stdout);
  // one block of two lines per reply: nothing forged a line of its own
  assert.equal(r.stdout.trim().split('\n').length, 4);
});

test('replies (text): the one-line cut is by code points and does not split an escape', async () => {
  const long = Buffer.from(`From: bob@example.net\r\nTo: me@owner.example\r\nSubject: l\r\nMessage-ID: <long@example.net>\r\nIn-Reply-To: <req@owner.example>\r\n\r\n${`${ESC}x`.repeat(80)}\r\n`);
  const mp2 = new Mailproof({ trailDir: dir, resolver: stubResolver({}), worker: { size: 0 } });
  await mp2.record(long, { direction: 'in' });
  await mp2.close();
  const r = await run('replies', '<req@owner.example>');
  noForbidden(r, 'replies long');
  assert.match(r.stdout, /(\\x1bx){50}\.\.\.\(\+\d+\)/, 'cut to 100 code points, then the count');
});

test('check (text): rule values from the mail are escaped', async () => {
  const f = path.join(makeTmpDir('mp-cli-termsafe-prof-'), 'p.json');
  fs.writeFileSync(f, JSON.stringify({ senders: ['@example.org'], checks: { dkimAligned: true }, link: ['signed'] }));
  const r = await run('check', rHostile.id, '--profile', f, '--parent', '<req@owner.example>');
  assert.equal(r.code, 2, r.stderr);
  noForbidden(r, 'check');
  const j = await run('check', rHostile.id, '--profile', f, '--json');
  assert.equal(j.code, 2);
  assert.ok(JSON.parse(j.stdout).failed.length >= 1);
  const strict = await run('check', rC1.id, '--profile', f);
  noForbidden(strict, 'check c1');
});

test('--json is unchanged: the values come back exactly as received (consumers treat strings as untrusted)', async () => {
  const rows = JSON.parse((await run('list', '--json')).stdout);
  assert.ok(rows.some((r) => r.message_id === MID_HOSTILE));
  const s = JSON.parse((await run('show', rHostile.id, '--json')).stdout);
  assert.equal(s.record.message.message_id, MID_HOSTILE);
  assert.ok(s.proof.attachments.some((a) => a.filename === '‮exe.txt​'), JSON.stringify(s.proof.attachments));
  const rep = JSON.parse((await run('replies', '<req@owner.example>', '--json')).stdout);
  const hit = rep.find((x) => x.messageId === MID_HOSTILE);
  assert.ok(hit.firstLine.startsWith(`yes${ESC}[1A${ESC}[2K`), 'the first line is the original');
  assert.ok(rows.some((r) => r.message_id.includes('\u009b2J')), 'C1 survives in --json');
});

test('show --raw is byte-identical to the stored raw email, hostile or not', async () => {
  const r = await run('show', rHostile.id, '--raw');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdoutBytes, reply);
});

test('errors and warnings are escaped too: a hostile id argument and a hostile account name', async () => {
  const r = await run('show', `zz${ESC}[2K${ESC}]0;x\u0007`);
  assert.notEqual(r.code, 0);
  noForbidden(r, 'bad id');
  const a = await run('list', '--account', `n${ESC}[1A\u009b`);
  assert.notEqual(a.code, 0);
  noForbidden(a, 'bad account');
  const u = await run(`frob${ESC}]0;x\u0007`);
  noForbidden(u, 'unknown command');
  assert.ok(u.stderr.includes('frob\\x1b]0;x\\x07'), u.stderr);
});

test('spawned binary: list output through a real process holds no forbidden code point either', async () => {
  const r = await w.spawn(['list']);
  assert.equal(r.code, 0, r.stderr);
  noForbidden(r, 'spawned list');
});
