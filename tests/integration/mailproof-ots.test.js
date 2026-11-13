// Optional OTS stamping, with a fake `ots` binary (a shell script).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Mailproof, otsTimeoutMs } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { recordPath, recordOtsPath } from '../../src/proof/layout.js';

const tmp = () => makeTmpDir('mp-ots-');
function fakeOts(body) {
  const f = path.join(tmp(), 'ots');
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}
const files = (root, id) => execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n');

test('OTS off (otsBin: null): no stamp, no .ots file', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, otsBin: null });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal(r.ots, 'off');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'default', path.dirname(recordPath(r.id)))), [`${r.id}.json`]);
});

test('OTS on: the stamp is made over the record file and committed in the same commit', async () => {
  const dir = tmp();
  const m = await signedMail({});
  const bin = fakeOts('[ "$1" = stamp ] && cp "$2" "$2.ots"');
  const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, otsBin: bin, stamp: { mode: 'record' } });
  const r = await mp.record(m.raw, { direction: 'in' });
  assert.equal(r.ots, 'pending');
  const root = path.join(dir, 'default');
  assert.ok(files(root).includes(recordOtsPath(r.id)));
  assert.ok(files(root).includes(`records/${r.id.slice(0, 2)}/${r.id}.json.ots`), 'literal sharded .ots path');
  assert.ok(files(root).includes(recordPath(r.id)));
  // the "proof" (our fake copies its input) is the exact record bytes that were committed
  assert.equal(fs.readFileSync(path.join(root, recordOtsPath(r.id)), 'utf8'), fs.readFileSync(path.join(root, recordPath(r.id)), 'utf8'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('OTS failure never blocks the commit: missing binary and failing binary both report {error}', async () => {
  for (const bin of ['/nonexistent/ots', fakeOts('echo calendar down >&2; exit 3')]) {
    const dir = tmp();
    const m = await signedMail({});
    const mp = new Mailproof({ trailDir: dir, resolver: m.resolver, otsBin: bin, stamp: { mode: 'record' } });
    const r = await mp.record(m.raw, { direction: 'in' });
    assert.equal(r.duplicate, false);
    assert.ok(typeof r.ots === 'object' && r.ots.error, JSON.stringify(r.ots));
    assert.ok(await mp.get(r.id));
    assert.ok(!fs.existsSync(path.join(dir, 'default', recordOtsPath(r.id))));
  }
});

test('a hanging OTS stamp is cut off inside the lock: the next writer is not locked out', async () => {
  const dir = tmp();
  const marker = path.join(tmp(), 'stamping');
  const bin = fakeOts(`touch '${marker}'\nexec sleep 60`);
  const m1 = await signedMail({ body: 'one\r\n', domain: 'one.example' });
  const m2 = await signedMail({ body: 'two\r\n', domain: 'two.example' });
  const mailFile = path.join(tmp(), 'm2.eml');
  fs.writeFileSync(mailFile, m2.raw);
  const mapFile = path.join(tmp(), 'dns.json');
  fs.writeFileSync(mapFile, JSON.stringify(m2.map));
  // writer A (this process) hangs in `ots stamp`; the stamp is capped at the 5000 ms floor
  const a = new Mailproof({ trailDir: dir, resolver: m1.resolver, otsBin: bin, stamp: { mode: 'record' }, lockTimeoutMs: 3000 });
  const aDone = a.record(m1.raw, { direction: 'in' });
  const end = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(marker), 'A is inside the lock, stamping');
  // writer B (another process) waits for the lock with a budget above that cap (it starts waiting only after its own parse/verify work)
  const helper = fileURLToPath(new URL('../helpers/record-proc.js', import.meta.url));
  const bOut = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [helper, dir, mailFile, mapFile, '12000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', reject);
    c.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop())));
  });
  assert.equal(bOut.ok, true, JSON.stringify(bOut));
  const ar = await aDone;
  assert.deepEqual(ar.ots, { error: 'ots timeout' });
  const root = path.join(dir, 'default');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter((x) => x.startsWith('record ')).length, 2);
  assert.equal(fs.existsSync(path.join(dir, '.default.lock')), false);
});

test('the ots timeout is clamp(floor(lockTimeoutMs / 3), 5000, 30000)', () => {
  for (const [lock, want] of [[0, 5000], [3000, 5000], [15000, 5000], [30000, 10000], [60000, 20000], [90000, 30000], [300000, 30000]]) {
    assert.equal(otsTimeoutMs(lock), want, `lockTimeoutMs ${lock}`);
  }
});
