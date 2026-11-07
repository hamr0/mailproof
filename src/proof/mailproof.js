// The proof core. One instance owns one trail (a git repo of records). Methods
// are bound, so `const { verify } = mp` works.

import path from 'node:path';
import { overLimitRecord, overLimitRecordFromDigest } from './over-limit.js';
import { runSync } from './sync.js';
import { workerConfig, leasePool } from './pool.js';
import { guardResolver, systemResolver } from './resolver-guard.js';
import { engine } from './verdict.js';
import { createOts, DEFAULT_OTS_TIMEOUT_MS } from './ots.js';
import { verifyRecord, matchBodyRecord, matchFileRecord } from './recheck.js';
import { TRAIL_NAME_RE, RECORD_ID_RE, DEFAULT_LOCK_TIMEOUT_MS, commitRecord, commitFiles, readRecord } from './trail.js';
import { STRIPPER, replyTextPath, extractReplyText, replyTextRecord } from './reply-text.js';
import { hashDocument } from './hash.js';

const OTS_MIN_TIMEOUT_MS = 5000; // floor for the `ots` timeout, however short lockTimeoutMs is

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {{ id: string, captured: string, direction: string, copy: string, body_status: string, live: string, portable: string }} CopySummary */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */
/** @typedef {{ id: string, text: string, text_sha256: string, text_bytes: number, quote: 'found' | 'not-found' | 'inline', trailing: boolean, source: 'text/plain' | 'html-only', boundary: string | null, stripper: string, body_status: import('./types.js').BodyStatus, proven: boolean, commit: string, duplicate: boolean }} ReplyText */

/**
 * @typedef {Object} MailproofOptions
 * @property {string} trailDir  Directory holding the trails; each trail is a git repo inside it.
 * @property {string} [trail]  Trail name (default "default").
 * @property {(name: string, type?: string) => Promise<any>} [resolver]  mailauth-compatible DNS resolver (tests inject one). A lookup it has not answered within 5 s is answered as the error `dns timeout` (`code: 'ETIMEOUT'`). It must return plain data, as `node:dns` does (a value structured clone refuses, such as a function, is answered as a DNS error, `code: 'EBADRESP'`).
 * @property {string | null} [otsBin]  Path to the `ots` binary; null/absent keeps OpenTimestamps off.
 * @property {() => Date} [now]  Clock (tests inject one).
 * @property {string[]} [trustedSealers]  ARC sealer domains whose chains may yield `forwarded` (live only).
 * @property {import('./pool.js').WorkerOptions} [worker]  The deadline backstop (default on): the parsing and verifying half of `check()`/`record()` runs in a warm worker thread that is killed when one message uses more than `cpuMs` (15000) of the thread's CPU, `wallMs` (120000) of busy wall time (DNS waits excluded) or `maxMemoryMb` (1536) of heap plus external memory. The message is then recorded `unverified` as `over limit: time` / `over limit: memory`; a worker that dies for no nameable reason gives `over limit: crash`. `size` is the number of warm workers (default 1); `size: 0` runs everything in-process, with no backstop. Needs Node 22.19 or later.
 * @property {number} [lockTimeoutMs]  How long `record()` waits for another writer of the same trail (default 30000). On timeout it throws `ERR_TRAIL_LOCKED` and writes nothing. With `otsBin`, the OTS stamp runs inside that lock and is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms, so a short `lockTimeoutMs` shortens the stamp (5 s floor), and concurrent writers can wait up to that long behind a slow stamp.
 */

/**
 * The `ots` command timeout: clamp(floor(lockTimeoutMs / 3), 5000, DEFAULT_OTS_TIMEOUT_MS).
 * @param {number} lockTimeoutMs
 * @returns {number}
 */
function otsTimeoutMs(lockTimeoutMs) {
  return Math.min(DEFAULT_OTS_TIMEOUT_MS, Math.max(OTS_MIN_TIMEOUT_MS, Math.floor(lockTimeoutMs / 3)));
}

