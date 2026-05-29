
// Composition root (m7b-3 Commit A). create({ ... }) must wire the four pillars
// onto ONE dataDir and hand back a working create/read/verify surface. These
// tests drive the real event store + git ledger + notary on a tmp dir — no
// mocks. The full ledger round-trip (commit → verify a real document) is
// exercised by ingest() in Commit B and by the direct gitrepo/notary
// integration tests; here we prove the wiring, validation, and surface shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { create } from '../../src/create.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-create-'));
}

test('create: requires dataDir and domain', () => {
  assert.throws(() => create({ domain: 'example.com' }), /dataDir required/);
  assert.throws(() => create({ dataDir: '/tmp/x' }), /domain required/);
  assert.throws(() => create(), /dataDir required/);
});

test('create: exposes the create/read/verify surface', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: 'example.com' });
    for (const fn of ['createEvent', 'activateEvent', 'editEvent', 'loadEvent',
      'listCommits', 'loadCommit', 'verifyDocument', 'hashDocument']) {
      assert.equal(typeof core[fn], 'function', `core.${fn} should be a function`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('create: createEvent → loadEvent round-trips a workflow event on the bound dataDir', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: 'example.com' });
    const event = await core.createEvent({
      id: 'wf01', type: 'workflow', flow: 'sequential', title: 'Onboard',
      steps: [{ id: 'sign', participant: 'alice@example.com' }],
    });
    assert.equal(event.id, 'wf01');
    assert.equal(event.steps[0].dependsOn.length, 0); // flow expanded

    // The store wrote under the SAME dataDir the instance was bound to.
    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'wf01.json'), 'utf8'));
    assert.equal(onDisk.title, 'Onboard');

    // loadEvent reads it back through the bound store.
    const loaded = await core.loadEvent('wf01');
    assert.deepEqual(loaded, onDisk);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('create: createEvent normalises a crypto sign-off event (the second mode)', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: 'example.com' });
    const event = await core.createEvent({
      id: 'cr01', type: 'crypto', title: 'Sign the deed',
      signers: ['A@example.com', 'b@example.com'], threshold: 2,
    });
    assert.equal(event.type, 'crypto');
    assert.equal(event.threshold, 2);
    assert.deepEqual(event.signers, ['a@example.com', 'b@example.com']); // lowercased
    assert.equal(event.open, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('create: notary + gitrepo are wired to the same store (verify routes through, no docs ⇒ not found)', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: 'example.com' });
    await core.createEvent({
      id: 'wf02', type: 'workflow', flow: 'sequential',
      steps: [{ id: 'sign', participant: 'alice@example.com' }],
    });
    // No commits yet: listCommits sees no repo, verifyDocument finds the event
    // (via the shared store) but no committed attachment to match. Both must
    // resolve cleanly rather than throw — proving the pillars share dataDir.
    assert.deepEqual(await core.listCommits('wf02'), []);
    const res = await core.verifyDocument('wf02', Buffer.from('anything'));
    assert.equal(res.found, false);
    assert.deepEqual(res.matches, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('create: optional otsBin omitted still composes a working instance', async () => {
  const tmp = await tmpDir();
  try {
    const core = create({ dataDir: tmp, domain: 'example.com', otsBin: undefined });
    const event = await core.createEvent({
      id: 'wf03', type: 'workflow', flow: 'parallel',
      steps: [{ id: 'a', participant: 'a@example.com' }, { id: 'b', participant: 'b@example.com' }],
    });
    assert.equal(event.flow, 'parallel');
    assert.deepEqual(event.steps.map((s) => s.dependsOn), [[], []]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
