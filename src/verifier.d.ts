export type Commit = import("./types").Commit;
export type TrustLevel = import("./types").TrustLevel;
/**
 * Compose the offline durable-verifier over the bound ledger + store.
 * @param {{ gitrepo?: any, eventStore?: any, resolver?: any }} [deps]
 * @returns {{
 *   verify: (eventId: string, candidateBytes: Buffer | string, opts?: { messageId?: string | null, resolver?: any }) => Promise<Record<string, any>>,
 *   reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: { resolver?: any, now?: string }) => Promise<Record<string, any>>,
 *   findMatch: typeof findMatch,
 *   reverifyDkim: typeof reverifyDkim,
 *   resolveUpgrade: typeof resolveUpgrade,
 *   pickSigner: typeof pickSigner,
 * }}
 */
export function createVerifier({ gitrepo, eventStore, resolver: defaultResolver }?: {
    gitrepo?: any;
    eventStore?: any;
    resolver?: any;
}): {
    verify: (eventId: string, candidateBytes: Buffer | string, opts?: {
        messageId?: string | null;
        resolver?: any;
    }) => Promise<Record<string, any>>;
    reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: {
        resolver?: any;
        now?: string;
    }) => Promise<Record<string, any>>;
    findMatch: typeof findMatch;
    reverifyDkim: typeof reverifyDkim;
    resolveUpgrade: typeof resolveUpgrade;
    pickSigner: typeof pickSigner;
};
/** @typedef {import('./types').Commit} Commit */
/** @typedef {import('./types').TrustLevel} TrustLevel */
/**
 * Match candidate bytes against an event's commits (raw → message-id → any
 * attachment). Pure.
 * @param {Buffer} candidateBytes
 * @param {Commit[]} commits
 * @param {{ messageIdHash?: string | null }} [opts]
 * @returns {{ matchType: 'raw_email' | 'message_id' | 'attachment' | 'none', hash: string, commit?: Commit, attachment?: Record<string, any>, messageIdHash?: string | null }}
 */
export function findMatch(candidateBytes: Buffer, commits: Commit[], { messageIdHash }?: {
    messageIdHash?: string | null;
}): {
    matchType: "raw_email" | "message_id" | "attachment" | "none";
    hash: string;
    commit?: Commit;
    attachment?: Record<string, any>;
    messageIdHash?: string | null;
};
/**
 * Re-run DKIM on `rawEmail` against an ARCHIVED PEM key. Never throws.
 * @param {Buffer | string} rawEmail
 * @param {string | null} archivedPem
 * @param {string} expectedDomain
 * @param {string} expectedSelector
 * @param {{ baseResolver?: any }} [opts]
 * @returns {Promise<{ ok: boolean, result?: string, reason?: string, signatures_found?: Array<Record<string, any>> }>}
 */
export function reverifyDkim(rawEmail: Buffer | string, archivedPem: string | null, expectedDomain: string, expectedSelector: string, { baseResolver }?: {
    baseResolver?: any;
}): Promise<{
    ok: boolean;
    result?: string;
    reason?: string;
    signatures_found?: Array<Record<string, any>>;
}>;
/**
 * Trust-upgrade policy for a contested commit (pure).
 * @param {string} currentLevel
 * @returns {{ upgradeTo: TrustLevel | null, reason: string | null }}
 */
export function resolveUpgrade(currentLevel: string): {
    upgradeTo: TrustLevel | null;
    reason: string | null;
};
/**
 * Find the signing domain/selector in a commit's DKIM summary. Pure.
 * @param {Record<string, any>} commit
 * @returns {{ domain: string, selector: string, result?: string } | null}
 */
export function pickSigner(commit: Record<string, any>): {
    domain: string;
    selector: string;
    result?: string;
} | null;
