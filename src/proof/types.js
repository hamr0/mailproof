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
 * @property {string | null} inReplyTo
 * @property {string[]} references
 * @property {Attachment[]} attachments
 * @property {string} rawSha256  `sha256:`-prefixed hex of the raw bytes.
 * @property {string | null} [subject]  Decoded Subject (transient; never stored outside signed_headers).
 * @property {Buffer[]} [rfc822]  Raw bytes of each `message/rfc822` part (transient).
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
 * @property {string} [k]
 * @property {string} [txt]
 * @property {string} [error]
 * @property {string} [fetched_at]
 * @property {string} [lookup]
 */

/**
 * One stored DKIM signature (SPEC Part B1).
 * @typedef {Object} RecordSignature
 * @property {string} dkim_signature  Base64 of the raw DKIM-Signature header line.
 * @property {Record<string, string | null>} tags  Informational copy of d,s,a,c,h,bh,l,t,x.
 * @property {string[]} signed_headers  Base64 raw lines, in hashing order.
 * @property {{ k: string, p: string } | null} key
 * @property {string | null} key_error
 * @property {string | null} key_file
 * @property {boolean} partial_body  l= present and shorter than the canonical body.
 * @property {BodyResult} body  Body status of this signature (never affects a trust verdict).
 */

/**
 * `matched`: the body hashes to the signed `bh=`. `partial`: `l=` signs only a prefix and that prefix matches.
 * `mismatch`: it does not. `not-checked`: nothing to check against (unsigned, or no raw email).
 * @typedef {'matched' | 'partial' | 'mismatch' | 'not-checked'} BodyStatus
 */

/**
 * One machine-readable hint about a body mismatch. `detail` carries counts, byte sizes and
 * domains only, never body text. Kinds: l_tag, appended, prepended, canonicalisation,
 * line_endings, forwarded, mailing_list, search_capped, unknown.
 * @typedef {Object} BodyExplain
 * @property {string} kind
 * @property {Record<string, any>} [detail]
 */

/**
 * @typedef {Object} BodyResult
 * @property {BodyStatus} status
 * @property {BodyExplain[]} explain
 */

/**
 * A stored record (SPEC Part B1). The verdict, message and ots shapes are open
 * here and pinned by SPEC.
 * @typedef {Object} MpRecord
 * @property {number} v
 * @property {string} id  First 32 hex of the raw bytes' sha256 (`message.raw_sha256`): one record per distinct copy.
 * @property {string | null} message_key  Shared by every copy of one signed message (see SPEC B1); null for unsigned mail with no Message-ID.
 * @property {MessageCopy} copy  Which kind of copy this is.
 * @property {string} captured
 * @property {'in' | 'out'} direction
 * @property {string} source
 * @property {Record<string, any>} message
 * @property {Array<{ filename: string | null, size: number, sha256: string }>} attachments
 * @property {RecordSignature[]} signatures
 * @property {BodyStatus} body_status  Best body status over the signatures that verify (see BodyStatus).
 * @property {Record<string, any>} verdicts
 */

/**
 * `direct`: signed, no ARC-Seal and no List-Id. `relayed`: ARC-Seal and/or List-Id present.
 * `forward`: the message is itself a forward (Subject prefix, or a message/rfc822 part with no List-Id).
 * `digest`: a list digest (List-Id or a multipart/digest part) that contains message/rfc822 parts.
 * `unknown`: no evidence (e.g. unsigned mail with no relay headers).
 * @typedef {'direct' | 'relayed' | 'forward' | 'digest' | 'unknown'} CopyKind
 */

/**
 * The signed original found attached to a forward (`message/rfc822`): the link is only
 * its key and verdict. The inner headers and body are NOT stored.
 * @typedef {Object} AttachedOriginal
 * @property {string | null} message_key
 * @property {'pass' | 'fail' | 'none'} dkim
 * @property {string | null} d
 * @property {BodyStatus} body_status
 */

/**
 * @typedef {Object} MessageCopy
 * @property {CopyKind} kind
 * @property {{ arc_sealers?: string[], list_id_domain?: string | null, subject_prefix?: true, attached_original?: AttachedOriginal[], capped?: true }} evidence  Domains and flags only.
 */

export {};
