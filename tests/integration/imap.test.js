// imap.js (real imapflow) against a fake TLS IMAP server (SPEC B4.8, layer 2). The certificate is generated at test
// time; if openssl is missing these tests FAIL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { openSession } from '../../src/proof/imap.js';
import { runSync } from '../../src/proof/sync.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { MAX_TOTAL_BYTES } from '../../src/proof/limits.js';
import { startFakeImap, makeCert, genSha256 } from '../helpers/fake-imap-server.js';
import { makeTmpDir } from '../helpers/tmp.js';

const CERT = makeCert();
const SECRET = 'Sup3r-Secret-App-Pass-7f3a';
const TOKEN = 'ya29.fake-access-token-9c1';
const USER = 'acct.owner@account.test';
const timeouts = { connectMs: 5000, socketMs: 20000 };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const args = (srv, extra = {}) => ({ host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert }, timeouts, ...extra });
const plainMail = (n) => Buffer.from(`From: a@b.test\r\nTo: c@d.test\r\nSubject: m${n}\r\nMessage-ID: <m${n}@b.test>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nbody ${n}\r\n`);
const servers = [];
const serve = async (cfg) => { const s = await startFakeImap({ tls: CERT, ...cfg }); servers.push(s); return s; };
test.after(async () => { await Promise.all(servers.map((s) => s.close())); });

async function withSession(srv, extra, fn) {
  const s = await openSession(args(srv, extra));
  try { return await fn(s); } finally { await s.close(); }
}

test('14. auth: AUTHENTICATE PLAIN, LOGIN and XOAUTH2 with the exact credentials; wrong ones are ERR_IMAP_AUTH without the secret', async () => {
  const folders = { INBOX: { msgs: [{ uid: 1, raw: plainMail(1) }] } };
  const plain = await serve({ folders });
  await withSession(plain, {}, async (s) => assert.equal((await s.select('INBOX')).uidNext, 2));
  assert.ok(plain.log.some((l) => l.cmd === 'AUTHENTICATE' && /^\S+ AUTHENTICATE PLAIN/i.test(l.line)));
  assert.ok(plain.log.some((l) => l.line === 'plain ok'), 'the server saw the exact user and password');

  const login = await serve({ folders, caps: [] });
  await withSession(login, {}, async (s) => assert.equal((await s.select('INBOX')).uidNext, 2));
  assert.ok(login.log.some((l) => l.cmd === 'LOGIN'));

  const oauth = await serve({ folders });
  await withSession(oauth, { auth: { accessToken: TOKEN } }, async (s) => assert.equal((await s.select('INBOX')).uidNext, 2));
  assert.ok(oauth.log.some((l) => /XOAUTH2/i.test(l.line)));
  assert.ok(oauth.log.some((l) => l.line === 'xoauth2 ok'), 'the server saw the exact SASL payload');

  for (const [srv, bad] of [[plain, { pass: 'wrong-' + SECRET }], [login, { pass: 'wrong-' + SECRET }], [oauth, { accessToken: 'bad-' + TOKEN }]]) {
    await assert.rejects(() => openSession(args(srv, { auth: bad })), (e) => {
      assert.equal(e.code, 'ERR_IMAP_AUTH');
      const all = `${e.message}${e.stack}`;
      assert.ok(!all.includes(SECRET) && !all.includes(TOKEN) && !all.includes(Object.values(bad)[0]));
      return true;
    });
  }
});

test('15. TLS is mandatory: untrusted certificate, wrong host name and a plain-text server are all ERR_IMAP_CONNECT, and no credential is sent', async () => {
  const folders = { INBOX: { msgs: [] } };
  const other = makeCert('DNS:other.invalid,IP:10.9.9.9');
  const cases = [
    ['untrusted certificate', await serve({ folders }), { tls: {} }],
    ['host name mismatch', await serve({ folders, tls: other }), { tls: { ca: other.cert } }], // trusted, but issued for another name
    ['plain text', await serve({ folders, tls: null }), {}],
  ];
  for (const [label, srv, extra] of cases) {
    await assert.rejects(() => openSession(args(srv, extra)), (e) => {
      assert.equal(e.code, 'ERR_IMAP_CONNECT', label);
      assert.ok(!`${e.message}${e.stack}`.includes(SECRET));
      return true;
    }, label);
    assert.ok(!srv.log.some((l) => /LOGIN|AUTHENTICATE/i.test(l.cmd)), `${label}: no credential left before the certificate was accepted`);
  }
});

