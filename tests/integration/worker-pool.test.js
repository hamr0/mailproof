// pool.js against a worker that misbehaves on purpose (tests/helpers/fault-worker.js), one way per test: each way a
// job can run away is reproduced here, on demand, and the pool must kill it, report why, and keep serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailproof } from '../../src/index.js';
import { makeTmpDir } from '../helpers/tmp.js';

const mod = await import('../../src/proof/pool.js').catch(() => null);
const FAULT = new URL('../helpers/fault-worker.js', import.meta.url);
const input = (source, extra = {}) => ({ ctx: { direction: 'in', source }, captured: extra.captured ?? '', hasEnvelope: false, trustedSealers: [] });
const buf = Buffer.from('From: a@b.example\r\n\r\nhi\r\n');

function pool(t, o = {}) {
  assert.ok(mod, 'src/proof/pool.js exists');
  const p = new mod.WorkerPool({ ...mod.workerConfig(o), workerUrl: FAULT });
  t.after(() => p.close());
  return p;
}
const ok = async (p) => { const r = await p.run(buf, input('ok'), undefined); assert.equal(r.out.record.id, 'ok'); return r; };

for (const kind of ['loop', 'regex']) {
  test(`pool: a CPU runaway (${kind}) is killed at the CPU budget and the pool serves the next job`, async (t) => {
    const p = pool(t, { cpuMs: 300 });
    await ok(p);
    const t0 = performance.now();
    assert.deepEqual(await p.run(buf, input(kind), undefined), { limit: 'time' });
    assert.ok(performance.now() - t0 < 10000);
    assert.equal(p.stats.killed, 1);
    await ok(p);
    assert.equal(p.stats.spawned, 2);
  });
}

test('pool: external memory (Buffers, invisible to the V8 heap limit) is killed by the watchdog before it grows far', async (t) => {
  const p = pool(t, { maxMemoryMb: 256, cpuMs: 60000 });
  const rss0 = process.memoryUsage.rss();
  let peak = rss0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 10);
  const r = await p.run(buf, input('alloc'), undefined);
  clearInterval(iv);
  assert.deepEqual(r, { limit: 'memory' });
  const mb = (n) => Math.round(n / 1048576);
  // the watchdog polls every 50 ms, so the worker overshoots the 256 MB budget by what it allocates in that time
  assert.ok(peak - rss0 < 1536 * 1048576, `RSS grew ${mb(peak - rss0)} MB before the kill`);
  await ok(p);
  await new Promise((r2) => setTimeout(r2, 500));
  assert.ok(process.memoryUsage.rss() - rss0 < 400 * 1048576, `RSS ${mb(process.memoryUsage.rss() - rss0)} MB above its start after the kill`);
});

test('pool: a JS heap blow-up is stopped as memory, too', async (t) => {
  const p = pool(t, { maxMemoryMb: 128, cpuMs: 60000 });
  assert.deepEqual(await p.run(buf, input('heap'), undefined), { limit: 'memory' });
  await ok(p);
});

test('pool: the wall budget is busy time: a lookup waiting on the caller is not counted, a sleep in the worker is', async (t) => {
  const p = pool(t, { wallMs: 1500, cpuMs: 60000 });   // generous for a loaded machine; the lookup waits longer than this
  const slow = async () => { await new Promise((r) => setTimeout(r, 2500)); return [['v=DKIM1']]; };
  const r = await p.run(buf, input('dns'), slow);
  assert.deepEqual(r.out.answer, [['v=DKIM1']]);
  assert.deepEqual(await p.run(buf, input('sleep', { captured: '8000' }), undefined), { limit: 'time' });
  await ok(p);
});

test('pool: a resolver error reaches the worker with its message and code', async (t) => {
  const p = pool(t);
  const r = await p.run(buf, input('dns'), async () => { throw Object.assign(new Error('boom'), { code: 'ESERVFAIL' }); });
  assert.deepEqual(r.out.error, { message: 'boom', code: 'ESERVFAIL' });
});

