// close() and the trail index: list()/copies() open the index, answer and close it inside one call, so nothing is
// open between calls and close() has nothing of the index to wait for, release or race with.
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
  const { id } = await w.record(a.raw, { direction: 'in', source: 'test' });
  await w.close();
  return { dir, mk, id };
}

test('nothing is open before list, and nothing is open after a list(), even before close()', linuxOnly, async () => {
  const { dir, mk } = await setup();
  assert.deepEqual(openUnder(dir), [], 'nothing open before the list');
  const mp = mk();
  assert.equal((await mp.list()).length, 1);
  assert.deepEqual(openUnder(dir), [], 'the index is closed when list() returns');
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

test('close() while a copies() is in flight leaves nothing open, and the copies resolves', linuxOnly, async () => {
  const { dir, mk, id } = await setup();
  const mp = mk();
  const inFlight = mp.copies(id);
  await mp.close();
  assert.equal((await inFlight).copies.length, 1);
  assert.equal((await mp.copies(id)).copies.length, 1, 'a call after close() works');
  await mp.close();
  assert.deepEqual(openUnder(dir), []);
});

test('close() resolves promptly under repeated concurrent list() loops, and no index fd remains once they stop', linuxOnly, async () => {
  const { dir, mk } = await setup();
  const mp = mk();
  let stop = false;
  const loop = async () => { while (!stop) await mp.list(); };
  const loops = [loop(), loop(), loop()];
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await mp.close();
  const took = Date.now() - t0;
  assert.ok(took < 1000, `close() took ${took} ms under list() load`);
  await new Promise((r) => setTimeout(r, 50));   // lists keep starting after close(): they must not leak either
  stop = true;
  await Promise.all(loops);
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir once the loops stop');
  await mp.close();
});

test('lists started at every point while close() runs leave no index file open', linuxOnly, async () => {
  const { dir, mk } = await setup();
  const mp = mk();
  await mp.list();
  const lists = [mp.list()];
  const closing = mp.close();
  for (let i = 0; i < 40; i++) {   // staggered over the whole of close(), including its last steps
    lists.push(new Promise((r) => (i % 2 ? setImmediate : setTimeout)(r, i % 7)).then(() => mp.list()));
  }
  await Promise.all([closing, ...lists]);
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir');
  await mp.close();
});

test('a list() started the instant the in-flight list() settles, while close() is draining, leaves no index file open', linuxOnly, async () => {
  const { dir, mk } = await setup();
  const mp = mk();
  await mp.list();
  const late = [];
  const first = mp.list().then((r) => { late.push(mp.list()); return r; });
  const closing = mp.close();
  await Promise.all([first, closing]);
  await Promise.all(late);
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir');
  await mp.close();
});
