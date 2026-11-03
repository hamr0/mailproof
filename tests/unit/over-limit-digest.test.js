// The digest form of overLimitRecord (SPEC B4.3): the record of a message we only HASHED (streamed from IMAP, never
// held) must be exactly the one the pipe path writes for the same bytes, so the two captures dedupe by id.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { overLimitRecord, overLimitRecordFromDigest } from '../../src/proof/over-limit.js';
import { Mailproof } from '../../src/proof/mailproof.js';
import { MAX_TOTAL_BYTES } from '../../src/proof/limits.js';
import { makeTmpDir } from '../helpers/tmp.js';

const ctx = { direction: 'in', source: 'imap:INBOX' };
const env = { captured: '2026-01-01T00:00:00.000Z', hasEnvelope: false, trustedSealers: [] };

test('the digest form builds the same record as the buffer form', () => {
  const buf = Buffer.from('Subject: x\r\n\r\nhello\r\n');
  const digest = { raw_sha256: `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`, size: buf.length };
  assert.deepEqual(overLimitRecordFromDigest(digest, ctx, env, 'total_bytes'), overLimitRecord(buf, ctx, env, 'total_bytes'));
});

test('the id of the digest form equals the id the pipe path gives the same over-size bytes', async () => {
  const buf = Buffer.alloc(MAX_TOTAL_BYTES + 1, 0x61);
  const mp = new Mailproof({ trailDir: makeTmpDir('mp-overlimit-'), worker: { size: 0 } });
  const piped = await mp.record(buf, { direction: 'in', source: 'x' });
  assert.equal(piped.record.verdicts.live.reason, 'over limit: total_bytes');
  const digest = { raw_sha256: `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`, size: buf.length };
  const built = overLimitRecordFromDigest(digest, ctx, env, 'total_bytes');
  assert.equal(built.record.id, piped.id);
  assert.equal(built.record.message.size, buf.length);
  assert.equal(built.overLimit, 'total_bytes');
  assert.deepEqual(built.keyFiles, []);
});
