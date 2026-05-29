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
    clientIp?: string | null;
    /**
     * Client HELO/EHLO name.
     */
    clientHelo?: string | null;
    /**
     * Envelope MAIL FROM.
     */
    sender?: string | null;
    /**
     * Envelope (original) RCPT TO — the plus-tag.
     */
    recipient?: string | null;
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
    name?: string;
    /**
     * The address whose reply counts.
     */
    participant?: string;
    /**
     * 'YYYY-MM-DD'.
     */
    deadline?: string;
    requires_attachment?: boolean;
    details?: string;
    status?: "pending" | "complete";
    /**
     * The reply commit that completed it.
     */
    commit_sequence?: number | null;
    /**
     * Step ids that gate eligibility.
     */
    dependsOn?: string[];
    completed_at?: string;
    last_send_error?: {
        reason: string;
        code: string | null;
        at: string;
    } | null;
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
    title?: string;
    /**
     * Initiator address (operator plaintext).
     */
    initiator?: string;
    /**
     * Workflow only.
     */
    flow?: "sequential" | "parallel" | "custom";
    /**
     * Workflow only.
     */
    steps?: Step[];
    /**
     * Crypto only (lowercased).
     */
    signers?: string[];
    /**
     * Crypto only — any sender may sign.
     */
    open?: boolean;
    /**
     * Crypto only — distinct sigs to complete.
     */
    threshold?: number;
    /**
     * Crypto only — optional doc gate.
     */
    requiredDocHash?: string | null;
    /**
     * Crypto only.
     */
    signatures?: Signature[];
    archive_reason?: string;
    nudged_overdue_at?: string;
    proof_email_message_id?: string;
    ots_proof_anchored_notified_at?: string;
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
    step_id?: string | null;
    sequence: number;
    received_at: string;
    sender_hash: string | null;
    sender_domain: string | null;
    message_id_hash: string | null;
    trust_level?: TrustLevel;
    participant_match?: boolean;
    counted: boolean;
    count_reason: string | null;
    attachments?: Attachment[];
    dkim?: any | null;
    spf?: any | null;
    dmarc?: any | null;
    arc?: any | null;
    envelope?: {
        client_ip: string | null;
        client_helo: string | null;
    };
    dkim_archive?: Record<string, any>;
    ots_archive?: Record<string, any>;
    raw_sha256?: string;
    raw_size?: number;
    dkim_key_file?: string | null;
    ots_proof_file?: string | null;
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
    reason?: string;
    /**
     * The resolved step (workflow).
     */
    step?: Step;
};
/**
 * The archived DKIM public key for one commit (`fetchDkimKey` output).
 */
export type DkimArchive = {
    pem: string | null;
    base64: string | null;
    error?: string;
    fetched_at?: string;
    lookup?: string;
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
