// TEST-ONLY. An in-memory ImapSession (the interface src/proof/imap.js gives sync.js, SPEC B4.6) that logs every
// call and can inject the faults the spec names. NEVER imported from src/.
import crypto from 'node:crypto';

/**
 * @param {Object} cfg
 * @param {Record<string, { uidvalidity?: string, uidNext?: number, msgs: Array<{ uid: number, raw: Buffer, size?: number }> }>} cfg.folders
 * @param {string | null} [cfg.sent]  Path of the folder with the \Sent flag, or null.
 * @param {boolean} [cfg.ignoreRange]  Behave like the `N:*` quirk: always also return the highest message, whatever was asked.
 * @param {(ev: { op: string, uid?: number, folder: string | null, n: number }) => void | Promise<void>} [cfg.onCall]  Called before fetch/hash/list/select; may throw or block.
 * @param {(opts: any) => void} [cfg.onOpen]
 * @param {Error} [cfg.findSentError]  What `findSent()` throws (a failing LIST).
 */
export function makeFake(cfg) {
  const log = { opens: 0, lists: /** @type {Array<[string, number, number]>} */ ([]), fetches: /** @type {Array<[string, number, number]>} */ ([]), hashes: /** @type {Array<[string, number]>} */ ([]), selects: /** @type {string[]} */ ([]), closes: 0 };
  const stats = { fetchBytes: 0, hashBytes: 0 };
  const counters = { fetch: 0, hash: 0, list: 0, select: 0 };
  /** @type {Record<string, string>} */
  const uidvalidity = {};
  for (const [p, f] of Object.entries(cfg.folders)) uidvalidity[p] = f.uidvalidity ?? '1';

  const fake = {
    log, stats, uidvalidity, folders: cfg.folders, openArgs: /** @type {any[]} */ ([]),
    async openSession(args) {
      cfg.onOpen?.(args);
      fake.openArgs.push(args);
      log.opens++;
      let current = null;
      const call = async (op, uid) => { counters[op]++; await cfg.onCall?.({ op, uid, folder: current, n: counters[op] }); };
      return {
        async findSent() { if (cfg.findSentError) throw cfg.findSentError; return cfg.sent ?? null; },
        async select(p) {
          const f = cfg.folders[p];
          log.selects.push(p);
          await call('select');
          if (!f) throw Object.assign(new Error(`no such folder ${p}`), { code: 'ERR_IMAP_NO_FOLDER' });
          current = p;
          const max = f.msgs.reduce((m, x) => Math.max(m, x.uid), 0);
          return { uidvalidity: uidvalidity[p], uidNext: f.uidNext ?? max + 1 };
        },
        async list(lo, hi) {
          log.lists.push([current, lo, hi]);
          await call('list');
          const f = cfg.folders[current];
          let out = f.msgs.filter((m) => cfg.ignoreRange || (m.uid >= lo && m.uid <= hi));
          if (cfg.ignoreRange) { const last = f.msgs.at(-1); if (last && !out.includes(last)) out = [...out, last]; }
          return out.map((m) => ({ uid: m.uid, size: m.size ?? m.raw.length }));
        },
        async fetch(uid, max) {
          log.fetches.push([current, uid, max]);
          await call('fetch', uid);
          const m = cfg.folders[current].msgs.find((x) => x.uid === uid);
          const out = m.raw.subarray(0, max);
          stats.fetchBytes += out.length;
          return Buffer.from(out);
        },
        async hash(uid, max) {
          log.hashes.push([current, uid]);
          await call('hash', uid);
          const m = cfg.folders[current].msgs.find((x) => x.uid === uid);
          stats.hashBytes += m.raw.length;
          if (max !== undefined && m.raw.length > max) return { sha256: null, size: max + 1, over: true };
          return { sha256: crypto.createHash('sha256').update(m.raw).digest('hex'), size: m.raw.length, over: false };
        },
        async close() { log.closes++; },
      };
    },
  };
  return fake;
}

/** Raised by `onCall` to simulate a dropped connection. */
export const drop = () => Object.assign(new Error('socket closed'), { code: 'ERR_IMAP_PROTOCOL', retryable: true });