class Mailproof {
  /**
   * @param {MailproofOptions} opts
   * @signature new Mailproof({ trailDir: string, trail?: string, resolver?: Function, otsBin?: string|null, now?: () => Date, trustedSealers?: string[], lockTimeoutMs?: number, worker?: { size?: number, cpuMs?: number, wallMs?: number, maxMemoryMb?: number } })
   * @when Start here. Construct one per trail (a git repo of records under `trailDir`), then `record()` each email you want a re-checkable proof of and `verify()` it later, offline. All methods are bound, so `const { verify } = mp` works.
   * @category proof
   * @fails Throws at construction when `trailDir` is missing, `trail` is not `[a-z0-9][a-z0-9_-]{0,63}`, or `worker` holds an unknown key or a bad value. Nothing touches the disk until the first `record()`. With `otsBin`, the OTS stamp runs inside the writer lock and is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms: a short `lockTimeoutMs` shortens the stamp (5 s floor), and concurrent writers can wait up to that long behind a slow stamp.
   * @example
   * import { Mailproof } from 'mailproof';
   * const mp = new Mailproof({ trailDir: './trails' });
   * const { id } = await mp.record(rawEmailBytes, { direction: 'in', source: 'imap' });
   * const v = await mp.verify(id);   // v.ok, v.trust
   */
  constructor(opts) {
    if (!opts || typeof opts.trailDir !== 'string' || !opts.trailDir) throw new Error('Mailproof: trailDir required');
    const trail = opts.trail ?? 'default';
    if (!TRAIL_NAME_RE.test(trail)) throw new Error(`Mailproof: invalid trail name "${trail}"`);
    this.trail = trail;
    this.root = path.resolve(opts.trailDir, trail);
    this.resolver = opts.resolver;
    this.otsBin = opts.otsBin || null;
    this.now = opts.now || (() => new Date());
    this.trustedSealers = opts.trustedSealers || [];
    this.worker = workerConfig(opts.worker);
    /** @type {{ run: import('./pool.js').WorkerPool['run'], runReplyText: import('./pool.js').WorkerPool['runReplyText'], release: () => Promise<void> } | null} */
    this._lease = null;
    /** @type {import('./index-db.js').TrailIndex | null} */
    this._ix = null;
    this.lockTimeoutMs = Number.isFinite(opts.lockTimeoutMs) && /** @type {number} */ (opts.lockTimeoutMs) >= 0 ? /** @type {number} */ (opts.lockTimeoutMs) : DEFAULT_LOCK_TIMEOUT_MS;
    // The stamp runs inside the trail lock, so it is capped at a third of the lock wait (see otsTimeoutMs).
    this.ots = this.otsBin ? createOts({ otsBin: this.otsBin, timeoutMs: otsTimeoutMs(this.lockTimeoutMs) }) : null;
    this.check = this.check.bind(this);
    this.record = this.record.bind(this);
    this.verify = this.verify.bind(this);
    this.matchBody = this.matchBody.bind(this);
    this.matchFile = this.matchFile.bind(this);
    this.get = this.get.bind(this);
    this.list = this.list.bind(this);
    this.copies = this.copies.bind(this);
    this.sync = this.sync.bind(this);
    this.replyText = this.replyText.bind(this);
    this.close = this.close.bind(this);
  }

