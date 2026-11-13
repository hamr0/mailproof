// C13: when the raw email is gone, say why when mailproof knows: a note left by forget or the retention sweep (outside git), or the store being off.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { goneText } from '../../src/cli/detail.js';
import { makeTmpDir } from '../helpers/tmp.js';

const mail = (n) => Buffer.from(`From: a@a.example\r\nTo: me@owner.example\r\nMessage-ID: <g${n}@a.example>\r\nSubject: s${n}\r\n\r\nbody ${n}\r\n`);
const NOW = new Date('2026-11-12T10:00:00Z');

test('forget and expiry leave a note; the store being off says never stored; an unknown reason stays generic', async () => {
  const dir = makeTmpDir('mp-gone-');
  const mp = new Mailproof({ trailDir: dir, worker: { size: 0 }, now: () => new Date('2026-11-01T00:00:00Z'), otsBin: null });
  const a = (await mp.record(mail(1), { direction: 'in' })).record;
  const b = (await mp.record(mail(2), { direction: 'in' })).record;
  const c = (await mp.record(mail(3), { direction: 'in' })).record;
  assert.equal((await mp.describe(a.id)).records[0].content.gone, null, 'stored: nothing to explain');
  await mp.forget([a.id]);
  const fa = (await mp.describe(a.id)).records[0].content;
  assert.equal(fa.raw_stored, false);
  assert.equal(fa.gone.reason, 'forgotten');
  assert.match(fa.gone.at, /^2026-11-01T/);
  await mp.expireContent({ now: new Date('2030-01-01T00:00:00Z') });
  assert.equal((await mp.describe(b.id)).records[0].content.gone.reason, 'expired');
  assert.equal(goneText(fa.gone, NOW), 'forgotten 11-01 (mailproof forget)');
  assert.equal(goneText({ reason: 'expired', at: '2025-03-04T00:00:00Z' }, NOW), 'expired 2025-03-04 (retention)');
  assert.equal(goneText({ reason: 'never-stored', at: null }, NOW), 'never stored (content store off)');
  assert.equal(goneText(null, NOW), 'expired, forgotten or never stored');
  assert.ok(c);
  const off = new Mailproof({ trailDir: makeTmpDir('mp-gone-off-'), worker: { size: 0 }, content: { store: false }, otsBin: null });
  const r = (await off.record(mail(9), { direction: 'in' })).record;
  assert.deepEqual((await off.describe(r.id)).records[0].content.gone, { reason: 'never-stored', at: null });
  await mp.close(); await off.close();
  assert.ok(path.isAbsolute(dir));
});
