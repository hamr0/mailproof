// The deadline backstop (src/proof/pool.js, worker.js, build.js): check()/record() build in a warm worker thread that is
// killed over a CPU, busy-wall or memory budget, and the message is recorded `over limit: time` / `over limit: memory`.
// The CPU budget is calibrated at load (tests/helpers/cpu-budget.js) between an ordinary message's cold first job and the
// SLOW worst case, because SLOW costs ~0.6 s of CPU on a fast CI runner and seconds on a slow box: no fixed number
// separates them everywhere. No test asserts a raw time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Mailproof } from '../../src/index.js';
import { signedMail } from '../helpers/proof.js';
import { WORST_CASES } from '../helpers/worst-cases.js';
import { WorkerPool, workerConfig } from '../../src/proof/pool.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { SLOW as SLOW_NAME, SLOW_CPU_MS, SLOW_COST_MS } from '../helpers/cpu-budget.js';   // SLOW_CPU_MS: calibrated on this machine (geometric mean of an ordinary cold job and SLOW), not a constant

const dir = () => makeTmpDir('mp-wk-');
const nxdomain = async () => { throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); };
const git = (mp, ...a) => execFileSync('git', ['-C', mp.root, ...a], { encoding: 'utf8' }).trim();
const workers = () => process.report.getReport().workers.length;
const heavy = (name) => WORST_CASES.find((c) => c.name === name);
/** 10 valid signatures over 500,000 lines: the most the gate admits, so it cannot be made heavier. It dies only to the backstop. */
const SLOW = SLOW_NAME;
const BIG = 'ordinary 24 MiB message with a base64 attachment';

/** A Mailproof that is closed when the test ends. */
function make(t, opts = {}) {
  const mp = new Mailproof({ trailDir: dir(), resolver: nxdomain, ...opts });
  assert.equal(typeof mp.close, 'function', 'Mailproof#close exists');
  t.after(() => mp.close());
  return mp;
}

test('worker: a message past the CPU budget is recorded once as "over limit: time", unverified, with nothing left behind', async (t) => {
  const mp = make(t, { worker: { cpuMs: SLOW_CPU_MS } });
  const { raw, resolver } = await heavy(SLOW).build();
  mp.resolver = resolver;
  const r = await mp.record(raw, { direction: 'in', source: 'slow' });
  assert.equal(r.duplicate, false);
  const rec = await mp.get(r.id);
  assert.equal(rec.verdicts.live.reason, 'over limit: time');
  assert.equal(rec.verdicts.portable.reason, 'over limit: time');
  assert.equal(rec.verdicts.live.trust, 'unverified');
  assert.equal(rec.verdicts.portable.trust, 'unverified');
  assert.deepEqual(rec.signatures, []);
  assert.equal(rec.message.size, raw.length);
  assert.equal(rec.body_status, 'not-checked');
  assert.equal((await mp.list()).length, 1);
  assert.equal(git(mp, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('record ')).length, 1, 'one record commit');
  assert.equal(git(mp, 'status', '--porcelain'), '');
  assert.equal(git(mp, 'fsck', '--no-progress'), '');
  assert.deepEqual(fs.readdirSync(path.dirname(mp.root)).filter((f) => f.includes('lock')), []);
  // the pool recovers: the next message goes through a fresh worker and verifies
  const good = await signedMail({ body: 'hello\r\n' });
  mp.resolver = good.resolver;
  const ok = await mp.record(good.raw, { direction: 'in', source: 'after' });
  assert.equal((await mp.get(ok.id)).verdicts.portable.trust, 'verified');
  assert.equal((await mp.verify(ok.id)).ok, true);
  assert.equal(git(mp, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('record ')).length, 2);
});

