// The proof core. One instance owns one trail (a git repo of records). Methods
// are bound, so `const { verify } = mp` works.

import crypto from 'node:crypto';
import path from 'node:path';
import { authenticateMessage, parseMessage } from './parse.js';
import { fetchDkimKey } from './keys.js';
import { splitMessage, parseTags } from './signed-headers.js';
import { buildSignatureEntry } from './record.js';
import { summariseBody } from './body-status.js';
import { messageKeyOf, classifyCopy, MAX_INNER } from './copy.js';
import { buildLive, buildPortable, engine } from './verdict.js';
import { createOts } from './ots.js';
import { verifyRecord, matchBodyRecord, matchFileRecord } from './recheck.js';
import { TRAIL_NAME_RE, RECORD_ID_RE, DEFAULT_LOCK_TIMEOUT_MS, commitRecord, readRecord, listIds } from './trail.js';

const OTS_TIMEOUT_MS = 30000; // the configured `ots` timeout (ots.js default)

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {{ id: string, captured: string, direction: string, copy: string, body_status: string, live: string, portable: string }} CopySummary */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */

/**
 * @typedef {Object} MailproofOptions
 * @property {string} trailDir  Directory holding the trails; each trail is a git repo inside it.
 * @property {string} [trail]  Trail name (default "default").
 * @property {(name: string, type?: string) => Promise<any>} [resolver]  mailauth-compatible DNS resolver (tests inject one).
 * @property {string | null} [otsBin]  Path to the `ots` binary; null/absent keeps OpenTimestamps off.
 * @property {() => Date} [now]  Clock (tests inject one).
 * @property {string[]} [trustedSealers]  ARC sealer domains whose chains may yield `forwarded` (live only).
 * @property {number} [lockTimeoutMs]  How long `record()` waits for another writer of the same trail (default 30000). On timeout it throws `ERR_TRAIL_LOCKED` and writes nothing.
 */

/** @param {Buffer | string} raw @returns {string} */
const sha256hex = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

