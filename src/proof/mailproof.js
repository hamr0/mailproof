// The proof core. One instance owns one trail (a git repo of records). Methods
// are bound, so `const { verify } = mp` works.

import path from 'node:path';
import fs from 'node:fs/promises';
import { overLimitRecord, overLimitRecordFromDigest } from './over-limit.js';
import { runSync } from './sync.js';
import { workerConfig, leasePool } from './pool.js';
import { guardResolver, systemResolver } from './resolver-guard.js';
import { engine } from './verdict.js';
import { createOts, DEFAULT_OTS_TIMEOUT_MS } from './ots.js';
import { verifyRecord, matchBodyRecord, matchFileRecord } from './recheck.js';
import { checkProfile } from './profile.js';
import { TRAIL_NAME_RE, RECORD_ID_RE, DEFAULT_LOCK_TIMEOUT_MS, commitRecord, commitFiles, readRecord, withTrailLock, trailLockFile } from './trail.js';
import { parseContentOptions, contentDirOf, storeContent, readRaw, readAttachment, expireStore, forgetIds, idsWith, exists, toMs, DAY_MS } from './content.js';
import { recordPath, recordOtsPath, assertTrailLayout } from './layout.js';
import { STRIPPER, replyTextPath, extractReplyText, replyTextRecord } from './reply-text.js';
import { replyBundle } from './reply-facts.js';
import { REPLY_FACTS_MAX } from './limits.js';
import { hashDocument } from './hash.js';
import { runPrune } from './prune.js';
import { runUpgradeStamps } from './ots-upgrade.js';

const OTS_MIN_TIMEOUT_MS = 5000; // floor for the `ots` timeout, however short lockTimeoutMs is

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {{ id: string, captured: string, direction: string, copy: string, body_status: string, live: string, portable: string }} CopySummary */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */
/** @typedef {import('./prune.js').PruneResult} PruneResult */
/** @typedef {{ id: string, text: string, text_sha256: string, text_bytes: number, quote: 'found' | 'not-found' | 'inline', trailing: boolean, source: 'text/plain' | 'html-only', boundary: string | null, stripper: string, body_status: import('./types.js').BodyStatus, proven: boolean, commit: string, duplicate: boolean }} ReplyText */

/** @typedef {import('./content.js').ContentResult} ContentResult */
/** @typedef {{ removed: number, attachments: number, dryRun?: true, ids?: string[] }} Forgotten  A dry run adds `dryRun: true` and the `ids` it names; `removed` and `attachments` are then what would go. */

