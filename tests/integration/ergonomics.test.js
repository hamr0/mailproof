
// 0.9.2 ergonomic gaps surfaced by the mailproof-probe P2 validation (probe PRD
// §8: G0/G2/G3a/G4). Each is a small consumer-DX primitive — none changes the
// coordination model. These tests pin the public-surface behaviour consumers
// rely on; the engine semantics are covered by crypto/completion/ingest suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { create } from '../../src/create.js';
import { saltedSenderHash as topLevelHash } from '../../src/index.js';
import { createGitrepo } from '../../src/gitrepo.js';
import { verifiedSigner } from '../helpers/dkim.js';

const OPERATOR = 'app.example';
const envOf = (recipient, sender) => ({ recipient, sender, clientIp: '198.51.100.9', clientHelo: 'mta.example' });
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-ergo-'));

// G0 — `exports` exposes `./package.json` so a consumer can read mailproof's
// version (`import pkg from 'mailproof/package.json'`).
test('G0: package.json exports map includes the ./package.json subpath', async () => {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  assert.equal(pkg.exports['./package.json'], './package.json',
    'consumers must be able to import mailproof/package.json (e.g. to read the version)');
});

// G2 — `saltedSenderHash` is a top-level export, so a consumer mapping an
// attestor email → its stored salted hash needn't construct a gitrepo. It must
// be the SAME pure function the ledger uses (no divergence).
test('G2: top-level saltedSenderHash matches the gitrepo instance hash byte-for-byte', async () => {
  const tmp = await tmpDir();
  try {
    const repo = createGitrepo({ dataDir: tmp });
    const salt = 'public-salt-123';
    const email = 'Alice@Corp.Example';
    assert.equal(typeof topLevelHash, 'function');
    assert.equal(topLevelHash(email, salt), repo.saltedSenderHash(email, salt));
    assert.match(topLevelHash(email, salt), /^sha256:[0-9a-f]{64}$/);
    assert.equal(topLevelHash(null, salt), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// G3a — `manualCompletion: true` suppresses the engine's auto-complete: a
// verified signer reply still COUNTS and commits, but the event stays open
// until the consumer calls completeEvent (the honest replacement for the
// threshold:999 hack). G4 — loadCompletion reads the canonical record.
test('G3a/G4: manualCompletion keeps the engine open at threshold; completeEvent finalises; loadCompletion reads the record', async () => {
  const tmp = await tmpDir();
  const signer = verifiedSigner({ domain: 'corp.example' });
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver });
    await core.createEvent({
      id: 'mc01', type: 'crypto', title: 'Consumer-owned completion',
      activated_at: '2026-01-01T00:00:00Z',
      signers: ['alice@corp.example'], threshold: 1, manualCompletion: true,
    });
    const to = `attest+mc01@${OPERATOR}`;

    // G4: no completion record before the event completes.
    assert.equal(await core.loadCompletion('mc01'), null);

    // A verified signer reply counts (and commits) but does NOT auto-complete.
    const r = await core.ingest(await signer.sign({ from: 'alice@corp.example', to }), envOf(to, 'alice@corp.example'));
    assert.equal(r.counted, true);
    assert.equal(r.signatureCount, 1);
    assert.equal(r.eventComplete, false, 'manualCompletion suppresses engine auto-complete');
    assert.equal((await core.loadEvent('mc01')).status, 'open');
    assert.equal(await core.loadCompletion('mc01'), null, 'still no completion record while open');

    // The consumer owns finalisation.
    const c = await core.completeEvent('mc01', { reason: 'all docs signed', completedAt: '2026-02-01T00:00:00Z' });
    assert.equal(c.completed, true);
    assert.equal((await core.loadEvent('mc01')).status, 'complete');

    // G4: loadCompletion now returns the canonical record.
    const rec = await core.loadCompletion('mc01');
    assert.ok(rec, 'completion record readable after completeEvent');
    assert.equal(rec.kind, 'completion');
    assert.equal(rec.event_id, 'mc01');
    assert.equal(rec.completed_at, '2026-02-01T00:00:00Z');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// G3a for workflow mode — completing the only step doesn't finalise the event.
test('G3a: manualCompletion suppresses workflow auto-complete too', async () => {
  const tmp = await tmpDir();
  const signer = verifiedSigner({ domain: 'corp.example' });
  try {
    const core = create({ dataDir: tmp, domain: OPERATOR, resolver: signer.resolver });
    await core.createEvent({
      id: 'mw01', type: 'workflow', flow: 'sequential', title: 'Manual finish',
      activated_at: '2026-01-01T00:00:00Z', manualCompletion: true,
      steps: [{ id: 'sign', participant: 'alice@corp.example' }],
    });
    const to = `event+mw01-sign@${OPERATOR}`;

    const r = await core.ingest(await signer.sign({ from: 'alice@corp.example', to }), envOf(to, 'alice@corp.example'));
    assert.equal(r.counted, true);
    assert.equal(r.completedStep, 'sign');
    assert.equal(r.eventComplete, false, 'last step done but event stays open under manualCompletion');

    const ev = await core.loadEvent('mw01');
    assert.equal(ev.status, 'open');
    assert.equal(ev.steps[0].status, 'complete', 'the step itself still completed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
