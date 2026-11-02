// POC worker pool with a hard per-job deadline. size 0 = cold worker per job (spawned, then terminated).
// Deadline = worker-BUSY time: the clock is paused while the worker is only waiting on a DNS answer from the main thread.
import { Worker } from 'node:worker_threads';
import dns from 'node:dns';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class DeadlinePool {
  /** @param {{ size?: number, deadlineMs?: number, resourceLimits?: object, mailproofUrl: string, workerUrl?: URL, resolver?: Function, transfer?: 'copy'|'transfer'|'shared' }} o */
  constructor(o) {
    this.size = o.size ?? 1;
    this.deadlineMs = o.deadlineMs ?? 10000;   // WALL budget of worker-busy time (DNS waits excluded)
    this.cpuMs = o.cpuMs ?? null;              // CPU budget of the worker thread (needs Worker#cpuUsage, Node >= 22.19); load-independent
    this.resourceLimits = o.resourceLimits;
    this.mailproofUrl = o.mailproofUrl;
    this.workerUrl = o.workerUrl ?? WORKER_URL;
    this.resolver = o.resolver ?? ((name, rr) => dns.promises.resolve(name, rr));
    this.mode = o.transfer ?? 'transfer';
    this.idle = []; this.all = new Set(); this.queue = []; this.jobSeq = 1; this.closed = false;
    this.stats = { spawned: 0, killed: 0 };
  }
  _spawn() {
    const w = new Worker(this.workerUrl, { workerData: { mailproofUrl: this.mailproofUrl }, resourceLimits: this.resourceLimits });
    w.unref();   // an idle pool must not hold the process open
    this.stats.spawned++; this.all.add(w);
    w.ready = new Promise((res, rej) => { w.once('message', (m) => (m.type === 'ready' ? res() : rej(new Error('bad hello')))); w.once('error', rej); w.once('exit', () => rej(new Error('exit before ready'))); });
    w.ready.catch(() => {});
    return w;
  }
  _discard(w) { this.all.delete(w); const i = this.idle.indexOf(w); if (i >= 0) this.idle.splice(i, 1); }
  /** @returns {Promise<{ok:true,out:any,ms:number}|{ok:false,reason:'time'|'memory'|'crash',error?:any,ms:number}>} */
  run(buf, ctx, extra = {}) {
    return new Promise((resolve) => { this.queue.push({ buf, ctx, extra, resolve }); this._pump(); });
  }
  _pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w) { if (this.size === 0 || this.all.size < this.size) w = this._spawn(); else return; }
      this._start(w, this.queue.shift());
    }
  }
  async _start(w, job) {
    const t0 = performance.now();
    const id = this.jobSeq++;
    let settled = false, timer = null, poll = null, cpu0 = 0, usedBusy = 0, busySince = null, rpcOpen = 0;
    const finish = (r) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearInterval(poll); w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit);
      r.ms = performance.now() - t0;
      if (r.ok && this.size > 0 && !this.closed) { w.unref(); this.idle.push(w); }
      else { this._discard(w); this.stats.killed++; w.terminate().catch(() => {}); }
      job.resolve(r); this._pump();
    };
    const arm = () => { busySince = performance.now(); timer = setTimeout(() => finish({ ok: false, reason: 'time' }), Math.max(0, this.deadlineMs - usedBusy)); };
    const pause = () => { clearTimeout(timer); usedBusy += performance.now() - busySince; };
    const onMsg = async (m) => {
      if (m.type === 'rpc') {
        if (rpcOpen++ === 0) pause();
        let reply;
        try { reply = { type: 'rpc-result', rpc: m.rpc, value: await this.resolver(m.name, m.rr) }; }
        catch (e) { reply = { type: 'rpc-result', rpc: m.rpc, error: { message: String(e?.message), code: e?.code } }; }
        if (settled) return;
        w.postMessage(reply);
        if (--rpcOpen === 0) arm();
      } else if (m.type === 'done' && m.job === id) {
        let cpuMs; try { const u = await w.cpuUsage(); cpuMs = (u.user + u.system) / 1000 - cpu0; } catch {}
        finish({ ok: true, out: m.out, cpuMs });
      }
      else if (m.type === 'fail' && m.job === id) finish({ ok: false, reason: 'crash', error: m.error });
    };
    const onErr = (e) => finish({ ok: false, reason: e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash', error: { message: String(e?.message), code: e?.code } });
    const onExit = () => finish({ ok: false, reason: 'crash', error: { message: 'worker exited' } });
    w.on('message', onMsg); w.on('error', onErr); w.on('exit', onExit);
    w.ref();   // a busy worker keeps the process alive until its job settles
    try { await w.ready; } catch (e) { return finish({ ok: false, reason: 'crash', error: { message: String(e?.message) } }); }
    if (settled) return;
    // The caller's Buffer must stay intact (and may be a view into Node's shared 8 KiB pool, whose ArrayBuffer must never be
    // transferred), so every mode makes exactly one private copy; they differ in how that copy reaches the worker.
    let payload, transferList = [];
    if (this.mode === 'shared') { const sab = new SharedArrayBuffer(job.buf.length); const u = new Uint8Array(sab); u.set(job.buf); payload = u; }
    else if (this.mode === 'transfer') { const u = new Uint8Array(job.buf.length); u.set(job.buf); payload = u; transferList = [u.buffer]; }
    else payload = job.buf;   // 'copy': structured clone copies it
    if (this.cpuMs !== null) {
      try { const u0 = await w.cpuUsage(); cpu0 = (u0.user + u0.system) / 1000; } catch {}
      let busy = false;
      poll = setInterval(async () => {
        if (busy || settled) return; busy = true;
        try { const u = await w.cpuUsage(); if (!settled && (u.user + u.system) / 1000 - cpu0 > this.cpuMs) finish({ ok: false, reason: 'time', by: 'cpu' }); } catch {} finally { busy = false; }
      }, 100);
    }
    arm();
    w.postMessage({ type: 'job', job: id, buf: payload, ctx: job.ctx.ctx, captured: job.ctx.captured, trustedSealers: job.ctx.trustedSealers, test: job.extra.test }, transferList);
  }
  async close() { this.closed = true; await Promise.all([...this.all].map((w) => w.terminate())); this.all.clear(); this.idle = []; }
}