test('read-only command log: only the allowed commands, EXAMINE not SELECT, BODY.PEEK never BODY[], nothing that writes', async () => {
  const big = 27 * 1024 * 1024;
  const srv = await serve({
    folders: {
      INBOX: { msgs: [{ uid: 1, raw: plainMail(1) }, { uid: 2, raw: plainMail(2) }, { uid: 3, genSize: big }] },
      '[Gmail]/Sent Mail': { flags: ['\\HasNoChildren', '\\Sent'], msgs: [{ uid: 1, raw: plainMail(9) }] },
    },
  });
  const trailDir = makeTmpDir('mp-imap-ro-');
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 }, otsBin: null });
  const res = await mp.sync({ host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert } });
  assert.equal(res.complete, true, JSON.stringify(res));
  assert.deepEqual(res.folders.map((f) => [f.folder, f.direction, f.recorded]), [['INBOX', 'in', 3], ['[Gmail]/Sent Mail', 'out', 1]]);
  assert.equal(res.folders[0].over_limit, 1, 'the 27 MiB message was streamed and recorded over limit');
  const allowed = new Set(['CAPABILITY', 'ID', 'LOGIN', 'AUTHENTICATE', 'AUTH-RESPONSE', 'NAMESPACE', 'LIST', 'LSUB', 'EXAMINE', 'UID FETCH', 'NOOP', 'LOGOUT']);
  // NAMESPACE and LSUB are sent by imapflow (login and folder listing) and are read-only; the SPEC list omitted them
  const cmds = srv.commands();
  for (const c of cmds) assert.ok(allowed.has(c), `unexpected command ${c}`);
  for (const bad of ['SELECT', 'STORE', 'APPEND', 'COPY', 'MOVE', 'DELETE', 'EXPUNGE', 'IDLE', 'COMPRESS', 'ENABLE', 'CREATE', 'RENAME', 'UID STORE', 'UID COPY', 'UID MOVE', 'UID EXPUNGE']) assert.ok(!cmds.includes(bad), bad);
  assert.ok(cmds.includes('EXAMINE'));
  const fetches = srv.log.filter((l) => l.cmd === 'UID FETCH').map((l) => l.line);
  assert.ok(fetches.length > 0);
  for (const l of fetches) assert.ok(!/BODY\[/i.test(l) && !/RFC822(?!\.SIZE)/i.test(l), `non-PEEK fetch: ${l}`);
  assert.ok(fetches.some((l) => /BODY\.PEEK\[\]<0\.\d+>/.test(l)));
  for (const l of fetches) assert.ok(!/UID FETCH \S*\*/.test(l), `a * in the UID range: ${l}`);
  // the secret is in no result, no trail file, no cursor file
  assert.ok(!JSON.stringify(res).includes(SECRET));
  const grep = (dir) => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, ent.name); if (ent.isDirectory()) grep(p); else assert.ok(!fs.readFileSync(p).includes(SECRET), p); } };
  grep(trailDir);
  // a second run with nothing new fetches no message
  const before = srv.log.filter((l) => l.cmd === 'UID FETCH' && /BODY/.test(l.line)).length;
  const again = await mp.sync({ host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert } });
  assert.equal(again.complete, true);
  assert.equal(srv.log.filter((l) => l.cmd === 'UID FETCH' && /BODY/.test(l.line)).length, before);
});