test('pool: the clock starts when a worker starts the job, never at enqueue', async (t) => {
  const p = pool(t, { size: 1, wallMs: 2000, cpuMs: 60000 });
  const t0 = performance.now();
  // 6 jobs of ~400 ms busy each through one worker: 2.4 s in all, twice the budget of one job
  const rs = await Promise.all(Array.from({ length: 6 }, () => p.run(buf, input('sleep', { captured: '400' }), undefined)));
  assert.ok(performance.now() - t0 > 2200);
  assert.ok(rs.every((r) => r.out?.record.id === 'ok'), JSON.stringify(rs.map((r) => r.limit)));
  assert.equal(p.stats.spawned, 1);
});

test('pool: with size N, N jobs run side by side and a killed one does not touch the others', async (t) => {
  const p = pool(t, { size: 2, cpuMs: 300, wallMs: 60000 });
  const [a, b] = await Promise.all([p.run(buf, input('loop'), undefined), p.run(buf, input('sleep', { captured: '600' }), undefined)]);
  assert.deepEqual(a, { limit: 'time' });
  assert.equal(b.out.record.id, 'ok');
});

test('pool: close() rejects what is still queued and ends the workers', async (t) => {
  const p = pool(t, { size: 1, wallMs: 60000 });
  const running = p.run(buf, input('sleep', { captured: '5000' }), undefined).then(() => null, (e) => e);
  const queued = p.run(buf, input('ok'), undefined).then(() => null, (e) => e);
  await new Promise((r) => setTimeout(r, 200));
  await p.close();
  assert.match((await queued)?.message, /closed/);
  assert.ok(await running, 'the running job was rejected, not left hanging');
  await assert.rejects(p.run(buf, input('ok'), undefined), /closed/);
});

for (const kind of ['exit', 'throw']) {
  test(`pool: a worker that dies unnamed (${kind}) is reported as a crash and the pool serves the next job`, async (t) => {
    const p = pool(t, { cpuMs: 60000, wallMs: 60000 });
    await ok(p);
    assert.deepEqual(await p.run(buf, input(kind), undefined).catch((e) => `rejected: ${e.message}`), { limit: 'crash' });
    assert.equal(p.stats.killed, 1);
    await ok(p);
    assert.equal(p.stats.spawned, 2);
  });
}

// A worker that cannot START is not a crash of a job: the call rejects and nothing is recorded (SPEC Part B, Limits).
const STARTFAIL = new URL('../helpers/start-fail-worker.js', import.meta.url);

test('pool: a worker that fails before it is ready rejects the call; it is not recorded as a crash', async (t) => {
  const p = new mod.WorkerPool({ ...mod.workerConfig({}), workerUrl: STARTFAIL });
  t.after(() => p.close());
  await assert.rejects(p.run(buf, input('ok'), undefined), /boom at startup/);
  assert.equal(p.stats.killed, 1, 'the dead worker is retired');
  await assert.rejects(p.run(buf, input('ok'), undefined), /boom at startup/, 'and the next call is tried afresh');
});

test('pool: a resolver answer that cannot be cloned to the worker never throws out of the handler: the worker gets a DNS error', async (t) => {
  const p = pool(t);
  const r = await p.run(buf, input('dns'), async () => [{ fn() {} }]);
  assert.deepEqual(r.out.error, { message: 'resolver returned a non-plain value', code: 'EBADRESP' });
  await ok(p);
});

test('pool: a worker that dies while idle is dropped, and the next job gets a fresh one (not "crash")', async () => {
  const p = new mod.WorkerPool(mod.workerConfig({ size: 1 }));
  try {
    const inp = input('idle');
    const raw = Buffer.from('From: a@b.example\r\nSubject: x\r\n\r\nhi\r\n');
    const nx = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };
    assert.ok('out' in await p.run(raw, inp, nx));
    assert.equal(p.idle.length, 1);
    await p.idle[0].terminate();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.idle.length, 0);
    assert.equal(p.all.size, 0);
    const r2 = await p.run(raw, inp, nx);
    assert.ok('out' in r2, JSON.stringify(r2));
    assert.equal(p.stats.spawned, 2);
  } finally { await p.close(); }
});