/**
 * @typedef {Object} MailproofOptions
 * @property {string} trailDir  Directory holding the trails; each trail is a git repo inside it.
 * @property {string} [trail]  Trail name (default "default").
 * @property {(name: string, type?: string) => Promise<any>} [resolver]  mailauth-compatible DNS resolver (tests inject one). A lookup it has not answered within 5 s is answered as the error `dns timeout` (`code: 'ETIMEOUT'`). It must return plain data, as `node:dns` does (a value structured clone refuses, such as a function, is answered as a DNS error, `code: 'EBADRESP'`).
 * @property {string | null} [otsBin]  Path to the `ots` binary; null/absent keeps OpenTimestamps off.
 * @property {() => Date} [now]  Clock (tests inject one).
 * @property {string[]} [trustedSealers]  ARC sealer domains whose chains may yield `forwarded` (live only).
 * @property {import('./pool.js').WorkerOptions} [worker]  The deadline backstop (default on): the parsing and verifying half of `check()`/`record()` runs in a warm worker thread that is killed when one message uses more than `cpuMs` (15000) of the thread's CPU, `wallMs` (120000) of busy wall time (DNS waits excluded) or `maxMemoryMb` (1536) of heap plus external memory. The message is then recorded `unverified` as `over limit: time` / `over limit: memory`; a worker that dies for no nameable reason gives `over limit: crash`. `size` is the number of warm workers (default 1); `size: 0` runs everything in-process, with no backstop. Needs Node 22.19 or later.
 * @property {{ store?: boolean, attachments?: boolean, days?: number, sweepDays?: number }} [content]  The local content store (SPEC B7): the raw email and its attachments, kept beside the trail (`<trailDir>/<trail>.content/`), outside git. `store` (default true) keeps the raw email of every recorded message; `store: false` is "proof only" (nothing is written, the caller supplies raw bytes). `attachments` (default true) also keeps attachment files, once per distinct sha256. `days` (default 730) is how long content is kept after the record's `captured` time. The automatic sweep (`expireContent()`) runs at the end of a `sync()` only when the last sweep is at least `sweepDays` days old (default 7; there is no timer, the first `sync()` after the interval runs it), so content lives between `days` and `days + sweepDays`; an explicit `expireContent()` always runs. Records are never deleted.
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
   * @signature new Mailproof({ trailDir: string, trail?: string, resolver?: Function, otsBin?: string|null, now?: () => Date, trustedSealers?: string[], lockTimeoutMs?: number, worker?: { size?: number, cpuMs?: number, wallMs?: number, maxMemoryMb?: number }, content?: { store?: boolean, attachments?: boolean, days?: number, sweepDays?: number } })
   * @when Start here. Construct one per trail (a git repo of records under `trailDir`), then `record()` each email you want a re-checkable proof of and `verify()` it later, offline. All methods are bound, so `const { verify } = mp` works.
   * @category proof
   * @fails Throws at construction when `trailDir` is missing, `trail` is not `[a-z0-9][a-z0-9_-]{0,63}`, or `worker` or `content` holds an unknown key or a bad value (`content.store` and `content.attachments` must be booleans, `content.days` and `content.sweepDays` positive integers). Nothing touches the disk until the first `record()`. With `otsBin`, the OTS stamp runs inside the writer lock and is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms: a short `lockTimeoutMs` shortens the stamp (5 s floor), and concurrent writers can wait up to that long behind a slow stamp.
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
    this.content = parseContentOptions(opts.content);
    this.contentDir = contentDirOf(this.root);
    /** Internal (tests): called between the unlocked scan and the locked deletions of expiry and forget. @type {import('./content.js').ScanHooks} */
    this._scanHooks = {};
    /** Internal (tests): the seams of prune. @type {import('./prune.js').PruneHooks} */
    this._pruneHooks = {};
    this._autoSweep = this._autoSweep.bind(this);
    /** @type {{ run: import('./pool.js').WorkerPool['run'], runReplyText: import('./pool.js').WorkerPool['runReplyText'], release: () => Promise<void> } | null} */
    this._lease = null;
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
    this.counterparties = this.counterparties.bind(this);
    this.linked = this.linked.bind(this);
    this.checkProfile = this.checkProfile.bind(this);
    this.proofParts = this.proofParts.bind(this);
    this.sync = this.sync.bind(this);
    this.replyText = this.replyText.bind(this);
    this.replyFacts = this.replyFacts.bind(this);
    this.rawEmail = this.rawEmail.bind(this);
    this.attachment = this.attachment.bind(this);
    this.expireContent = this.expireContent.bind(this);
    this.forget = this.forget.bind(this);
    this.prune = this.prune.bind(this);
    this.upgradeStamps = this.upgradeStamps.bind(this);
    this.close = this.close.bind(this);
  }

  /**
   * Build the record for a message (nothing is written): in a worker thread under the deadline backstop
   * (pool.js), or in-process when `worker.size` is 0. A message over an input limit (admit.js) gets the
   * over-limit record: the parsers never see it and no DNS is asked. So does one the backstop stopped
   * (`over limit: time` / `over limit: memory`), or whose worker crashed (`over limit: crash`).
   * @param {Buffer | string} raw
   * @param {{ direction: 'in' | 'out', source: string, envelope?: Envelope }} ctx
   * @param {{ keepAttachments?: boolean }} [opts]  Return the attachment bytes too (`record()` with the content store on).
   * @returns {Promise<import('./build.js').Built>}
   *   `overLimit`: the name of the limit the message exceeded, else null.
   */
  async _build(raw, ctx, { keepAttachments = false } = {}) {
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
      return buildRecord(buf, ctx, { captured, hasEnvelope, trustedSealers, resolver, keepAttachments });
    }
    this._lease ??= leasePool(this.worker);
    const r = await this._lease.run(buf, { ctx, captured, hasEnvelope, trustedSealers, keepAttachments }, resolver);
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
   * @fails Never throws. `list()` and `copies()` keep nothing open between calls, so there is nothing of theirs to close. A call with nothing to stop, or with `worker.size` 0, resolves at once. With a worker (`size` 1 or more), a `record()` or `check()` still running when `close()` is called (or when the last instance sharing the pool closes) may reject, and if it rejects that message is not recorded: await in-flight calls before `close()`.
   * @example
   * await mp.close();
   */
  async close() {
    const lease = this._lease;
    this._lease = null;
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

  /** @mcp Mailproof#check Look at one email (`path` or `base64`) and return both verdicts without recording anything. Unsigned or unverifiable mail comes back `unverified`, not as a failure; a message over an input limit is not parsed at all and says `over limit: <name>`. Judged as of now: a key that has left DNS shows in `key_errors`. The portable verdict covers the signed headers only; read `body_status` for the body. Asks DNS for the signers' keys. */
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

  /** @mcp Mailproof#record Keep a re-checkable proof of one email (`path` or `base64` of its exact bytes, `direction` in or out): the signed headers, signature, archived key, both verdicts and the body status are committed to the trail, the raw email and attachments to the local content store; the body never goes in the trail. Mail that is unsigned, fails verification or is over a limit is still recorded as `unverified`. The same bytes again return `duplicate: true` and write nothing. Fails with `ERR_TRAIL_LOCKED` (retry later) or `ERR_TRAIL_LAYOUT`. */
  /**
   * Record a message: verdicts + signed-header record + key archive + one git commit.
   * @param {Buffer | string} raw  The raw RFC-822 bytes.
   * @param {{ direction: 'in' | 'out', source?: string, envelope?: Envelope }} ctx
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord, ots?: 'off' | 'pending' | { error: string }, content?: ContentResult }>}
   *   `content`: absent when the content store is off (`content.store: false`); else `{ stored, attachments, error? }`: whether the raw email is in the store after this call, how many distinct attachment files are, and the reason when a write failed (the proof is committed regardless). A duplicate of a message whose content is missing (and not yet expired) writes it now.
   *   `ots`: 'off' unless `otsBin` is set; 'pending' once the stamp is committed beside the record; `{ error }`
   *   when stamping failed (the record is committed regardless: accept-with-flag).
   * @name Mailproof#record
   * @when Use to keep a proof of an email (one record per distinct copy, marked `direct` / `relayed` / `forward` / `digest`): it stores the signed headers, the signature, the archived key, both verdicts and the body status (`body_status`: did the body match the signed `bh=`, with hints on what changed) as one git commit, and never the body in the trail. With the content store on (the default) the raw email and its attachments are also kept beside the trail, outside git, for `rawEmail()`, `attachment()`, `replyText({ id })` and `matchBody(id)`. Call it for every email you may need to prove later, including ones that fail verification (they are recorded as `unverified`).
   * @category proof
   * @signature mp.record(raw: Buffer|string, ctx: { direction: 'in'|'out', source?: string, envelope?: Envelope }) => Promise<{ id, duplicate, commit, record?, ots?, content? }>
   * @fails Throws on an empty message, a `direction` other than 'in'/'out', `err.code === 'ERR_TRAIL_LAYOUT'` for a trail still in the pre-M3 flat layout (not converted: re-create it), a git failure (the tree is rolled back: only files this call created are removed), or `err.code === 'ERR_TRAIL_LOCKED'` when another process holds the trail's writer lock for longer than `lockTimeoutMs` (nothing is written; retry later). Never throws because the mail is unsigned or fails verification. A message over an input limit, or one the worker backstop stopped (see `check()`), is still recorded (committed, accept-with-flag) but never parsed or verified, and no DNS is asked: `unverified` with `reason: 'over limit: <name>'` on both verdicts, `signatures: []`, `body_status` `not-checked`, and only the `id`, `raw_sha256` and `size` taken from the bytes (`message_id` null, no attachments, `copy.kind` `unknown`, `message_key` null). This includes a header block over 256 KiB, which used to reject with `EMAXLEN` and record nothing. The id is the hash of the raw bytes: the identical bytes recorded twice return `duplicate: true` and write nothing, while a copy with any byte difference (a list footer, an added header) is its own record, linked by `message_key` (see `copies()`). An OTS failure or timeout is reported in `ots`, not thrown; the stamp runs inside the writer lock, so it is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms. A content-store write failure (disk full, permissions) never fails the call and never loses the proof: the record commits and `content` is `{ stored: false, attachments: 0, error }`. If the commit fails, the content files this call created are removed with the rest. The raw email of a message over 25 MiB is not stored.
   * @example
   * const { id, duplicate } = await mp.record(fs.readFileSync('mail.eml'), { direction: 'in', source: 'file' });
   */
  async record(raw, ctx) {
    if (!ctx || (ctx.direction !== 'in' && ctx.direction !== 'out')) throw new Error("record: ctx.direction must be 'in' or 'out'");
    const source = typeof ctx.source === 'string' && ctx.source ? ctx.source.slice(0, 200) : 'api';
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));   // as _build reads it
    const keepAttachments = this.content.store && this.content.attachments;
    const { record, keyFiles, attachmentBytes } = await this._build(buf, { direction: ctx.direction, source, envelope: ctx.envelope }, { keepAttachments });
    const atts = (attachmentBytes ?? []).map((a) => ({ sha256: a.sha256, bytes: Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength) }));   // a worker hands back plain Uint8Arrays
    return this._commit(record, keyFiles, this.content.store ? { id: record.id, raw: buf, attachments: atts } : null);
  }

  /**
   * Commit a built record under the trail lock (OTS stamp included when enabled). The one commit path of
   * `record()` and of `_recordDigest()`.
   * @param {MpRecord} record
   * @param {Array<{ rel: string, json: unknown }>} keyFiles
   * @param {import('./content.js').ContentJob | null} [content]  What the content store should keep (null: nothing).
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord, ots?: 'off' | 'pending' | { error: string }, content?: ContentResult }>}
   */
  async _commit(record, keyFiles, content = null) {
    const message = `record ${record.id.slice(0, 12)} ${record.direction} ${record.verdicts.live.trust}/${record.verdicts.portable.trust}`;
    const ots = this.ots;
    /** @type {'off' | 'pending' | { error: string }} */
    let otsState = ots ? { error: 'not attempted' } : 'off';
    const afterWrite = ots ? async (/** @type {string} */ recordAbs) => {
      const st = await ots.stampFile(recordAbs);
      if ('error' in st) { otsState = { error: st.error }; return []; }
      otsState = 'pending';
      return [recordOtsPath(record.id)];
    } : undefined;
    /** @type {ContentResult | undefined} */
    let contentState;
    const sideFiles = content ? async (/** @type {boolean} */ duplicate) => {
      if (duplicate) {   // backfill, unless the retention of the existing record has already run out
        const old = await readRecord(this.root, record.id);
        const at = old ? Date.parse(old.captured) : NaN;
        if (Number.isFinite(at) && at < this.now().getTime() - this.content.days * DAY_MS) { contentState = { stored: false, attachments: 0 }; return []; }
      }
      const { result, created } = await storeContent(this.contentDir, this.content, content);
      contentState = result;
      return created;
    } : undefined;
    const res = await commitRecord(this.root, this.trail, { record, keyFiles, message, now: this.now, afterWrite, sideFiles, lockTimeoutMs: this.lockTimeoutMs });
    return res.duplicate
      ? { id: record.id, duplicate: true, commit: res.commit, ...(contentState ? { content: contentState } : {}) }
      : { id: record.id, duplicate: false, commit: res.commit, record, ots: otsState, ...(contentState ? { content: contentState } : {}) };
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

  /** @mcp Mailproof#replyText Read the new text of a reply (without the quoted history) for a recorded email, from the content store, and commit a small fingerprint record of it. `text` is the new text; `proven` is true only when the body matched the signed hash; `quote` says whether a quote boundary was found. Interpreting the text is your job, not mailproof's: a reply that quotes a question is not an answer to it. Fails with `ERR_NO_CONTENT` (content not stored or already forgotten), `ERR_NOT_RECORDED`, `ERR_OVER_LIMIT`, `ERR_TRAIL_LOCKED` (retry) or `ERR_TRAIL_LAYOUT`. */
  /**
   * The text the sender newly wrote in a recorded reply (quoted history removed), with proof flags, and a small
   * `reply-text` record committed to the trail (SPEC B6).
   * @param {Buffer | string | { id: string }} raw  The raw RFC-822 bytes of a message already recorded in this trail, or `{ id }` to read them from the content store.
   * @returns {Promise<ReplyText>}
   * @name Mailproof#replyText
   * @when Use to read what a person actually wrote in a reply they sent you, without the quoted history (the trap: a reply that quotes "Approve payment of $5,000?" is not an approval). Record the email first (`record()`, or `sync()`), then hand the same raw bytes to this, or just `{ id }` when the content store holds them (the default). `text` is the new text; `proven` is true only when the recorded body matched the signed `bh=` (`body_status` `matched`), so the text really came from that signed email; `quote` says whether a quote boundary was found (`found`), none was (`not-found`: the whole body is returned) or the answer is written inside the quote (`inline`); `trailing` says unquoted text follows the quote and was not returned. The stripper is the versioned, deterministic `mailproof-quote/1`: anyone with the raw email re-runs it and gets the same text byte for byte. Signatures are not stripped. Interpreting the text (approve or decline, in any language) is the consumer's job, not mailproof's.
   * @category proof
   * @signature mp.replyText(raw: Buffer|string|{ id: string }) => Promise<{ id, text, text_sha256, text_bytes, quote, trailing, source, boundary, stripper, body_status, proven, commit, duplicate }>
   * @fails `ERR_TRAIL_LAYOUT` for a trail still in the pre-M3 flat layout (not converted: re-create it). `{ id }` with no stored content (store off, expired, forgotten, or the file failed its hash check) rejects with `err.code === 'ERR_NO_CONTENT'`; an `id` that is not 32 hex is a plain Error. Rejects with `err.code === 'ERR_NOT_RECORDED'` when the message is not committed in this trail (record it first), `ERR_OVER_LIMIT` with `err.limit` set when the message is over an input limit or the worker backstop stopped it (`total_bytes`, ..., `time`, `memory`, `crash`; nothing is written), `ERR_TRAIL_LOCKED` when another writer holds the trail longer than `lockTimeoutMs`, or a plain Error on an empty message or a git failure (rolled back). A message with no text/plain part is not an error: `source: 'html-only'`, `text` '' and `proven` false. The committed record holds fingerprints and flags only, never the text, the body or the subject; the same message and stripper version again returns the text with `duplicate: true` and writes nothing. `partial` body status (an `l=` signed prefix) is unproven in v1. `proven: false` is normal for mail received at Outlook/msn from outside (Microsoft alters the body): the words are unproven while the signed headers still verify; receive replies whose words matter at Gmail.
   * @example
   * const { id } = await mp.record(raw, { direction: 'in' });
   * const r = await mp.replyText(raw);   // r.text, r.proven, r.quote, r.trailing
   * const again = await mp.replyText({ id });   // the same, from the stored raw email
   */
  async replyText(raw) {
    /** @type {Buffer} */
    let buf;
    if (raw !== null && typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array) && 'id' in raw) {
      if (typeof raw.id !== 'string' || !RECORD_ID_RE.test(raw.id)) throw new Error('replyText: id must be 32 hex characters');
      const got = await readRaw(this.contentDir, raw.id);
      if (!got.buf) throw Object.assign(new Error(`replyText: no stored content for ${raw.id} in trail "${this.trail}" (${got.status === 'corrupt' ? 'the stored file failed its hash check' : 'not stored, expired or forgotten'})`), { code: 'ERR_NO_CONTENT' });
      buf = got.buf;
    } else buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    if (buf.length === 0) throw new Error('Mailproof: empty message');
    const id = hashDocument(buf).replace(/^sha256:/, '').slice(0, 32);   // the id record() gives these bytes
    const rec = await this.get(id);
    if (!rec) throw Object.assign(new Error(`replyText: message ${id} is not recorded in trail "${this.trail}"`), { code: 'ERR_NOT_RECORDED' });
    const ex = await this._extract(buf);
    if (!ex.ok) throw Object.assign(new Error(`replyText: over limit: ${ex.limit}`), { code: 'ERR_OVER_LIMIT', limit: ex.limit });
    const s = ex.stripped;
    const body_status = rec.body_status ?? 'not-checked';
    const row = replyTextRecord({ id, stripped: s, body_status, extracted_at: this.now().toISOString() });
    const res = await commitFiles(this.root, this.trail, {
      rel: replyTextPath(id), json: row, requires: recordPath(id),
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
   * Strip the quoted history from raw bytes: in the worker under the deadline backstop, or in-process with `worker.size` 0.
   * @param {Buffer} buf
   * @returns {Promise<import('./reply-text.js').Extracted>}
   */
  async _extract(buf) {
    if (this.worker.size === 0) return extractReplyText(buf);
    this._lease ??= leasePool(this.worker);
    const r = await this._lease.runReplyText(buf);
    return 'out' in r ? r.out : { ok: false, limit: r.limit };
  }

  /** @mcp Mailproof#replyFacts List the facts about every recorded direct reply to an email you sent, given its `messageId`, earliest first: sender (`from`), whether an aligned DKIM signature covers From (`fromDkimAligned`), `link` strength to the request, `bodyProven`, the new `text` and `firstLine`, authentication results and both verdicts. `[]` means no reply yet. Copies of one signed message are separate entries with one `messageKey`. Deciding what a reply means is your job: judge by these fields, never by the text alone. Fails with `ERR_TOO_MANY_REPLIES` (over 200: nothing is cut), `ERR_INDEX_UNAVAILABLE` or `ERR_TRAIL_LOCKED` (retry). */
  /**
   * The facts about every direct reply to one email, as flat string-only bundles: who sent it and whether DKIM proves
   * it, the verdicts, how the reply links to the request, and the new text with its first line. Read-only.
   * @param {{ messageId: string }} opts  `messageId`: the Message-ID of the request, as in its header (`<id@host>`; the angle brackets are added when missing).
   * @returns {Promise<Array<Record<string, string>>>}
   * @name Mailproof#replyFacts
   * @when Use to learn what the people you wrote to answered, without interpreting it: pass the Message-ID of the email you sent (the request) and get one bundle per recorded inbound DIRECT reply (its In-Reply-To names the request, or the request is the last entry of its References; later messages deeper in the thread are not included), earliest capture first. `[]` means no reply yet. Every value is a string from a closed set or free text, so a rule engine can compare them exactly: `from` (lower-case), `fromDkimAligned` (pass: an aligned DKIM signature that verifies offline covers From), `link` (signed/unsigned/none: is the request in a signed In-Reply-To/References), `bodyProven`, `quote`, `trailing`, `firstLine`, `text`, `dkim`/`dmarc`/`spf`/`arc`, `live`/`portable` (trust levels), `commit`, `recordId`, `messageKey` and more (SPEC B10). Copies of one signed message are separate bundles with the same `messageKey`; mailproof never picks or filters, the consumer groups and decides (an approval rule: allow only when at least one distinct reply is green and none is red). Nothing is written to the trail; the text comes from the local content store, so an expired, forgotten or disabled store gives `text` and `firstLine` of "" with `textSource` "none".
   * @category read
   * @signature mp.replyFacts(opts: { messageId: string }) => Promise<Array<{ messageId, messageKey, recordId, commit, trail, captured, from, fromRaw, fromDomain, fromDkimAligned, to, toRaw, cc, ccRaw, date, dateSource, subject, subjectSource, dkim, dmarc, spf, arc, live, portable, link, text, firstLine, textSource, bodyProven, quote, trailing, attachments }>>
   * @fails Rejects with a TypeError when `messageId` is not a non-empty string, `ERR_TOO_MANY_REPLIES` when more than 200 direct replies exist (a flood; nothing is cut silently), and with `ERR_INDEX_UNAVAILABLE` or `ERR_TRAIL_LOCKED` exactly like `list()` (the lookup uses the trail index). An unrecorded request, an empty trail or no reply gives `[]`. A reply with no Message-ID has `messageId` "".
   * @example
   * const replies = await mp.replyFacts({ messageId: '<q-123@mail.example>' });
   * for (const r of replies) console.log(r.from, r.fromDkimAligned, r.link, r.firstLine);
   */
  async replyFacts(opts) {
    const raw = opts && typeof opts === 'object' ? opts.messageId : undefined;
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('replyFacts: messageId must be a non-empty string');
    const t = raw.trim();
    const messageId = t.startsWith('<') ? t : `<${t}>`;
    const { repliesIndex } = await import('./index-db.js');
    const rows = await repliesIndex(this._indexCfg(), messageId);
    if (rows.length > REPLY_FACTS_MAX) throw Object.assign(new Error(`replyFacts: more than ${REPLY_FACTS_MAX} direct replies to ${messageId}`), { code: 'ERR_TOO_MANY_REPLIES' });
    /** @type {Array<Record<string, string>>} */
    const out = [];
    for (const row of rows) {
      const rec = await readRecord(this.root, row.id);
      if (!rec) continue;
      const got = await readRaw(this.contentDir, row.id);
      /** @type {import('./reply-facts.js').TextFacts} */
      let text = { source: 'none' };
      if (got.buf) {
        const ex = await this._extract(got.buf);
        text = ex.ok ? { source: 'content', text: ex.stripped.text, quote: ex.stripped.quote, trailing: ex.stripped.trailing, textPlain: ex.stripped.source === 'text/plain' } : { source: 'over-limit' };
      }
      out.push(replyBundle({ rec, parent: messageId, commit: row.commit, trail: this.trail, raw: text.source === 'content' ? got.buf : null, text }));
    }
    return out;
  }

  /**
   * The stored raw email of a record, re-hashed on read.
   * @param {string} id  32 hex chars.
   * @returns {Promise<Buffer | null>}
   * @name Mailproof#rawEmail
   * @when Use to get the original bytes of a recorded email back from the local content store (on by default), long after the mailbox has deleted it: hand them to any DKIM tool, to `replyText`, or to an auditor. Nothing leaves the machine. The bytes are checked on every read: their sha256 must be the id, so what you get is exactly what was captured.
   * @category read
   * @signature mp.rawEmail(id: string) => Promise<Buffer|null>
   * @fails Never throws. Returns null for an unknown or malformed id, a store that is off or never held it, content that expired or was forgotten, and a stored file whose hash is not the id (a corrupt or tampered file is never returned; the record still verifies). Takes no lock.
   * @example
   * const raw = await mp.rawEmail(id);   // Buffer or null
   */
  async rawEmail(id) {
    return (await readRaw(this.contentDir, id)).buf;
  }

  /**
   * A stored attachment by its sha256, re-hashed on read.
   * @param {string} sha256  `sha256:<hex>` as in `record.attachments[].sha256` (bare hex also works).
   * @returns {Promise<Buffer | null>}
   * @name Mailproof#attachment
   * @when Use to get an attachment of a recorded email back from the local content store (the sha256 comes from `get(id).attachments[]`). An attachment is stored once however many emails carried it.
   * @category read
   * @signature mp.attachment(sha256: string) => Promise<Buffer|null>
   * @fails Never throws. Returns null for a malformed hash, a store without attachments (`content.attachments: false`, or `store: false`), content that expired or was forgotten, and a stored file whose sha256 is not the one asked for (never returned). Takes no lock.
   * @example
   * const [a] = (await mp.get(id)).attachments;
   * const bytes = await mp.attachment(a.sha256);
   */
  async attachment(sha256) {
    return (await readAttachment(this.contentDir, sha256)).buf;
  }

  /**
   * Delete stored content older than the retention (`content.days`, counted from each record's `captured`).
   * @param {{ now?: Date | number }} [opts]  `now` overrides the clock (tests).
   * @returns {Promise<Forgotten>}
   * @name Mailproof#expireContent
   * @when Use to enforce retention on demand; `sync()` already calls it at the end of a run, but only when the last automatic sweep is at least `content.sweepDays` days old (default 7; content therefore lives between `days` and `days + sweepDays`). Only content goes (raw emails, and attachment files no remaining stored email references): records, archived keys and git history are never touched, so every proof still verifies.
   * @category content
   * @signature mp.expireContent(opts?: { now?: Date|number }) => Promise<{ removed: number, attachments: number }>
   * @fails Rejects with `ERR_TRAIL_LOCKED` when another writer holds the trail longer than `lockTimeoutMs` (nothing is deleted; retry later), `ERR_TRAIL_LAYOUT` for a trail still in the pre-M3 flat layout (not converted: re-create it), or a TypeError for a `now` that is not a Date or finite number. A missing content directory returns zeros without creating anything. A record that cannot be read, or has no usable `captured`, keeps its content. Idempotent. The scan of stored emails runs without the trail lock (writers carry on); the lock is held only for the deletions, so it is short whatever the trail's size. If the trail's history was rewritten during the scan nothing is deleted this round. Cost of the scan grows with the number of stored emails (SPEC B7).
   * @example
   * const { removed, attachments } = await mp.expireContent();
   */
  async expireContent({ now } = {}) {
    const nowMs = now === undefined ? this.now().getTime() : toMs(now, 'now');
    if (!(await exists(this.contentDir))) return { removed: 0, attachments: 0 };
    await assertTrailLayout(this.root);
    const res = await expireStore(this.root, this.contentDir, this.content.days, nowMs, (w) => this._lock(w), this._scanHooks);
    await this._markSwept();
    return res;
  }

  /**
   * Run `work` under the trail lock (the deletion phase of expiry and forget).
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  _lock(work) { return withTrailLock(this.root, trailLockFile(this.trail), this.lockTimeoutMs, work); }

  /** @returns {string} The file that remembers when the last retention sweep completed (beside the trail, not in git). */
  _sweepFile() { return path.join(path.dirname(this.root), `.${this.trail}.content-sweep.json`); }

  /** Record that a sweep just completed (atomic: temp file, then rename). Best effort: a failure only means the next run sweeps again. @returns {Promise<void>} */
  async _markSwept() {
    const file = this._sweepFile();
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ last: this.now().toISOString() }) + '\n');
      await fs.rename(tmp, file);
    } catch { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }

  /**
   * The automatic sweep `sync()` runs: `expireContent()` only when the last completed sweep is `content.sweepDays` days old or more
   * (or unknown, unreadable, or dated in the future). Uses the instance clock.
   * @returns {Promise<{ removed: number, attachments: number } | null>}  null when it was skipped.
   */
  async _autoSweep() {
    if (!(await exists(this.contentDir))) return null;
    try {
      const last = Date.parse(JSON.parse(await fs.readFile(this._sweepFile(), 'utf8')).last);
      const now = this.now().getTime();
      if (Number.isFinite(last) && last <= now && now - last < this.content.sweepDays * DAY_MS) return null;
    } catch { /* no usable marker: sweep */ }
    return this.expireContent();
  }

  /** @mcp Mailproof#forget Delete the stored raw email and attachment files of chosen emails; the proofs stay and still re-verify offline. Name the emails with `ids` (record ids) or with `with` (one exact address on From, To, Cc or Reply-To, case-insensitive; `before` and `after` bound the capture time), never both. An id with nothing stored is not an error. Fails with `ERR_TRAIL_LOCKED` (retry) or `ERR_TRAIL_LAYOUT` (an old flat trail). */
  /**
   * Delete the stored content of chosen emails now, keeping their proofs.
   * @param {string | string[] | { with: string, before?: Date | number | string, after?: Date | number | string }} target  A record id, an array of ids, or every stored email with a counterparty: `with` is one exact address on the From, To, Cc or Reply-To line (case-insensitive), `after` (inclusive) and `before` (exclusive) bound the capture time.
   * @param {{ dryRun?: boolean }} [opts]  `dryRun`: delete nothing and return what would go (default false).
   * @returns {Promise<Forgotten>}
   * @name Mailproof#forget
   * @when Use to erase what you hold of other people's mail earlier than retention would: one email, a list, or everything with one correspondent. Only the raw email and attachment files not needed by any remaining stored email are deleted. The proof stays: headers, verdicts, hashes and archived keys still re-verify offline, and anyone who later produces the raw email (sha256 = the record id) or an attachment gets it re-checked.
   * @category content
   * @signature mp.forget(target: string|string[]|{ with: string, before?, after? }, opts?: { dryRun?: boolean }) => Promise<{ removed: number, attachments: number, dryRun?: true, ids?: string[] }>
   * @fails Throws a TypeError for a malformed id, an empty or non-string `with`, a bad `before`/`after`, or a bad `opts`/`dryRun`; `ERR_TRAIL_LOCKED` and `ERR_TRAIL_LAYOUT` as `expireContent()`. An id with nothing stored is not an error (`removed` counts only what was deleted), so it is idempotent. The counterparty is found from the From/To/Cc/Reply-To lines of the signed headers in the record, of the unsigned record's `from`, and of the stored raw email's header block; the match is exact, `bob@gmail.com` is not `bob@company.com`.
   * @example
   * await mp.forget(id);
   * await mp.forget({ with: 'bob@example.com', before: '2026-01-01' });
   * const plan = await mp.forget({ with: 'bob@example.com' }, { dryRun: true });   // plan.ids, plan.removed: nothing deleted
   */
  async forget(target, opts) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some((k) => k !== 'dryRun') || (opts.dryRun !== undefined && typeof opts.dryRun !== 'boolean'))) throw new TypeError('forget: opts must be { dryRun?: boolean }');
    const dryRun = opts?.dryRun === true;
    /** @type {string[] | null} */
    let ids = null;
    /** @type {{ with: string, before?: Date | number | string, after?: Date | number | string } | null} */
    let query = null;
    if (typeof target === 'string') ids = [target];
    else if (Array.isArray(target)) ids = target;
    else if (target && typeof target === 'object') {
      if (typeof target.with !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(target.with.trim())) throw new TypeError('forget: with must be an email address');
      toMs(target.before ?? 0, 'before'); toMs(target.after ?? 0, 'after');   // validate before taking the lock
      query = target;
    } else throw new TypeError('forget: target must be an id, an array of ids, or { with }');
    if (ids) for (const id of ids) if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) throw new TypeError('forget: ids must be 32 hex characters');
    if (!(await exists(this.contentDir))) return dryRun ? { removed: 0, attachments: 0, dryRun: true, ids: ids ? [...new Set(ids)] : [] } : { removed: 0, attachments: 0 };
    await assertTrailLayout(this.root);
    const list = ids ?? await idsWith(this.root, this.contentDir, /** @type {NonNullable<typeof query>} */ (query));   // the scan holds no lock
    return forgetIds(this.root, this.contentDir, list, (w) => this._lock(w), this._scanHooks, dryRun);
  }

  /** @mcp Mailproof#prune Remove everything captured before the date `before` (records, reply-text commits, stamps, stored content): the trail is rewritten, the old one is kept beside it as a backup. Rare and never scheduled. The result lists what is removed and kept and `stragglers`; `noop: true` means nothing was captured before `before`. It can take minutes on a big trail. Fails with `ERR_PRUNE_RUNNING` (another prune, retry later), `ERR_PRUNE_CUTOFF` (everything is older than `before`), `ERR_PRUNE_REWRITTEN` (run it again), `ERR_SYNC_LOCKED` or `ERR_TRAIL_LOCKED` (nothing changed, retry), `ERR_PRUNE_VERIFY`, `ERR_PRUNE_JOURNAL` or `ERR_TRAIL_LAYOUT` (stop and tell the user). */
  /**
   * Delete everything captured before a date: a pruned copy of the trail replaces it, and the old one is kept as a backup.
   * @param {{ before: Date | number | string, deleteBackup?: boolean, dryRun?: boolean, now?: Date | number }} opts  `before` (required): records captured strictly before it are removed. `deleteBackup`: remove the backup after a successful swap (default false). `dryRun`: compute and return what a prune would do, change nothing (default false). `now` overrides the clock (tests).
   * @returns {Promise<PruneResult>}
   * @name Mailproof#prune
   * @when Use to drop old mail from a trail on purpose, for example to honour a retention promise longer than `content.days`, or to shrink a trail that has grown large: every record, reply-text record, OpenTimestamps stamp and stored content captured before `before` goes, and the trail starts with a prune notice that says what was removed. Everything kept is byte-identical and still verifies offline; only the commit ids change. It is an explicit, rare, never-scheduled operation: it rewrites history. The old trail stays as `<trail>.pre-prune-<date>` beside it (still holding everything pruned) until you delete it, or pass `deleteBackup: true`. Writers keep working while the pruned trail is built; they wait only for the short swap.
   * @category content
   * @signature mp.prune(opts: { before: Date|number|string, deleteBackup?: boolean, dryRun?: boolean, now?: Date|number }) => Promise<{ cutoff, noop, dryRun, previousHead, head, removed, kept, stragglers: string[], dropped, keysCarried, reverify: { ok, failed: string[] }, backup: string|null, content: { removed, attachments, error? }, timing }>
   * @fails Throws a TypeError for a missing or bad `before`, `deleteBackup`, `dryRun` or `now`, or an unknown option, before anything is read. `ERR_PRUNE_RUNNING` when another prune of this trail is running (at once). `ERR_SYNC_LOCKED` when a `sync` kept running for more than 31 minutes while the swap waited for it, `ERR_TRAIL_LOCKED` when a writer held the trail longer than `lockTimeoutMs` at the swap: in both nothing was changed. `ERR_PRUNE_CUTOFF` when every record is older than `before` (a trail with nothing left is refused). `ERR_PRUNE_REWRITTEN` when the history was rewritten while the pruned trail was built (run it again). `ERR_PRUNE_VERIFY` when the pruned trail did not match the old one (a bug; nothing was changed). `ERR_PRUNE_JOURNAL` when a crashed earlier prune left a state it cannot recognise (nothing is touched; see SPEC B9.4). `ERR_TRAIL_LAYOUT` for a flat pre-M3 trail. A `before` that removes nothing returns `noop: true` and changes nothing (no rewrite, no backup). Records captured before `before` that sit after a later one are kept and listed in `stragglers` (only a prefix of history is ever removed, never a range in the middle); reply-text commits for removed records are `dropped`. The result's `reverify` re-checks every kept record offline; a record that does not verify is listed, never a reason to stop. The time is about quadratic in the trail size on git's side (minutes at 20,000 records); disk needs room for a second copy of the kept trail. After the swap the sync cursor follows the new HEAD (so the next `sync` does not re-record the removed mail), the content of the removed records is deleted, and the trail index rebuilds on the next `list`. A crash at any point leaves either exactly the old trail or exactly the pruned one: the next call that takes the trail lock finishes or undoes the swap. Removing the backup is the only thing that makes the removal final. With `dryRun: true` it runs the same plan and the same re-check of the kept records and returns the same summary (`dryRun: true`, `head: null`, `content` zero, `backup` the path it would use) without building, swapping or writing anything: HEAD, the working tree, the content store and the sync cursor stay as they were; it still takes the prune lock (so it fails at once with `ERR_PRUNE_RUNNING` while another prune runs) and finishes an unfinished earlier swap like any trail-lock holder.
   * @example
   * const plan = await mp.prune({ before: '2025-01-01', dryRun: true });   // plan.removed, plan.kept: nothing changed
   * const r = await mp.prune({ before: '2025-01-01' });   // r.removed, r.kept, r.backup
   * await fs.rm(r.backup, { recursive: true });           // when you are sure
   */
  async prune(opts) {
    return runPrune({ root: this.root, trail: this.trail, lockTimeoutMs: this.lockTimeoutMs, now: this.now, hooks: this._pruneHooks }, opts);
  }

  /** @mcp Mailproof#upgradeStamps For an account with OpenTimestamps on, ask the calendars whether pending stamps have been anchored in Bitcoin and commit the ones that gained it. Does nothing (`enabled: false`) when the account has no `ots`. A missing `ots` binary or calendar problem comes back in `error`, not as a failure. Not idempotent: running it later can upgrade more. Fails with `ERR_TRAIL_LOCKED` (retry later) or `ERR_TRAIL_LAYOUT`. */
  /**
   * Fold the Bitcoin attestation into the OpenTimestamps stamps that are still calendar-pending.
   * @returns {Promise<import('./ots-upgrade.js').StampUpgrade>}
   * @name Mailproof#upgradeStamps
   * @when Use on a trail created with `otsBin`, some hours after the records were captured: a fresh stamp only says "submitted to the calendars", and `ots upgrade` merges the Bitcoin attestation once it exists, so the proof then holds offline. Each stamp that gained it is committed as its own small commit; `sync` consumers call this at the end of a run, a `record()`-only consumer calls it from its own schedule. It asks only about stamps not yet known to be anchored (remembered in a sidecar file beside the trail, a cache), so the cost follows the pending ones.
   * @category verify
   * @signature mp.upgradeStamps() => Promise<{ enabled: boolean, upgraded: number, pending: number, error?: string }>
   * @fails With no `otsBin` it does nothing and returns `{ enabled: false, upgraded: 0, pending: 0 }`. A missing or hanging `ots` binary does not throw: the pass stops and the result carries `error` (`ots not found`, `ots timeout`, ...), with `pending` counting every stamp still not anchored. `ots upgrade` exiting non-zero for a stamp the calendars have not finished is normal (it stays pending). Rejects with `ERR_TRAIL_LOCKED` when a writer held the trail longer than `lockTimeoutMs` (retry later), `ERR_TRAIL_LAYOUT` for a flat pre-M3 trail, or a git error if a changed proof cannot be committed (the file is restored). One trail-lock window per stamp, at most `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms each (the `ots` timeout). Idempotent.
   * @example
   * const { upgraded, pending } = await mp.upgradeStamps();
   */
  async upgradeStamps() {
    return runUpgradeStamps({ root: this.root, trail: this.trail, ots: this.ots, lockTimeoutMs: this.lockTimeoutMs });
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
   * @param {Buffer | string} [raw]  Omit to read the raw email from the content store.
   * @returns {Promise<{ match: boolean, full: boolean, signatures: Array<{ index: number, d: string | null, s: string | null, match: boolean }>, reason?: string }>}
   * @name Mailproof#matchBody
   * @when Use when the original email turns up later (a mailbox copy, an .eml) and you want to know it is the one the record signed. A match upgrades the record to a full proof (`full`). Leave `raw` out and the stored raw email is used (content store, on by default).
   * @category verify
   * @signature mp.matchBody(recordOrId: Record|string, raw?: Buffer|string) => Promise<{ match, full, signatures[], reason? }>
   * @fails Never throws on a malformed record (non-array `signatures`, junk entries: `match: false`). Returns `match: false` for a different email, an unknown record, a message over an input limit (not examined, see `check()`) or a body altered in transit (mail exported by some clients is altered; `verify()` can still pass in that case). With `raw` omitted and no usable stored content (store off, expired, forgotten, or the file failed its hash check) it returns `match: false` with a `reason`.
   * @example
   * const m = await mp.matchBody(id, fs.readFileSync('mail.eml'));   // m.full
   * const s = await mp.matchBody(id);   // against the stored raw email
   */
  async matchBody(recordOrId, raw) {
    const rec = await this._resolve(recordOrId);
    if (!rec) return { match: false, full: false, signatures: [] };
    if (raw === undefined) {
      const got = await readRaw(this.contentDir, rec.id);
      if (!got.buf) return { match: false, full: false, signatures: [], reason: got.status === 'corrupt' ? 'stored content failed its hash check' : 'no stored content' };
      return matchBodyRecord(rec, got.buf);
    }
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
   * @fails Returns null for an unknown id or anything that is not 32 hex characters. Rejects only for a trail still in the pre-M3 flat layout (`records/<id>.json`): `err.code === 'ERR_TRAIL_LAYOUT'`, the trail must be re-created.
   * @example
   * const rec = await mp.get(id);
   */
  async get(id) {
    await assertTrailLayout(this.root);
    return readRecord(this.root, id);
  }

  /** @mcp Mailproof#copies Show every route one signed message reached the mailbox by (direct, via a mailing list, forwarded), given the `id` of any copy or the shared `message_key`. `original` is the earliest direct copy whose body matched, or null; `contained_in` lists records that carry it as an attached original. An unknown id returns just that record or nothing. Fails with `ERR_INDEX_UNAVAILABLE`, `ERR_TRAIL_LOCKED` (retry) or `ERR_TRAIL_LAYOUT`. */
  /**
   * Every recorded copy of one message, plus the records (forwards, list digests) that carry it as an attachment.
   * @param {string} idOrKey  A record id or a `message_key` (32 hex each).
   * @returns {Promise<{ message_key: string | null, original: string | null, copies: Array<CopySummary>, contained_in: Array<CopySummary> }>}
   * @name Mailproof#copies
   * @when Use to see every route one signed message reached you by (direct, via a mailing list, forwarded), given the id of any copy or the shared `message_key`. `copies` share the key; `contained_in` lists other records that carry it as an attached original (forwards and list digests). `original` is the earliest `direct` copy whose body matched, or null. Use `get(id)` for a full record.
   * @category read
   * @signature mp.copies(idOrKey: string) => Promise<{ message_key, original, copies[], contained_in[] }>
   * @fails Rejects with `err.code === 'ERR_INDEX_UNAVAILABLE'` when the `better-sqlite3` native addon cannot load on this platform (there is no fallback; `record`, `get` and `verify` do not need it), or `ERR_TRAIL_LOCKED` when bringing the trail index up to date had to wait for a writer longer than `lockTimeoutMs`, or `ERR_TRAIL_LAYOUT` for a trail still in the pre-M3 flat layout (not converted: re-create it). Otherwise never throws. An unknown id or key, or a record with no `message_key` (unsigned mail with no Message-ID), returns just that record (or nothing) with empty `contained_in`. Answers come from the trail index (SPEC B5), a cache beside the trail that is opened and closed inside each call (nothing stays open, so `close()` has nothing to wait for): whoever can write that file can change this answer, never `get` or `verify`.
   * @example
   * const { copies, contained_in, original } = await mp.copies(id);
   */
  async copies(idOrKey) {
    const { copiesIndex } = await import('./index-db.js');
    return copiesIndex(this._indexCfg(), idOrKey);
  }

  /** @mcp Mailproof#list List recorded emails, newest capture first (default 50, at most 500 per call; `limit` narrows). Filter by `direction`, or by counterparty `with` (one exact address, case-insensitive, seen on From, To, Cc or Reply-To; `role` narrows it to one of them) and by `after` (inclusive) and `before` (exclusive) capture time. Returns summaries; use `get` for the full record. Fails with `ERR_INDEX_UNAVAILABLE`, `ERR_TRAIL_LOCKED` (retry) or `ERR_TRAIL_LAYOUT`. */
  /**
   * List records, newest capture first.
   * @param {{ limit?: number, direction?: 'in' | 'out', with?: string, role?: 'from' | 'to' | 'cc' | 'reply-to', before?: Date | number | string, after?: Date | number | string }} [opts]
   * @returns {Promise<Array<{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }>>}
   * @name Mailproof#list
   * @when Use to find recorded emails, newest capture first, optionally by direction or by counterparty: `with` is one exact email address (case-insensitive, no grouping: bob@gmail.com is not bob@company.com) seen on the From, To, Cc or Reply-To of the record (`role` narrows it to one of them), `after` (inclusive) and `before` (exclusive) bound the capture time. It returns summaries; use `get(id)` for the full record.
   * @category read
   * @signature mp.list(opts?: { limit?: number, direction?: 'in'|'out', with?: string, role?: 'from'|'to'|'cc'|'reply-to', before?: Date|number|string, after?: Date|number|string }) => Promise<Array<{ id, captured, direction, live, portable, message_id }>>
   * @fails Rejects with `err.code === 'ERR_INDEX_UNAVAILABLE'` when the `better-sqlite3` native addon cannot load on this platform (there is no fallback; `record`, `get` and `verify` do not need it), or `ERR_TRAIL_LOCKED` when bringing the trail index up to date had to wait for a writer longer than `lockTimeoutMs`, or `ERR_TRAIL_LAYOUT` for a trail still in the pre-M3 flat layout (not converted: re-create it). A wrong type for `with`, `role` (it needs `with`), `before` or `after` throws a TypeError. Otherwise never throws. An empty or missing trail returns `[]`. Records captured in the same instant come in ascending id order. Only addresses the record itself shows count: a signed record shows the headers its DKIM signatures cover (an unsigned Cc is not visible), an unsigned one only its From (SPEC B8). Answers come from the trail index (SPEC B5), a cache beside the trail that is opened and closed inside each call (nothing stays open, so `close()` has nothing to wait for): whoever can write that file can change this answer, never `get` or `verify`.
   * @example
   * const recent = await mp.list({ limit: 10 });
   */
  async list({ limit, direction, with: who, role, before, after } = {}) {
    const { listIndex } = await import('./index-db.js');
    return listIndex(this._indexCfg(), { limit, direction, with: who, role, before, after });
  }

  /**
   * Every exact email address the trail has seen, with how many records name it.
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Array<{ address: string, records: number, first: string, last: string }>>}
   * @name Mailproof#counterparties
   * @when Use to see who is in this trail: one row per exact lower-cased address (bob@gmail.com and bob@company.com are two rows; DKIM proves an address or a domain, not a person), most recently seen first. `records` counts the records that name the address on From, To, Cc or Reply-To; `first`/`last` are the earliest and latest `captured`. The trail's own owner appears too, on every record: a record does not say which address is yours. Then `list({ with })` for the emails.
   * @category read
   * @signature mp.counterparties(opts?: { limit?: number }) => Promise<Array<{ address, records, first, last }>>
   * @fails Rejects with `ERR_INDEX_UNAVAILABLE` or `ERR_TRAIL_LOCKED` exactly like `list()`, and with a TypeError for a `limit` that is not a positive number. An empty or missing trail returns `[]`. Only addresses a record shows count (SPEC B8). Answers come from the trail index, a cache: not proof.
   * @example
   * const people = await mp.counterparties({ limit: 20 });
   */
  async counterparties({ limit } = {}) {
    const { counterpartiesIndex } = await import('./index-db.js');
    return counterpartiesIndex(this._indexCfg(), { limit });
  }

  /** @mcp Mailproof#linked Read the thread around one record: `parents` are the Message-IDs its In-Reply-To/References name (with the recorded id, or null), `children` the recorded emails that name its Message-ID. `strength` is `signed` only when a verifying DKIM signature covers the naming header, else `unsigned`. It reports what looks linked, never "the reply chain". At most `limit` children (default 1000); `more` says there were others. Fails with `ERR_INDEX_UNAVAILABLE` or `ERR_TRAIL_LOCKED` (retry). */
  /**
   * The emails one record looks linked to, with how strongly each link is signed.
   * @param {string} id  A record id.
   * @param {{ limit?: number }} [opts]  `limit`: most children returned, a positive integer (default 1000).
   * @returns {Promise<{ id: string, message_id: string | null, parents: Array<{ id: string | null, message_id: string, via: string, strength: string }>, children: Array<{ id: string, message_id: string | null, via: string, strength: string }>, more: boolean } | null>}
   * @name Mailproof#linked
   * @when Use to read a thread around one record without trusting it blindly. `parents` are the Message-IDs this email names in In-Reply-To / References (`id` is the recorded email with that Message-ID, the earliest copy, or null when it is not in the trail); `children` are the recorded emails that name this one's Message-ID. `strength` is `signed` when a DKIM signature that verifies offline covers the header that names it, `unsigned` otherwise (a Microsoft sender signs neither). It reports what looks linked and never asserts "the reply chain"; the other copies of one message are `copies()`.
   * @category read
   * @signature mp.linked(id: string, opts?: { limit?: number }) => Promise<{ id, message_id, parents: [{ id, message_id, via, strength }], children: [{ id, message_id, via, strength }], more: boolean } | null>
   * @fails Rejects with `ERR_INDEX_UNAVAILABLE` or `ERR_TRAIL_LOCKED` exactly like `list()`. Returns null for an unknown or malformed id. A record with no Message-ID has no children. At most `limit` children (default 1000, oldest capture first) come back and `more` is true when there were others; a `limit` that is not a positive integer throws a `TypeError`. Answers come from the trail index, a cache: the strength is the one found when the record was indexed (re-grade one record with `checkProfile`).
   * @example
   * const t = await mp.linked(replyId);   // t.parents[0].strength === 'signed'
   */
  async linked(id, { limit } = {}) {
    const { linkedIndex } = await import('./index-db.js');
    return linkedIndex(this._indexCfg(), id, { limit });
  }

  /**
   * Evaluate a trust profile against a recorded email (or a record object).
   * @param {MpRecord | string} recordOrId  A record, its JSON text, or a trail id.
   * @param {import('./profile.js').TrustProfile} profile  See `checkProfile`.
   * @param {{ at?: Date | number | string, parent?: string }} [opts]
   * @returns {Promise<{ ok: boolean, failed: Array<{ rule: string, want: unknown, got: unknown }>, record: string | null, rules: string }>}
   * @name Mailproof#checkProfile
   * @when Use to gate which recorded email an agent may act on, by id: allowed senders, required checks, required body level, required link strength. Same rules as the pure `checkProfile()`; this one reads the record from the trail first. Local, free, deterministic: re-run it later for the same answer.
   * @category verify
   * @signature mp.checkProfile(recordOrId: Record|string, profile: { senders?, checks?, body?, link? }, opts?: { at?, parent? }) => Promise<{ ok, failed: [{ rule, want, got }], record, rules }>
   * @fails Rejects with `ERR_BAD_PROFILE` for an invalid profile. An id that is not in the trail gives `ok: false` with a failed `record` rule, not a throw.
   * @example
   * const r = await mp.checkProfile(id, { senders: ['alice@gmail.com'], checks: { dkimAligned: true }, body: 'proven', link: ['signed'] }, { parent: requestMessageId });
   */
  async checkProfile(recordOrId, profile, opts) {
    const rec = await this._resolve(recordOrId);
    return checkProfile(rec, profile, opts);
  }

  /**
   * Separate results for the email and for each attachment.
   * @param {MpRecord | string} recordOrId  A record, its JSON text, or a trail id.
   * @returns {Promise<{ email: { ok: boolean, trust: 'verified' | 'unverified', body_status: import('./types.js').BodyStatus }, attachments: Array<{ index: number, filename: string | null, sha256: string | null, stored: boolean, match: boolean | null }> } | null>}
   * @name Mailproof#proofParts
   * @when Use when "the email is valid" and "this attachment is the one recorded" are different questions. `email` is the offline DKIM re-check of the record (`ok`, `trust`) and its recorded `body_status`. Each attachment is re-hashed from the content store: `match: true` is the recorded bytes, `false` a stored file that is NOT the recorded one (damaged or swapped), `null` nothing stored to check (proof-only account, expired, forgotten): then use `matchFile` with a copy you hold.
   * @category verify
   * @signature mp.proofParts(recordOrId: Record|string) => Promise<{ email: { ok, trust, body_status }, attachments: [{ index, filename, sha256, stored, match }] } | null>
   * @fails Never throws. Returns null for an unknown id or an unreadable record.
   * @example
   * const p = await mp.proofParts(id);   // p.email.ok, p.attachments[0].match
   */
  async proofParts(recordOrId) {
    const rec = await this._resolve(recordOrId);
    if (!rec || typeof rec !== 'object') return null;
    const v = verifyRecord(rec);
    const list = Array.isArray(rec.attachments) ? rec.attachments : [];
    const attachments = await Promise.all(Array.from(/** @type {any[]} */ (list), async (a, index) => {
      const obj = a !== null && typeof a === 'object' && !Array.isArray(a);
      const sha256 = obj && typeof a.sha256 === 'string' ? a.sha256 : null;
      const filename = obj && typeof a.filename === 'string' ? a.filename : null;
      if (!sha256) return { index, filename, sha256, stored: false, match: null };
      const { status } = await readAttachment(this.contentDir, sha256);
      // readAttachment re-hashes the file: 'ok' is the recorded bytes, 'corrupt' a file under that name that is not.
      return { index, filename, sha256, stored: status !== 'absent', match: status === 'absent' ? null : status === 'ok' };
    }));
    return { email: { ok: v.ok, trust: v.trust, body_status: rec.body_status ?? 'not-checked' }, attachments };
  }

  /**
   * What index-db.js needs for one query: the index is opened and closed inside each `list`/`copies` call.
   * @returns {import('./index-db.js').IndexCfg}
   */
  _indexCfg() {
    return { root: this.root, trail: this.trail, lockTimeoutMs: this.lockTimeoutMs };
  }

  /** @mcp Mailproof#sync Read new mail from the account's mailbox (read-only: nothing is marked, moved or deleted) and record it. At most `maxMessages` per folder per call: call again while `complete` is false. `folders` and `sent` override the account's settings for this call. A problem in one folder is in that folder's `error`; the run goes on. Fails with `ERR_IMAP_AUTH` (login refused: the user must fix the account config; do not retry), `ERR_IMAP_CONNECT` or `ERR_SYNC_LOCKED` (retry later). */
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
    const host = { root: this.root, trail: this.trail, record: this.record, recordDigest: (/** @type {{ raw_sha256: string, size: number }} */ d, /** @type {{ direction: 'in' | 'out', source: string }} */ c) => this._recordDigest(d, c), expireContent: this._autoSweep };
    return runSync(host, opts, {
      openSession: async (args) => (await import('./imap.js')).openSession(args),
    });
  }
}

export { Mailproof, otsTimeoutMs };