test('worker: check() reports a timed-out message like any over-limit one', async (t) => {
  const mp = make(t, { worker: { cpuMs: SLOW_CPU_MS } });
  const { raw, resolver } = await heavy(SLOW).build();
  mp.resolver = resolver;
  const c = await mp.check(raw);
  assert.equal(c.portable.reason, 'over limit: time');
  assert.equal(c.live.reason, 'over limit: time');
  assert.equal(c.portable.trust, 'unverified');
  assert.equal(c.signatures, 0);
  assert.equal(c.unsigned, false);
  assert.equal(c.body_status, 'not-checked');
});

test('worker: a worker that dies unnamed still records the message once as "over limit: crash"; check() agrees; the next message verifies', async (t) => {
  // tests/helpers/fault-worker.js ends its thread (`exit`) or throws outside the build (`throw`), as the message's X-Fault header says
  const FAULT = new URL('../helpers/fault-worker.js', import.meta.url);
  const good = await signedMail({ body: 'hello\r\n' });
  for (const how of ['exit', 'throw']) {
    const mp = make(t, { resolver: good.resolver });
    const pool = new WorkerPool({ ...workerConfig({}), workerUrl: FAULT });
    mp._lease = { run: (...a) => pool.run(...a), release: () => pool.close() };   // the same seam leasePool fills
    const raw = Buffer.from(`X-Fault: ${how}\r\nFrom: a@example.com\r\nMessage-ID: <${how}@example.com>\r\n\r\nkills its worker\r\n`);
    const c = await mp.check(raw).catch((e) => ({ portable: { reason: `rejected: ${e.message}` }, live: {} }));
    assert.equal(c.portable.reason, 'over limit: crash', how);
    assert.equal(c.live.reason, 'over limit: crash', how);
    assert.equal(c.portable.trust, 'unverified');
    const r = await mp.record(raw, { direction: 'in', source: how }).catch((e) => ({ rejected: e.message }));
    assert.equal(r.rejected, undefined, how);
    assert.equal(r.duplicate, false);
    const rec = await mp.get(r.id);
    assert.equal(rec.verdicts.live.reason, 'over limit: crash', how);
    assert.equal(rec.verdicts.portable.reason, 'over limit: crash', how);
    assert.equal(rec.verdicts.portable.trust, 'unverified');
    assert.deepEqual(rec.signatures, []);
    assert.equal((await mp.list()).length, 1);
    assert.equal(git(mp, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('record ')).length, 1, 'one record commit');
    assert.equal(git(mp, 'status', '--porcelain'), '');
    assert.deepEqual(fs.readdirSync(path.dirname(mp.root)).filter((f) => f.includes('lock')), []);
    assert.equal(pool.stats.killed, 2, 'the check and the record each lost a worker');
    // the real pool takes over (the pool's own recovery is tested in worker-pool.test.js): the next message verifies
    await mp.close();
    const ok = await mp.record(good.raw, { direction: 'in', source: 'ok' });
    assert.equal((await mp.get(ok.id)).verdicts.portable.trust, 'verified', how);
    assert.equal(git(mp, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('record ')).length, 2);
  }
});

test('worker: the memory watchdog stops a message that needs more memory than the budget', async (t) => {
  const mp = make(t, { worker: { maxMemoryMb: 64 } });
  const { raw, resolver } = await heavy(BIG).build();
  mp.resolver = resolver;
  const r = await mp.record(raw, { direction: 'in', source: 'big' });
  const rec = await mp.get(r.id);
  assert.equal(rec.verdicts.portable.reason, 'over limit: memory');
  assert.equal(rec.verdicts.live.reason, 'over limit: memory');
  assert.equal(rec.verdicts.live.trust, 'unverified');
  assert.equal(git(mp, 'status', '--porcelain'), '');
  const good = await signedMail({ body: 'hello\r\n' });
  mp.resolver = good.resolver;
  assert.equal((await mp.check(good.raw)).portable.trust, 'verified');
});

