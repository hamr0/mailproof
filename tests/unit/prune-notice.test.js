// The prune notice format (SPEC B9.2) and the path classes prune works with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotice, noticeMessage, classify } from '../../src/proof/prune.js';

const ID = 'ab' + 'cd'.repeat(15);
const fields = (n) => ({ cutoff: `2026-0${n}-01T00:00:00.000Z`, 'previous-head': String(n).repeat(40), removed: String(n), kept: '9', stragglers: '0', dropped: '1', 'pruned-at': `2026-0${n}-02T00:00:00.000Z` });

test('a notice round-trips, and each prune pushes the earlier ones down (cumulative)', () => {
  const one = noticeMessage(fields(1), []);
  assert.ok(one.startsWith('prune notice: everything captured before 2026-01-01T00:00:00.000Z removed\n\ncutoff: '));
  assert.deepEqual(parseNotice(one), [fields(1)]);
  const two = noticeMessage(fields(2), parseNotice(one));
  assert.deepEqual(parseNotice(two), [fields(2), fields(1)]);
  const three = noticeMessage(fields(3), parseNotice(two));
  assert.deepEqual(parseNotice(three), [fields(3), fields(2), fields(1)]);
  assert.match(three, /\nearlier-2-cutoff: 2026-01-01T00:00:00\.000Z\n/);
});

test('a message that is not a notice parses to nothing', () => {
  assert.deepEqual(parseNotice('trail created\n'), []);
  assert.deepEqual(parseNotice('record abcdef in verified/verified\n'), []);
});

test('classify: records, their stamps and reply-text records belong to an id; keys are keys; the rest is neither', () => {
  assert.deepEqual(classify(`records/ab/${ID}.json`), { kind: 'record', id: ID });
  assert.deepEqual(classify(`records/ab/${ID}.json.ots`), { kind: 'record', id: ID });
  assert.deepEqual(classify(`replies/ab/${ID}.mailproof-quote-1.json`), { kind: 'reply', id: ID });
  assert.deepEqual(classify('keys/example.com/sel/0123456789abcdef.json'), { kind: 'key' });
  assert.equal(classify('trail.json'), null);
  assert.equal(classify(`records/cd/${ID}.json`), null);   // not the id's own shard: not a library file
});
