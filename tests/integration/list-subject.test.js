// list({ subject }): a case-insensitive substring match on the subject the rows carry (signed or claimed), combinable with the
// other filters, applied BEFORE the limit; the same filter through the CLI `list --subject` and the MCP `list` tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';

const T = await buildThread();
const all = await T.mp.list();
const lower = (r) => (r.subject ?? '').toLowerCase();

test('list({ subject }): case-insensitive substring over signed and claimed subjects; a plain text, never a pattern', async () => {
  assert.ok(all.some((r) => lower(r).includes('approve')) && all.some((r) => lower(r).includes('please sign')), 'the fixture has two distinct subjects');
  for (const text of ['approve', 'APPROVE?', 'Please Sign', 'sign!', 'e s']) {
    const got = await T.mp.list({ subject: text });
    assert.deepEqual(got.map((r) => r.id), all.filter((r) => lower(r).includes(text.toLowerCase())).map((r) => r.id), text);
    assert.ok(got.length > 0, text);
  }
  assert.ok((await T.mp.list({ subject: 'sign!' })).every((r) => r.subjectSource === 'claimed'), 'a claimed subject is searched too');
  assert.deepEqual(await T.mp.list({ subject: 'no such subject' }), []);
  assert.deepEqual(await T.mp.list({ subject: '.*' }), [], 'a regex is not a pattern');
  assert.deepEqual(await T.mp.list({ subject: '%' }), [], 'nor is a SQL wildcard');
});

test('list({ subject }) combines with with/direction/after and the limit counts matches, not rows', async () => {
  const both = await T.mp.list({ subject: 'please sign', with: 'bob@beta.example' });
  assert.deepEqual(both.map((r) => r.id), all.filter((r) => lower(r).includes('please sign') && r.addresses.some((a) => a.address === 'bob@beta.example')).map((r) => r.id));
  const one = await T.mp.list({ subject: 'please sign', limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, (await T.mp.list({ subject: 'please sign' }))[0].id, 'the newest match, whatever its rank among all rows');
  assert.deepEqual(await T.mp.list({ subject: 'approve', direction: 'in' }), []);
});

test('list({ subject }) refuses a value that is not a non-empty string', async () => {
  for (const bad of ['', '  ', 5, null, {}]) await assert.rejects(() => T.mp.list({ subject: bad }), { name: 'TypeError', message: /subject/ });
});

test('CLI: list --subject text, and --json carries the same rows', async () => {
  const w = makeWorld({ accounts: { test: account(T.dir) } });
  const r = await w.run(['list', '--subject', 'APPROVE', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.id), [T.r.req.id]);
  const h = await w.run(['help', 'list']);
  assert.match(h.stdout, /--subject <text>/);
  const none = await w.run(['list', '--subject', 'zzz']);
  assert.match(none.stdout, /no emails recorded/);
});
