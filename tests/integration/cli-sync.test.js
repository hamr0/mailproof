// bin/mailproof-sync.js spawned against the fake TLS IMAP server. The CLI has no way to add a CA, so the child
// trusts the throwaway certificate through NODE_EXTRA_CA_CERTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { startFakeImap, makeCert } from '../helpers/fake-imap-server.js';
import { makeTmpDir } from '../helpers/tmp.js';

const CLI = path.resolve(import.meta.dirname, '../../bin/mailproof-sync.js');
const CERT = makeCert();
const SECRET = 'Sup3r-Secret-App-Pass-7f3a';
const USER = 'acct.owner@account.test';
const mail = (n) => Buffer.from(`From: a@b.test\r\nTo: c@d.test\r\nSubject: m${n}\r\nMessage-ID: <m${n}@b.test>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nbody ${n}\r\n`);

const work = makeTmpDir('mp-cli-');
const certFile = path.join(work, 'ca.pem');
fs.writeFileSync(certFile, CERT.cert);
// a pass command that prints the secret (a tiny node script: portable, no shell)
const passScript = path.join(work, 'print-pass.mjs');
fs.writeFileSync(passScript, `console.log(${JSON.stringify(SECRET.replace(/(.{4})/g, '$1 '))});\nconsole.log('second line ignored');\n`);

const servers = [];
const serve = async (n = 2, extra = {}) => {
  const s = await startFakeImap({ tls: CERT, folders: { INBOX: { msgs: Array.from({ length: n }, (_, i) => ({ uid: i + 1, raw: mail(i + 1) })) } }, ...extra });
  servers.push(s);
  return s;
};
test.after(async () => { await Promise.all(servers.map((s) => s.close())); });

function run(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: certFile, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const base = (srv, trailDir) => ['--trail-dir', trailDir, '--host', '127.0.0.1', '--port', String(srv.port), '--user', USER, '--sent', 'off'];
const passCmd = `${process.execPath} ${passScript}`;

test('happy run via --pass-command: JSON summary, exit 0, the secret appears nowhere; a second run records 0', async () => {
  const srv = await serve(2);
  const trailDir = makeTmpDir('mp-cli-trail-');
  const args = [...base(srv, trailDir), '--pass-command', passCmd];
  const r1 = await run(args);
  assert.equal(r1.code, 0, r1.stderr);
  const lines = r1.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'one JSON line');
  const j1 = JSON.parse(lines[0]);
  assert.equal(j1.complete, true);
  assert.equal(j1.folders[0].folder, 'INBOX');
  assert.equal(j1.folders[0].recorded, 2);
  for (const out of [r1.stdout, r1.stderr]) {
    assert.ok(!out.includes(SECRET) && !out.includes(SECRET.replace(/(.{4})/g, '$1 ').trim()), 'the password is never echoed');
  }
  assert.ok(srv.log.some((l) => l.line === 'plain ok'), 'the spaces in the app password were stripped');

  const r2 = await run(args);
  assert.equal(r2.code, 0, r2.stderr);
  const j2 = JSON.parse(r2.stdout);
  assert.equal(j2.folders[0].recorded, 0);
  assert.equal(j2.folders[0].seen, 0);
});

test('--pass-file and stdin also work', async () => {
  const srv = await serve(1);
  const trailDir = makeTmpDir('mp-cli-trail-');
  const pf = path.join(work, 'pw');
  fs.writeFileSync(pf, SECRET + '\n');
  const a = await run([...base(srv, trailDir), '--pass-file', pf]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).folders[0].recorded, 1);
  const trail2 = makeTmpDir('mp-cli-trail-');
  const b = await run(base(srv, trail2), { input: SECRET + '\n' });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).folders[0].recorded, 1);
});

test('env fallbacks and the access-token command (XOAUTH2)', async () => {
  const srv = await serve(1);
  const trailDir = makeTmpDir('mp-cli-trail-');
  const tokScript = path.join(work, 'print-token.mjs');
  fs.writeFileSync(tokScript, `console.log(${JSON.stringify(srv.creds.token)});\n`);
  const r = await run([], { env: {
    MAILPROOF_TRAIL_DIR: trailDir, MAILPROOF_HOST: '127.0.0.1', MAILPROOF_PORT: String(srv.port), MAILPROOF_USER: USER,
    MAILPROOF_SENT: 'off', MAILPROOF_ACCESS_TOKEN_COMMAND: `${process.execPath} ${tokScript}`,
  } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(srv.log.some((l) => l.line === 'xoauth2 ok'));
  assert.ok(!r.stdout.includes(srv.creds.token) && !r.stderr.includes(srv.creds.token));
});

test('login refused is exit 77, without the secret', async () => {
  const srv = await serve(1);
  const trailDir = makeTmpDir('mp-cli-trail-');
  const bad = path.join(work, 'bad-pw');
  fs.writeFileSync(bad, 'wrong-' + SECRET);
  const r = await run([...base(srv, trailDir), '--pass-file', bad]);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /ERR_IMAP_AUTH/);
  assert.ok(!(r.stdout + r.stderr).includes('wrong-' + SECRET));
});

test('another sync holding the lock is exit 75', async () => {
  const srv = await serve(1);
  const trailDir = makeTmpDir('mp-cli-trail-');
  fs.writeFileSync(path.join(trailDir, '.default.sync.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
  const r = await run([...base(srv, trailDir), '--pass-command', passCmd]);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /ERR_SYNC_LOCKED/);
  assert.equal(r.stdout, '');
});

test('an unreachable server is exit 75', async () => {
  const srv = await serve(1);
  const trailDir = makeTmpDir('mp-cli-trail-');
  const port = srv.port;
  await srv.close();
  const r = await run([...base({ port }, trailDir), '--pass-command', passCmd]);
  assert.equal(r.code, 75, r.stderr);
});

test('bad usage is exit 64', async () => {
  const noTrail = await run(['--user', USER]);
  assert.equal(noTrail.code, 64);
  assert.match(noTrail.stderr, /trail-dir/);
  const unknown = await run(['--bogus']);
  assert.equal(unknown.code, 64);
  const t = makeTmpDir('mp-cli-trail-');
  const badPort = await run(['--trail-dir', t, '--user', USER, '--port', 'x', '--pass-command', passCmd]);
  assert.equal(badPort.code, 64);
  const noPass = await run(['--trail-dir', t, '--user', USER]); // stdin is empty
  assert.equal(noPass.code, 64);
  const both = await run(['--trail-dir', t, '--user', USER, '--pass-command', passCmd, '--pass-file', certFile]);
  assert.equal(both.code, 64);
});

test('--help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: mailproof-sync/);
  assert.match(r.stdout, /Exit codes/);
});
