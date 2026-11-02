import test from 'node:test';
import assert from 'node:assert/strict';
import { guardResolver } from '../../src/proof/resolver-guard.js';
import { DNS_TIMEOUT_MS } from '../../src/proof/limits.js';

test('resolver-guard: an answer inside the bound passes through, and so does a rejection', async () => {
  const r = guardResolver(async (n) => [[n]], 200);
  assert.deepEqual(await r('a.example'), [['a.example']]);
  const bad = guardResolver(async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }, 200);
  await assert.rejects(bad('a'), { code: 'ENOTFOUND' });
  const sync = guardResolver(() => { throw new Error('sync'); }, 200);
  await assert.rejects(sync('a'), /sync/);
});

test('resolver-guard: a lookup that never settles is answered as ETIMEOUT "dns timeout"', async () => {
  const hang = guardResolver(() => new Promise(() => {}), 50);
  await assert.rejects(hang('a'), { message: 'dns timeout', code: 'ETIMEOUT' });
});

test('resolver-guard: the default bound is the one limit, 5 s', () => {
  assert.equal(DNS_TIMEOUT_MS, 5000);
});

test('resolver-guard: an answer structured clone refuses is the error EBADRESP; plain data of every kind passes', async () => {
  class Priv { #p = 1; }
  for (const bad of [[{ fn() {} }], () => {}, Symbol('s'), { s: Symbol() }, new WeakMap()]) {
    await assert.rejects(guardResolver(async () => bad, 200)('a'), { message: 'resolver returned a non-plain value', code: 'EBADRESP' });
  }
  for (const good of [[['v=DKIM1; p=abc']], [], null, undefined, 'x', [{ exchange: 'mx', priority: 1 }], new Priv(), Buffer.from('x')]) {
    assert.deepEqual(await guardResolver(async () => good, 200)('a'), good);
  }
});

test('resolver-guard: refuses exactly what a worker postMessage refuses', async () => {
  const { Worker } = await import('node:worker_threads');
  const w = new Worker('setInterval(() => {}, 1000)', { eval: true });
  try {
    class C { #p = 1; }
    const vals = [() => {}, [{ f() {} }], Symbol('s'), { s: Symbol() }, new C(), new Date(), new Map(), /x/, new Error('e'), 1n, new Uint8Array(2), undefined, null, 'x', [['a']],
      new WeakMap(), new Proxy({}, {}), { get a() { throw new Error('g'); } }, Object.assign([1], { f() {} }), Object(Symbol())];
    for (const v of vals) {
      let clones = true; let posts = true;
      try { structuredClone(v); } catch { clones = false; }
      try { w.postMessage({ value: v }); } catch { posts = false; }
      const guarded = await guardResolver(async () => v, 200)('a').then(() => true, (e) => { assert.equal(e.code, 'EBADRESP'); return false; });
      assert.equal(guarded, posts, vals.indexOf(v) + " " + typeof v);
      assert.equal(clones, posts, vals.indexOf(v) + " " + typeof v);
    }
  } finally { await w.terminate(); }
});
