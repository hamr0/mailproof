// The proof core. One instance owns one trail (a git repo of records). Methods
// are bound, so `const { verify } = mp` works.

import crypto from 'node:crypto';
import path from 'node:path';
import { authenticateMessage, parseMessage } from './parse.js';
import { fetchDkimKey } from './keys.js';
import { splitMessage, parseTags } from './signed-headers.js';
import { buildSignatureEntry } from './record.js';
import { buildLive, buildPortable } from './verdict.js';
import { TRAIL_NAME_RE, commitRecord, readRecord, listIds } from './trail.js';

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
    this.record = this.record.bind(this);
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