test('17. bytes are exact (bare LF, CRLF, FF FE 00); folder names with spaces and brackets; \\Sent found by SPECIAL-USE; UIDVALIDITY above 2^53', async () => {
  const raw = Buffer.concat([Buffer.from('Subject: bytes\n\nline one\r\nline two\n'), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('\r\ntail\n')]);
  const srv = await serve({
    folders: {
      INBOX: { uidvalidity: '9007199254740993', msgs: [{ uid: 7, raw }] },
      '[Gmail]/Sent Mail': { flags: ['\\HasNoChildren', '\\Sent'], msgs: [] },
    },
  });
  await withSession(srv, {}, async (s) => {
    assert.equal(await s.findSent(), '[Gmail]/Sent Mail');
    const sel = await s.select('INBOX');
    assert.equal(sel.uidvalidity, '9007199254740993', 'a decimal string, exact above 2^53');
    assert.equal(typeof sel.uidvalidity, 'string');
    assert.deepEqual(await s.list(1, 10), [{ uid: 7, size: raw.length }]);
    assert.equal(Buffer.compare(await s.fetch(7, MAX_TOTAL_BYTES + 1), raw), 0, 'fetch is byte-exact');
    assert.deepEqual(await s.hash(7), { sha256: sha(raw), size: raw.length, over: false }, 'the streamed hash equals the sha256 of the server bytes');
    const sent = await s.select('[Gmail]/Sent Mail');
    assert.equal(sent.uidNext, 1);
    await assert.rejects(() => s.select('Nope/Missing'), { code: 'ERR_IMAP_NO_FOLDER' });
  });
  const trailDir = makeTmpDir('mp-imap-bytes-');
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 }, otsBin: null });
  const res = await mp.sync({ host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert } });
  assert.equal(res.folders[0].recorded, 1, JSON.stringify(res));
  const rec = await mp.get((await mp.list())[0].id);
  assert.equal(rec.message.raw_sha256, `sha256:${sha(raw)}`);
  assert.equal(res.folders[0].uidvalidity, '9007199254740993');
});

test('18. literals: a short literal rejects and returns no Buffer; a server ignoring the range is cut to what was asked; a huge literal is refused', async () => {
  const srv = await serve({
    folders: {
      INBOX: { msgs: [
        { uid: 1, raw: Buffer.alloc(4000, 0x61), fault: 'short' },
        { uid: 2, raw: Buffer.alloc(100_000, 0x62), fault: 'ignore-partial' },
        { uid: 3, genSize: MAX_TOTAL_BYTES + 2 * 1024 * 1024, fault: 'ignore-partial' },
      ] },
    },
  });
  await withSession(srv, {}, async (s) => {
    await s.select('INBOX');
    const cut = await s.fetch(2, 1000);
    assert.equal(cut.length, 1000, 'never more than asked, even if the server ignores the range');
  });
  await withSession(srv, {}, async (s) => {
    await s.select('INBOX');
    await assert.rejects(() => s.fetch(3, MAX_TOTAL_BYTES + 1), (e) => { assert.equal(e.code, 'ERR_IMAP_PROTOCOL'); return true; }, 'a literal beyond the gate limit plus margin is refused, not buffered');
  });
  await withSession(srv, {}, async (s) => {
    await s.select('INBOX');
    let got = null;
    await assert.rejects(async () => { got = await s.fetch(1, 10_000); }, (e) => { assert.equal(e.code, 'ERR_IMAP_PROTOCOL'); assert.equal(e.retryable, true, 'a dropped connection is retryable'); return true; });
    assert.equal(got, null, 'no Buffer came back');
  });
  // a short literal never reaches record(): sync.js sees the drop, reconnects and never records partial bytes
  const trailDir = makeTmpDir('mp-imap-short-');
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 }, otsBin: null });
  const host = { root: mp.root, trail: mp.trail, record: mp.record, recordDigest: (d, c) => mp._recordDigest(d, c) };
  const res = await runSync(host, { host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert }, sent: false }, { openSession, sleep: async () => {} });
  assert.equal(res.folders[0].error.code, 'ERR_IMAP_PROTOCOL');
  assert.equal(res.folders[0].last_uid, 0);
  assert.equal((await mp.list()).length, 0, 'nothing recorded from partial bytes');
});

