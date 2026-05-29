/**
 * Trust level a reply is classified at (SPEC §1, strongest-first).
 */
export type TrustLevel = "verified" | "forwarded" | "authorized" | "unverified";
/**
 * The raw result of mailauth's `authenticate()`. mailauth ships no types, so
 * this is intentionally open — the kernel only reads a few nested verdicts.
 */
export type MailauthResult = Record<string, any>;
/**
 * Postfix pipe-transport envelope (the `parseEnvelope` shape + `ingest` input).
 */
export type Envelope = {
    /**
     * Connecting client IP (mailauth SPF).
     */
    clientIp?: string | null | undefined;
    /**
     * Client HELO/EHLO name.
     */
    clientHelo?: string | null | undefined;
    /**
     * Envelope MAIL FROM.
     */
    sender?: string | null | undefined;
    /**
     * Envelope (original) RCPT TO — the plus-tag.
     */
    recipient?: string | null | undefined;
};
/**
 * One attachment fingerprint from a parsed message (content stripped; the
 * `sha256` is the notary fingerprint of the part bytes).
 */
export type Attachment = {
    filename: string | null;
    size: number;
    /**
     * `sha256:`-prefixed hex, or null.
     */
    sha256: string | null;
};
/**
 * The structured shape `parseMessage` decodes raw RFC-822 bytes into.
 */
export type ParsedMessage = {
    from: {
        address: string | null;
        name: string | null;
    };
    messageId: string | null;
    attachments: Attachment[];
    /**
     * `sha256:`-prefixed hex of the raw bytes.
     */
    rawSha256: string;
};
/**
 * Compact per-pillar auth summary the ledger records on each commit (`summariseAuth`).
 */
export type AuthSummary = {
    dkim: {
        result?: string;
    } | {
        signatures: Array<Record<string, any>>;
    };
    spf: {
        result: any;
    } | null;
    dmarc: {
        result: any;
    } | null;
    arc: {
        result: any;
        comment: any;
        chain_length: number;
    } | null;
};
/**
 * A workflow step (SPEC §3). `status`/`commit_sequence`/`dependsOn` are filled
 * by `expandFlow` at creation; the rest are caller-supplied.
 */
export type Step = {
    id: string;
    name?: string | undefined;
    /**
     * The address whose reply counts.
     */
    participant?: string | undefined;
    /**
     * 'YYYY-MM-DD'.
     */
    deadline?: string | undefined;
    requires_attachment?: boolean | undefined;
    details?: string | undefined;
    status?: "pending" | "complete" | undefined;
    /**
     * The reply commit that completed it.
     */
    commit_sequence?: number | null | undefined;
    /**
     * Step ids that gate eligibility.
     */
    dependsOn?: string[] | undefined;
    completed_at?: string | undefined;
    last_send_error?: {
        reason: string;
        code: string | null;
        at: string;
    } | null | undefined;
};
/**
 * A counted crypto sign-off (SPEC §4 crypto-event shape). Non-PII only.
 */
export type Signature = {
    /**
     * Salted hash of the signer (SPEC §0.1).
     */
    sender_hash: string;
    sender_domain: string | null;
    commit_sequence: number;
    received_at: string;
    trust_level: string;
};
/**
 * A mailproof event record (SPEC §4) — workflow or crypto. One open shape with
 * mode-specific fields optional, so consumers don't fight union narrowing.
 */
export type MailproofEvent = {
    id: string;
    type: "workflow" | "crypto";
    created_at: string;
    /**
     * Per-event public salt (SPEC §0.1).
     */
    salt: string;
    status: "open" | "complete" | string;
    activated_at: string | null;
    completed_at: string | null;
    archived_at: string | null;
    title?: string | undefined;
    /**
     * Initiator address (operator plaintext).
     */
    initiator?: string | undefined;
    /**
     * Workflow only.
     */
    flow?: "sequential" | "parallel" | "custom" | undefined;
    /**
     * Workflow only.
     */
    steps?: Step[] | undefined;
    /**
     * Crypto only (lowercased).
     */
    signers?: string[] | undefined;
    /**
     * Crypto only — any sender may sign.
     */
    open?: boolean | undefined;
    /**
     * Crypto only — distinct sigs to complete.
     */
    threshold?: number | undefined;
    /**
     * Crypto only — optional doc gate.
     */
    requiredDocHash?: string | null | undefined;
    /**
     * Crypto only.
     */
    signatures?: Signature[] | undefined;
    archive_reason?: string | undefined;
    nudged_overdue_at?: string | undefined;
    proof_email_message_id?: string | undefined;
    ots_proof_anchored_notified_at?: string | undefined;
};
/**
 * A ledger reply-commit's metadata (SPEC §4; `buildCommitMetadata` output).
 */
export type Commit = {
    schema_version: number;
    /**
     * 'reply' | 'reverify' | 'event_edit' | 'completion'
     */
    kind: string;
    event_id: string;
    step_id?: string | null | undefined;
    sequence: number;
    received_at: string;
    sender_hash: string | null;
    sender_domain: string | null;
    message_id_hash: string | null;
    trust_level?: TrustLevel | undefined;
    participant_match?: boolean | undefined;
    counted: boolean;
    count_reason: string | null;
    attachments?: Attachment[] | undefined;
    dkim?: Object | null | undefined;
    spf?: Object | null | undefined;
    dmarc?: Object | null | undefined;
    arc?: Object | null | undefined;
    envelope?: {
        client_ip: string | null;
        client_helo: string | null;
    } | undefined;
    dkim_archive?: Record<string, any> | undefined;
    ots_archive?: Record<string, any> | undefined;
    raw_sha256?: string | undefined;
    raw_size?: number | undefined;
    dkim_key_file?: string | null | undefined;
    ots_proof_file?: string | null | undefined;
};
/**
 * A reply COUNT decision returned by both sequencing engines.
 */
export type CountDecision = {
    /**
     * Whether the reply advances state.
     */
    count: boolean;
    /**
     * Machine code when `count` is false.
     */
    reason?: string | undefined;
    /**
     * The resolved step (workflow).
     */
    step?: Step | undefined;
};
/**
 * The archived DKIM public key for one commit (`fetchDkimKey` output).
 */
export type DkimArchive = {
    pem: string | null;
    base64: string | null;
    error?: string | undefined;
    fetched_at?: string | undefined;
    lookup?: string | undefined;
};
/**
 * One outbound notification record (`deliver` result).
 */
export type DeliverResult = {
    kind: string;
    to: string;
    ok: boolean;
    reason: string | null;
};