test('worker: wall time counts busy time only; a slow DNS answer does not spend it', async (t) => {
  const good = await signedMail({ body: 'hello\r\n' });
  let lookups = 0;
  let sleepMs = 0;
  let slowDns = false;
  const SLEEP = 1500;
  const resolver = async (n, ty) => {
    if (slowDns) { lookups++; sleepMs += SLEEP; await new Promise((r) => setTimeout(r, SLEEP)); }
    return good.resolver(n, ty);
  };
  // The budget is far above what the (tiny) job needs even on a loaded machine, and far below the DNS waiting.
  const mp = make(t, { worker: { wallMs: 2500 }, resolver });
  // Start the worker first (its module load is slow under load and is not what is measured), with fast DNS.
  assert.equal((await mp.check(Buffer.concat([Buffer.from('X-Warm: 1\r\n'), good.raw]))).portable.trust, 'verified');
  slowDns = true;
  const t0 = performance.now();
  const c = await mp.check(good.raw);
  assert.ok(lookups > 0, 'DNS went through the caller\'s resolver');
  assert.ok(sleepMs > 2500, `the DNS waits (${sleepMs} ms) alone exceed the wall budget, so counting them would kill the job`);
  assert.ok(performance.now() - t0 > 2500, 'the lookups really were slow');
  assert.equal(c.portable.trust, 'verified');
  assert.equal(c.portable.reason, undefined);
  // the same kind of budget does stop a message that is BUSY for longer than it (it needs seconds of CPU)
  const busy = make(t, { worker: { wallMs: Math.round(SLOW_COST_MS / 4), cpuMs: 1e9 } });
  const { raw, resolver: heavyResolver } = await heavy(SLOW).build();
  busy.resolver = heavyResolver;
  assert.equal((await busy.check(raw)).portable.reason, 'over limit: time');
});

test('worker: DNS errors cross the thread with their code, so the verdicts equal the in-process ones', async (t) => {
  const good = await signedMail({ body: 'hello\r\n' });
  const errs = {};
  for (const code of ['ENOTFOUND', 'ETIMEOUT']) {
    const resolver = async () => { throw Object.assign(new Error('dns ' + code), { code }); };
    const inproc = new Mailproof({ trailDir: dir(), resolver, worker: { size: 0 } });
    const wk = make(t, { resolver });
    const [a, b] = [await inproc.check(good.raw), await wk.check(good.raw)];
    assert.deepEqual(b, a, code);
    assert.ok(workers() >= 1);
    errs[code] = JSON.stringify(b.live);
  }
  assert.notEqual(errs.ENOTFOUND, errs.ETIMEOUT, 'the error code reaches mailauth (else this test could not tell)');
  assert.match(errs.ETIMEOUT, /temperror/, 'a timeout is a temp error, not "no record"');
});

test('worker: size 0 builds in-process, with no worker thread', async (t) => {
  const before = workers();
  const good = await signedMail({ body: 'hello\r\n' });
  const mp = make(t, { worker: { size: 0 }, resolver: good.resolver });
  assert.equal((await mp.check(good.raw)).portable.trust, 'verified');
  assert.equal(workers(), before);
  const wk = make(t, { worker: { size: 1 }, resolver: good.resolver });
  await wk.check(good.raw);
  assert.equal(workers(), before + 1, 'the default builds in a worker');
  await wk.close();
  assert.equal(workers(), before);
});

test('worker: close() ends the workers once the last instance sharing them closes, and a later call starts a new one', async (t) => {
  const before = workers();
  const good = await signedMail({ body: 'hello\r\n' });
  const a = make(t, { resolver: good.resolver, worker: { cpuMs: 14001 } });
  const b = make(t, { resolver: good.resolver, worker: { cpuMs: 14001 } });
  await a.check(good.raw); await b.check(good.raw);
  assert.equal(workers(), before + 1, 'two instances, one shared worker');
  await a.close();
  assert.equal((await b.check(good.raw)).portable.trust, 'verified', 'the other instance is unaffected');
  assert.equal(workers(), before + 1);
  await b.close();
  assert.equal(workers(), before);
  assert.equal((await a.check(good.raw)).portable.trust, 'verified');
  assert.equal(workers(), before + 1);
  await a.close(); await a.close();
  assert.equal(workers(), before);
});

