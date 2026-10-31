// Optional OTS stamping, with a fake `ots` binary (a shell script).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ots-'));
function fakeOts(body) {
  const f = path.join(tmp(), 'ots');
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}
const files = (root, id) => execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n');

test('OTS is off by default: no stamp, no .ots file', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal(r.ots, 'off');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'default', 'records')), [`${r.id}.json`]);
});

test('OTS on: the stamp is made over the record file and committed in the same commit', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const bin = fakeOts('[ "$1" = stamp ] && cp "$2" "$2.ots"');
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, otsBin: bin });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal(r.ots, 'pending');
  const root = path.join(dir, 'default');
  assert.ok(files(root).includes(`records/${r.id}.json.ots`));
  assert.ok(files(root).includes(`records/${r.id}.json`));
  // the "proof" (our fake copies its input) is the exact record bytes that were committed
  assert.equal(fs.readFileSync(path.join(root, 'records', `${r.id}.json.ots`), 'utf8'), fs.readFileSync(path.join(root, 'records', `${r.id}.json`), 'utf8'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('OTS failure never blocks the commit: missing binary and failing binary both report {error}', async () => {
  for (const bin of ['/nonexistent/ots', fakeOts('echo calendar down >&2; exit 3')]) {
    const dir = tmp();
    const m = await signedMail({});
    const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, otsBin: bin });
    const r = await mp.record(m.raw, { direction: 'in' });
    assert.equal(r.duplicate, false);
    assert.ok(typeof r.ots === 'object' && r.ots.error, JSON.stringify(r.ots));
    assert.ok(await mp.get(r.id));
    assert.ok(!fs.existsSync(path.join(dir, 'default', 'records', `${r.id}.json.ots`)));
  }
});
