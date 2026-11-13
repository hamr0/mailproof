// The trail index (SPEC B5, F19): list() and copies() answer from a SQLite cache beside the trail, and the answers equal
// the old full read of every record. Also: catch-up, rebuild, a second process, the addon missing, a failed index write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Mailproof } from '../../src/proof/mailproof.js';
import { listIds, readRecord } from '../../src/proof/trail.js';
import { RECORD_ID_RE } from '../../src/proof/trail.js';
import { signedMail, stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { recordPath } from '../../src/proof/layout.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const T0 = new Date('2026-11-01T10:00:00Z');
const at = (min) => () => new Date(T0.getTime() + min * 60000);
const SPLIT = Buffer.from('\r\n\r\n');
const withBody = (raw, fn) => { const i = raw.indexOf(SPLIT) + 4; return Buffer.concat([raw.subarray(0, i), Buffer.from(fn(raw.subarray(i).toString('binary')), 'binary')]); };
const addHeaders = (raw, ...h) => Buffer.concat([Buffer.from(h.join('\r\n') + '\r\n'), raw]);
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const unsigned = (id, extra = '') => Buffer.from(`From: u@u.example\r\n${id ? `Message-ID: <${id}@u.example>\r\n` : ''}${extra}\r\nhi ${id}\r\n`);
function forwardOf(inners, B = 'B') {
  const parts = inners.flatMap((b) => [`--${B}`, 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '', b.toString('binary').replace(/\r\n$/, '')]);
  return Buffer.from(['From: fwd@fwd.example', 'To: me@me.example', 'Subject: Fwd: x', 'Message-ID: <fwd-1@fwd.example>', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}`, 'Content-Type: text/plain', '', 'see attached', ...parts, `--${B}--`, ''].join('\r\n'), 'binary');
}

/** The 3.3.0 row: the additive who-and-what fields (from, to, subject, subjectSource, addresses) are tested in list-rows.test.js. */
const base = (rows) => rows.map(({ id, captured, direction, live, portable, message_id }) => ({ id, captured, direction, live, portable, message_id }));

/** TEST-ONLY oracle: the full read list()/copies() did before the index (every record read and parsed). Equal captures
 *  come in ascending id order, which is the order the index promises (the old code left it to the file system). */
async function oracle(root) {
  const all = (await Promise.all((await listIds(root)).sort().map((id) => readRecord(root, id)))).filter((r) => r !== null);
  const list = ({ limit, direction } = {}) => {
    const recs = all.filter((r) => !direction || r.direction === direction).sort((a, b) => (a.captured < b.captured ? 1 : a.captured > b.captured ? -1 : 0));
    return (limit ? recs.slice(0, limit) : recs).map((r) => ({
      id: r.id, captured: r.captured, direction: r.direction,
      live: r.verdicts?.live?.trust, portable: r.verdicts?.portable?.trust, message_id: r.message?.message_id ?? null,
    }));
  };
  const copies = (idOrKey) => {
    const self = typeof idOrKey === 'string' ? all.find((r) => r.id === idOrKey) : undefined;
    const key = self ? self.message_key : (typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null);
    const sum = (r) => ({ id: r.id, captured: r.captured, direction: r.direction, copy: r.copy?.kind ?? 'unknown', body_status: r.body_status, live: r.verdicts?.live?.trust, portable: r.verdicts?.portable?.trust });
    const byTime = (a, b) => (a.captured < b.captured ? -1 : a.captured > b.captured ? 1 : 0);
    const cs = (key ? all.filter((r) => r.message_key === key) : self ? [self] : []).sort(byTime);
    const ci = key ? all.filter((r) => r.message_key !== key && (r.copy?.evidence?.attached_original || []).some((o) => o.message_key === key)).sort(byTime) : [];
    const original = cs.find((r) => r.copy?.kind === 'direct' && r.body_status === 'matched');
    return { message_key: key, original: original ? original.id : null, copies: cs.map(sum), contained_in: ci.map(sum) };
  };
  return { all, list, copies };
}

/** Assert that mp answers every list/copies question exactly like the full read of the trail does. */
async function assertSameAsFullRead(mp, root) {
  const o = await oracle(root);
  for (const opts of [undefined, {}, { limit: 2 }, { limit: 1 }, { limit: 0 }, { limit: 2.5 }, { limit: -1 }, { limit: '3' }, { limit: 100 }, { limit: Infinity },
    { direction: 'in' }, { direction: 'out' }, { direction: 'in', limit: 2 }, { direction: 'out', limit: 1 }, { direction: 'sideways' }]) {
    assert.deepStrictEqual(base(await mp.list(opts)), o.list(opts), `list(${JSON.stringify(opts)})`);
  }
  const probes = new Set(['0'.repeat(32), 'nope', '', 'F'.repeat(32), undefined, null, 5]);
  for (const r of o.all) { probes.add(r.id); if (r.message_key) probes.add(r.message_key); }
  for (const p of probes) assert.deepStrictEqual(await mp.copies(p), o.copies(p), `copies(${String(p)})`);
  return o;
}

/** A trail with: 2 copies of one signed message (captured out of commit order), a third with an equal capture time,
 *  a forward that carries it (contained_in), a second signed message sent out, unsigned mail with and without a
 *  Message-ID (null message_key), and one more message that is a duplicate of the first. */
async function buildTrail(dir) {
  const a = await signedMail({ signTime: T0, subject: 'A', body: 'Hello A.\r\n', domain: 'a.example' });
  const b = await signedMail({ signTime: T0, subject: 'B', body: 'Hello B.\r\n', domain: 'b.example' });
  const resolver = stubResolver({ ...a.map, ...b.map });
  const mp = new Mailproof({ trailDir: dir, resolver, worker: { size: 0 } });
  const rec = async (raw, direction, min) => { mp.now = at(min); return (await mp.record(raw, { direction, source: 'test' })).record; };
  const relayed = addHeaders(withBody(a.raw, (x) => x + '\r\n-- \r\nfooter\r\n'), 'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=Relay.Example; s=arc; b=AAAA', 'List-Id: <l.lists.example.org>');
  const relayed2 = addHeaders(withBody(a.raw, (x) => x + '\r\n-- \r\nfooter two\r\n'), 'List-Id: <m.lists.example.org>');
  const out = {};
  out.relayed = await rec(relayed, 'in', 30);            // committed first, captured last
  out.direct = await rec(a.raw, 'in', 5);                // committed second, captured first
  out.relayed2 = await rec(relayed2, 'in', 30);          // equal capture time to `relayed`: a tie
  out.fwd = await rec(forwardOf([a.raw]), 'in', 40);
  out.b = await rec(b.raw, 'out', 20);
  out.u1 = await rec(unsigned('u1'), 'in', 10);
  out.nokey1 = await rec(unsigned(''), 'in', 10);        // no Message-ID: message_key null; equal capture time again
  out.nokey2 = await rec(unsigned('', 'X-Other: 1\r\n'), 'out', 11);
  return { mp, a, b, out, resolver, root: path.join(dir, 'default') };
}

const indexFile = (dir) => path.join(dir, '.default.index.sqlite');
const storedMeta = (dir, k) => { const d = new Database(indexFile(dir), { readonly: true }); try { return d.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v; } finally { d.close(); } };
/** Put a row in the index that is in no record: it survives a catch-up and is wiped by a rebuild. */
const plantSentinel = (dir) => {
  const d = new Database(indexFile(dir));
  d.prepare("INSERT OR REPLACE INTO rec(id, captured) VALUES ('sentinel', '9999-01-01T00:00:00.000Z')").run();
  d.close();
};
const hasSentinel = async (mp) => (await mp.list({ limit: 1 }))[0]?.id === 'sentinel';

test('indexed list() and copies() equal the full read: ties, null keys, out-of-order capture, contained_in', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, out, root } = await buildTrail(dir);
  const o = await assertSameAsFullRead(mp, root);
  assert.equal(o.all.length, 8);
  // the cases the comparison is meant to cover are really in the data
  assert.equal(out.nokey1.message_key, null);
  assert.equal(out.relayed.captured, out.relayed2.captured);
  assert.ok(out.direct.captured < out.relayed.captured && out.direct.id !== out.relayed.id);
  const c = await mp.copies(out.direct.id);
  assert.equal(c.copies.length, 3);
  assert.equal(c.original, out.direct.id);
  assert.deepEqual(c.contained_in.map((x) => x.id), [out.fwd.id]);
  assert.deepEqual((await mp.copies(out.nokey1.id)).copies.map((x) => x.id), [out.nokey1.id]);
  await mp.close();
});

test('the index file sits beside the lock file, outside the git repo, and is never committed', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  assert.equal(fs.existsSync(indexFile(dir)), false, 'record() alone never creates it');
  await mp.list();
  assert.equal(fs.existsSync(indexFile(dir)), true);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal(gitOut(root, 'ls-files').split('\n').some((f) => f.includes('index')), false);
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'));
  await mp.close();
});

test('a missing or empty trail lists nothing and creates no index', async () => {
  const dir = makeTmpDir('mp-ix-');
  const mp = new Mailproof({ trailDir: dir });
  assert.deepEqual(await mp.list(), []);
  assert.deepEqual(await mp.copies('a'.repeat(32)), { message_key: 'a'.repeat(32), original: null, copies: [], contained_in: [] });
  assert.deepEqual(await mp.copies('x'), { message_key: null, original: null, copies: [], contained_in: [] });
  assert.equal(fs.existsSync(indexFile(dir)), false);
  await mp.close();
});

test('record() never touches the index: N recorded messages reach it by catch-up on the next list(), and list() equals the full read', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  await mp.list();
  plantSentinel(dir);
  const before = storedMeta(dir, 'head');
  for (let i = 0; i < 5; i++) { mp.now = at(50 + i); await mp.record(unsigned(`late${i}`), { direction: i % 2 ? 'out' : 'in' }); }
  assert.equal(storedMeta(dir, 'head'), before, 'record() did not move the stored HEAD');
  const rows = await mp.list();
  assert.equal(rows[0].id, 'sentinel', 'caught up, not rebuilt');
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'));
  assert.equal(rows.length, 14);
  assert.deepStrictEqual(base(rows.filter((r) => r.id !== 'sentinel')), (await oracle(root)).list());
  const d = new Database(indexFile(dir)); d.prepare("DELETE FROM rec WHERE id = 'sentinel'").run(); d.close();
  await assertSameAsFullRead(mp, root);
  await mp.close();
});

test('catch-up: records committed while the index existed (another instance) and records before it ever existed', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  const other = new Mailproof({ trailDir: dir });
  await other.list(); // builds the index from 8 records
  plantSentinel(dir);
  assert.equal(await hasSentinel(other), true);
  // `mp` never touches the index, so its commits wait for the next query
  mp.now = at(60);
  await mp.record(unsigned('c1'), { direction: 'in' });
  mp.now = at(61);
  await mp.record(unsigned('c2'), { direction: 'out' });
  assert.notEqual(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'), 'stale until the next query');
  assert.equal(await hasSentinel(other), true, 'caught up, not rebuilt');
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'));
  const o = await oracle(root);
  const real = (await other.list()).filter((r) => r.id !== 'sentinel');
  assert.deepStrictEqual(base(real), o.list());
  assert.equal(real.length, 10);
  await other.close();
  await mp.close();

  // never indexed at all: the first query builds it from every record
  const dir2 = makeTmpDir('mp-ix-');
  const t2 = await buildTrail(dir2);
  assert.equal(fs.existsSync(indexFile(dir2)), false);
  await assertSameAsFullRead(new Mailproof({ trailDir: dir2 }), t2.root);
});

test('rebuild: after the trail is restored to an older commit, a schema-version mismatch, and a corrupted index file', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  const reader = new Mailproof({ trailDir: dir });
  await reader.list();
  const old = gitOut(root, 'rev-parse', 'HEAD~3');
  plantSentinel(dir);
  gitOut(root, 'reset', '--hard', old); // a restore: the stored HEAD is not an ancestor of HEAD
  assert.equal(await hasSentinel(reader), false, 'rebuilt');
  const o = await assertSameAsFullRead(reader, root);
  assert.equal(o.all.length, 5);

  // a record committed after the restore is still found
  mp.now = at(70);
  await mp.record(unsigned('after-restore'), { direction: 'in' });
  await assertSameAsFullRead(reader, root);

  // schema-version mismatch
  plantSentinel(dir);
  const d = new Database(indexFile(dir)); d.prepare("UPDATE meta SET v = '0' WHERE k = 'schema'").run(); d.close();
  assert.equal(await hasSentinel(reader), false, 'rebuilt');
  await assertSameAsFullRead(reader, root);
  await reader.close();

  // corrupted file: garbage where the database was, in a fresh instance
  for (const f of [indexFile(dir), `${indexFile(dir)}-wal`, `${indexFile(dir)}-shm`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(indexFile(dir), Buffer.alloc(8192, 'garbage! '));
  const fresh = new Mailproof({ trailDir: dir });
  await assertSameAsFullRead(fresh, root);
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'));

  // a deleted index file
  await fresh.close();
  for (const f of [indexFile(dir), `${indexFile(dir)}-wal`, `${indexFile(dir)}-shm`]) fs.rmSync(f, { force: true });
  await assertSameAsFullRead(new Mailproof({ trailDir: dir }), root);
  await mp.close();
});

test('a record committed by a second process is visible to an open index', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  await mp.list();
  plantSentinel(dir);
  const extra = await signedMail({ subject: 'from another process', domain: 'p.example' });
  const files = makeTmpDir('mp-ix-files-');
  fs.writeFileSync(path.join(files, 'm.eml'), extra.raw);
  fs.writeFileSync(path.join(files, 'dns.json'), JSON.stringify(extra.map));
  const helper = fileURLToPath(new URL('../helpers/record-proc.js', import.meta.url));
  const res = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [helper, dir, path.join(files, 'm.eml'), path.join(files, 'dns.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = ''; c.stdout.on('data', (x) => { s += x; }); c.on('error', reject); c.on('close', () => resolve(JSON.parse(s.trim().split('\n').pop())));
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = await mp.list();
  assert.ok(rows.some((r) => r.id === res.id), 'the other process\'s record is listed');
  assert.equal(rows[0].id, 'sentinel', 'by catch-up, not rebuild');
  assert.deepStrictEqual(base(rows.filter((r) => r.id !== 'sentinel')), (await oracle(root)).list());
  await mp.close();
});

test('concurrent list() calls and a record() in flight leave the index equal to the trail', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  const extra = await signedMail({ subject: 'concurrent', domain: 'c.example' });
  const m2 = new Mailproof({ trailDir: dir, resolver: stubResolver(extra.map), worker: { size: 0 } });
  await Promise.all([mp.list(), mp.copies('x'), m2.record(extra.raw, { direction: 'in' }), mp.list({ limit: 3 })]);
  await assertSameAsFullRead(mp, root);
  await mp.close();
});

test('an index write failure does not fail record(); the next query catches up', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  await mp.list();
  const boom = new Database(indexFile(dir));
  boom.exec("CREATE TRIGGER boom BEFORE INSERT ON rec BEGIN SELECT RAISE(ABORT, 'index write refused'); END");
  mp.now = at(80);
  const r = await mp.record(unsigned('survives'), { direction: 'in' });
  assert.equal(r.duplicate, false);
  assert.equal((await mp.get(r.id)).id, r.id);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');
  assert.equal(gitOut(root, 'rev-parse', 'HEAD'), r.commit, 'the record commit stands');
  assert.notEqual(storedMeta(dir, 'head'), r.commit);
  await assert.rejects(mp.list(), /index write refused/, 'while the index cannot be written, list says so rather than answering stale');
  boom.exec('DROP TRIGGER boom');
  boom.close();
  await assertSameAsFullRead(mp, root);
  await mp.close();
});

test('without the better-sqlite3 addon: record, get, verify, check, matchBody work; list and copies reject ERR_INDEX_UNAVAILABLE', async () => {
  const dir = makeTmpDir('mp-ix-');
  const files = makeTmpDir('mp-ix-files-');
  const m = await signedMail({ subject: 'no addon', domain: 'n.example' });
  fs.writeFileSync(path.join(files, 'm.eml'), m.raw);
  fs.writeFileSync(path.join(files, 'dns.json'), JSON.stringify(m.map));
  const reg = fileURLToPath(new URL('../helpers/no-sqlite-register.js', import.meta.url));
  const child = fileURLToPath(new URL('../helpers/index-child.js', import.meta.url));
  const run = (args) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', reg, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = ''; let e = ''; c.stdout.on('data', (x) => { s += x; }); c.stderr.on('data', (x) => { e += x; });
    c.on('error', reject); c.on('close', (code) => { try { resolve(JSON.parse(s.trim().split('\n').pop())); } catch { reject(new Error(`no JSON (code ${code}): ${s} ${e}`)); } });
  });
  // control: the hook really makes the addon unloadable
  const probe = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', reg, '--input-type=module', '-e', "import('better-sqlite3').then(() => console.log('loaded'), (e) => console.log(e.code))"], { stdio: ['ignore', 'pipe', 'inherit'] });
    let s = ''; c.stdout.on('data', (x) => { s += x; }); c.on('close', () => resolve(s.trim()));
  });
  assert.equal(probe, 'ERR_MODULE_NOT_FOUND');
  const r = await run([child, dir, path.join(files, 'm.eml'), path.join(files, 'dns.json')]);
  assert.deepEqual(r, { recorded: true, got: true, verified: true, checked: 'verified', matched: true, list: 'ERR_INDEX_UNAVAILABLE', copies: 'ERR_INDEX_UNAVAILABLE' });
  assert.equal(fs.existsSync(indexFile(dir)), false);
  // the same trail, addon present again: nothing was lost
  const mp = new Mailproof({ trailDir: dir });
  assert.equal((await mp.list()).length, 1);
  await mp.close();
});

/** A one-record trail, the Mailproof on it, and a cfg for the one-shot index API. */
async function capTrail() {
  const dir = makeTmpDir('mp-ix-cap-');
  const a = await signedMail({ signTime: T0, subject: 'A', body: 'Hi\r\n', domain: 'a.example' });
  const mp = new Mailproof({ trailDir: dir, resolver: stubResolver(a.map), worker: { size: 0 }, now: at(5) });
  await mp.record(a.raw, { direction: 'in', source: 'test' });
  return { dir, mp, cfg: { root: path.join(dir, 'default'), trail: 'default', lockTimeoutMs: 5000 } };
}
// The "no output cap" proof is tests/unit/git-lines.test.js (a listing past 16 MB); this pins the rows of both paths.
test('a rebuild and a catch-up read through the streamed git listings and give the same rows', async () => {
  const { dir, mp, cfg } = await capTrail();
  const { listIndex } = await import('../../src/proof/index-db.js');
  assert.equal((await listIndex(cfg)).length, 1);
  plantSentinel(dir);
  mp.now = at(9);
  await mp.record(unsigned('more'), { direction: 'in' });
  const rows = await listIndex(cfg); // catch-up: the sentinel survives
  assert.equal(rows[0].id, 'sentinel');
  assert.equal(rows.length, 3);
  for (const f of [indexFile(dir), `${indexFile(dir)}-wal`, `${indexFile(dir)}-shm`]) fs.rmSync(f, { force: true });
  assert.equal((await listIndex(cfg)).length, 2, 'a rebuild lists the two committed records');
  await mp.close();
});

test('catch-up lists both paths of a renamed record file: the old id leaves the index (git rename detection is off)', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, out, root } = await buildTrail(dir);
  const mp2 = new Mailproof({ trailDir: dir });
  await mp2.list(); // index at the current HEAD
  plantSentinel(dir);
  // rename a record file (same content: git sees a 100% rename) and commit it
  const NEWID = 'f'.repeat(32);
  const oldFile = recordPath(out.u1.id);
  const body = JSON.parse(fs.readFileSync(path.join(root, oldFile), 'utf8'));
  fs.writeFileSync(path.join(root, oldFile), JSON.stringify({ ...body, id: NEWID }));
  fs.mkdirSync(path.join(root, path.dirname(recordPath(NEWID))), { recursive: true });
  gitOut(root, 'mv', oldFile, recordPath(NEWID));
  gitOut(root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'diff.renames=true', 'commit', '-q', '-m', 'rename');
  assert.match(gitOut(root, '-c', 'diff.renames=true', 'diff', '--name-status', 'HEAD~1', 'HEAD'), /^R/, 'git reports a rename');
  assert.equal(await hasSentinel(mp2), true, 'caught up, not rebuilt');
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'));
  const ids = (await mp2.list()).map((r) => r.id);
  assert.equal(ids.includes(out.u1.id), false, 'the old id is gone');
  assert.equal(ids.includes(NEWID), true);
  // everything but the planted sentinel equals the full read
  const o = await oracle(root);
  assert.deepStrictEqual(base((await mp2.list()).filter((r) => r.id !== 'sentinel')), o.list());
  assert.deepStrictEqual(await mp2.copies(out.u1.id), o.copies(out.u1.id));
  assert.deepStrictEqual(await mp2.copies(NEWID), o.copies(NEWID));
  await mp2.close();
  await mp.close();
});

test('a catch-up or rebuild that throws part-way is rolled back: previous rows kept, stored head not advanced; the next query recovers', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp, root } = await buildTrail(dir);
  const other = new Mailproof({ trailDir: dir });
  await other.list(); // index built at HEAD
  plantSentinel(dir);
  const head0 = storedMeta(dir, 'head');
  // a trigger that aborts the insert of the highest id, so earlier rows are already written when it fires
  const poison = (id) => { const d = new Database(indexFile(dir)); d.exec(`CREATE TRIGGER boom BEFORE INSERT ON rec WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`); d.close(); };
  const unpoison = () => { const d = new Database(indexFile(dir)); d.exec('DROP TRIGGER boom'); d.close(); };
  const rowCount = () => { const d = new Database(indexFile(dir), { readonly: true }); try { return d.prepare('SELECT count(*) AS n FROM rec').get().n; } finally { d.close(); } };

  // catch-up: three new records, the last (highest id) one fails
  mp.now = at(60);
  const added = [];
  for (const [i, tag] of ['c1', 'c2', 'c3'].entries()) { mp.now = at(60 + i); added.push((await mp.record(unsigned(tag), { direction: 'in' })).record.id); }
  poison(added.slice().sort().at(-1));
  await assert.rejects(other.list(), /boom/);
  assert.equal(storedMeta(dir, 'head'), head0, 'head not advanced');
  assert.equal(rowCount(), 9, 'no new row survived (8 records + sentinel)');
  unpoison();
  assert.equal(await hasSentinel(other), true);
  assert.equal(storedMeta(dir, 'head'), gitOut(root, 'rev-parse', 'HEAD'), 'recovered by catch-up');
  assert.equal(rowCount(), 12);

  // rebuild (schema mismatch): the wipe at its start is rolled back too
  const d = new Database(indexFile(dir)); d.prepare("UPDATE meta SET v = '0' WHERE k = 'schema'").run(); d.close();
  const all = (await oracle(root)).all.map((r) => r.id).sort();
  poison(all.at(-1));
  await assert.rejects(other.list(), /boom/);
  assert.equal(rowCount(), 12, 'the wipe was rolled back');
  assert.equal(storedMeta(dir, 'schema'), '0');
  unpoison();
  assert.equal(await hasSentinel(other), false, 'rebuilt on the next query');
  await assertSameAsFullRead(other, root);
  await other.close();
  await mp.close();
});

test('better-sqlite3 is imported by src/proof/index-db.js and by nothing else in src/', () => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js') && /better-sqlite3/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(src, p)); } };
  walk(src);
  // mailproof.js, the generated CLI help and the status hint only quote the name in text (the JSDoc `@fails` of list(); the `unknown` index hint)
  assert.deepEqual(hits.filter((h) => h !== path.join('proof', 'index-db.js') && h !== path.join('proof', 'mailproof.js') && h !== path.join('cli', 'help.generated.js') && h !== path.join('cli', 'status.js')), []);
  const importing = hits.filter((h) => /(?:from\s+|import\()\s*['"]better-sqlite3['"]/.test(fs.readFileSync(path.join(src, h), 'utf8')));
  assert.deepEqual(importing, [path.join('proof', 'index-db.js')]);
});

test('a caught-up list() reads the trail HEAD once (one rev-parse spawn), not twice', async () => {
  const dir = makeTmpDir('mp-ix-');
  const { mp } = await buildTrail(dir);
  await mp.list();   // the index is built and caught up
  const bin = makeTmpDir('mp-ix-gitshim-');
  const log = path.join(bin, 'calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try { await mp.list({ limit: 1 }); } finally { process.env.PATH = oldPath; }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  assert.equal(calls.filter((c) => c === 'rev-parse').length, 1, `git calls: ${calls.join(',')}`);
  await mp.close();
});
