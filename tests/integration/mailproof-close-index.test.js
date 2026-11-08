// close() and the trail index: nothing stays open after close(), even when a list() is still in flight
// (close() waits for it; the list resolves normally).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

/** Paths of this process's open file descriptors that live under `dir` (Linux only). */
const openUnder = (dir) => fs.readdirSync('/proc/self/fd').flatMap((fd) => {
  try { const l = fs.readlinkSync(`/proc/self/fd/${fd}`); return l.startsWith(dir) ? [l] : []; } catch { return []; }
});

const linuxOnly = { skip: process.platform !== 'linux' };

/** A trail with one recorded mail, and a factory for fresh instances on it. */
async function setup() {
  const dir = makeTmpDir('mp-close-ix-');
  const a = await signedMail({ signTime: new Date('2026-11-01T10:00:00Z'), subject: 'A', body: 'Hi\r\n', domain: 'a.example' });
  const mk = () => new Mailproof({ trailDir: dir, resolver: stubResolver(a.map), worker: { size: 0 }, now: () => new Date('2026-11-01T10:05:00Z') });
  const w = mk();
  await w.record(a.raw, { direction: 'in', source: 'test' });
  await w.close();
  return { dir, mk };
}

test('nothing is open before list; a plain list() then close() leaves nothing open', linuxOnly, async () => {
  const { dir, mk } = await setup();
  assert.deepEqual(openUnder(dir), [], 'nothing open before the list');
  const mp = mk();
  assert.equal((await mp.list()).length, 1);
  assert.notDeepEqual(openUnder(dir), [], 'the index is open while the instance is');
  await mp.close();
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir after close()');
});

test('close() while a list() is in flight leaves no open index handle, and the list resolves', linuxOnly, async () => {
  const { dir, mk } = await setup();
  const mp = mk();
  await mp.list();                // the index now exists
  const inFlight = mp.list();
  await mp.close();               // while the second list() runs
  assert.equal((await inFlight).length, 1);
  await mp.close();               // and once more
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir after close()');
});

test('close() during the very first list() (index not yet opened) leaves nothing open', linuxOnly, async () => {
  const { dir, mk } = await setup();
  const mp = mk();
  const inFlight = mp.list();
  await mp.close();
  assert.equal((await inFlight).length, 1);
  assert.deepEqual(openUnder(dir), []);
  assert.equal((await mp.list()).length, 1, 'a call after close() starts fresh');
  await mp.close();
  assert.deepEqual(openUnder(dir), []);
});