test('worker: options are validated at construction', () => {
  for (const bad of [{ size: -1 }, { size: 1.5 }, { cpuMs: 0 }, { wallMs: NaN }, { maxMemoryMb: -5 }, { sise: 1 }, 'x']) {
    assert.throws(() => new Mailproof({ trailDir: dir(), worker: bad }), /worker/, JSON.stringify(bad));
  }
});

test('worker: a program that never calls close() exits on its own, after a timed-out and a normal message', () => {
  const script = `
    import { Mailproof } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
    import { signedMail } from ${JSON.stringify(new URL('../helpers/proof.js', import.meta.url).href)};
    import { WORST_CASES } from ${JSON.stringify(new URL('../helpers/worst-cases.js', import.meta.url).href)};
    const good = await signedMail({ body: 'hi\\r\\n' });
    const mp = new Mailproof({ trailDir: ${JSON.stringify(dir())}, resolver: good.resolver, worker: { cpuMs: ${SLOW_CPU_MS} } });
    const slow = await WORST_CASES.find((c) => c.name === ${JSON.stringify(SLOW)}).build();
    mp.resolver = slow.resolver;
    const b = await mp.check(slow.raw);   // the worker is killed ...
    mp.resolver = good.resolver;
    const a = await mp.check(good.raw);   // ... a new one serves this, and is left idle and open
    console.log(JSON.stringify([a.portable.trust, b.portable.reason, process.report.getReport().workers.length]));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${r.stderr} (null: it did not exit by itself within 60 s)`);
  assert.equal(r.stdout.trim(), JSON.stringify(['verified', 'over limit: time', 1]));
});

test('worker: queueing is not time spent: messages waiting behind a slow job are not timed out', async (t) => {
  const good = await signedMail({ body: 'hello\r\n' });
  let first = true;
  // the first job waits 3.5 s for DNS, longer than the 2.5 s busy budget; the four behind it wait in the queue that long
  const resolver = async (n, ty) => { if (first) { first = false; await new Promise((r) => setTimeout(r, 3500)); } return good.resolver(n, ty); };
  const mp = make(t, { resolver, worker: { size: 1, wallMs: 2500 } });
  const before = workers();
  const t0 = performance.now();
  const all = await Promise.all(Array.from({ length: 5 }, (_, i) => mp.check(Buffer.concat([Buffer.from(`X-N: ${i}\r\n`), good.raw]))));
  assert.ok(performance.now() - t0 > 3400);
  assert.deepEqual(all.map((c) => c.portable.reason), Array(5).fill(undefined));
  assert.equal(workers(), before + 1, 'one worker served all five');
});

