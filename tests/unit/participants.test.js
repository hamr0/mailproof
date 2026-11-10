// Address-list parsing, participants and link grading from a record alone (SPEC B8). Pure functions, no trail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddresses, participantsOf, linksOf, strongest, signedFromAddresses } from '../../src/proof/participants.js';

const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
const sig = (...lines) => ({ signed_headers: lines.map((l) => b64(l + '\r\n')) });

test('parseAddresses: plain, display names, quoted, comments, groups, route, junk', () => {
  assert.deepEqual(parseAddresses('a@x.example'), ['a@x.example']);
  assert.deepEqual(parseAddresses(' Bob <Bob@Beta.Example>, "Carol, C." <carol@g.example> '), ['Bob@Beta.Example', 'carol@g.example']);
  // a display name that looks like an address is not an address
  assert.deepEqual(parseAddresses('"ceo@bank.example" <evil@x.example>'), ['evil@x.example']);
  assert.deepEqual(parseAddresses('x@y.example (the "boss" <z@z.example>)'), ['x@y.example']);
  assert.deepEqual(parseAddresses('Team: a@x.example, b@y.example;'), ['a@x.example', 'b@y.example']);
  assert.deepEqual(parseAddresses('<@r1.example,@r2.example:user@host.example>'), ['user@host.example']);
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddresses('not an address, @x.example, a@, "a"@x.example'), []);
  // a quoted string hides its `<`: only the real angle address counts
  assert.deepEqual(parseAddresses('"a<" <b@c.example>'), ['b@c.example']);
  assert.deepEqual(parseAddresses(''), []);
  assert.deepEqual(parseAddresses('a@b@c.example'), []);
  assert.deepEqual(parseAddresses(`<${'a'.repeat(300)}@x.example>`), []);
});

test('parseAddresses is linear on a long hostile value', () => {
  for (const v of ['"'.repeat(200_000), '('.repeat(200_000), '<'.repeat(200_000), 'a@'.repeat(100_000), ','.repeat(200_000)]) {
    const t = process.cpuUsage();
    parseAddresses(v);
    assert.ok((process.cpuUsage(t).user / 1000) < 500, 'under 500 ms CPU');
  }
});

test('participantsOf: roles, lower-casing with raw kept, signed flag, dedupe, reply-to, unsigned message.from', () => {
  const rec = {
    signatures: [sig('From: Alice <Alice@A.example>', 'To: Bob@B.example, bob@b.example', 'Cc: c@c.example', 'Reply-To: r@r.example', 'Subject: x'), sig('To: Bob@B.example')],
    message: {},
  };
  const p = participantsOf(rec);
  const key = (x) => `${x.role}:${x.address}:${x.signed}`;
  assert.deepEqual(p.map(key).sort(), ['cc:c@c.example:true', 'from:alice@a.example:true', 'reply-to:r@r.example:true', 'to:bob@b.example:true']);
  assert.equal(p.find((x) => x.role === 'from').raw, 'Alice@A.example');
  // an unsigned record: only message.from, signed false; unsigned To/Cc are not in the record at all
  assert.deepEqual(participantsOf({ signatures: [], message: { from: 'U@U.example' } }), [{ address: 'u@u.example', raw: 'U@U.example', role: 'from', signed: false }]);
  assert.deepEqual(participantsOf({ signatures: 'x', message: null }), []);
  assert.deepEqual(participantsOf(null), []);
});

test('participantsOf caps rows per record', () => {
  const many = Array.from({ length: 2000 }, (_, i) => `u${i}@x.example`).join(', ');
  assert.equal(participantsOf({ signatures: [sig(`To: ${many}`)], message: {} }).length, 500);
});

test('signedFromAddresses reads only the named signatures', () => {
  const rec = { signatures: [sig('From: a@a.example'), sig('From: b@b.example')] };
  assert.deepEqual(signedFromAddresses(rec), ['a@a.example', 'b@b.example']);
  assert.deepEqual(signedFromAddresses(rec, [1]), ['b@b.example']);
  assert.deepEqual(signedFromAddresses(rec, []), []);
});

