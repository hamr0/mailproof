/**
 * Submit a raw message to the local MTA via sendmail(8). Never throws under
 * normal operation — failure is reported in the resolved object. `binary` is
 * required (injected config).
 * @param {{ from?: string, rawMessage?: string, binary?: string | null, to?: string[] }} args
 * @returns {Promise<{ ok: boolean, code?: number, stderr?: string | null, reason?: string }>}
 */
export function sendmail({ from, rawMessage, binary, to }: {
    from?: string;
    rawMessage?: string;
    binary?: string | null;
    to?: string[];
}): Promise<{
    ok: boolean;
    code?: number;
    stderr?: string | null;
    reason?: string;
}>;
/**
 * Build a raw RFC-822 message from structured fields (plaintext only). The
 * canonical builder; from/to/subject/body are required.
 * @param {Object} fields
 * @param {string} fields.from
 * @param {string} fields.to
 * @param {string} fields.subject
 * @param {string} fields.body
 * @param {string} [fields.inReplyTo]
 * @param {string} [fields.references]
 * @param {string | false} [fields.autoSubmitted]
 * @param {string} [fields.messageId]
 * @param {Record<string, string>} [fields.extraHeaders]
 * @param {string} [fields.domain]
 * @param {string} [fields.replyTo]
 * @param {string} [fields.footer]
 * @returns {string}
 */
export function buildRawMessage({ from, to, subject, body, inReplyTo, references, autoSubmitted, messageId, extraHeaders, domain, replyTo, footer }: {
    from: string;
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string | undefined;
    references?: string | undefined;
    autoSubmitted?: string | false | undefined;
    messageId?: string | undefined;
    extraHeaders?: Record<string, string> | undefined;
    domain?: string | undefined;
    replyTo?: string | undefined;
    footer?: string | undefined;
}): string;
/**
 * Strip CR/LF from a subject so it can't inject extra headers. Pure.
 * @param {*} s
 * @returns {string}
 */
export function sanitizeSubject(s: any): string;
/**
 * Generate an RFC 5322 Message-Id `<timestamp.random@domain>`. Domain required.
 * @param {string} domain
 * @returns {string}
 */
export function newMessageId(domain: string): string;
/**
 * Format a date as an RFC 5322 date-time string. Pure.
 * @param {Date} [d]
 * @returns {string}
 */
export function rfc5322Date(d?: Date): string;
/**
 * Append an injected signature footer (RFC 3676 `-- ` marker). Idempotent; a
 * falsy footer returns the body verbatim. Pure.
 * @param {string} body
 * @param {string | null | undefined} footer
 * @returns {string}
 */
export function withSignature(body: string, footer: string | null | undefined): string;
