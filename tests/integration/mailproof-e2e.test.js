// End to end through the PUBLIC entry only (package self-reference): sign ->
// record -> reload from disk in a fresh instance -> verify -> matchBody -> matchFile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof, verifyRecord, hashDocument, TRUST_LEVELS, RULES_VERSION } from 'mailproof';
import { signedMail } from '../helpers/proof.js';

test('public entry: the whole M0 journey', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
  const file = Buffer.from('signed-off budget v3');
  const m = await signedMail({ attachment: { filename: 'budget.xlsx', bytes: file }, inReplyTo: '<ask@me.example>' });

  const writer = new Mailproof({ trailDir: dir, resolver: m.resolver });
  const r = await writer.record(m.raw, { direction: 'in', source: 'e2e' });
  assert.equal(r.record.verdicts.live.trust, 'verified');

  // a brand-new instance with NO resolver reads the same trail from disk
  const reader = new Mailproof({ trailDir: dir });
  assert.deepEqual((await reader.list()).map((x) => x.id), [r.id]);
  const rec = await reader.get(r.id);
  assert.equal(verifyRecord(rec).trust, 'verified');
  assert.equal((await reader.verify(r.id)).ok, true);
  assert.equal((await reader.matchBody(r.id, m.raw)).full, true);
  assert.equal((await reader.matchFile(r.id, file)).attachment.filename, 'budget.xlsx');
  assert.equal(rec.attachments[0].sha256, hashDocument(file));
  assert.ok(TRUST_LEVELS.includes('verified') && RULES_VERSION === 'mp-rules/1');
});
