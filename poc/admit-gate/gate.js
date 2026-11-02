// POC wrapper: admit -> (only if admitted) the real public Mailproof.check()/record().
import { Mailproof } from '../../src/index.js';
import { admit } from './admit.js';
export class GatedMailproof {
  constructor(opts) { this.mp = new Mailproof(opts); }
  async check(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    const a = admit(buf);
    if (!a.ok) return { verdict: 'unverified', reason: `over limit: ${a.reason}`, gated: true, metrics: a.m };
    return this.mp.check(buf);
  }
  async record(raw, ctx) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    const a = admit(buf);
    // the real record() would still commit the bytes (accept-with-flag) with an unverified record carrying `reason`;
    // the POC only proves the gate decision + that the dependencies are never entered.
    if (!a.ok) return { recorded: 'unverified', reason: `over limit: ${a.reason}`, gated: true };
    return this.mp.record(buf, ctx);
  }
}
