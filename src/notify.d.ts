export type DeliverResult = import("./types").DeliverResult;
/**
 * One occasion-to-email delivery request.
 */
export type DeliverArgs = {
    kind: string;
    to?: string | null | undefined;
    replyAddress?: string | undefined;
    subject?: string | undefined;
    defaultBody?: string | undefined;
    ctx?: Record<string, any> | undefined;
};
/** @typedef {import('./types').DeliverResult} DeliverResult */
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
 * @param {typeof import('./outbound').buildRawMessage} deps.buildRawMessage
 * @param {typeof import('./outbound').sendmail} deps.sendmail
 * @param {typeof import('./outbound').newMessageId} deps.newMessageId
 * @param {typeof import('./outbound').sanitizeSubject} deps.sanitizeSubject
 * @param {string | null} [deps.domain]
 * @param {string | null} [deps.sendmailBin]
 * @param {((ctx: Record<string, any>) => string | null | undefined) | null} [deps.composeNotification]
 * @returns {{ deliver: (args: DeliverArgs) => Promise<DeliverResult | null> }}
 */
export function createNotifier({ buildRawMessage, sendmail, newMessageId, sanitizeSubject, domain, sendmailBin, composeNotification, }: {
    buildRawMessage: typeof import("./outbound").buildRawMessage;
    sendmail: typeof import("./outbound").sendmail;
    newMessageId: typeof import("./outbound").newMessageId;
    sanitizeSubject: typeof import("./outbound").sanitizeSubject;
    domain?: string | null | undefined;
    sendmailBin?: string | null | undefined;
    composeNotification?: ((ctx: Record<string, any>) => string | null | undefined) | null | undefined;
}): {
    deliver: (args: DeliverArgs) => Promise<DeliverResult | null>;
};
