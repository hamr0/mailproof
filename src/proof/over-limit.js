// The record of a message that was not built: refused by the admission gate, or stopped by the worker backstop
// (pool.js). It needs no parser, so the main thread can make it without loading mailauth or mailparser, which
// only the build (build.js, in the worker) uses.

import { overLimitReason } from './admit.js';
import { hashDocument } from './hash.js';
import { buildLive, buildPortable } from './verdict.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */
/** @typedef {{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }>, overLimit: string | null }} Built */

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

export { overLimitRecord };