class Mailproof {
  /**
   * @param {MailproofOptions} opts
   * @signature new Mailproof({ trailDir: string, trail?: string, resolver?: Function, otsBin?: string|null, now?: () => Date, trustedSealers?: string[], lockTimeoutMs?: number })
   * @when Start here. Construct one per trail (a git repo of records under `trailDir`), then `record()` each email you want a re-checkable proof of and `verify()` it later, offline. All methods are bound, so `const { verify } = mp` works.
   * @category proof
   * @fails Throws at construction when `trailDir` is missing or `trail` is not `[a-z0-9][a-z0-9_-]{0,63}`. Nothing touches the disk until the first `record()`.
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
    this.lockTimeoutMs = Number.isFinite(opts.lockTimeoutMs) && /** @type {number} */ (opts.lockTimeoutMs) >= 0 ? /** @type {number} */ (opts.lockTimeoutMs) : DEFAULT_LOCK_TIMEOUT_MS;
    // The stamp runs inside the trail lock, so it must give up well before other writers' lock deadline.
    this.ots = this.otsBin ? createOts({ otsBin: this.otsBin, timeoutMs: Math.min(OTS_TIMEOUT_MS, Math.floor(this.lockTimeoutMs / 3)) }) : null;
    this.check = this.check.bind(this);
    this.record = this.record.bind(this);
    this.verify = this.verify.bind(this);
    this.matchBody = this.matchBody.bind(this);
    this.matchFile = this.matchFile.bind(this);
    this.get = this.get.bind(this);
    this.list = this.list.bind(this);
    this.copies = this.copies.bind(this);
  }

  /**
   * Build the record for a message (nothing is written).
   * @param {Buffer | string} raw
   * @param {{ direction: 'in' | 'out', source: string, envelope?: Envelope }} ctx
   * @returns {Promise<{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }> }>}
   */
  async _build(raw, ctx) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
    if (buf.length === 0) throw new Error('Mailproof: empty message');
    const captured = this.now().toISOString();
    const { rows, body } = splitMessage(buf);
    const hasEnvelope = Boolean(ctx.envelope && (ctx.envelope.clientIp || ctx.envelope.sender));
    const [auth, parsed] = await Promise.all([
      authenticateMessage(buf, ctx.envelope || {}, { resolver: this.resolver }).catch(() => /** @type {MailauthResult} */ ({})),
      parseMessage(buf),
    ]);

    const sigRows = rows.filter((r) => r.name === 'dkim-signature');
    const { signatures, keyFiles } = await this._signatures(rows, body, auth?.arc?.status?.result);

    // Forward as attachment: verify each signed original (key + verdict only; nothing of it is stored).
    const inner = parsed.rfc822 || [];
    /** @type {import('./types.js').AttachedOriginal[]} */
    const attached = [];
    for (const m of inner.slice(0, MAX_INNER)) {
      const r = await this._inner(m, captured);
      attached.push(r.entry);
      keyFiles.push(...r.keyFiles);
    }

    // One record per distinct copy: the id is the raw bytes' hash; `message_key` groups the copies.
    const id = parsed.rawSha256.replace(/^sha256:/, '').slice(0, 32);

    /** @type {MpRecord} */
    const record = {
      v: 2,
      id,
      message_key: messageKeyOf(rows),
      captured,
      direction: ctx.direction,
      source: ctx.source,
      message: {
        message_id: parsed.messageId || null,
        in_reply_to: parsed.inReplyTo || null,
        references: parsed.references || [],
        raw_sha256: parsed.rawSha256,
        size: buf.length,
        ...(sigRows.length ? {} : { from: parsed.from.address }),
      },
      attachments: parsed.attachments.map((a) => ({ filename: a.filename, size: a.size, sha256: /** @type {string} */ (a.sha256) })),
      signatures,
      body_status: 'not-checked',
      copy: classifyCopy({ rows, subject: parsed.subject || null, signed: sigRows.length > 0, attached, capped: inner.length > MAX_INNER, multipartDigest: /^content-type:[ \t]*multipart\/digest/im.test(body.toString('binary')) || rows.some((r) => r.name === 'content-type' && /multipart\/digest/i.test(r.raw)) }),
      verdicts: {},
    };
    const sigOk = verifyRecord(record).signatures.map((x) => x.ok);
    record.body_status = summariseBody(signatures, sigOk);
    record.verdicts = {
      live: buildLive(auth, { trustedSealers: this.trustedSealers, hasEnvelope }),
      portable: buildPortable(record),
    };
    return { record, keyFiles };
  }

  /**
   * Signature entries (+ the DKIM keys to archive) for a header block and body.
   * @param {import('./signed-headers.js').HeaderRow[]} rows
   * @param {Buffer} body
   * @param {string | null | undefined} arc  ARC chain result (a body-status hint).
   * @returns {Promise<{ signatures: import('./types.js').RecordSignature[], keyFiles: Array<{ rel: string, json: unknown }> }>}
   */
  async _signatures(rows, body, arc) {
    /** @type {Array<{ rel: string, json: unknown }>} */
    const keyFiles = [];
    /** @type {import('./types.js').RecordSignature[]} */
    const signatures = [];
    const resolver = this.resolver;
    for (const sr of rows.filter((r) => r.name === 'dkim-signature')) {
      const t = parseTags(sr.raw);
      const k = await fetchDkimKey(t.d, t.s, { resolver: resolver ? (name) => resolver(name, 'TXT') : undefined });
      /** @type {{ k: string, p: string } | null} */
      let key = null;
      let key_file = null;
      if (k.base64) {
        key = { k: k.k || 'rsa', p: k.base64 };
        key_file = `keys/${t.d.toLowerCase()}/${t.s.toLowerCase()}/${sha256hex(k.base64).slice(0, 16)}.json`;
        keyFiles.push({
          rel: key_file,
          json: { v: 2, domain: t.d.toLowerCase(), selector: t.s.toLowerCase(), k: key.k, p: key.p, txt: k.txt, lookup: k.lookup, first_fetched: k.fetched_at },
        });
      }
      signatures.push(buildSignatureEntry(rows, sr, body, { key, key_error: k.base64 ? null : (k.error || 'no key'), key_file }, { arc }));
    }
    return { signatures, keyFiles };
  }

  /**
   * Check one attached original (`message/rfc822`) the way a record is checked, keeping
   * only its key and verdict. One level deep: its own attachments are not examined.
   * @param {Buffer} buf
   * @param {string} captured
   * @returns {Promise<{ entry: import('./types.js').AttachedOriginal, keyFiles: Array<{ rel: string, json: unknown }> }>}
   */
  async _inner(buf, captured) {
    const { rows, body } = splitMessage(buf);
    const { signatures, keyFiles } = await this._signatures(rows, body, null);
    const v = verifyRecord({ v: 2, id: '', message_key: null, copy: { kind: 'unknown', evidence: {} }, captured, direction: 'in', source: 'inner', message: {}, attachments: [], signatures, body_status: 'not-checked', verdicts: {} });
    const passing = v.signatures.find((x) => x.ok);
    return {
      entry: {
        message_key: messageKeyOf(rows),
        dkim: !signatures.length ? 'none' : passing ? 'pass' : 'fail',
        d: (passing || v.signatures[0])?.d ?? null,
        body_status: summariseBody(signatures, v.signatures.map((x) => x.ok)),
      },
      keyFiles,
    };
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
   * @fails Rejects on an empty message. Unsigned or unverifiable mail does not throw: it comes back `unverified`. Judged as of now, so a key that has left DNS appears in `key_errors` and the portable verdict is `unverified`. The portable verdict covers the signed headers only: read `body_status` (and `body[i].explain`) for the body.
   * @example
   * const mp = new Mailproof({ trailDir: './trails' });
   * const c = await mp.check(fs.readFileSync('mail.eml'));   // c.live.trust, c.portable.trust
   */
  async check(raw, { envelope } = {}) {
    const { record } = await this._build(raw, { direction: 'in', source: 'check', envelope });
    return {
      live: record.verdicts.live,
      portable: record.verdicts.portable,
      signatures: record.signatures.length,
      unsigned: record.signatures.length === 0,
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
   * @fails Throws on an empty message, a `direction` other than 'in'/'out', a git failure (the tree is rolled back: only files this call created are removed), or `err.code === 'ERR_TRAIL_LOCKED'` when another process holds the trail's writer lock for longer than `lockTimeoutMs` (nothing is written; retry later). Never throws because the mail is unsigned or fails verification. The id is the hash of the raw bytes: the identical bytes recorded twice return `duplicate: true` and write nothing, while a copy with any byte difference (a list footer, an added header) is its own record, linked by `message_key` (see `copies()`). An OTS failure or timeout is reported in `ots`, not thrown; the stamp runs inside the writer lock, so it is cut off after `min(30000, lockTimeoutMs / 3)` ms.
   * @example
   * const { id, duplicate } = await mp.record(fs.readFileSync('mail.eml'), { direction: 'in', source: 'file' });
   */
  async record(raw, ctx) {
    if (!ctx || (ctx.direction !== 'in' && ctx.direction !== 'out')) throw new Error("record: ctx.direction must be 'in' or 'out'");
    const source = typeof ctx.source === 'string' && ctx.source ? ctx.source.slice(0, 200) : 'api';
    const { record, keyFiles } = await this._build(raw, { direction: ctx.direction, source, envelope: ctx.envelope });
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
    const res = await commitRecord(this.root, this.trail, { record, keyFiles, message, now: this.now, afterWrite, lockTimeoutMs: this.lockTimeoutMs });
    return res.duplicate
      ? { id: record.id, duplicate: true, commit: res.commit }
      : { id: record.id, duplicate: false, commit: res.commit, record, ots: otsState };
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
   * @fails Never throws on a malformed record (non-array `signatures`, junk entries: `match: false`). Returns `match: false` for a different email, an unknown record or a body altered in transit (mail exported by some clients is altered; `verify()` can still pass in that case).
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
   * @fails Never throws on a malformed record (non-array `attachments`, junk entries: `match: false`). `match: false` for any other bytes or an unknown record.
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
   * @fails Never throws. An unknown id or key, or a record with no `message_key` (unsigned mail with no Message-ID), returns just that record (or nothing) with empty `contained_in`.
   * @example
   * const { copies, contained_in, original } = await mp.copies(id);
   */
  async copies(idOrKey) {
    const all = (await Promise.all((await listIds(this.root)).map((id) => readRecord(this.root, id)))).filter((r) => r !== null);
    const self = typeof idOrKey === 'string' ? all.find((r) => r.id === idOrKey) : undefined;
    const key = self ? self.message_key : (typeof idOrKey === 'string' && RECORD_ID_RE.test(idOrKey) ? idOrKey : null);
    /** @type {(r: MpRecord) => CopySummary} */
    const sum = (r) => ({
      id: r.id, captured: r.captured, direction: r.direction, copy: r.copy?.kind ?? 'unknown', body_status: r.body_status,
      live: r.verdicts?.live?.trust, portable: r.verdicts?.portable?.trust,
    });
    const byTime = (/** @type {MpRecord} */ a, /** @type {MpRecord} */ b) => (a.captured < b.captured ? -1 : a.captured > b.captured ? 1 : 0);
    const copies = (key ? all.filter((r) => r.message_key === key) : self ? [self] : []).sort(byTime);
    const containedIn = key
      ? all.filter((r) => r.message_key !== key && (r.copy?.evidence?.attached_original || []).some((o) => o.message_key === key)).sort(byTime)
      : [];
    const original = copies.find((r) => r.copy?.kind === 'direct' && r.body_status === 'matched');
    return { message_key: key, original: original ? original.id : null, copies: copies.map(sum), contained_in: containedIn.map(sum) };
  }

  /**
   * List records, newest capture first.
   * @param {{ limit?: number, direction?: 'in' | 'out' }} [opts]
   * @returns {Promise<Array<{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }>>}
   * @name Mailproof#list
   * @when Use to find recorded emails, newest capture first, optionally by direction. It returns summaries; use `get(id)` for the full record.
   * @category read
   * @signature mp.list(opts?: { limit?: number, direction?: 'in'|'out' }) => Promise<Array<{ id, captured, direction, live, portable, message_id }>>
   * @fails Never throws. An empty or missing trail returns `[]`.
   * @example
   * const recent = await mp.list({ limit: 10 });
   */
  async list({ limit, direction } = {}) {
    const recs = (await Promise.all((await listIds(this.root)).map((id) => readRecord(this.root, id))))
      .filter((r) => r !== null)
      .filter((r) => !direction || r.direction === direction)
      .sort((a, b) => (a.captured < b.captured ? 1 : a.captured > b.captured ? -1 : 0));
    return (limit ? recs.slice(0, limit) : recs).map((r) => ({
      id: r.id, captured: r.captured, direction: r.direction,
      live: r.verdicts?.live?.trust, portable: r.verdicts?.portable?.trust, message_id: r.message?.message_id ?? null,
    }));
  }
}

export { Mailproof };
