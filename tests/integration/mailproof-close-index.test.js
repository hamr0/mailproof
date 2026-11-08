// Ledger finding on `_ix` (mailproof.js): a list() still in flight when close() runs leaves an open SQLite handle that
// no later close() reaches. Reproduced; the fix changes behaviour (close() would also close an index opened mid-flight),
// so it is marked `todo` until that change is specified. When fixed, drop the `todo`.
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

test('close() while a list() is in flight leaves no open index handle', { skip: process.platform !== 'linux', todo: 'ledger: needs a close() behaviour change' }, async () => {
  const dir = makeTmpDir('mp-close-ix-');
  const a = await signedMail({ signTime: new Date('2026-11-01T10:00:00Z'), subject: 'A', body: 'Hi\r\n', domain: 'a.example' });
  const mk = () => new Mailproof({ trailDir: dir, resolver: stubResolver(a.map), worker: { size: 0 }, now: () => new Date('2026-11-01T10:05:00Z') });
  const w = mk();
  await w.record(a.raw, { direction: 'in', source: 'test' });
  await w.close();
  assert.deepEqual(openUnder(dir), [], 'control: nothing open before the list');
  const mp = mk();
  await mp.list();                // the index now exists
  const inFlight = mp.list();
  await mp.close();               // while the second list() runs
  await inFlight;
  await mp.close();               // and once more, to show a later close() does not reach it
  assert.deepEqual(openUnder(dir), [], 'no fd under the trail dir after close()');
});