test('pool: a crash during a job is still "crash", and the dead worker is gone', async (t) => {
  const p = pool(t);
  await ok(p);
  assert.deepEqual(await p.run(buf, input('exit'), undefined), { limit: 'crash' });
  assert.equal(p.all.size, 0);
  assert.equal(p.idle.length, 0);
  await ok(p);
});

test('pool: input that cannot be cloned to the worker rejects that job with a clear error, and the pool serves the next one', async (t) => {
  const p = pool(t);
  await ok(p);
  const bad = input('ok');
  bad.ctx.envelope = { clientIp: () => 1 };
  await assert.rejects(() => p.run(buf, bad, undefined), /cannot be sent to the worker/);
  await ok(p);
  assert.equal(p.stats.spawned, 1, 'the worker was untouched and reused');
});

test('pool: a thread that cannot even be created rejects that job, and the pump goes on to the next one', async (t) => {
  const p = pool(t);
  const real = p._spawn.bind(p);
  let failNext = true;
  p._spawn = () => { if (failNext) { failNext = false; throw new Error('thread creation failed'); } return real(); };
  await assert.rejects(() => p.run(buf, input('ok'), undefined), /thread creation failed/);
  assert.equal(p.queue.length, 0, 'the failed job left the queue (it is not retried on the next pump)');
  await ok(p);
});

test('pool: a job whose start rejects settles with that error and retires its worker; the pool serves the next job', async (t) => {
  const p = pool(t);
  const real = p._start.bind(p);
  let failNext = true;
  p._start = async (w, job) => { if (failNext) { failNext = false; throw new Error('start failed'); } return real(w, job); };
  await assert.rejects(() => p.run(buf, input('ok'), undefined), /start failed/);
  assert.equal(p.stats.killed, 1);
  await ok(p);
});

test('envelope: a function in an envelope field is read as null, identically with a worker and in-process', async (t) => {
  const raw = Buffer.from('From: a@b.example\r\nSubject: env\r\n\r\nhi\r\n');
  const envelope = { clientIp: () => 1, clientHelo: () => 1, sender: () => 1 };
  const out = [];
  for (const size of [1, 0]) {
    const mp = new Mailproof({ trailDir: makeTmpDir('mp-env-'), worker: { size }, now: () => new Date('2026-01-01T00:00:00Z') });
    t.after(() => mp.close());
    const c = await mp.check(raw, { envelope });
    const r = await mp.record(raw, { direction: 'in', source: 'x', envelope });
    assert.equal(r.duplicate, false, `size ${size} records it`);
    assert.equal(c.live.spf, null, `size ${size}: no usable envelope, so no SPF`);
    out.push(JSON.stringify([c, r.id, r.record]));
  }
  assert.equal(out[0], out[1], 'same result with a worker and in-process');
});

test('envelope: an envelope that is not an object is read as no envelope, identically with a worker and in-process', async (t) => {
  const raw = Buffer.from('From: a@b.example\r\nSubject: env\r\n\r\nhi\r\n');
  const out = [];
  for (const size of [1, 0]) {
    const mp = new Mailproof({ trailDir: makeTmpDir('mp-env-'), worker: { size }, now: () => new Date('2026-01-01T00:00:00Z') });
    t.after(() => mp.close());
    const c = await mp.check(raw, { envelope: () => 1 });
    const r = await mp.record(raw, { direction: 'in', source: 'x', envelope: () => 1 });
    assert.equal(r.duplicate, false, `size ${size} records it`);
    out.push(JSON.stringify([c, r.id, r.record]));
  }
  assert.equal(out[0], out[1], 'same result with a worker and in-process');
});
