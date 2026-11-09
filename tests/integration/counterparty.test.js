// M3 step 2 on the trail index (SPEC B5, B8): participants, the counterparty view of list(), counterparties(),
// graded thread links, and the schema bump that rebuilds an old cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { trailIndexFile } from '../../src/proof/trail.js';
import { buildThread } from '../helpers/thread-trail.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const ids = (rows) => rows.map((x) => x.id);
const peek = (dir, sql, ...a) => {
  const d = new Database(path.join(dir, trailIndexFile('default')), { readonly: true });
  try { return d.prepare(sql).all(...a); } finally { d.close(); }
};

test('participants: roles, lower-cased address with raw kept, signed flag; unsigned Cc is not visible', async () => {
  const { mp, dir, r } = await buildThread();
  await mp.list();   // builds the index
  const rows = peek(dir, 'SELECT address, raw, role, signed FROM participants WHERE rec_id = ? ORDER BY role, address', r.req.id);
  assert.deepEqual(rows, [
    { address: 'carol@gamma.example', raw: 'carol@gamma.example', role: 'cc', signed: 1 },
    { address: 'me@owner.example', raw: 'me@owner.example', role: 'from', signed: 1 },
    { address: 'bob@beta.example', raw: 'Bob@Beta.Example', role: 'to', signed: 1 },
  ]);
  // unsigned mail: only From, signed 0
  assert.deepEqual(peek(dir, 'SELECT address, role, signed FROM participants WHERE rec_id = ?', r.plain.id), [{ address: 'zed@zed.example', role: 'from', signed: 0 }]);
  // the unsigned-threading reply (Microsoft-like) did not sign Cc or Reply-To: nothing invented
  assert.deepEqual(peek(dir, "SELECT role FROM participants WHERE rec_id = ? AND role IN ('cc','reply-to')", r.unsigned.id), []);
  assert.equal((await mp.get(r.unsigned.id)).signatures.length, 1);
  assert.deepEqual(peek(dir, "SELECT rec_id FROM participants WHERE address = 'dave@delta.example'"), []);   // its Cc line is in the mail, not in the record
  assert.deepEqual(await mp.list({ with: 'dave@delta.example' }), []);
});

test('list({ with }): exact, case-insensitive, no grouping across domains or lookalikes', async () => {
  const { mp, r } = await buildThread();
  const want = [r.grand.id, r.failing.id, r.signed.id, r.req.id];   // Bob on From (signed, failing), To (req, grand)
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example' })), want);
  assert.deepEqual(ids(await mp.list({ with: ' BOB@BETA.EXAMPLE ' })), want);
  assert.deepEqual(ids(await mp.list({ with: 'bob@gmail.com' })), []);
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.exampl' })), []);
  assert.deepEqual(ids(await mp.list({ with: '@beta.example' })), []);
  assert.deepEqual(ids(await mp.list({ with: 'zed@zed.example' })), [r.plain.id]);
  // rows keep the existing summary shape
  assert.deepEqual(Object.keys((await mp.list({ with: 'bob@beta.example' }))[0]), ['id', 'captured', 'direction', 'live', 'portable', 'message_id']);
});

test('list({ with, role, before, after, direction, limit }) combine; existing ordering and options unchanged', async () => {
  const { mp, r } = await buildThread();
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', role: 'from' })), [r.failing.id, r.signed.id]);
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', role: 'to' })), [r.grand.id, r.req.id]);
  assert.deepEqual(ids(await mp.list({ with: 'carol@gamma.example', role: 'cc' })), [r.req.id]);
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', direction: 'out' })), [r.req.id]);
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', limit: 2 })), [r.grand.id, r.failing.id]);
  // after inclusive, before exclusive, on captured
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', after: r.signed.captured })), [r.grand.id, r.failing.id, r.signed.id]);
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', before: r.signed.captured })), [r.req.id]);
  assert.deepEqual(ids(await mp.list({ after: new Date(r.failing.captured), before: r.plain.captured })), [r.grand.id, r.failing.id]);
  assert.deepEqual(ids(await mp.list({ before: Date.parse(r.req.captured) })), []);
  assert.deepEqual(ids(await mp.list()), [r.plain.id, r.grand.id, r.failing.id, r.unsigned.id, r.signed.id, r.req.id]);
  assert.deepEqual(ids(await mp.list({ direction: 'out' })), [r.req.id]);
});