  /**
   * Build the record for a message (nothing is written): in a worker thread under the deadline backstop
   * (pool.js), or in-process when `worker.size` is 0. A message over an input limit (admit.js) gets the
   * over-limit record: the parsers never see it and no DNS is asked. So does one the backstop stopped
   * (`over limit: time` / `over limit: memory`), or whose worker crashed (`over limit: crash`).
   * @param {Buffer | string} raw
   * @param {{ direction: 'in' | 'out', source: string, envelope?: Envelope }} ctx
   * @returns {Promise<import('./build.js').Built>}
   *   `overLimit`: the name of the limit the message exceeded, else null.
   */
  async _build(raw, ctx) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    if (buf.length === 0) throw new Error('Mailproof: empty message');
    // Only the three envelope fields the build reads (parse.js authenticateMessage) go on: extra caller fields are
    // dropped here, in both modes, so they can never reach the worker's postMessage. Each is a string or null: a
    // value of any other type (a function would not survive the worker's postMessage) becomes null, in both modes.
    // An envelope that is not itself a non-null object is treated as absent, in both modes.
    const e = ctx.envelope;
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : null);
    if (e && typeof e === 'object') ctx = { ...ctx, envelope: { clientIp: str(e.clientIp), clientHelo: str(e.clientHelo), sender: str(e.sender) } };
    else if (e !== undefined) { const { envelope: _drop, ...rest } = ctx; ctx = rest; }
    const captured = this.now().toISOString();
    const hasEnvelope = Boolean(ctx.envelope && (ctx.envelope.clientIp || ctx.envelope.sender));
    const trustedSealers = this.trustedSealers;
    const resolver = guardResolver(this.resolver ?? systemResolver);   // one guard per message: a lookup that never answers, or answers with a non-plain value, is a DNS error, and all of one message's lookups share one DNS budget; in the worker and in-process alike, system resolver included
    if (this.worker.size === 0) {
      // loaded here, not at the top: with a worker, only the worker pays for mailauth and mailparser
      const { buildRecord } = await import('./build.js');
      return buildRecord(buf, ctx, { captured, hasEnvelope, trustedSealers, resolver });
    }
    this._lease ??= leasePool(this.worker);
    const r = await this._lease.run(buf, { ctx, captured, hasEnvelope, trustedSealers }, resolver);
    return 'out' in r ? r.out : overLimitRecord(buf, ctx, { captured, hasEnvelope, trustedSealers }, r.limit);
  }

  /**
   * Stop the worker threads this instance uses. Optional: idle workers do not keep the process alive, so a
   * program that never calls it still exits on its own. A later `check()` or `record()` starts a fresh worker.
   * @returns {Promise<void>}
   * @name Mailproof#close
   * @when Use to release the worker threads at once (a test, a long-lived process that is done checking mail). Workers are shared by instances with the same `worker` options, so they end when the last of those instances closes. Never needed for the process to exit.
   * @category proof
   * @signature mp.close() => Promise<void>
   * @fails Never throws. A call with nothing to stop, or with `worker.size` 0, resolves at once. With a worker (`size` 1 or more), a `record()` or `check()` still running when `close()` is called (or when the last instance sharing the pool closes) may reject, and if it rejects that message is not recorded: await in-flight calls before `close()`.
   * @example
   * await mp.close();
   */
  async close() {
    const lease = this._lease;
    this._lease = null;
    const ix = this._ix;
    this._ix = null;
    await ix?.close();
    await lease?.release();
  }

  /**
   * Resolve a record argument: a record object, its JSON text, or a trail id.
   * @param {MpRecord | string} recordOrId
   * @returns {Promise<MpRecord | null>}
   */
  async _resolve(recordOrId) {
    if (typeof recordOrId === 'string') {
      if (RECORD_ID_RE.test(recordOrId)) return this.get(recordOrId);
      try { return JSON.parse(recordOrId); } catch { return null; }
    }
    return recordOrId && typeof recordOrId === 'object' ? recordOrId : null;
  }

  /**
   * One-off check of a message (e.g. a saved .eml): both verdicts, nothing written.
   * Judged as of now, so a signature whose key has left DNS shows up as
   * `key_errors` and an `unverified` portable verdict.
   * @param {Buffer | string} raw
   * @param {{ envelope?: Envelope }} [opts]
   * @returns {Promise<{ live: Record<string, any>, portable: Record<string, any>, signatures: number, unsigned: boolean, partial_body: boolean, key_errors: string[], body_status: import('./types.js').BodyStatus, body: import('./types.js').BodyResult[] }>}
   * @name Mailproof#check
   * @when Use for a one-off look at an email you were handed (a saved .eml), when you do NOT want it recorded. It returns both verdicts and writes nothing. Use `record()` instead to keep a proof.
   * @category proof
   * @signature mp.check(raw: Buffer|string, opts?: { envelope?: Envelope }) => Promise<{ live, portable, signatures: number, unsigned: boolean, partial_body: boolean, key_errors: string[], body_status, body[] }>
   * @fails Rejects on an empty message. Unsigned or unverifiable mail does not throw: it comes back `unverified`. A message over an input limit is not parsed or verified at all, and no DNS is asked: `unverified`, `reason: 'over limit: <name>'` on both verdicts (`total_bytes`, `header_bytes`, `header_lines`, `header_fields`, `signatures`, `h_names`, `sig_bytes`, `mime_parts`, `body_line`, `body_lines`; or `time` / `memory` / `crash` when the worker backstop stopped the build or its worker died, see the `worker` option), `signatures` 0, `unsigned` false, `body_status` `not-checked`. The limits: total size 25 MiB, header block 256 KiB, 4,000 header lines, 1,000 header fields, 10 DKIM-Signature headers, 200 names in one `h=`, 16 KiB per DKIM-Signature field, 200 MIME delimiter lines, 256 KiB per body line, 500,000 body lines (SPEC Part B, Limits). Judged as of now, so a key that has left DNS appears in `key_errors` and the portable verdict is `unverified`. The portable verdict covers the signed headers only: read `body_status` (and `body[i].explain`) for the body.
   * @example
   * const mp = new Mailproof({ trailDir: './trails' });
   * const c = await mp.check(fs.readFileSync('mail.eml'));   // c.live.trust, c.portable.trust
   */
  async check(raw, { envelope } = {}) {
    const { record, overLimit } = await this._build(raw, { direction: 'in', source: 'check', envelope });
    return {
      live: record.verdicts.live,
      portable: record.verdicts.portable,
      signatures: record.signatures.length,
      unsigned: record.signatures.length === 0 && overLimit === null,   // an over-limit message was not looked at, so it is not known to be unsigned
      partial_body: record.signatures.some((x) => x.partial_body),
      key_errors: record.signatures.filter((x) => x.key_error).map((x) => /** @type {string} */ (x.key_error)),
      body_status: record.body_status,
      body: record.signatures.map((x) => x.body),
    };
  }

  /**
   * Record a message: verdicts + signed-header record + key archive + one git commit.
   * @param {Buffer | string} raw  The raw RFC-822 bytes.
   * @param {{ direction: 'in' | 'out', source?: string, envelope?: Envelope }} ctx
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord, ots?: 'off' | 'pending' | { error: string } }>}
   *   `ots`: 'off' unless `otsBin` is set; 'pending' once the stamp is committed beside the record; `{ error }`
   *   when stamping failed (the record is committed regardless: accept-with-flag).
   * @name Mailproof#record
   * @when Use to keep a proof of an email (one record per distinct copy, marked `direct` / `relayed` / `forward` / `digest`): it stores the signed headers, the signature, the archived key, both verdicts and the body status (`body_status`: did the body match the signed `bh=`, with hints on what changed) as one git commit, and never the body. Call it for every email you may need to prove later, including ones that fail verification (they are recorded as `unverified`).
   * @category proof
   * @signature mp.record(raw: Buffer|string, ctx: { direction: 'in'|'out', source?: string, envelope?: Envelope }) => Promise<{ id, duplicate, commit, record?, ots? }>
   * @fails Throws on an empty message, a `direction` other than 'in'/'out', a git failure (the tree is rolled back: only files this call created are removed), or `err.code === 'ERR_TRAIL_LOCKED'` when another process holds the trail's writer lock for longer than `lockTimeoutMs` (nothing is written; retry later). Never throws because the mail is unsigned or fails verification. A message over an input limit, or one the worker backstop stopped (see `check()`), is still recorded (committed, accept-with-flag) but never parsed or verified, and no DNS is asked: `unverified` with `reason: 'over limit: <name>'` on both verdicts, `signatures: []`, `body_status` `not-checked`, and only the `id`, `raw_sha256` and `size` taken from the bytes (`message_id` null, no attachments, `copy.kind` `unknown`, `message_key` null). This includes a header block over 256 KiB, which used to reject with `EMAXLEN` and record nothing. The id is the hash of the raw bytes: the identical bytes recorded twice return `duplicate: true` and write nothing, while a copy with any byte difference (a list footer, an added header) is its own record, linked by `message_key` (see `copies()`). An OTS failure or timeout is reported in `ots`, not thrown; the stamp runs inside the writer lock, so it is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms.
   * @example
   * const { id, duplicate } = await mp.record(fs.readFileSync('mail.eml'), { direction: 'in', source: 'file' });
   */
  async record(raw, ctx) {
    if (!ctx || (ctx.direction !== 'in' && ctx.direction !== 'out')) throw new Error("record: ctx.direction must be 'in' or 'out'");
    const source = typeof ctx.source === 'string' && ctx.source ? ctx.source.slice(0, 200) : 'api';
    const { record, keyFiles } = await this._build(raw, { direction: ctx.direction, source, envelope: ctx.envelope });
    return this._commit(record, keyFiles);
  }

  /**
   * Commit a built record under the trail lock (OTS stamp included when enabled). The one commit path of
   * `record()` and of `_recordDigest()`.
   * @param {MpRecord} record
   * @param {Array<{ rel: string, json: unknown }>} keyFiles
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord, ots?: 'off' | 'pending' | { error: string } }>}
   */
  async _commit(record, keyFiles) {
    const message = `record ${record.id.slice(0, 12)} ${record.direction} ${record.verdicts.live.trust}/${record.verdicts.portable.trust}`;
    const ots = this.ots;
    /** @type {'off' | 'pending' | { error: string }} */
    let otsState = ots ? { error: 'not attempted' } : 'off';
    const afterWrite = ots ? async (/** @type {string} */ recordAbs) => {
      const st = await ots.stampFile(recordAbs);
      if ('error' in st) { otsState = { error: st.error }; return []; }
      otsState = 'pending';
      return [`records/${record.id}.json.ots`];
    } : undefined;
    // an index this instance has open takes the record in the same lock; if that fails the next query catches up
    const afterCommit = async (/** @type {string} */ commit) => { await this._ix?.applyCommitted(record, commit); };
    const res = await commitRecord(this.root, this.trail, { record, keyFiles, message, now: this.now, afterWrite, afterCommit, lockTimeoutMs: this.lockTimeoutMs });
    return res.duplicate
      ? { id: record.id, duplicate: true, commit: res.commit }
      : { id: record.id, duplicate: false, commit: res.commit, record, ots: otsState };
  }

  /**
   * INTERNAL (used by sync, not an export, not a primitive): record an over-size message that was streamed
   * through a hash and never held. Builds exactly the over-limit record `record()` writes for the same bytes
   * (`over limit: total_bytes`, same id), so a later pipe capture of that message is a duplicate. Nothing is parsed.
   * @param {{ raw_sha256: string, size: number }} digest  `raw_sha256` in the `sha256:<hex>` form of hashDocument.
   * @param {{ direction: 'in' | 'out', source: string }} ctx
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord }>}
   */
  async _recordDigest(digest, ctx) {
    const captured = this.now().toISOString();
    const { record, keyFiles } = overLimitRecordFromDigest(digest, ctx, { captured, hasEnvelope: false, trustedSealers: this.trustedSealers }, 'total_bytes');
    return this._commit(record, keyFiles);
  }

  /**
   * The text the sender newly wrote in a recorded reply (quoted history removed), with proof flags, and a small
   * `reply-text` record committed to the trail (SPEC B6).
   * @param {Buffer | string} raw  The raw RFC-822 bytes of a message already recorded in this trail.
   * @returns {Promise<ReplyText>}
   * @name Mailproof#replyText
   * @when Use to read what a person actually wrote in a reply they sent you, without the quoted history (the trap: a reply that quotes "Approve payment of $5,000?" is not an approval). Record the email first (`record()`, or `sync()`), then hand the same raw bytes to this. `text` is the new text; `proven` is true only when the recorded body matched the signed `bh=` (`body_status` `matched`), so the text really came from that signed email; `quote` says whether a quote boundary was found (`found`), none was (`not-found`: the whole body is returned) or the answer is written inside the quote (`inline`); `trailing` says unquoted text follows the quote and was not returned. The stripper is the versioned, deterministic `mailproof-quote/1`: anyone with the raw email re-runs it and gets the same text byte for byte. Signatures are not stripped. Interpreting the text (approve or decline, in any language) is the consumer's job, not mailproof's.
   * @category proof
   * @signature mp.replyText(raw: Buffer|string) => Promise<{ id, text, text_sha256, text_bytes, quote, trailing, source, boundary, stripper, body_status, proven, commit, duplicate }>
   * @fails Rejects with `err.code === 'ERR_NOT_RECORDED'` when the message is not committed in this trail (record it first), `ERR_OVER_LIMIT` with `err.limit` set when the message is over an input limit or the worker backstop stopped it (`total_bytes`, ..., `time`, `memory`, `crash`; nothing is written), `ERR_TRAIL_LOCKED` when another writer holds the trail longer than `lockTimeoutMs`, or a plain Error on an empty message or a git failure (rolled back). A message with no text/plain part is not an error: `source: 'html-only'`, `text` '' and `proven` false. The committed record holds fingerprints and flags only, never the text, the body or the subject; the same message and stripper version again returns the text with `duplicate: true` and writes nothing. `partial` body status (an `l=` signed prefix) is unproven in v1. `proven: false` is normal for mail received at Outlook/msn from outside (Microsoft alters the body): the words are unproven while the signed headers still verify; receive replies whose words matter at Gmail.
   * @example
   * const { id } = await mp.record(raw, { direction: 'in' });
   * const r = await mp.replyText(raw);   // r.text, r.proven, r.quote, r.trailing
   */
  async replyText(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    if (buf.length === 0) throw new Error('Mailproof: empty message');
    const id = hashDocument(buf).replace(/^sha256:/, '').slice(0, 32);   // the id record() gives these bytes
    const rec = await this.get(id);
    if (!rec) throw Object.assign(new Error(`replyText: message ${id} is not recorded in trail "${this.trail}"`), { code: 'ERR_NOT_RECORDED' });
    /** @type {import('./reply-text.js').Extracted} */
    let ex;
    if (this.worker.size === 0) ex = extractReplyText(buf);
    else {
      this._lease ??= leasePool(this.worker);
      const r = await this._lease.runReplyText(buf);
      ex = 'out' in r ? r.out : { ok: false, limit: r.limit };
    }
    if (!ex.ok) throw Object.assign(new Error(`replyText: over limit: ${ex.limit}`), { code: 'ERR_OVER_LIMIT', limit: ex.limit });
    const s = ex.stripped;
    const body_status = rec.body_status ?? 'not-checked';
    const row = replyTextRecord({ id, stripped: s, body_status, extracted_at: this.now().toISOString() });
    const res = await commitFiles(this.root, this.trail, {
      rel: replyTextPath(id), json: row, requires: `records/${id}.json`,
      message: `reply-text ${id.slice(0, 12)} ${STRIPPER} ${s.quote}`,
      now: this.now, lockTimeoutMs: this.lockTimeoutMs,
    });
    return {
      id, text: s.text, text_sha256: s.text_sha256, text_bytes: s.text_bytes, quote: s.quote, trailing: s.trailing,
      source: s.source, boundary: s.boundary, stripper: STRIPPER, body_status,
      proven: s.source === 'text/plain' && body_status === 'matched', commit: res.commit, duplicate: res.duplicate,
    };
  }

  /**
   * Offline re-check from the record alone (no DNS, no raw email). `at`
   * defaults to the record's capture time; a bad capture time fails closed.
   * `trust` is the portable level recomputed now, never read from the stored verdict.
   * @param {MpRecord | string} recordOrId  A record, its JSON, or a trail id.
   * @param {{ at?: Date | number | string }} [opts]
   * @returns {Promise<{ ok: boolean, trust: 'verified' | 'unverified', basis: 'dkim' | 'none', at: string | null, engine: { rules: string, mailauth: string }, signatures: Array<Record<string, any>>, error?: string }>}
   * @name Mailproof#verify
   * @when Use to re-check a recorded email later, offline, from the record alone (no DNS, no raw email). It judges `x=`/`t=` as of capture time, so a valid record stays valid after the signature's expiry. Pass `at` only to ask "was it valid at T?".
   * @category verify
   * @signature mp.verify(recordOrId: Record|string, opts?: { at?: Date|number|string }) => Promise<{ ok, trust, basis, at, engine, signatures[] }>
   * @fails Never throws. An unknown id, junk input, a tampered record or a missing or garbled `captured` comes back `ok: false` (fail closed). `ok` means at least one signature verifies; `trust` is the portable level recomputed now.
   * @example
   * const v = await mp.verify(id);
   * if (v.ok && v.trust === 'verified') console.log('signature holds against the archived key');
   */
  async verify(recordOrId, opts) {
    const at = opts && typeof opts === 'object' ? opts.at : undefined;
    const rec = await this._resolve(recordOrId);
    if (!rec) return { ok: false, trust: 'unverified', basis: 'none', at: null, engine: engine(), signatures: [], error: 'record not found' };
    const v = verifyRecord(rec, at === undefined ? {} : { at });
    return { ok: v.ok, trust: v.trust, basis: v.basis, at: v.at, engine: engine(), signatures: v.signatures };
  }

  /**
   * Body-match: hash a raw email's body against the record's `bh=`. A match
   * that also verifies at capture time is a full proof (`full`).
   * @param {MpRecord | string} recordOrId
   * @param {Buffer | string} raw
   * @returns {Promise<{ match: boolean, full: boolean, signatures: Array<{ index: number, d: string | null, s: string | null, match: boolean }> }>}
   * @name Mailproof#matchBody
   * @when Use when the original email turns up later (a mailbox copy, an .eml) and you want to know it is the one the record signed. A match upgrades the record to a full proof (`full`).
   * @category verify
   * @signature mp.matchBody(recordOrId: Record|string, raw: Buffer|string) => Promise<{ match, full, signatures[] }>
   * @fails Never throws on a malformed record (non-array `signatures`, junk entries: `match: false`). Returns `match: false` for a different email, an unknown record, a message over an input limit (not examined, see `check()`) or a body altered in transit (mail exported by some clients is altered; `verify()` can still pass in that case).
   * @example
   * const m = await mp.matchBody(id, fs.readFileSync('mail.eml'));   // m.full
   */
  async matchBody(recordOrId, raw) {
    const rec = await this._resolve(recordOrId);
    if (!rec) return { match: false, full: false, signatures: [] };
    return matchBodyRecord(rec, raw);
  }

  /**
   * File-match: is this file one of the record's attachments (by sha256)?
   * @param {MpRecord | string} recordOrId
   * @param {Buffer | Uint8Array | string} bytes
   * @returns {Promise<{ match: boolean, attachment: { index: number, filename: string | null, size: number, sha256: string } | null }>}
   * @name Mailproof#matchFile
   * @when Use to check that a file is the attachment recorded at capture time (its sha256 matches). The hash is self-recorded and timestamped; it is tied to the DKIM signature only if you also produce the body (`matchBody`).
   * @category verify
   * @signature mp.matchFile(recordOrId: Record|string, bytes: Buffer|Uint8Array|string) => Promise<{ match, attachment }>
   * @fails Never throws on a malformed record (non-array `attachments`, junk entries: `match: false`). Junk `bytes` (not a Buffer, Uint8Array or string) also return `{ match: false, attachment: null }` rather than throwing. `match: false` for any other bytes or an unknown record.
   * @example
   * const f = await mp.matchFile(id, fs.readFileSync('contract.pdf'));   // f.attachment.filename
   */
  async matchFile(recordOrId, bytes) {
    const rec = await this._resolve(recordOrId);
    if (!rec) return { match: false, attachment: null };
    return matchFileRecord(rec, bytes);
  }

  /**
   * Read one record from the trail.
   * @param {string} id  32 hex chars.
   * @returns {Promise<MpRecord | null>}
   * @name Mailproof#get
   * @when Use to read one stored record (to export it, or to hand to `verifyRecord`). Use `list()` first if you do not have an id.
   * @category read
   * @signature mp.get(id: string) => Promise<Record|null>
   * @fails Never throws. Returns null for an unknown id or anything that is not 32 hex characters.
   * @example
   * const rec = await mp.get(id);
   */
  async get(id) {
    return readRecord(this.root, id);
  }

  /**
   * Every recorded copy of one message, plus the records (forwards, list digests) that carry it as an attachment.
   * @param {string} idOrKey  A record id or a `message_key` (32 hex each).
   * @returns {Promise<{ message_key: string | null, original: string | null, copies: Array<CopySummary>, contained_in: Array<CopySummary> }>}
   * @name Mailproof#copies
   * @when Use to see every route one signed message reached you by (direct, via a mailing list, forwarded), given the id of any copy or the shared `message_key`. `copies` share the key; `contained_in` lists other records that carry it as an attached original (forwards and list digests). `original` is the earliest `direct` copy whose body matched, or null. Use `get(id)` for a full record.
   * @category read
   * @signature mp.copies(idOrKey: string) => Promise<{ message_key, original, copies[], contained_in[] }>
   * @fails Rejects with `err.code === 'ERR_INDEX_UNAVAILABLE'` when the `better-sqlite3` native addon cannot load on this platform (there is no fallback; `record`, `get` and `verify` do not need it), or `ERR_TRAIL_LOCKED` when bringing the trail index up to date had to wait for a writer longer than `lockTimeoutMs`. Otherwise never throws. An unknown id or key, or a record with no `message_key` (unsigned mail with no Message-ID), returns just that record (or nothing) with empty `contained_in`. Answers come from the trail index (SPEC B5), a cache beside the trail: whoever can write that file can change this answer, never `get` or `verify`.
   * @example
   * const { copies, contained_in, original } = await mp.copies(id);
   */
  async copies(idOrKey) {
    return (await this._index()).copies(idOrKey);
  }

  /**
   * List records, newest capture first.
   * @param {{ limit?: number, direction?: 'in' | 'out' }} [opts]
   * @returns {Promise<Array<{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }>>}
   * @name Mailproof#list
   * @when Use to find recorded emails, newest capture first, optionally by direction. It returns summaries; use `get(id)` for the full record.
   * @category read
   * @signature mp.list(opts?: { limit?: number, direction?: 'in'|'out' }) => Promise<Array<{ id, captured, direction, live, portable, message_id }>>
   * @fails Rejects with `err.code === 'ERR_INDEX_UNAVAILABLE'` when the `better-sqlite3` native addon cannot load on this platform (there is no fallback; `record`, `get` and `verify` do not need it), or `ERR_TRAIL_LOCKED` when bringing the trail index up to date had to wait for a writer longer than `lockTimeoutMs`. Otherwise never throws. An empty or missing trail returns `[]`. Records captured in the same instant come in ascending id order. Answers come from the trail index (SPEC B5), a cache beside the trail: whoever can write that file can change this answer, never `get` or `verify`.
   * @example
   * const recent = await mp.list({ limit: 10 });
   */
  async list({ limit, direction } = {}) {
    return (await this._index()).list({ limit, direction });
  }

  /**
   * The trail index handle (index-db.js, loaded on the first `list`/`copies`, so no other method pays for it).
   * @returns {Promise<import('./index-db.js').TrailIndex>}
   */
  async _index() {
    if (!this._ix) {
      const { createIndex } = await import('./index-db.js');
      this._ix ??= createIndex({ root: this.root, trail: this.trail, lockTimeoutMs: this.lockTimeoutMs });
    }
    return this._ix;
  }

  /**
   * Capture mail over IMAP: read one mailbox, read-only, and `record()` every message in it (inbox folders as
   * `in`, the Sent folder as `out`). A resume cursor (a sidecar file beside the trail, not in git) makes the next
   * call fetch only what is new; a capped run is continued by calling again until `complete` is true.
   * @param {import('./sync.js').SyncOptions} opts
   * @returns {Promise<import('./sync.js').SyncResult>}
   * @name Mailproof#sync
   * @when Use to record the mail in a mailbox you can log in to (Gmail with an app password, or any IMAP server with an OAuth2 access token you obtained), from a cron job or a one-off backfill, instead of piping each mail in by hand. The mailbox is only read: nothing is marked seen, moved or deleted. Run it again to pick up new mail; loop until `complete` is true to backfill a large folder.
   * @category capture
   * @signature mp.sync(opts: { host: string, port?: number, user: string, auth: { pass: string } | { accessToken: string }, folders?: string[], sent?: boolean|string, maxMessages?: number, maxBytes?: number, tls?: { ca?: string|Buffer|Array } }) => Promise<{ complete: boolean, folders: Array<{ folder, direction, attempted, uidvalidity, reset, last_uid, seen, recorded, duplicate, over_limit, skipped[], bytes, complete, error }> }>
   * @fails Throws a TypeError for bad options, before any connection. Then it throws only when the whole run is pointless: `ERR_IMAP_AUTH` (login refused; the message never contains the credential), `ERR_IMAP_CONNECT` (server unreachable, or its TLS certificate did not verify: TLS is always on and certificate checking is never off), `ERR_SYNC_LOCKED` (another `sync` on this trail is running: it fails at once, so a cron job skips an overlapping run). A problem in one folder lands in that folder's `error` (`ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`) and the run goes on to the next folder. The first trail error (`ERR_TRAIL_LOCKED` or any `record()` failure) stops the run: that folder carries the error, later folders come back `attempted: false`, and progress already recorded stays recorded. It never throws because a message is unsigned, fails verification or is over a limit: those are recorded `unverified`. A message over 25 MiB is stream-hashed and recorded `over limit: total_bytes`; over 128 MiB it is listed in `skipped` and not recorded. Caps per folder per run: 1,000 messages and 512 MiB (`maxMessages` and `maxBytes` can only lower them), 30 minutes per call. A caller passes the secret only to `sync`; it is never logged, returned or stored. A restored or replaced trail is detected from the cursor file (`reset: 'trail'`) and rescanned automatically (duplicates are no-ops); no manual step. Leave `otsBin` off for a backfill: every record is stamped inside the trail lock.
   * @example
   * const res = await mp.sync({ host: 'imap.gmail.com', user: 'you@gmail.com', auth: { pass: process.env.APP_PASSWORD } });
   * // res.complete, res.folders[0].recorded; call again until res.complete is true
   */
  async sync(opts) {
    const host = { root: this.root, trail: this.trail, record: this.record, recordDigest: (/** @type {{ raw_sha256: string, size: number }} */ d, /** @type {{ direction: 'in' | 'out', source: string }} */ c) => this._recordDigest(d, c) };
    return runSync(host, opts, {
      openSession: async (args) => (await import('./imap.js')).openSession(args),
    });
  }
}

export { Mailproof, otsTimeoutMs };
