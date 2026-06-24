// Shared JSDoc type vocabulary — the domain shapes that recur across the
// pillars (SPEC §0–4). This module declares ONLY types: no runtime code. Other
// modules reference these via `import('./types.js').Name` in their JSDoc, so every
// annotation speaks one vocabulary instead of re-inventing `Event`/`Step` shapes.
// tsc emits types.d.ts from these typedefs — the JSDoc here is the source of
// truth, the .d.ts is generated (no hand-maintained second copy).


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
 * A workflow step (SPEC §3). `status`/`commit_sequence`/`dependsOn` are filled
 * by `expandFlow` at creation; the rest are caller-supplied.
 * @typedef {Object} Step
 * @property {string} id
 * @property {string} [name]
 * @property {string} [participant]              The address whose reply counts.
 * @property {string} [deadline]                 'YYYY-MM-DD'.
 * @property {boolean} [requires_attachment]
 * @property {string} [details]
 * @property {'pending' | 'complete'} [status]
 * @property {number | null} [commit_sequence]   The reply commit that completed it.
 * @property {string[]} [dependsOn]              Step ids that gate eligibility.
 * @property {string} [completed_at]
 * @property {{ reason: string, code: string | null, at: string } | null} [last_send_error]
 */

/**
 * A counted crypto sign-off (SPEC §4 crypto-event shape). Non-PII only.
 * @typedef {Object} Signature
 * @property {string} sender_hash       Salted hash of the signer (SPEC §0.1).
 * @property {string | null} sender_domain
 * @property {number} commit_sequence
 * @property {string} received_at
 * @property {string} trust_level
 */

/**
 * A mailproof event record (SPEC §4) — workflow or crypto. One open shape with
 * mode-specific fields optional, so consumers don't fight union narrowing.
 * @typedef {Object} MailproofEvent
 * @property {string} id
 * @property {'workflow' | 'crypto'} type
 * @property {string} created_at
 * @property {string} salt                       Per-event public salt (SPEC §0.1).
 * @property {'open' | 'complete' | string} status
 * @property {string | null} activated_at
 * @property {string | null} completed_at
 * @property {string | null} archived_at
 * @property {string} [title]
 * @property {string} [initiator]                Initiator address (operator plaintext).
 * @property {'sequential' | 'parallel' | 'custom'} [flow]   Workflow only.
 * @property {Step[]} [steps]                     Workflow only.
 * @property {string[]} [signers]                 Crypto only (lowercased).
 * @property {boolean} [open]                     Crypto only — any sender may sign.
 * @property {number} [threshold]                 Crypto only — distinct sigs to complete.
 * @property {string | null} [requiredDocHash]    Crypto only — optional doc gate.
 * @property {Signature[]} [signatures]           Crypto only.
 * @property {string} [archive_reason]
 * @property {string} [reopened_at]             Set when a completed event is reopened by consumer policy.
 * @property {string | null} [reopened_reason]  Opaque consumer-supplied reason for the reopen.
 * @property {string} [nudged_overdue_at]
 * @property {string} [proof_email_message_id]
 * @property {string} [ots_proof_anchored_notified_at]
 */

/**
 * A ledger reply-commit's metadata (SPEC §4; `buildCommitMetadata` output).
 * @typedef {Object} Commit
 * @property {number} schema_version
 * @property {string} kind                        'reply' | 'reverify' | 'event_edit' | 'completion'
 * @property {string} event_id
 * @property {string | null} [step_id]
 * @property {number} sequence
 * @property {string} received_at
 * @property {string | null} sender_hash
 * @property {string | null} sender_domain
 * @property {string | null} message_id_hash
 * @property {TrustLevel} [trust_level]
 * @property {boolean} [participant_match]
 * @property {boolean} counted
 * @property {string | null} count_reason
 * @property {Attachment[]} [attachments]
 * @property {Object | null} [dkim]
 * @property {Object | null} [spf]
 * @property {Object | null} [dmarc]
 * @property {Object | null} [arc]
 * @property {{ client_ip: string | null, client_helo: string | null }} [envelope]
 * @property {Record<string, any>} [dkim_archive]
 * @property {Record<string, any>} [ots_archive]
 * @property {string} [raw_sha256]
 * @property {number} [raw_size]
 * @property {string | null} [dkim_key_file]
 * @property {string | null} [ots_proof_file]
 */

/**
 * A reply COUNT decision returned by both sequencing engines.
 * @typedef {Object} CountDecision
 * @property {boolean} count                      Whether the reply advances state.
 * @property {string} [reason]                    Machine code when `count` is false.
 * @property {Step} [step]                        The resolved step (workflow).
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

/**
 * One outbound notification record (`deliver` result).
 * @typedef {Object} DeliverResult
 * @property {string} kind
 * @property {string} to
 * @property {boolean} ok
 * @property {string | null} reason
 */

export {};
