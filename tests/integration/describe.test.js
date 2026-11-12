// `describe` and `verifyWith` (SPEC B8.5): the facts of an email by id, Message-ID or address, the offline re-check of all of them,
// and the same objects over MCP. Real record() over the thread fixture; IMAP and DNS are never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailproof } from '../../src/index.js';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { inProcess } from '../helpers/mcp.js';
import { signedMail, stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { classifyTarget, resolveRecordId } from '../../src/proof/target.js';
import { explain, shortReason } from '../../src/proof/explain.js';

const T = await buildThread();
const longBody = `${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\r\n')}\r\n`;
T.r.long = await T.rec('long', Buffer.from(`From: Lou <lou@long.example>\r\nTo: me@owner.example\r\nMessage-ID: <l1@long.example>\r\nSubject: long one\r\nBcc: hidden@own.example\r\n\r\n${longBody}`), 'in', 7);
const sentOnly = await T.mk('owner.example', { from: 'Owner <me@owner.example>', to: 'solo@solo.example', messageId: '<solo1@owner.example>', subject: 'only sent', headerList: ['from', 'to', 'subject', 'date', 'message-id'] });
T.r.solo = await T.rec('solo', sentOnly.raw, 'out', 8);
const BOB = 'bob@beta.example';
const id = (n) => T.r[n].id;
const wire = (v) => JSON.parse(JSON.stringify(v));

test('targets: an id (and a unique prefix), a Message-ID and an address name the same facts; the resolver is the library\'s', async () => {
  const byId = await T.mp.describe(id('signed'));
  assert.deepEqual([byId.target, byId.total, byId.more, byId.records.length], [{ kind: 'id', value: id('signed') }, 1, false, 1]);
  assert.equal((await T.mp.describe(id('signed').slice(0, 10))).records[0].id, id('signed'));
  const byMid = await T.mp.describe('<r1@beta.example>');
  assert.deepEqual([byMid.target.kind, byMid.total, byMid.records[0].id], ['message-id', 1, id('signed')]);
  const byAddr = await T.mp.describe(' Bob@Beta.Example ');
  assert.deepEqual([byAddr.target, byAddr.total], [{ kind: 'address', value: BOB }, 4]);
  assert.deepEqual(byAddr.records.map((r) => r.id), [id('grand'), id('failing'), id('signed'), id('req')], 'newest capture first');
  assert.deepEqual(byAddr.records.find((r) => r.id === id('signed')), byId.records[0], 'one definition: the same Facts either way');
  assert.deepEqual(await T.mp.describe(classifyTarget(BOB)), byAddr, 'a classified target is accepted');
  const lim = await T.mp.describe(BOB, { limit: 1 });
  assert.deepEqual([lim.total, lim.more, lim.records.length], [4, true, 1]);
  const rng = await T.mp.describe(BOB, { after: '2026-11-01T10:02:00Z', before: new Date('2026-11-01T10:05:00Z') });
  assert.equal(rng.total, 2);
  assert.deepEqual(await T.mp.describe('nobody@nowhere.example'), { target: { kind: 'address', value: 'nobody@nowhere.example' }, total: 0, more: false, records: [] });
  assert.equal((await T.mp.describe('0'.repeat(32))).total, 0);
  assert.deepEqual(await resolveRecordId(T.dir + '/default', 'zzzzzzzz'.replace(/z/g, '0')), { none: true });
  for (const bad of ['hello', 'ea1fda2', '-x', '<a b>', 'a@b c', 'a'.repeat(33)]) await assert.rejects(T.mp.describe(bad), (e) => e.code === 'ERR_TARGET', bad);
  await assert.rejects(T.mp.describe(BOB, { limit: -1 }), TypeError);
});

test('Facts of a signed reply: addresses with coverage, signed date and subject, links, dkim, trust, why null', async () => {
  const [f] = (await T.mp.describe(id('signed'))).records;
  assert.deepEqual([f.direction, f.source, f.message_id, f.copy], ['in', 'test', '<r1@beta.example>', 'direct']);
  assert.deepEqual(f.from, [{ address: 'Bob@Beta.Example', signed: true, coverage: 'signed' }]);
  assert.deepEqual(f.to, [{ address: 'me@owner.example', signed: true, coverage: 'signed' }]);
  assert.deepEqual([f.date.coverage, f.subject], ['signed', { value: 'Re: please sign', coverage: 'signed' }]);
  assert.deepEqual(f.in_reply_to, { value: '<req@owner.example>', strength: 'signed' });
  assert.deepEqual(f.children.map((c) => [c.message_id, c.strength]), [['<g1@alpha.example>', 'signed']]);
  assert.deepEqual([f.dkim.length, f.dkim[0].d, f.dkim[0].result, f.dkim[0].aligned, f.dkim[0].recheck, f.dkim[0].key_archived], [1, 'beta.example', 'pass', true, { ok: true, why: null }, true]);
  assert.deepEqual([f.trust.live, f.trust.portable, f.trust.rules, f.recheck], ['verified', 'verified', 'mp-rules/1', { ok: true, trust: 'verified' }]);
  assert.equal(f.why, null);
  assert.deepEqual([f.body.proof, f.body.stored, f.body.source, f.body.text, f.body.more_lines], ['proven', true, 'text/plain', 'I confirm.', 0]);
  assert.deepEqual([f.content.raw_stored, f.attachments], [true, []]);
  assert.equal(f.message_key.length, 32);
});

test('a record with little in it: every absent value is null (or empty), never missing', async () => {
  const [f] = (await T.mp.describe(id('plain'))).records;
  assert.deepEqual([f.date, f.subject], [{ value: null, coverage: 'none' }, { value: null, coverage: 'none' }]);
  assert.deepEqual([f.in_reply_to, f.references, f.children, f.bcc, f.spf, f.arc, f.dkim], [null, [], [], null, null, null, []]);
  assert.deepEqual(f.from, [{ address: 'zed@zed.example', signed: false, coverage: 'none' }]);
  assert.equal(f.from[0].coverage, 'none');
  assert.deepEqual([f.to, f.cc, f.reply_to], [[{ address: 'me@owner.example', signed: false, coverage: 'none' }], [], []]);
  assert.match(f.why, /no DKIM signature/);
  assert.equal(f.body.proof, 'not');
  for (const k of ['id', 'message_id', 'message_key', 'captured', 'direction', 'source', 'date', 'subject', 'from', 'to', 'cc', 'reply_to', 'bcc', 'in_reply_to', 'references', 'children', 'children_more', 'copy', 'dkim', 'dmarc', 'spf', 'arc', 'trust', 'recheck', 'why', 'body_proof', 'body', 'attachments', 'content', 'seal']) assert.ok(k in f, k);
});

test('body text: the first 10 lines and the count of the rest, the whole text with full: true; bcc is read from the own copy', async () => {
  const [cut] = (await T.mp.describe(id('long'))).records;
  assert.deepEqual([cut.body.text.split('\n').length, cut.body.more_lines], [10, 5]);
  assert.equal(cut.body.text.split('\n').at(-1), 'line 10');
  const [full] = (await T.mp.describe(id('long'), { full: true })).records;
  assert.deepEqual([full.body.text.split('\n').length, full.body.more_lines, full.body.text.split('\n').at(-1)], [15, 0, 'line 15']);
  assert.equal(full.bcc, 'hidden@own.example');
  assert.deepEqual([full.subject.value, full.subject.coverage], ['long one', 'claimed']);
});

test('a failing signature: coverage failing, and `why` says what the offline re-check found', async () => {
  const [f] = (await T.mp.describe(id('failing'))).records;
  assert.deepEqual([f.from[0].signed, f.from[0].coverage, f.subject.coverage], [false, 'failing', 'failing']);
  assert.deepEqual([f.recheck.ok, f.dkim[0].recheck], [false, { ok: false, why: 'bad signature' }]);
  assert.match(f.why, /offline re-check of beta\.example: bad signature/);
  assert.equal(f.why, explain(await T.mp.get(id('failing'))), 'explain is the one definition');
  assert.equal(f.reason, 'signature fails');
  assert.equal(f.reason, shortReason(await T.mp.get(id('failing'))), 'shortReason is the one definition of the short reason');
  assert.equal((await T.mp.describe(id('signed'))).records[0].reason, 'verifies');
  assert.equal((await T.mp.describe(id('plain'))).records[0].reason, 'no DKIM signature');
});

test('why states a recorded DNS error as the fact', async () => {
  const m = await signedMail({ domain: 'gone.example', signTime: new Date('2026-11-01T10:00:00Z') });
  const mp = new Mailproof({ trailDir: makeTmpDir('mp-describe-gone-'), resolver: stubResolver({}), worker: { size: 0 } });
  await mp.record(m.raw, { direction: 'in', source: 'test' });
  const [f] = (await mp.describe(m.signers[0].domain === 'gone.example' ? 'me@gone.example' : 'x@y.z')).records;
  assert.match(f.why, /no public key published at sel1\._domainkey\.gone\.example at capture \(DNS: stub-dns: no record for sel1\._domainkey\.gone\.example\)/);
  assert.doesNotMatch(f.why, /typically/);
  await mp.close();
});

test('verifyWith: a failing RECEIVED email makes ok false; sent copies are listed but counted only with all: true', async () => {
  const v = await T.mp.verifyWith(BOB);
  assert.deepEqual([v.ok, v.total, v.checked, v.counted, v.verified, v.not_verified, v.sent_copies], [false, 4, 4, 3, 2, 1, 1]);
  assert.deepEqual([v.inbound, v.outbound, v.all], [{ verified: 2, failed: 1 }, { verified: 1, failed: 0 }, false]);
  const bad = v.records.find((r) => !r.ok);
  assert.deepEqual([bad.id, bad.counted, bad.trust, bad.reason], [id('failing'), true, 'unverified', 'beta.example: bad signature']);
  assert.match(bad.why, /offline re-check of beta\.example/);
  assert.equal(v.records.find((r) => r.direction === 'out').counted, false);
  assert.deepEqual(Object.keys(v.records[0]).sort(), ['captured', 'counted', 'direction', 'id', 'ok', 'reason', 'subject', 'trust', 'why']);
  assert.equal(v.records.find((r) => r.id === id('signed')).subject, 'Re: please sign');
  const clean = await T.mp.verifyWith(BOB, { before: '2026-11-01T10:04:00Z' });
  assert.deepEqual([clean.ok, clean.counted, clean.verified, clean.not_verified], [true, 1, 1, 0]);
  const all = await T.mp.verifyWith(BOB, { all: true, before: '2026-11-01T10:04:00Z' });
  assert.deepEqual([all.ok, all.counted, all.verified], [true, 2, 2]);
  assert.equal((await T.mp.verifyWith('<r1@beta.example>')).ok, true);
  assert.equal((await T.mp.verifyWith(BOB, { limit: 1 })).checked, 1);
});

test('verifyWith: only sent copies is not ok (counted 0); all: true counts them; nothing recorded is not ok either', async () => {
  const s = await T.mp.verifyWith('solo@solo.example');
  assert.deepEqual([s.ok, s.total, s.counted, s.verified, s.sent_copies, s.records[0].counted, s.records[0].ok], [false, 1, 0, 0, 1, false, true]);
  const a = await T.mp.verifyWith('solo@solo.example', { all: true });
  assert.deepEqual([a.ok, a.counted, a.verified], [true, 1, 1]);
  const n = await T.mp.verifyWith('nobody@nowhere.example');
  assert.deepEqual([n.ok, n.total, n.counted, n.records], [false, 0, 0, []]);
  await assert.rejects(T.mp.verifyWith('nonsense'), (e) => e.code === 'ERR_TARGET');
  assert.deepEqual((await T.mp.verify(id('signed'))).ok, true, 'verify(id) is unchanged');
});

test('counterparties is the one row the CLI people and the MCP tool both read: verified counts received verified emails', async () => {
  const rows = await T.mp.counterparties();
  const bob = rows.find((r) => r.address === BOB);
  assert.deepEqual([bob.records, bob.verified], [4, 2 + 0]);
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  const j = JSON.parse((await w.run(['people', '--json'])).stdout);
  assert.equal(j.find((p) => p.address === BOB).verified, bob.verified);
  assert.equal(j.find((p) => p.address === BOB).records, bob.records);
});

test('MCP: describe and verifyWith return the library objects, read-only', async () => {
  const w = makeWorld({ accounts: { personal: account(T.dir) } });
  const s = await inProcess(w);
  try {
    const tl = (await s.request('tools/list')).result.tools;
    for (const n of ['describe', 'verifyWith']) {
      const t = tl.find((x) => x.name === n);
      assert.equal(t.annotations.readOnlyHint, true, n);
      assert.equal(t.annotations.openWorldHint, false, n);
      assert.deepEqual(t.inputSchema.required, ['target'], n);
      assert.match(t.description, /untrusted data/);
    }
    assert.match(tl.find((x) => x.name === 'describe').description, /full: true/);
    const mp = new Mailproof({ trailDir: T.dir, worker: { size: 0 } });
    for (const [args, want] of [
      [{ target: BOB }, await mp.describe(BOB)],
      [{ target: id('long'), full: true }, await mp.describe(id('long'), { full: true })],
      [{ target: '<r1@beta.example>' }, await mp.describe('<r1@beta.example>')],
      [{ target: BOB, limit: 2, after: '2026-11-01' }, await mp.describe(BOB, { limit: 2, after: new Date('2026-11-01') })],
    ]) assert.deepEqual((await s.call('describe', args)).json, wire(want), JSON.stringify(args));
    assert.deepEqual((await s.call('verifyWith', { target: BOB })).json, wire(await mp.verifyWith(BOB)));
    assert.deepEqual((await s.call('verifyWith', { target: 'solo@solo.example', all: true })).json, wire(await mp.verifyWith('solo@solo.example', { all: true })));
    assert.equal((await s.call('describe', { target: 'nonsense' })).error.code, 'ERR_TARGET');
    assert.equal((await s.call('describe', { target: BOB, limit: 0 })).error.code, 'ERR_BAD_ARGUMENT');
    assert.equal((await s.call('describe', {})).error.code, 'ERR_BAD_ARGUMENT');
    await mp.close();
  } finally { await s.close(); }
});