test('list rejects a badly typed counterparty option', async () => {
  const { mp } = await buildThread();
  for (const o of [{ with: 5 }, { with: '' }, { with: '  ' }, { with: 'a@b.example', role: 'bcc' }, { role: 'to' }, { before: 'yesterday' }, { after: {} }]) {
    await assert.rejects(() => mp.list(o), TypeError, JSON.stringify(o));
  }
});

test('counterparties: one row per exact address with counts, first and last; the owner is included', async () => {
  const { mp, r } = await buildThread();
  const rows = await mp.counterparties();
  const by = Object.fromEntries(rows.map((x) => [x.address, x]));
  assert.deepEqual(by['bob@beta.example'], { address: 'bob@beta.example', records: 4, first: r.req.captured, last: r.grand.captured });
  assert.deepEqual(by['me@owner.example'], { address: 'me@owner.example', records: 4, first: r.req.captured, last: r.failing.captured });
  assert.equal(by['carol@gamma.example'].records, 2);       // cc on req, from on unsigned
  assert.equal(by['zed@zed.example'].records, 1);
  assert.equal(by['dave@delta.example'], undefined);
  assert.equal(rows.length, 5);                              // me, bob, carol, alice, zed: no grouping, no duplicates
  assert.deepEqual(rows.map((x) => x.last), [...rows.map((x) => x.last)].sort().reverse());   // most recently seen first
  assert.equal((await mp.counterparties({ limit: 2 })).length, 2);
  await assert.rejects(() => mp.counterparties({ limit: 0 }), TypeError);
  await assert.rejects(() => mp.counterparties({ limit: 'x' }), TypeError);
});

test('counterparties: bob@gmail.com and bob@company.com are two counterparties', async () => {
  const { mp, rec, mk } = await buildThread();
  const a = await mk('gamma.example', { from: 'bob@gmail.com', messageId: '<x1@g>' });
  const b = await mk('gamma.example', { from: 'bob@company.com', messageId: '<x2@g>' });
  mp.resolver = async (n, t) => { const map = { ...a.map, ...b.map }; if (map[n] === undefined) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return [[map[n]]]; };
  await rec('a', a.raw, 'in', 10); await rec('b', b.raw, 'in', 11);
  const rows = await mp.counterparties();
  assert.equal(rows.find((x) => x.address === 'bob@gmail.com').records, 1);
  assert.equal(rows.find((x) => x.address === 'bob@company.com').records, 1);
  assert.deepEqual((await mp.list({ with: 'bob@gmail.com' })).length, 1);
});

test('linked: parents and children, with signed / unsigned strength', async () => {
  const { mp, r } = await buildThread();
  const sgn = await mp.linked(r.signed.id);
  assert.deepEqual(sgn, {
    id: r.signed.id, message_id: '<r1@beta.example>',
    parents: [{ id: r.req.id, message_id: '<req@owner.example>', via: 'in-reply-to', strength: 'signed' }],
    children: [{ id: r.grand.id, message_id: '<g1@alpha.example>', via: 'in-reply-to', strength: 'signed' }],
  });
  // the request sees all four replies as children, with their grades: signed, unsigned (not in h=), unsigned (signature fails), none
  const req = await mp.linked(r.req.id);
  assert.deepEqual(req.parents, []);
  assert.deepEqual(req.children.map((c) => [c.id, c.via, c.strength]), [
    [r.signed.id, 'in-reply-to', 'signed'],
    [r.unsigned.id, 'in-reply-to', 'unsigned'],
    [r.failing.id, 'in-reply-to', 'unsigned'],
    [r.grand.id, 'references', 'signed'],
  ]);
  // grand names r1 (in-reply-to, signed) and req (references, signed): two parents, in header order
  const g = await mp.linked(r.grand.id);
  assert.deepEqual(g.parents.map((p) => [p.id, p.via, p.strength]), [[r.signed.id, 'in-reply-to', 'signed'], [r.req.id, 'references', 'signed']]);
});

