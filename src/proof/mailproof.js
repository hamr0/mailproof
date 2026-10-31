// The proof core. One instance owns one trail (a git repo of records). Methods
// are bound, so `const { verify } = mp` works.

import crypto from 'node:crypto';
import path from 'node:path';
import { authenticateMessage, parseMessage } from './parse.js';
import { fetchDkimKey } from './keys.js';
import { splitMessage, parseTags } from './signed-headers.js';
import { buildSignatureEntry } from './record.js';
import { buildLive, buildPortable, engine } from './verdict.js';
import { verifyRecord, matchBodyRecord, matchFileRecord } from './recheck.js';
import { TRAIL_NAME_RE, RECORD_ID_RE, commitRecord, readRecord, listIds } from './trail.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').Envelope} Envelope */

/**
 * @typedef {Object} MailproofOptions
 * @property {string} trailDir  Directory holding the trails; each trail is a git repo inside it.
 * @property {string} [trail]  Trail name (default "default").
 * @property {(name: string, type?: string) => Promise<any>} [resolver]  mailauth-compatible DNS resolver (tests inject one).
 * @property {string | null} [otsBin]  Path to the `ots` binary; null/absent keeps OpenTimestamps off.
 * @property {() => Date} [now]  Clock (tests inject one).
 * @property {string[]} [trustedSealers]  ARC sealer domains whose chains may yield `forwarded` (live only).
 */

/** @param {Buffer | string} raw @returns {string} */
const sha256hex = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

class Mailproof {
  /** @param {MailproofOptions} opts */
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
    this.check = this.check.bind(this);
    this.record = this.record.bind(this);
    this.verify = this.verify.bind(this);
    this.matchBody = this.matchBody.bind(this);
    this.matchFile = this.matchFile.bind(this);
    this.get = this.get.bind(this);
    this.list = this.list.bind(this);
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
      authenticateMessage(buf, ctx.envelope || {}, { resolver: this.resolver }).catch(() => ({})),
      parseMessage(buf),
    ]);

    const sigRows = rows.filter((r) => r.name === 'dkim-signature');
    /** @type {Array<{ rel: string, json: unknown }>} */
    const keyFiles = [];
    const signatures = [];
    const resolver = this.resolver;
    for (const sr of sigRows) {
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
      signatures.push(buildSignatureEntry(rows, sr, body, { key, key_error: k.base64 ? null : (k.error || 'no key'), key_file }));
    }

    const identity = sigRows.length
      ? (parseTags(sigRows[0].raw).b || '').replace(/\s+/g, '')
      : sha256hex(rows.map((r) => r.raw).join('\r\n'));
    const id = sha256hex('mp2\n' + identity).slice(0, 32);

    /** @type {MpRecord} */
    const record = {
      v: 2,
      id,
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
      verdicts: {},
    };
    record.verdicts = {
      live: buildLive(auth, { trustedSealers: this.trustedSealers, hasEnvelope }),
      portable: buildPortable(record),
    };
    return { record, keyFiles };
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
   * @returns {Promise<{ live: Record<string, any>, portable: Record<string, any>, signatures: number, unsigned: boolean, partial_body: boolean, key_errors: string[] }>}
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
    };
  }

  /**
   * Record a message: verdicts + signed-header record + key archive + one git commit.
   * @param {Buffer | string} raw  The raw RFC-822 bytes.
   * @param {{ direction: 'in' | 'out', source?: string, envelope?: Envelope }} ctx
   * @returns {Promise<{ id: string, duplicate: boolean, commit: string, record?: MpRecord }>}
   */
  async record(raw, ctx) {
    if (!ctx || (ctx.direction !== 'in' && ctx.direction !== 'out')) throw new Error("record: ctx.direction must be 'in' or 'out'");
    const source = typeof ctx.source === 'string' && ctx.source ? ctx.source.slice(0, 200) : 'api';
    const { record, keyFiles } = await this._build(raw, { direction: ctx.direction, source, envelope: ctx.envelope });
    const message = `record ${record.id.slice(0, 12)} ${record.direction} ${record.verdicts.live.trust}/${record.verdicts.portable.trust}`;
    const res = await commitRecord(this.root, this.trail, { record, keyFiles, message, now: this.now });
    return res.duplicate
      ? { id: record.id, duplicate: true, commit: res.commit }
      : { id: record.id, duplicate: false, commit: res.commit, record };
  }

  /**
   * Offline re-check from the record alone (no DNS, no raw email). `at`
   * defaults to the record's capture time; a bad capture time fails closed.
   * `trust` is the portable level recomputed now, never read from the stored verdict.
   * @param {MpRecord | string} recordOrId  A record, its JSON, or a trail id.
   * @param {{ at?: Date | number | string }} [opts]
   * @returns {Promise<{ ok: boolean, trust: 'verified' | 'unverified', basis: 'dkim' | 'none', at: string | null, engine: { rules: string, mailauth: string }, signatures: Array<Record<string, any>>, error?: string }>}
   */
  async verify(recordOrId, { at } = {}) {
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
   */
  async get(id) {
    return readRecord(this.root, id);
  }

  /**
   * List records, newest capture first.
   * @param {{ limit?: number, direction?: 'in' | 'out' }} [opts]
   * @returns {Promise<Array<{ id: string, captured: string, direction: string, live: string, portable: string, message_id: string | null }>>}
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
