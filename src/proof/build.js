// The pure half of check()/record(): raw bytes in, record + DKIM key files out. It touches no trail, no git
// and no lock, so it can run anywhere: on the main thread, or in a worker thread under a deadline (pool.js),
// which is why a killed run leaves nothing behind. Everything it needs comes in as arguments.

import crypto from 'node:crypto';
import { authenticateMessage, parseMessage } from './parse.js';
import { fetchDkimKey } from './keys.js';
import { splitMessage, parseTags } from './signed-headers.js';
import { MAX_INNER } from './limits.js';
import { admit, overLimitReason } from './admit.js';
import { hashDocument } from './hash.js';
import { buildSignatureEntry } from './record.js';
import { summariseBody, newBudget } from './body-status.js';
import { messageKeyOf, classifyCopy } from './copy.js';
import { buildLive, buildPortable } from './verdict.js';
import { verifyRecord } from './recheck.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */

/**
 * What a build needs besides the bytes. `captured` is read from the caller's clock once, so the worker never
 * has a clock of its own.
 * @typedef {Object} BuildEnv
 * @property {string} captured  ISO time of capture.
 * @property {boolean} hasEnvelope
 * @property {string[]} trustedSealers
 * @property {((name: string, type?: string) => Promise<any>) | undefined} resolver  Absent: the system resolver.
 */

/** @typedef {{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }>, overLimit: string | null }} Built */

/** @param {Buffer | string} raw @returns {string} */
const sha256hex = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Build the record for a message (nothing is written). A message over an input limit (admit.js) gets
 * the over-limit record: the parsers never see it and no DNS is asked.
 * @param {Buffer} buf  Not empty.
 * @param {{ direction: 'in' | 'out', source: string, envelope?: import('./types.js').Envelope }} ctx
 * @param {BuildEnv} env
 * @returns {Promise<Built>}
 *   `overLimit`: the name of the limit the message exceeded, else null.
 */
async function buildRecord(buf, ctx, env) {
  const { captured, hasEnvelope, trustedSealers, resolver } = env;
  const gate = admit(buf);
  if (!gate.ok) return overLimitRecord(buf, ctx, env, /** @type {string} */ (gate.limit));
  const { rows, body } = splitMessage(buf);
  // Decode first, then authenticate: a message the decoder rejects must not have started any DNS
  // work, which running the two side by side would do.
  const parsed = await parseMessage(buf);
  const auth = await authenticateMessage(buf, ctx.envelope || {}, { resolver }).catch(() => /** @type {MailauthResult} */ ({}));

  const sigRows = rows.filter((r) => r.name === 'dkim-signature');
  // one body-search budget for the whole message: its signatures and its attached originals draw on the same
  const budget = newBudget();
  const { signatures, keyFiles } = await signaturesOf(rows, body, auth?.arc?.status?.result, budget, resolver);

  // Forward as attachment: verify each signed original (key + verdict only; nothing of it is stored).
  const inner = parsed.rfc822 || [];
  /** @type {import('./types.js').AttachedOriginal[]} */
  const attached = [];
  for (const m of inner.slice(0, MAX_INNER)) {
    const r = await innerOf(m, captured, budget, resolver);
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
    live: buildLive(auth, { trustedSealers, hasEnvelope }),
    portable: buildPortable(record),
  };
  return { record, keyFiles, overLimit: null };
}

/**
 * The record of a message that was refused (accept-with-flag): committed like any other, but nothing
 * was parsed, so it holds only what the raw bytes give without a parser: `raw_sha256` (and so the
 * `id`) and `size`. Everything else is empty or null, both verdicts are `unverified`, and their
 * `reason` names the limit (`over limit: body_line`). `limit` is a gate limit, or `time` / `memory` when the
 * worker backstop (pool.js) stopped the build.
 * @param {Buffer} buf
 * @param {{ direction: 'in' | 'out', source: string }} ctx
 * @param {{ captured: string, hasEnvelope: boolean, trustedSealers: string[] }} env
 * @param {string} limit
 * @returns {Built & { overLimit: string }}
 */
function overLimitRecord(buf, ctx, env, limit) {
  const rawSha256 = hashDocument(buf);
  const reason = overLimitReason(limit);
  /** @type {MpRecord} */
  const record = {
    v: 2,
    id: rawSha256.replace(/^sha256:/, '').slice(0, 32),
    message_key: null,
    captured: env.captured,
    direction: ctx.direction,
    source: ctx.source,
    message: { message_id: null, in_reply_to: null, references: [], raw_sha256: rawSha256, size: buf.length },
    attachments: [],
    signatures: [],
    body_status: 'not-checked',
    copy: { kind: 'unknown', evidence: {} },
    verdicts: {},
  };
  record.verdicts = {
    live: { ...buildLive(/** @type {MailauthResult} */ ({}), { trustedSealers: env.trustedSealers, hasEnvelope: env.hasEnvelope }), reason },
    portable: { ...buildPortable(record), reason },
  };
  return { record, keyFiles: [], overLimit: limit };
}

/**
 * Signature entries (+ the DKIM keys to archive) for a header block and body that passed the gate
 * (so: at most MAX_SIGNATURES signatures, each listing at most MAX_H_NAMES names).
 * @param {import('./signed-headers.js').HeaderRow[]} rows
 * @param {Buffer} body
 * @param {string | null | undefined} arc  ARC chain result (a body-status hint).
 * @param {import('./body-status.js').WorkBudget} budget  The message's shared body-search budget.
 * @param {BuildEnv['resolver']} resolver
 * @returns {Promise<{ signatures: import('./types.js').RecordSignature[], keyFiles: Array<{ rel: string, json: unknown }> }>}
 */
async function signaturesOf(rows, body, arc, budget, resolver) {
  /** @type {Array<{ rel: string, json: unknown }>} */
  const keyFiles = [];
  /** @type {import('./types.js').RecordSignature[]} */
  const signatures = [];
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
    signatures.push(buildSignatureEntry(rows, sr, body, { key, key_error: k.base64 ? null : (k.error || 'no key'), key_file }, { arc, budget }));
  }
  return { signatures, keyFiles };
}

/**
 * Check one attached original (`message/rfc822`) the way a record is checked, keeping
 * only its key and verdict. One level deep: its own attachments are not examined. It goes through
 * the same gate: over a limit it is not examined at all (`over_limit` names the limit).
 * @param {Buffer} buf
 * @param {string} captured
 * @param {import('./body-status.js').WorkBudget} budget  The outer message's shared body-search budget.
 * @param {BuildEnv['resolver']} resolver
 * @returns {Promise<{ entry: import('./types.js').AttachedOriginal, keyFiles: Array<{ rel: string, json: unknown }> }>}
 */
async function innerOf(buf, captured, budget, resolver) {
  const gate = admit(buf);
  if (!gate.ok) return { entry: { message_key: null, dkim: 'none', d: null, body_status: 'not-checked', over_limit: /** @type {string} */ (gate.limit) }, keyFiles: [] };
  const { rows, body } = splitMessage(buf);
  const { signatures, keyFiles } = await signaturesOf(rows, body, null, budget, resolver);
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

export { buildRecord, overLimitRecord };