// A forced gc before every sample: without it the figure is mostly garbage Buffers the collector has not freed yet
// (measured 60-80 MiB for a correct streaming hash), which says nothing about what hash() holds.
// arrayBuffers is the Buffer memory (`external` includes it, so adding both would count it twice).
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc');

test('18b. hash() of a 100 MiB literal streams: live memory growth stays small, and the hash is right', async () => {
  const size = 100 * 1024 * 1024;
  const srv = await serve({ folders: { INBOX: { msgs: [{ uid: 1, genSize: size }] } } });
  await withSession(srv, {}, async (s) => {
    await s.select('INBOX');
    const live = () => { forceGc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    const base = live();
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, live() - base); }, 10);
    let h;
    try { h = await s.hash(1); } finally { clearInterval(timer); }
    assert.equal(h.size, size);
    assert.equal(h.sha256, genSha256(size));
    assert.ok(peak < 32 * 1024 * 1024, `memory grew by ${(peak / 1048576).toFixed(1)} MiB while hashing 100 MiB`);
    // and the cap: past `max` it stops and says so
    const capped = await s.hash(1, 5 * 1024 * 1024);
    assert.deepEqual([capped.over, capped.sha256], [true, null]);
    assert.ok(capped.size > 5 * 1024 * 1024 && capped.size < size);
  });
});

test('a lying size and a UIDVALIDITY change through the real wrapper, end to end', async () => {
  const big = MAX_TOTAL_BYTES + 1024 * 1024;
  const srv = await serve({ folders: { INBOX: { msgs: [{ uid: 1, genSize: big, announcedSize: 1024 }, { uid: 2, raw: plainMail(2) }] } } });
  const trailDir = makeTmpDir('mp-imap-lie-');
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 }, otsBin: null });
  const opts = { host: '127.0.0.1', port: srv.port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert }, sent: false };
  const res = await mp.sync(opts);
  assert.deepEqual([res.folders[0].recorded, res.folders[0].over_limit, res.complete], [2, 1, true], JSON.stringify(res));
  const fetchLines = srv.log.filter((l) => l.cmd === 'UID FETCH' && /BODY/.test(l.line)).map((l) => l.line);
  assert.ok(fetchLines.some((l) => l.includes(`<0.${MAX_TOTAL_BYTES + 1}>`)), 'the lying message was asked for at most the gate limit plus one byte');
  const id = (await mp.list()).map((x) => x.id);
  assert.equal(id.length, 2);
  srv.uidvalidity.INBOX = '9007199254740992';
  const again = await mp.sync(opts);
  assert.equal(again.folders[0].reset, 'uidvalidity');
  assert.deepEqual([again.folders[0].recorded, again.folders[0].duplicate], [0, 2]);
});

test('a server that never greets is ERR_IMAP_CONNECT within the connect timeout', async () => {
  const mute = net.createServer(() => {});
  await new Promise((r) => mute.listen(0, '127.0.0.1', () => r()));
  try {
    await assert.rejects(() => openSession({ host: '127.0.0.1', port: mute.address().port, user: USER, auth: { pass: SECRET }, tls: { ca: CERT.cert }, timeouts: { connectMs: 400, socketMs: 2000 } }), { code: 'ERR_IMAP_CONNECT' });
  } finally { mute.close(); mute.closeAllConnections?.(); }
});

test('19. imapflow has exactly one importer, and the runtime dependencies are exactly the four (the better-sqlite3 importer check is in trail-index.test.js)', () => {
  const root = new URL('../../src/', import.meta.url).pathname;
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|cjs|ts)$/.test(e.name) && /from\s+['"]imapflow['"]|require\(\s*['"]imapflow['"]\s*\)|import\(\s*['"]imapflow['"]\s*\)|imapflow\//.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p)); } };
  walk(root);
  assert.deepEqual(hits, ['proof/imap.js']);
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['better-sqlite3', 'imapflow', 'mailauth', 'mailparser']);
  assert.match(pkg.dependencies.imapflow, /^\^?\d+\.\d+\.\d+$/);
});
