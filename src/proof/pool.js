// The deadline backstop. The admission gate (admit.js) bounds the dimensions we have measured; this bounds
// the rest. buildRecord() (build.js: gate, splitMessage, mailparser, mailauth, signatures, summariseBody) runs
// in a warm worker thread, and the main thread kills the worker when a job spends too much CPU, too much
// busy wall time or too much memory. A killed job is recorded through the over-limit path (`over limit: time`
// / `over limit: memory`, unverified): the main thread commits, so a killed worker leaves no partial state.
// A worker that dies for a reason the pool cannot name (exits, or throws outside the build) is recorded the same
// way as `over limit: crash`: every message is recorded, even one that deterministically crashes its worker.
// An Error thrown by the build itself is not a crash: it rejects, exactly as it would in-process.
//
// CPU time, not wall time: the worker thread's own CPU (Worker#cpuUsage) does not stretch when the machine
// is busy, so a legitimate message is never killed because its neighbours were slow. Wall time is only a
// cap on busy time with DNS waits excluded (a lookup is the main thread's work; the worker idles for it).
// The clock starts when a worker begins the job, never at enqueue: queueing behind other messages costs
// nothing.

import { Worker } from 'node:worker_threads';
import { WORKER_DEFAULTS } from './limits.js';
import { systemResolver } from './resolver-guard.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const TICK_MS = 50;   // how often a busy worker's CPU and memory are read

/**
 * @typedef {Object} WorkerOptions
 * @property {number} [size]  Warm worker threads (default 1). 0 runs everything in-process on the calling thread, with no backstop.
 * @property {number} [cpuMs]  CPU a job may use on its worker thread (default 15000).
 * @property {number} [wallMs]  Busy wall time a job may take, DNS waits excluded (default 120000).
 * @property {number} [maxMemoryMb]  Heap plus external memory of the worker thread (default 1536).
 */

/** @typedef {{ size: number, cpuMs: number, wallMs: number, maxMemoryMb: number }} WorkerConfig */

/**
 * The options with defaults filled in. Throws on an unknown key or a bad value.
 * @param {WorkerOptions | undefined} opts
 * @returns {WorkerConfig}
 */
function workerConfig(opts) {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new Error('Mailproof: worker must be an object');
  const o = opts || {};
  for (const k of Object.keys(o)) if (!(k in WORKER_DEFAULTS)) throw new Error(`Mailproof: unknown worker option "${k}"`);
  const cfg = { ...WORKER_DEFAULTS, ...o };
  if (!Number.isInteger(cfg.size) || cfg.size < 0) throw new Error('Mailproof: worker.size must be an integer >= 0');
  for (const k of /** @type {const} */ (['cpuMs', 'wallMs', 'maxMemoryMb'])) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new Error(`Mailproof: worker.${k} must be a number > 0`);
  }
  return cfg;
}

/**
 * @typedef {Object} JobInput
 * @property {{ direction: 'in' | 'out', source: string, envelope?: import('./types.js').Envelope }} ctx
 * @property {string} captured
 * @property {boolean} hasEnvelope
 * @property {string[]} trustedSealers
 */

/** @typedef {import('./build.js').Built} Built */

