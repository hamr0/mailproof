// TEST-ONLY. A small real trail for the prune tests: signed mails recorded through `Mailproof#record()` with a clock
// the test moves, senders whose archived keys are first used before, across or after the cutoff, a reply-text commit
// for a record that will be pruned and one for a record that will be kept, a straggler (captured before the cutoff
// but committed after a later record) and attachments shared across the cutoff. NEVER imported from src/.
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, makeKey } from './proof.js';
import { makeTmpDir } from './tmp.js';

export const DAY = 86_400_000;
export const T0 = Date.parse('2026-01-01T10:00:00Z');
const PDF_A = Buffer.from('%PDF-1.4 shared contract\n'.repeat(10));
const PDF_B = Buffer.from('%PDF-1.4 only a pruned mail has this\n'.repeat(10));

/**
 * Sender plan for 10 mails (index = commit order). A: only before the cutoff (key dropped), B: before and after
 * (key carried into the notice), C: only after (key stays where it was first committed).
 */
const SENDERS = ['A', 'A', 'B', 'B', 'B', 'B', 'C', 'C', 'B', 'C'];

/**
 * @param {{ trailDir?: string, extra?: Record<string, any>, n?: number }} [o]
 * @returns {Promise<{ mp: Mailproof, clock: { t: number }, dir: string, root: string, cdir: string, recs: Array<{ id: string, raw: Buffer, sender: string, at: number }>, resolver: Function, keys: Record<string, any>, mailFor: (sender: string, tag: string, opts?: any) => Promise<Buffer>, cutoff: string }>}
 */
export async function makeTrail({ trailDir, extra = {}, n = SENDERS.length } = {}) {
  const dir = trailDir ?? makeTmpDir('mp-prune-');
  const clock = { t: T0 };
  const keys = { A: makeKey('ed25519'), B: makeKey('ed25519'), C: makeKey('ed25519') };
  const map = {};
  for (const [s, key] of Object.entries(keys)) {
    map[`sel${s}._domainkey.send${s}.example`] = `v=DKIM1; k=${key.k}; p=${key.p}`;
    map[`_dmarc.send${s}.example`] = 'v=DMARC1; p=none; adkim=r; aspf=r';
  }
  const resolver = async (name, type) => {
    if ((type || 'TXT').toUpperCase() !== 'TXT') throw Object.assign(new Error('only TXT'), { code: 'ENODATA' });
    if (map[name] === undefined) throw Object.assign(new Error('no record ' + name), { code: 'ENOTFOUND' });
    return [[map[name]]];
  };
  const mp = new Mailproof({ trailDir: dir, resolver, worker: { size: 0 }, now: () => new Date(clock.t), ...extra });
  let seq = 0;
  const mailFor = async (sender, tag, opts = {}) => (await signedMail({
    domain: `send${sender}.example`, selector: `sel${sender}`, alg: 'ed25519', signers: [{ domain: `send${sender}.example`, selector: `sel${sender}`, alg: 'ed25519', key: keys[sender] }],
    body: `mail ${tag} ${seq++}\r\n`, signTime: new Date(clock.t), ...opts,
  })).raw;
  const recs = [];
  for (let i = 0; i < n; i++) {
    const sender = SENDERS[i % SENDERS.length];
    // record 8 is the straggler: committed after record 7 but captured two days in (before the cutoff, day 5)
    clock.t = T0 + (i === 8 ? 2 : i) * DAY;
    const attachment = i === 1 ? { filename: 'b.pdf', bytes: PDF_B } : i === 0 || i === 6 ? { filename: 'a.pdf', bytes: PDF_A } : undefined;
    const raw = await mailFor(sender, `m${i}`, { attachment });
    const r = await mp.record(raw, { direction: 'in', source: 'test' });
    recs.push({ id: r.id, raw, sender, at: clock.t });
    if (i === 7 && n >= 8) {
      // reply-text commits made later: one for a record that will be pruned (becomes an empty commit), one for a kept one
      clock.t = T0 + 7 * DAY + 3600_000;
      await mp.replyText({ id: recs[1].id });
      await mp.replyText({ id: recs[6].id });
    }
  }
  clock.t = T0 + 20 * DAY;
  return { mp, clock, dir, root: path.join(dir, 'default'), cdir: path.join(dir, 'default.content'), recs, resolver, keys, mailFor, cutoff: new Date(T0 + 5 * DAY).toISOString() };
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