test('worker: check() and record() give the same JSON in a worker as in-process', async (t) => {
  const key = (await signedMail({})).signers;
  const mails = [
    await signedMail({ body: 'plain\r\n' }),
    await signedMail({ body: 'two signers\r\n', signers: [{ domain: 'a.example', selector: 's1', alg: 'rsa' }, { domain: 'b.example', selector: 's2', alg: 'ed25519' }] }),
    await signedMail({ body: 'with file\r\n', attachment: { filename: 'a.bin', bytes: Buffer.from('some attached bytes') } }),
    await signedMail({ body: 'canon simple\r\n', canon: 'simple/simple', bodyLength: 4 }),
  ];
  mails.push({ ...mails[0], raw: Buffer.concat([mails[0].raw, Buffer.from('tampered after signing\r\n')]) });
  mails.push({ raw: Buffer.from('From: nobody@example.com\r\nSubject: unsigned\r\nMessage-ID: <u@example.com>\r\n\r\nno signature\r\n'), resolver: nxdomain });
  const inner = await signedMail({ body: 'inner\r\n' });
  const fwd = await signedMail({ subject: 'Fwd: x', body: 'see attached\r\n', attachment: { filename: 'o.eml', bytes: inner.raw } });
  mails.push({ raw: fwd.raw, resolver: async (n, ty) => { try { return await fwd.resolver(n, ty); } catch { return inner.resolver(n, ty); } } });
  assert.ok(key.length);
  const now = () => new Date('2026-11-02T00:00:00Z');
  const env = { clientIp: '203.0.113.9', sender: 'a@example.com' };
  const strip = (v) => JSON.stringify(v, (k, x) => (k === 'commit' ? undefined : x));
  const keysOf = (root) => { const o = {}; const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else o[path.relative(root, p)] = fs.readFileSync(p, 'utf8').replace(/"first_fetched": ?"[^"]*"/, ''); }); return o; };
  let n = 0;
  for (const m of mails) {
    const a = new Mailproof({ trailDir: dir(), resolver: m.resolver, now, worker: { size: 0 } });
    const b = make(t, { resolver: m.resolver, now });
    assert.equal(strip(await b.check(m.raw)), strip(await a.check(m.raw)), `check ${n}`);
    assert.equal(strip(await b.check(m.raw, { envelope: env })), strip(await a.check(m.raw, { envelope: env })), `check+envelope ${n}`);
    const [ra, rb] = [await a.record(m.raw, { direction: 'in', source: 'eq', envelope: env }), await b.record(m.raw, { direction: 'in', source: 'eq', envelope: env })];
    assert.equal(strip(rb), strip(ra), `record ${n}`);
    assert.equal(strip(await b.get(rb.id)), strip(await a.get(ra.id)), `stored record ${n}`);
    assert.deepEqual(keysOf(b.root), keysOf(a.root), `key archive ${n}`);
    n++;
  }
  assert.ok(workers() >= 1, 'the worker path was the one exercised');
});

test('worker: the published files include the worker, and engines carries the Node floor Worker#cpuUsage needs', () => {
  const src = fileURLToPath(new URL('../..', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  assert.ok(pkg.files.some((f) => f === 'src/proof/' || f === 'src/proof/worker.js'), 'src/proof/worker.js is published');
  assert.ok(fs.existsSync(path.join(src, 'src/proof/worker.js')));
  assert.match(pkg.engines.node, /22\.19/);
});

test('worker: a worker that cannot start rejects check() and record(); nothing is recorded and no lock is left', async (t) => {
  const mp = make(t, { worker: { size: 1 } });
  const failing = new WorkerPool({ ...workerConfig({}), workerUrl: new URL('../helpers/start-fail-worker.js', import.meta.url) });
  t.after(() => failing.close());
  mp._lease = { run: (...a) => failing.run(...a), release: async () => {} };   // the private seam: Mailproof cannot name a worker file
  const good = await signedMail({ body: 'hello\r\n' });
  await assert.rejects(mp.check(good.raw), /boom at startup/);
  await assert.rejects(mp.record(good.raw, { direction: 'in', source: 'x' }), /boom at startup/);
  assert.deepEqual(await mp.list(), [], 'no record');
  assert.deepEqual(fs.existsSync(path.dirname(mp.root)) ? fs.readdirSync(path.dirname(mp.root)).filter((f) => f.includes('lock')) : [], []);
});

test('worker: a lookup that never answers is a DNS error after DNS_TIMEOUT_MS, in the worker and in-process alike, and the next job is not blocked', { timeout: 120_000 }, async (t) => {
  const good = await signedMail({ body: 'hello\r\n' });
  // only the signing key's lookups hang; every other name is absent
  const hang = (name) => (name.includes('_domainkey') ? new Promise(() => {}) : nxdomain());
  const deadline = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('STILL PENDING after 60 s'), 60_000))]);
  const inproc = new Mailproof({ trailDir: dir(), resolver: hang, worker: { size: 0 } });
  const wk = make(t, { resolver: hang });
  const other = make(t, { resolver: good.resolver });   // same config, so the same single worker: its job queues behind wk's
  const [a, b, c] = await Promise.all([deadline(inproc.check(good.raw)), deadline(wk.check(good.raw)), deadline(other.check(good.raw))]);
  assert.equal(typeof a, 'object', String(a));
  assert.equal(typeof b, 'object', String(b));
  assert.deepEqual(b, a, 'both modes answer the same');
  assert.equal(a.portable.trust, 'unverified');
  assert.deepEqual(a.key_errors, ['dns timeout']);
  assert.equal(a.live.dkim[0].result, 'temperror', 'a timeout is a temp error, like an unreachable key');
  assert.equal(typeof c, 'object', String(c));
  assert.equal(c.portable.trust, 'verified', 'the job queued behind the hung lookup ran');
});