test('linked: a parent that is not in the trail has id null; a record with no links has none; unknown id is null', async () => {
  const { mp, dir, r, rec, mk } = await buildThread();
  const orphan = await mk('gamma.example', { from: 'o@gamma.example', messageId: '<o1@g>', inReplyTo: '<missing@nowhere>', headerList: ['from', 'to', 'subject', 'date', 'message-id', 'in-reply-to'] });
  mp.resolver = async (n) => { if (orphan.map[n] === undefined) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return [[orphan.map[n]]]; };
  const o = await rec('o', orphan.raw, 'in', 20);
  assert.deepEqual((await mp.linked(o.id)).parents, [{ id: null, message_id: '<missing@nowhere>', via: 'in-reply-to', strength: 'signed' }]);
  assert.deepEqual(await mp.linked(r.plain.id), { id: r.plain.id, message_id: '<z1@zed.example>', parents: [], children: [] });
  assert.equal(await mp.linked('0'.repeat(32)), null);
  assert.equal(await mp.linked('nope'), null);
  assert.equal(await mp.linked(undefined), null);
  assert.ok(dir);
});

test('a catch-up after new commits reaches participants and links', async () => {
  const { mp, r, rec, mk } = await buildThread();
  await mp.list();
  const late = await mk('alpha.example', { from: 'alice@alpha.example', to: 'me@owner.example', messageId: '<late@alpha.example>', inReplyTo: '<g1@alpha.example>', headerList: ['from', 'to', 'subject', 'date', 'message-id', 'in-reply-to'] });
  mp.resolver = async (n) => { if (late.map[n] === undefined) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return [[late.map[n]]]; };
  const l = await rec('late', late.raw, 'in', 30);
  assert.deepEqual((await mp.linked(r.grand.id)).children.map((c) => [c.id, c.strength]), [[l.id, 'signed']]);
  assert.equal((await mp.list({ with: 'alice@alpha.example' })).length, 2);
});

test('an index of the old schema rebuilds on its own (participants and links appear)', async () => {
  const { mp, dir, r } = await buildThread();
  await mp.list();
  const file = path.join(dir, trailIndexFile('default'));
  const d = new Database(file);
  d.exec("UPDATE meta SET v = '1' WHERE k = 'schema'; DELETE FROM participants; DELETE FROM links;");
  d.close();
  assert.deepEqual(peek(dir, 'SELECT COUNT(*) AS n FROM participants'), [{ n: 0 }]);
  assert.deepEqual(ids(await mp.list({ with: 'zed@zed.example' })), [r.plain.id]);   // the query itself triggers the rebuild
  assert.ok(peek(dir, 'SELECT COUNT(*) AS n FROM links')[0].n > 0);
  assert.deepEqual(peek(dir, "SELECT v FROM meta WHERE k = 'schema'"), [{ v: '2' }]);
  // a schema-1 file that has none of the new tables at all is created and filled too
  const e = new Database(file);
  e.exec("DROP TABLE participants; DROP TABLE links; UPDATE meta SET v = '1' WHERE k = 'schema';");
  e.close();
  assert.equal((await mp.counterparties()).length, 5);
});

test('the index never reads the content store: store:false gives the same participants and links', async () => {
  const { mp, r } = await buildThread({ content: { store: false } });
  assert.deepEqual(ids(await mp.list({ with: 'bob@beta.example', role: 'from' })), [r.failing.id, r.signed.id]);
  assert.equal((await mp.linked(r.req.id)).children.length, 4);
});
