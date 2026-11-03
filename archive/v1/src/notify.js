// Trigger pillar — the shared neutral-notification seam. Every kernel-derived
// occasion (workflow advance / crypto ack / completion from ingest; overdue /
// archived from sweep; bounce, proof_anchored, … as m7d lands them) is emitted
// through ONE `deliver`, so there is a single source of truth for how mailproof
// turns an occasion into an outbound email.
//
// Locked boundary (decisions-log 2026-05-27, "occasions are kernel … bodies are
// policy"): the OCCASION + a simple NEUTRAL default body are mechanism; the real
// branded body/prose is policy (§8.6). The one seam for that is
// composeNotification(ctx) → body — keyed by `kind` so a consumer can template
// per occasion. A hook throw or falsy return falls back to the neutral default;
// a hook can never break delivery.
//
// Best-effort by construction: a transport failure yields an { ok:false } entry,
// never an exception — the ledger transition that prompted the email already
// happened and must not be undone by a send. (Same contract ingest relied on
// when deliver lived inline; m7d lifted it here verbatim so sweep can share it.)


// Bind the outbound primitives + the operator domain + the optional body hook
// once; return { deliver }. create() builds exactly one notifier and threads its
// deliver into both ingest() and sweep().
/** @typedef {import('./types.js').DeliverResult} DeliverResult */

/**
 * One occasion-to-email delivery request.
 * @typedef {Object} DeliverArgs
 * @property {string} kind
 * @property {string | null} [to]
 * @property {string} [replyAddress]
 * @property {string} [subject]
 * @property {string} [defaultBody]
 * @property {Record<string, any>} [ctx]
 */

/**
 * Bind the shared neutral-notification seam. Returns `{ deliver }`; create()
 * builds exactly one and threads it into ingest() and sweep(). The four outbound
 * primitives are required — `deliver` cannot compose an email without them.
 * @param {Object} deps
 * @param {typeof import('./outbound.js').buildRawMessage} deps.buildRawMessage
 * @param {typeof import('./outbound.js').sendmail} deps.sendmail
 * @param {typeof import('./outbound.js').newMessageId} deps.newMessageId
 * @param {typeof import('./outbound.js').sanitizeSubject} deps.sanitizeSubject
 * @param {string | null} [deps.domain]
 * @param {string | null} [deps.sendmailBin]
 * @param {((ctx: Record<string, any>) => string | null | undefined) | null} [deps.composeNotification]
 * @returns {{ deliver: (args: DeliverArgs) => Promise<DeliverResult | null> }}
 */
function createNotifier({
  buildRawMessage,
  sendmail,
  newMessageId,
  sanitizeSubject,
  domain = null,
  sendmailBin = null,
  composeNotification = null,
}) {
  // Build + submit ONE neutral notification. `replyAddress` is the plus-tagged
  // From so the recipient's reply routes straight back to the right event/step.
  // Auto-Submitted marks it machine-generated (our own prefilter drops any
  // auto-reply to it). Returns a { kind, to, ok, reason } record, or null when
  // there is no recipient.
  /**
   * @param {DeliverArgs} args
   * @returns {Promise<DeliverResult | null>}
   */
  async function deliver({ kind, to, replyAddress, subject, defaultBody, ctx }) {
    if (!to) return null;
    let body = defaultBody;
    if (composeNotification) {
      try {
        const custom = composeNotification({ ...ctx, kind, to, replyAddress });
        if (custom) body = custom;
      } catch { /* hook failure → neutral default */ }
    }
    // newMessageId/buildRawMessage throw on a falsy domain/from/body at runtime;
    // surface the same requirements to the type system without changing behaviour
    // (the throw point only moves a line earlier, with the same effect).
    if (!domain) throw new Error('createNotifier: domain required to deliver');
    if (!replyAddress || body == null) {
      throw new Error('deliver: from (replyAddress) and body are required');
    }
    const rawMessage = buildRawMessage({
      from: replyAddress,
      to,
      subject: sanitizeSubject(subject),
      body,
      messageId: newMessageId(domain),
      domain,
      autoSubmitted: 'auto-generated',
    });
    const res = await sendmail({ from: replyAddress, rawMessage, binary: sendmailBin, to: [to] });
    return { kind, to, ok: !!res.ok, reason: res.reason || null };
  }

  return { deliver };
}

export { createNotifier };
