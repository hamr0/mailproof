export type DeliverResult = import("./types").DeliverResult;
/** @typedef {import('./types').DeliverResult} DeliverResult */
/**
 * Bind the shared neutral-notification seam. Returns `{ deliver }`; create()
 * builds exactly one and threads it into ingest() and sweep().
 * @param {Object} [deps]
 * @param {typeof import('./outbound').buildRawMessage} [deps.buildRawMessage]
 * @param {typeof import('./outbound').sendmail} [deps.sendmail]
 * @param {typeof import('./outbound').newMessageId} [deps.newMessageId]
 * @param {typeof import('./outbound').sanitizeSubject} [deps.sanitizeSubject]
 * @param {string | null} [deps.domain]
 * @param {string | null} [deps.sendmailBin]
 * @param {((ctx: Record<string, any>) => string | null | undefined) | null} [deps.composeNotification]
 * @returns {{ deliver: (args: { kind: string, to?: string | null, replyAddress?: string, subject?: string, defaultBody?: string, ctx?: Record<string, any> }) => Promise<DeliverResult | null> }}
 */
export function createNotifier({ buildRawMessage, sendmail, newMessageId, sanitizeSubject, domain, sendmailBin, composeNotification, }?: {
    buildRawMessage?: typeof import("./outbound").buildRawMessage;
    sendmail?: typeof import("./outbound").sendmail;
    newMessageId?: typeof import("./outbound").newMessageId;
    sanitizeSubject?: typeof import("./outbound").sanitizeSubject;
    domain?: string | null;
    sendmailBin?: string | null;
    composeNotification?: ((ctx: Record<string, any>) => string | null | undefined) | null;
}): {
    deliver: (args: {
        kind: string;
        to?: string | null;
        replyAddress?: string;
        subject?: string;
        defaultBody?: string;
        ctx?: Record<string, any>;
    }) => Promise<DeliverResult | null>;
};
