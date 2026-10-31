// Types for the v2 proof layer (src/proof/*). Declares ONLY types: no runtime
// code. The v1 src/types.js aliases the shapes shared with it, so there is one
// definition per concept.

/**
 * Trust level a reply is classified at (SPEC §1, strongest-first).
 * @typedef {'verified' | 'forwarded' | 'authorized' | 'unverified'} TrustLevel
 */

/**
 * The raw result of mailauth's `authenticate()`. mailauth ships no types, so
 * this is intentionally open — the kernel only reads a few nested verdicts.
 * @typedef {Record<string, any>} MailauthResult
 */

/**
 * Postfix pipe-transport envelope (the `parseEnvelope` shape + `ingest` input).
 * @typedef {Object} Envelope
 * @property {string | null} [clientIp]   Connecting client IP (mailauth SPF).
 * @property {string | null} [clientHelo] Client HELO/EHLO name.
 * @property {string | null} [sender]     Envelope MAIL FROM.
 * @property {string | null} [recipient]  Envelope (original) RCPT TO — the plus-tag.
 */

/**
 * One attachment fingerprint from a parsed message (content stripped; the
 * `sha256` is the notary fingerprint of the part bytes).
 * @typedef {Object} Attachment
 * @property {string | null} filename
 * @property {number} size
 * @property {string | null} sha256  `sha256:`-prefixed hex, or null.
 */

/**
 * The structured shape `parseMessage` decodes raw RFC-822 bytes into.
 * @typedef {Object} ParsedMessage
 * @property {{ address: string | null, name: string | null }} from
 * @property {string | null} messageId
 * @property {Attachment[]} attachments
 * @property {string} rawSha256  `sha256:`-prefixed hex of the raw bytes.
 */

/**
 * Compact per-pillar auth summary the ledger records on each commit (`summariseAuth`).
 * @typedef {Object} AuthSummary
 * @property {{ result?: string } | { signatures: Array<Record<string, any>> }} dkim
 * @property {{ result: any } | null} spf
 * @property {{ result: any } | null} dmarc
 * @property {{ result: any, comment: any, chain_length: number } | null} arc
 */

/**
 * The archived DKIM public key for one commit (`fetchDkimKey` output).
 * @typedef {Object} DkimArchive
 * @property {string | null} pem
 * @property {string | null} base64
 * @property {string} [error]
 * @property {string} [fetched_at]
 * @property {string} [lookup]
 */

export {};