class WorkerPool {
  /** @param {WorkerConfig & { workerUrl?: URL }} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.workerUrl = cfg.workerUrl ?? WORKER_URL;
    /** @type {Set<import('node:worker_threads').Worker>} */ this.all = new Set();
    /** @type {import('node:worker_threads').Worker[]} */ this.idle = [];
    /** @type {Array<{ buf: Buffer, input: JobInput, resolver: Function, resolve: (v: any) => void, reject: (e: Error) => void }>} */ this.queue = [];
    this.closed = false;
    this.jobSeq = 1;
    this.stats = { spawned: 0, killed: 0 };
  }

  /**
   * Run one build on a worker.
   * @param {Buffer} buf
   * @param {JobInput} input
   * @param {((name: string, type?: string) => Promise<any>) | undefined} resolver  The caller's resolver (absent: the system one).
   * @returns {Promise<{ out: Built, cpuMs: number } | { limit: 'time' | 'memory' | 'crash' }>}
   *   Rejects with the build's own error (or when a worker cannot start); a worker that dies mid-job for no
   *   reason the pool can name is `{ limit: 'crash' }`.
   */
  run(buf, input, resolver) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Mailproof: worker pool closed'));
      this.queue.push({ buf, input, resolver: resolver || systemResolver, resolve, reject });
      this._pump();
    });
  }

  _spawn() {
    // execArgv: the worker does not inherit the process flags (--input-type, --inspect, --require ... mean something else, or nothing, there)
    const w = new Worker(this.workerUrl, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: this.cfg.maxMemoryMb } });
    w.unref();   // an idle worker must not keep the process alive
    this.stats.spawned++;
    this.all.add(w);
    // Permanent, attached once: a worker that exits while idle (nothing else is listening then) must not stay
    // in `idle`/`all`, or the next job would be handed a dead thread. During a job this changes nothing: the
    // job's own exit handler settles it (`crash`), and _retire is a no-op for a worker already forgotten.
    w.once('exit', () => {
      this.all.delete(w);
      const i = this.idle.indexOf(w);
      if (i >= 0) this.idle.splice(i, 1);
    });
    const ready = new Promise((resolve, reject) => {
      w.once('message', (m) => (m.type === 'ready' ? resolve(undefined) : reject(new Error('Mailproof: bad worker hello'))));
      w.once('error', reject);
      w.once('exit', () => reject(new Error('Mailproof: worker exited before it was ready')));
    });
    ready.catch(() => {});
    return Object.assign(w, { ready });
  }

  _pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w) {
        if (this.all.size >= Math.max(1, this.cfg.size)) return;
        try { w = this._spawn(); } catch (e) {   // the thread could not even be created: that job fails, the pump goes on
          /** @type {NonNullable<typeof this.queue[number]>} */ (this.queue.shift()).reject(/** @type {Error} */ (e));
          continue;
        }
      }
      const job = /** @type {NonNullable<typeof this.queue[number]>} */ (this.queue.shift());
      // Nothing may escape _start unhandled: a rejected _start settles its own job (a no-op if it already settled).
      this._start(/** @type {any} */ (w), job).catch((e) => { this._retire(w); job.reject(e instanceof Error ? e : new Error(String(e))); });
    }
  }

  _retire(/** @type {import('node:worker_threads').Worker} */ w) {
    this.all.delete(w);
    const i = this.idle.indexOf(w);
    if (i >= 0) this.idle.splice(i, 1);
    this.stats.killed++;
    w.terminate().catch(() => {});
  }

  /**
   * @param {import('node:worker_threads').Worker & { ready: Promise<unknown> }} w
   * @param {typeof this.queue[number]} job
   */
  async _start(w, job) {
    const { cpuMs, wallMs, maxMemoryMb } = this.cfg;
    const maxBytes = maxMemoryMb * 1024 * 1024;
    const id = this.jobSeq++;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
    /** @type {ReturnType<typeof setInterval> | undefined} */ let poll;
    let cpu0 = 0;
    let usedBusy = 0;     // busy wall ms before the current stretch
    let busySince = 0;    // start of the current stretch
    let rpcOpen = 0;      // DNS lookups the worker is waiting on

    /** @param {{ out: Built, cpuMs: number } | { limit: 'time' | 'memory' | 'crash' } | Error} r @param {boolean} reusable */
    const finish = (r, reusable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit);
      if (reusable && !this.closed) { w.unref(); this.idle.push(w); } else this._retire(w);
      if (r instanceof Error) job.reject(r); else job.resolve(r);
      this._pump();
    };
    const kill = (/** @type {'time' | 'memory' | 'crash'} */ limit) => finish({ limit }, false);
    const arm = () => {
      busySince = performance.now();
      timer = setTimeout(() => kill('time'), Math.max(0, wallMs - usedBusy));
    };
    const pause = () => { clearTimeout(timer); usedBusy += performance.now() - busySince; };
    const cpuOf = (/** @type {{ user: number, system: number }} */ u) => (u.user + u.system) / 1000;

    /** @param {any} m */
    const onMessage = async (m) => {
      if (m.type === 'rpc') {
        if (rpcOpen++ === 0) pause();
        let reply;
        try { reply = { type: 'rpc-result', rpc: m.rpc, value: await job.resolver(m.name, m.rr) }; } catch (e) {
          const err = /** @type {any} */ (e);
          reply = { type: 'rpc-result', rpc: m.rpc, error: { message: String(err?.message), code: err?.code } };
        }
        if (settled) return;
        try { w.postMessage(reply); } catch {   // belt and braces: the guard in mailproof.js already refuses what cannot be cloned
          w.postMessage({ type: 'rpc-result', rpc: m.rpc, error: { message: 'resolver returned a non-plain value', code: 'EBADRESP' } });
        }
        if (--rpcOpen === 0) arm();
      } else if (m.type === 'done' && m.job === id) {
        let used = 0;
        let spent = 0;
        try {
          const [u, h] = await Promise.all([w.cpuUsage(), w.getHeapStatistics()]);
          spent = cpuOf(u) - cpu0;
          used = h.used_heap_size + h.external_memory;
        } catch { /* worker gone: not reusable below */ }
        // A worker that finished holding more than half the memory limit (garbage not yet collected) is
        // replaced: the next job must not start on the previous one's leftovers.
        finish({ out: m.out, cpuMs: spent }, used > 0 && used < maxBytes / 2);
      } else if (m.type === 'fail' && m.job === id) {
        finish(Object.assign(new Error(m.error.message), { code: m.error.code, name: m.error.name }), true);
      }
    };
    const onError = (/** @type {any} */ e) => this.closed ? finish(new Error(`Mailproof: worker failed: ${e?.message}`), false) : kill(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash');
    const onExit = () => (this.closed ? finish(new Error('Mailproof: worker exited unexpectedly'), false) : kill('crash'));
    w.ref();   // a busy worker keeps the process alive until its job settles

    // A worker that fails before its hello (cannot load, cannot start) rejects the call. The job's own
    // failure listeners are attached only once the worker is ready, so they cannot settle it as a crash first.
    try { await w.ready; } catch (e) { return finish(/** @type {Error} */ (e), false); }
    if (settled) return;
    w.on('message', onMessage); w.on('error', onError); w.on('exit', onExit);
    // The caller's Buffer stays intact (it may be a view into Node's shared 8 KiB pool, which must never be
    // transferred), so the worker gets one private copy, moved rather than cloned.
    const payload = new Uint8Array(job.buf.length);
    payload.set(job.buf);
    try { cpu0 = cpuOf(await w.cpuUsage()); } catch { return kill('crash'); }
    if (settled) return;
    let reading = false;
    poll = setInterval(async () => {
      if (reading || settled) return;
      reading = true;
      try {
        const [u, h] = await Promise.all([w.cpuUsage(), w.getHeapStatistics()]);
        if (settled) return;
        if (cpuOf(u) - cpu0 > cpuMs) kill('time');
        else if (h.used_heap_size + h.external_memory > maxBytes) kill('memory');
      } catch { /* the worker ended between ticks: its own event settles the job */ } finally { reading = false; }
    }, TICK_MS);
    arm();
    try {
      w.postMessage({ type: 'job', job: id, buf: payload, ...job.input }, [payload.buffer]);
    } catch (e) {   // the input cannot be structured-cloned (a function or similar in a field the worker is sent): nothing reached the worker, so it is intact and reusable
      finish(new Error(`Mailproof: message input cannot be sent to the worker: ${/** @type {any} */ (e)?.message}`), true);
    }
  }

  /** Terminate every worker; jobs still queued are rejected. */
  async close() {
    this.closed = true;
    for (const q of this.queue.splice(0)) q.reject(new Error('Mailproof: worker pool closed'));
    const all = [...this.all];
    this.all.clear();
    this.idle = [];
    await Promise.all(all.map((w) => w.terminate()));
  }
}

/** @type {Map<string, { pool: WorkerPool, refs: number }>} */
const shared = new Map();

/**
 * Take a share of the process-wide pool for this config. Instances with the same config share workers, so
 * many `Mailproof` objects do not each start a thread; the pool ends when the last one releases it.
 * @param {WorkerConfig} cfg
 * @returns {{ run: WorkerPool['run'], release: () => Promise<void> }}
 */
function leasePool(cfg) {
  const key = `${cfg.size}|${cfg.cpuMs}|${cfg.wallMs}|${cfg.maxMemoryMb}`;
  let e = shared.get(key);
  if (!e) { e = { pool: new WorkerPool(cfg), refs: 0 }; shared.set(key, e); }
  e.refs++;
  const entry = e;
  let released = false;
  return {
    run: (buf, input, resolver) => entry.pool.run(buf, input, resolver),
    async release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0) { shared.delete(key); await entry.pool.close(); }
    },
  };
}

export { WorkerPool, workerConfig, leasePool };
