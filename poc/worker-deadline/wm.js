// WorkerMailproof: a Mailproof whose _build runs in the pool. check()/record()/everything else are inherited unchanged,
// so record() still commits (trail lock + git) on the MAIN thread only after the worker has returned.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { DeadlinePool } from './pool.js';

// Setup: these POCs import a frozen copy of the repo at $WD_DIR/wd-src (default <tmpdir>/mailproof-worker-deadline/wd-src; or set WD_SRC).
// Create it once from the repo root, node_modules included (a plain copy, no git worktree):
//   mkdir -p "$WD_DIR" && cp -r . "$WD_DIR/wd-src"   # run `npm ci` first if node_modules is missing
export const SRC = process.env.WD_SRC || path.join(process.env.WD_DIR || path.join(os.tmpdir(), 'mailproof-worker-deadline'), 'wd-src');
export const mailproofUrl = pathToFileURL(path.join(SRC, 'src/proof/mailproof.js')).href;
export const { Mailproof } = await import(mailproofUrl);
const { overLimitReason } = await import(pathToFileURL(path.join(SRC, 'src/proof/admit.js')).href);

export function makeWorkerMailproof(poolOpts = {}) {
  class WorkerMailproof extends Mailproof {
    constructor(opts) {
      super(opts);
      this.pool = new DeadlinePool({ mailproofUrl, resolver: opts.resolver ? (n, t) => opts.resolver(n, t) : undefined, ...poolOpts });
      this.last = null;
    }
    async _build(raw, ctx) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
      if (buf.length === 0) throw new Error('Mailproof: empty message');
      const captured = this.now().toISOString();
      const hasEnvelope = Boolean(ctx.envelope && (ctx.envelope.clientIp || ctx.envelope.sender));
      const r = await this.pool.run(buf, { ctx, captured, trustedSealers: this.trustedSealers }, { test: this.__test });
      this.last = r;
      if (r.ok) return r.out;
      if (r.reason === 'crash' && r.error?.message && !/exited/.test(r.error.message)) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return this._overLimitRecord(buf, captured, ctx, hasEnvelope, r.reason === 'memory' ? 'memory' : 'time');
    }
    close() { return this.pool.close(); }
  }
  return WorkerMailproof;
}
export { overLimitReason };
