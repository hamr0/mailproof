'use strict';

// Integration tests for the optional OTS anchor. stampFile is a thin wrapper
// around the `ots` CLI, so we cover the failure path (binary missing) with a
// real spawn — the happy path needs the `ots` client + network and is verified
// in deployment, not CI (matching gitdone's note). moveProofIntoTree was
// dropped in the lift (gitrepo files the proof into its own tree).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createOts } = require('../../src/ots');

test('createOts: requires otsBin', () => {
  assert.throws(() => createOts({}), /otsBin required/);
  assert.throws(() => createOts(), /otsBin required/);
});

test('stampFile: returns {error}, never throws, when the ots binary is missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ots-'));
  try {
    const f = path.join(tmp, 'dummy.json');
    await fs.writeFile(f, '{}');
    const ots = createOts({ otsBin: '/nonexistent/ots', timeoutMs: 3000 });
    const r = await ots.stampFile(f);
    assert.equal(r.proof_path, undefined);
    assert.ok(r.error, 'error should be populated');
    assert.match(r.error, /not found|exit|ENOENT|timeout/i);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