test('worker: a resolver answer that is not plain data is a DNS error: no crash, the same JSON in a worker and in-process, the record saved unverified', { timeout: 60_000 }, async (t) => {
  // run in a child: on a build that throws out of the postMessage handler, the process dies, and that must fail an assertion, not the runner
  const script = `
    import { Mailproof } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
    import { signedMail } from ${JSON.stringify(new URL('../helpers/proof.js', import.meta.url).href)};
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const good = await signedMail({ body: 'hello\\r\\n' });
    const resolver = async () => [{ fn() {} }];
    const out = {};
    for (const size of [0, 1]) {
      const mp = new Mailproof({ trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bad-')), resolver, worker: { size }, now: () => new Date('2026-01-01T00:00:00Z') });
      const c = await mp.check(good.raw);
      const r = await mp.record(good.raw, { direction: 'in', source: 'x' });
      const rec = await mp.get(r.id);
      out[size] = { c, rec: { ...rec, trail: undefined }, dup: r.duplicate };
      await mp.close();
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 50_000, env: { ...process.env, TMPDIR: makeTmpDir('mp-badsub-') } });   // the child's own trail dirs live under a dir this process removes
  assert.equal(r.status, 0, `the process survived: ${r.stderr.slice(0, 300)}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out[1].c, out[0].c, 'check(): same in both modes');
  assert.deepEqual(out[1].rec, out[0].rec, 'the record: same in both modes');
  assert.equal(out[1].dup, false);
  assert.equal(out[1].c.portable.trust, 'unverified');
  assert.deepEqual(out[1].c.key_errors, ['resolver returned a non-plain value']);
  assert.equal(out[1].c.live.dkim[0].result, 'temperror');
  assert.equal(out[1].rec.verdicts.portable.trust, 'unverified');
});

test('worker: an envelope with extra, non-cloneable caller fields neither crashes the process nor hangs, and both modes agree', () => {
  // A subprocess: on a regression the whole process dies (unhandled rejection) or hangs, and the parent asserts on it.
  const script = `
    import { Mailproof } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
    import { signedMail } from ${JSON.stringify(new URL('../helpers/proof.js', import.meta.url).href)};
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const good = await signedMail({});
    const resolver = good.resolver;
    const out = {};
    for (const size of [1, 0]) {
      const mp = new Mailproof({ trailDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-env-')), resolver, worker: { size }, now: () => new Date('2026-01-01T00:00:00Z') });
      out[size] = await mp.check(good.raw, { envelope: { clientIp: '1.2.3.4', extra: () => 1 } });
      await mp.close();
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const tmp = makeTmpDir('mp-envsub-');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 50_000, env: { ...process.env, TMPDIR: tmp } });
  assert.equal(r.status, 0, `the process survived and finished: status ${r.status} signal ${r.signal} ${r.stderr.slice(0, 300)}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out[1], out[0], 'check(): same in both modes');
});
