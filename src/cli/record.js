// `mailproof record` (SPEC B14, M5): one raw email from a file or stdin into the trail, for a mail server that pipes each message to it
// (Postfix pipe(8)). A thin wrapper over `Mailproof#record`; the one thing it adds is a bounded read: the bytes are hashed as they arrive and
// held only up to the library's size cap, so a huge message never fills memory and is still recorded with its true id.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Mailproof } from '../index.js';
import { UsageError } from './errors.js';
import { loadCtxConfig, print, warn, printJson } from './session.js';
import { selectAccount, mailproofOptions } from './config.js';
import { printable as p } from './printable.js';
import { MAX_TOTAL_BYTES } from '../proof/limits.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/**
 * Read a byte stream once: hash and count every byte, hold them only while the total is at most `cap` (SPEC B14.2). Memory is the cap plus one
 * chunk whatever the input size. Over the cap the held bytes are dropped and the rest is only hashed and counted.
 * @param {AsyncIterable<Buffer | Uint8Array | string>} source
 * @param {number} cap
 * @returns {Promise<{ buf: Buffer | null, held: number, maxHeld: number, size: number, sha256: string, over: boolean }>}  `buf`: the whole input, or null when it was over the cap (`over`). `held`: bytes in the returned buffer. `maxHeld`: the most bytes it ever held. `sha256`: hex of all `size` bytes.
 */
export async function readBounded(source, cap) {
  const hash = createHash('sha256');
  let size = 0;
  let held = 0;
  let maxHeld = 0;
  let over = false;
  /** @type {Buffer | null} */
  let store = null;
  for await (const c of source) {
    const b = typeof c === 'string' ? Buffer.from(c) : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    hash.update(b);
    size += b.length;
    if (over) continue;
    if (size > cap) { over = true; store = null; held = 0; continue; }
    store ??= Buffer.allocUnsafeSlow(cap);   // not zero-filled: only the pages actually written are resident
    b.copy(store, held);
    held += b.length;
    if (held > maxHeld) maxHeld = held;
  }
  const buf = over ? null : store ? store.subarray(0, held) : Buffer.alloc(0);
  return { buf, held: buf ? buf.length : 0, maxHeld, size, sha256: hash.digest('hex'), over };
}

/**
 * The library options of a `record` run: the account's, and no worker thread (one process per message, SPEC B14.8). The admission gate and the DNS budget still apply.
 * @param {import('./config.js').Account} account
 */
export const recordOptions = (account) => ({ ...mailproofOptions(account), worker: { size: 0 } });

/**
 * The envelope the three flags describe: absent when no flag was given, even an empty one counts (an empty `--sender=` is the null sender).
 * @param {Record<string, any>} v
 * @returns {{ clientIp?: string, clientHelo?: string, sender?: string | null } | null}
 */
function envelopeOf(v) {
  if (v['client-ip'] === undefined && v['client-helo'] === undefined && v.sender === undefined) return null;
  return {
    ...(v['client-ip'] !== undefined ? { clientIp: v['client-ip'] } : {}),
    ...(v['client-helo'] !== undefined ? { clientHelo: v['client-helo'] } : {}),
    ...(v.sender !== undefined ? { sender: v.sender === '' ? null : v.sender } : {}),
  };
}

/**
 * The input: the file when one is given, else stdin (never a terminal).
 * @param {string | undefined} file
 * @param {Ctx} ctx
 * @returns {Promise<AsyncIterable<Buffer | Uint8Array | string>>}
 */
async function inputOf(file, ctx) {
  if (file !== undefined) {
    /** @type {import('node:fs').Stats} */
    let st;
    try { st = await fs.stat(file); }
    catch (e) { throw new Error(`record: cannot read ${file}: ${String(/** @type {Error} */ (e).message).replace(/^[A-Z]+: /, '').split(',')[0]}`); }
    if (st.isDirectory()) throw new UsageError(`record: ${file} is a directory, not an email`);
    return createReadStream(file);
  }
  const stdin = ctx.stdin;
  if (!stdin || /** @type {{ isTTY?: boolean }} */ (stdin).isTTY) throw new UsageError('record: no <file> and stdin is a terminal; give a file or pipe the email in');
  return stdin;
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function recordCmd(a, ctx) {
  const direction = a.values.direction;
  if (direction !== 'in' && direction !== 'out') throw new UsageError(direction === undefined ? 'record: --direction in or out is required' : `record: --direction must be in or out (got "${p(String(direction))}")`);
  const source = a.values.source === undefined || a.values.source === '' ? 'pipe' : String(a.values.source);
  const input = await inputOf(a.positionals[0], ctx);
  const { config } = await loadCtxConfig(a, ctx);
  const account = selectAccount(config, a.values.account);
  const mp = ctx.deps.makeMailproof ? ctx.deps.makeMailproof(account) : new Mailproof(recordOptions(account));
  try {
    const got = await readBounded(input, MAX_TOTAL_BYTES);   // a stream error ends here: nothing is recorded (B14.2)
    if (got.size === 0) throw new Error('record: empty message');
    const envelope = envelopeOf(a.values);
    const res = got.over
      ? await mp._recordDigest({ raw_sha256: `sha256:${got.sha256}`, size: got.size }, { direction, source })   // the envelope is not recorded for an over-cap message
      : await mp.record(/** @type {Buffer} */ (got.buf), { direction, source, ...(envelope ? { envelope } : {}) });
    try { await mp._autoSweep(); }   // the upkeep `sync` would do (SPEC B14.4); its failure never changes the exit code
    catch (e) { warn(ctx, `content sweep failed: ${p(String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200))}`); }
    if (a.values.json) {
      printJson(ctx, { id: res.id, duplicate: res.duplicate, commit: res.commit, ...(res.ots !== undefined ? { ots: res.ots } : {}), ...(res.content !== undefined ? { content: res.content } : {}) });
    } else if (res.duplicate) print(ctx, `already recorded ${res.id}`);
    else {
      const v = res.record?.verdicts;
      print(ctx, `recorded ${res.id} ${direction}${v ? ` ${v.live.trust}/${v.portable.trust}` : ''}`);
    }
    return 0;
  } finally { await mp.close(); }
}