test('linksOf: signed needs a PASSING signature that covers the header; unsigned otherwise; strongest wins per id', () => {
  const rec = {
    signatures: [sig('In-Reply-To: <p1@x>', 'References: <p0@x> <p1@x>')],
    message: { message_id: '<me@x>', in_reply_to: '<p1@x>', references: ['<p0@x>', '<p1@x>', '<me@x>', '<p9@x>'] },
  };
  assert.deepEqual(linksOf(rec, [0]), [
    { mid: '<p1@x>', via: 'in-reply-to', strength: 'signed' },
    { mid: '<p0@x>', via: 'references', strength: 'signed' },
    { mid: '<p9@x>', via: 'references', strength: 'unsigned' },   // named in the unsigned parse only; own id skipped
  ]);
  // the signature does not pass: everything is unsigned
  assert.ok(linksOf(rec, []).every((l) => l.strength === 'unsigned'));
  // unsigned In-Reply-To but a signed References for the same id: one row, signed
  const mixed = { signatures: [sig('References: <p1@x>')], message: { message_id: '<me@x>', in_reply_to: '<p1@x>', references: ['<p1@x>'] } };
  assert.deepEqual(linksOf(mixed, [0]), [{ mid: '<p1@x>', via: 'references', strength: 'signed' }]);
  assert.deepEqual(linksOf({ signatures: [], message: {} }, []), []);
  assert.deepEqual(linksOf(null, []), []);
});

test('strongest, with and without a named parent', () => {
  const l = [{ mid: '<a>', via: 'references', strength: 'unsigned' }, { mid: '<b>', via: 'in-reply-to', strength: 'signed' }];
  assert.equal(strongest(l), 'signed');
  assert.equal(strongest(l, '<a>'), 'unsigned');
  assert.equal(strongest(l, '<zzz>'), 'none');
  assert.equal(strongest([]), 'none');
});

test('addressesOf: all four roles, signed or not, header order, dedupe, spoof skipped, cap; participantsOf reads the field', async () => {
  const { addressesOf } = await import('../../src/proof/participants.js');
  const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
  const rows = [
    { name: 'from', raw: 'From: A <A@X.example>' },
    { name: 'to', raw: 'To: "ceo@bank.example" <Bob@Y.example>,\r\n b@y.example' },
    { name: 'cc', raw: 'Cc: c@z.example' },
    { name: 'reply-to', raw: 'Reply-To: r@z.example' },
    { name: 'subject', raw: 'Subject: x@y.example' },
    { name: 'to', raw: 'To: bob@y.example' },
  ];
  const sigs = [{ signed_headers: [b64('From: A <A@X.example>'), b64('To: bob@y.example')] }];
  const a = addressesOf(rows, sigs);
  assert.deepEqual(a.map((x) => `${x.role}:${x.address}:${x.raw}:${x.signed}`), [
    'from:a@x.example:A@X.example:true', 'to:bob@y.example:Bob@Y.example:true', 'to:b@y.example:b@y.example:false',
    'cc:c@z.example:c@z.example:false', 'reply-to:r@z.example:r@z.example:false',
  ]);
  assert.deepEqual(addressesOf([], null), []);
  const many = Array.from({ length: 700 }, (_, i) => `u${i}@x.example`).join(', ');
  assert.equal(addressesOf([{ name: 'to', raw: `To: ${many}` }], []).length, 500);
  // participantsOf prefers the field; ignores malformed entries
  const rec = { signatures: [], message: { from: 'ignored@x.example' }, addresses: [...a, null, { role: 'bcc', raw: 'q@q.example' }, { role: 'to', raw: 5 }] };
  assert.deepEqual(participantsOf(rec).map((p) => p.address), ['a@x.example', 'bob@y.example', 'b@y.example', 'c@z.example', 'r@z.example']);
});
