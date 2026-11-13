// list() rows say who and what (SPEC B5/B8.1): from, to, subject with its source, and every address with `signed` AND the
// stricter `coverage`; counterparties() rows carry `verified`; the index schema bump rebuilds an older cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { trailIndexFile } from '../../src/proof/trail.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { buildThread } from '../helpers/thread-trail.js';
import { stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
const cov = (row, role, address) => row.addresses.find((a) => a.role === role && a.address === address);

test('list rows: from, to, subject (signed) and every address with signed and coverage', async () => {
  const { mp, r } = await buildThread();
  const rows = byId(await mp.list());
  const req = rows[r.req.id];
  assert.equal(req.from, 'me@owner.example');
  assert.deepEqual(req.to, ['bob@beta.example']);
  assert.equal(req.subject, 'Approve?');
  assert.equal(req.subjectSource, 'signed');
  assert.deepEqual(req.addresses.map((a) => [a.role, a.address, a.signed, a.coverage]), [
    ['from', 'me@owner.example', true, 'signed'], ['to', 'bob@beta.example', true, 'signed'], ['cc', 'carol@gamma.example', true, 'signed'],
  ]);
  // the existing summary fields are untouched
  for (const k of ['id', 'captured', 'direction', 'live', 'portable', 'message_id']) assert.ok(k in req, k);
  // Carol's Cc is not in h=: the record says signed false and coverage none (the line is not covered at all)
  const un = rows[r.unsigned.id];
  assert.deepEqual(cov(un, 'cc', 'dave@delta.example'), { role: 'cc', address: 'dave@delta.example', signed: false, coverage: 'none' });
  assert.equal(cov(un, 'from', 'carol@gamma.example').coverage, 'signed');
});

test('coverage failing: a signature covers the line but does not verify; `signed` keeps its record meaning', async () => {
  const { mp, r } = await buildThread();
  const f = byId(await mp.list())[r.failing.id];
  const from = cov(f, 'from', 'bob@beta.example');
  assert.equal(from.signed, true, 'covered by some signature (the record field)');
  assert.equal(from.coverage, 'failing', 'but that signature does not verify');
  assert.equal(f.subjectSource, 'claimed', 'a subject only a failing signature covers is not a signed subject');
  assert.equal(typeof f.subject, 'string');
});

test('unsigned mail: no subject, coverage none, the record field unchanged', async () => {
  const { mp, r } = await buildThread();
  const p = byId(await mp.list())[r.plain.id];
  assert.equal(p.from, 'zed@zed.example');
  assert.deepEqual(p.to, ['me@owner.example']);
  assert.equal(p.subject, null);
  assert.equal(p.subjectSource, null);
  assert.deepEqual(p.addresses.map((a) => [a.signed, a.coverage]), [[false, 'none'], [false, 'none']]);
  assert.deepEqual((await mp.get(r.plain.id)).addresses.map((a) => Object.keys(a)), [['role', 'address', 'raw', 'signed'], ['role', 'address', 'raw', 'signed']], 'the record is not changed');
});

test('a sent copy with no signature shows its subject as claimed, read from the content store (decoded)', async () => {
  const dir = makeTmpDir('mp-claimed-');
  const mp = new Mailproof({ trailDir: dir, resolver: stubResolver({}), worker: { size: 0 }, otsBin: null });
  const raw = Buffer.from('From: me@owner.example\r\nTo: Bob <bob@beta.example>, cc2@beta.example\r\nSubject: =?UTF-8?B?Q2Fmw6kgcGxhbg==?=\r\nMessage-ID: <s1@owner.example>\r\n\r\nhi\r\n');
  const { id } = await mp.record(raw, { direction: 'out', source: 'test' });
  const row = (await mp.list())[0];
  assert.equal(row.id, id);
  assert.equal(row.subject, 'Café plan');
  assert.equal(row.subjectSource, 'claimed');
  assert.deepEqual(row.to, ['bob@beta.example', 'cc2@beta.example'], 'header order');
  assert.equal(row.from, 'me@owner.example');
  assert.deepEqual(row.addresses.map((a) => a.coverage), ['none', 'none', 'none']);
  await mp.close();
  // the content store off: nothing to read, so null
  const dir2 = makeTmpDir('mp-claimed-off-');
  const off = new Mailproof({ trailDir: dir2, resolver: stubResolver({}), worker: { size: 0 }, otsBin: null, content: { store: false } });
  await off.record(raw, { direction: 'out', source: 'test' });
  const o = (await off.list())[0];
  assert.equal(o.subject, null);
  assert.equal(o.subjectSource, null);
  await off.close();
});

test('counterparties rows carry verified: received records naming the address whose live trust is verified', async () => {
  const { mp, r } = await buildThread();
  const people = await mp.counterparties();
  assert.ok(people.length >= 4);
  for (const p of people) {
    const inbound = await mp.list({ with: p.address, direction: 'in' });
    assert.equal(p.verified, inbound.filter((x) => x.live === 'verified').length, p.address);
  }
  const bob = people.find((p) => p.address === 'bob@beta.example');
  assert.ok(bob.verified >= 1 && bob.verified < bob.records, 'a sent copy and a failing signature are not counted');
  assert.ok(r);
  assert.deepEqual(Object.keys(bob), ['address', 'records', 'first', 'last', 'verified']);
});

test('an index of the previous schema (5) rebuilds into the new columns on first use', async () => {
  const { mp, dir, r } = await buildThread();
  const before = await mp.list();
  const file = path.join(dir, trailIndexFile('default'));
  const d = new Database(file);
  // make the file look like a schema-5 one: no subject columns, no coverage or pos, an old schema number
  d.exec("ALTER TABLE rec DROP COLUMN subject; ALTER TABLE rec DROP COLUMN subject_src; ALTER TABLE participants DROP COLUMN coverage; ALTER TABLE participants DROP COLUMN pos; UPDATE meta SET v = '5' WHERE k = 'schema';");
  d.close();
  assert.deepEqual(await mp.list(), before);
  const e = new Database(file, { readonly: true });
  try { assert.equal(e.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, '6'); } finally { e.close(); }
  assert.equal(byId(await mp.list())[r.req.id].subject, 'Approve?');
});
