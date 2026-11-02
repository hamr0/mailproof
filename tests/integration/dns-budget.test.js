// One DNS budget per message (limits.js DNS_BUDGET_MS, resolver-guard.js). Each lookup was bounded by 5 s, but a message
// carries up to 10 outer + 10 x 10 inner signatures whose keys are fetched in turn, so against a nameserver that never
// answers one message cost minutes (DNS waits are not busy time) and wedged the single worker. The tests race every
// wait against a deadline, so a regression fails an assertion instead of hanging the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/index.js';
import { guardResolver } from '../../src/proof/resolver-guard.js';
import * as limits from '../../src/proof/limits.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const BUDGET = 30000;   // limits.DNS_BUDGET_MS, asserted below; a literal here so a missing export is a failed assertion
// 30 s of DNS plus the CPU of 110 signatures, twice at once, on a machine the rest of the suite may be loading: the margin is
// wide on purpose. Without the budget the same message costs ~555 s, so the deadline still separates the two by a factor of 9.
const SLACK = 30000;
const dir = () => makeTmpDir('mp-dnsb-');
const CRLF = '\r\n';
const sig = (d, i) => `DKIM-Signature: v=1; a=rsa-sha256; d=${d}${i}.example; s=sel${i}; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA`;
const inner = (k) => [...Array(10)].map((_, i) => sig('in' + k + 'x', i)).concat(['From: a@in.example', 'Subject: i', '']).join(CRLF) + CRLF + 'hi' + CRLF;

/** 10 outer + 10 x 10 inner signatures, every selector unique: 110 key lookups, none cached. */
function hangMessage() {
  const parts = [...Array(10)].map((_, k) => `--B${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}${inner(k)}`);
  const outer = [...Array(10)].map((_, i) => sig('out', i));
  return Buffer.from([...outer, 'From: a@o.example', 'To: b@x.example', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=B', '', ...parts, '--B--', ''].join(CRLF));
}
const ENV = { envelope: { mailFrom: 'a@o.example', clientIp: '1.2.3.4', helo: 'h.example' } };

/** Rejects (an assertion failure) when `p` has not settled by `ms`. */
const within = (p, ms, what) => {
  let timer;
  const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new assert.AssertionError({ message: `${what}: not done within ${ms} ms` })), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

test('dns budget: the constants', () => {
  assert.equal(limits.DNS_BUDGET_MS, BUDGET);
  assert.ok(limits.DNS_BUDGET_MS > limits.DNS_TIMEOUT_MS);
});

test('dns budget: a message of 110 signatures against a nameserver that never answers is done in about the budget, in a worker and in-process alike, and the queue behind it moves', async (t) => {
  const stuck = (name) => (/^sel\d+\._domainkey\./.test(name) || name.startsWith('_dmarc.') ? new Promise(() => {}) : Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
  const mk = (size) => {
    const mp = new Mailproof({ trailDir: dir(), resolver: stuck, worker: { size }, now: () => new Date('2026-01-01T00:00:00Z') });
    t.after(() => mp.close());
    return mp;
  };
  const raw = hangMessage();
  const t0 = performance.now();
  const run = async (mp) => {
    const first = mp.check(raw, ENV);
    const behind = mp.check(Buffer.from('From: a@b.example\r\nSubject: plain\r\n\r\nhi\r\n'));   // queued behind it in the size-1 pool
    const r = await first;
    await behind;
    return r;
  };
  const [w, p] = await within(Promise.all([run(mk(1)), run(mk(0))]), BUDGET + SLACK, 'two hung messages');
  assert.ok(performance.now() - t0 < BUDGET + SLACK);
  assert.equal(JSON.stringify(w), JSON.stringify(p), 'identical in a worker and in-process');
  assert.ok(w.key_errors.length > 0 && w.key_errors.every((e) => e === 'dns timeout'), JSON.stringify(w.key_errors));
});

test('dns budget: a normal message whose resolver answers slowly (1 s a lookup) still verifies, in a worker and in-process', async (t) => {
  const { raw, resolver } = await signedMail({ from: 'a@signer.example' });
  const slow = async (n, ty) => { await new Promise((r) => setTimeout(r, 1000)); return resolver(n, ty); };
  for (const size of [1, 0]) {
    const mp = new Mailproof({ trailDir: dir(), resolver: slow, worker: { size } });
    t.after(() => mp.close());
    const r = await within(mp.check(raw), 20000, `slow resolver, size ${size}`);
    const fast = await new Mailproof({ trailDir: dir(), resolver, worker: { size: 0 } }).check(raw);
    assert.equal(JSON.stringify(r.live), JSON.stringify(fast.live), 'same verdict as with an instant resolver');
    assert.deepEqual(r.key_errors, [], `size ${size}`);
    assert.ok(r.signatures >= 1);
  }
});

test('dns budget: the guard counts wall time with a lookup in flight, not the sum of waits', async () => {
  // 50 parallel lookups that never answer: 50 x 200 ms summed would be 10 s, but the wall time is 200 ms, so the 400 ms budget survives it
  const g = guardResolver(() => new Promise(() => {}), 200, 400);
  await Promise.all([...Array(50)].map(() => assert.rejects(g('a'), { message: 'dns timeout', code: 'ETIMEOUT' })));
  const ok = guardResolver(async () => 'x', 200, 400);
  assert.equal(await ok('a'), 'x');
  // sequential lookups spend the budget; the next one fails at once, not after the per-lookup timeout
  const seq = guardResolver(() => new Promise(() => {}), 200, 400);
  await assert.rejects(seq('a'), /dns timeout/);
  await assert.rejects(seq('b'), /dns timeout/);
  const t0 = performance.now();
  await assert.rejects(seq('c'), { message: 'dns timeout', code: 'ETIMEOUT' });
  assert.ok(performance.now() - t0 < 100, 'spent budget fails at once');
});

test('dns budget: time between lookups (CPU, a slow neighbour) is not charged', async () => {
  const g = guardResolver(async () => 'x', 200, 300);
  for (let i = 0; i < 4; i++) { assert.equal(await g('a'), 'x'); await new Promise((r) => setTimeout(r, 120)); }
});

test('dns budget: a lookup is bounded by the budget that is left, when that is less than the per-lookup timeout', async () => {
  const g = guardResolver(() => new Promise(() => {}), 1000, 250);
  const t0 = performance.now();
  await assert.rejects(g('a'), /dns timeout/);
  const dt = performance.now() - t0;
  assert.ok(dt >= 200 && dt < 900, `took ${dt} ms`);
});
