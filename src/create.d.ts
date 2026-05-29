export type MailproofEvent = import("./types").MailproofEvent;
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/**
 * Compose a bound mailproof instance — wires the four pillars over one dataDir.
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]     Root for events/*.json + per-event repos (REQUIRED at runtime).
 * @param {string} [opts.domain]      Operator domain for Message-Ids + plus-tags (REQUIRED at runtime).
 * @param {string} [opts.sendmailBin] Path to sendmail(8); absent ⇒ sends report {ok:false}.
 * @param {string} [opts.otsBin]      Path to the `ots` binary for OpenTimestamps.
 * @param {string} [opts.mtaHostname] This MTA's hostname for mailauth.
 * @param {any} [opts.resolver]       Custom DNS resolver for mailauth (tests inject offline).
 * @param {(ctx: Record<string, any>) => string | null | undefined} [opts.composeNotification] Body hook (§8.6).
 * @param {number} [opts.overdueDays] sweep(): idle days before the overdue nudge (default 14).
 * @param {number} [opts.archiveDays] sweep(): idle days before auto-archive (default 45).
 * @returns {{
 *   ingest: (raw: Buffer | string, envelope?: import('./types').Envelope) => Promise<Record<string, any>>,
 *   sweep: (opts?: { now?: number }) => Promise<Record<string, any>>,
 *   upgradeProofs: ((opts?: { now?: string }) => Promise<Record<string, any>>) | undefined,
 *   createEvent: (partialEvent: Partial<MailproofEvent> & Record<string, any>) => Promise<MailproofEvent>,
 *   activateEvent: (eventId: string, opts?: { now?: string }) => Promise<Record<string, any>>,
 *   editEvent: (eventId: string, patch: any, opts?: any) => Promise<Record<string, any>>,
 *   loadEvent: (eventId: string) => Promise<MailproofEvent | null>,
 *   listCommits: (eventId: string) => Promise<Record<string, any>[]>,
 *   loadCommit: (eventId: string, sequence: number) => Promise<Record<string, any> | null>,
 *   verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: { email?: string }) => Promise<Record<string, any>>,
 *   hashDocument: (bytes: Buffer | Uint8Array | string) => string,
 *   verify: (eventId: string, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>,
 *   reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>,
 * }}
 */
export function create({ dataDir, domain, sendmailBin, otsBin, mtaHostname, resolver, composeNotification, overdueDays, archiveDays, }?: {
    dataDir?: string;
    domain?: string;
    sendmailBin?: string;
    otsBin?: string;
    mtaHostname?: string;
    resolver?: any;
    composeNotification?: (ctx: Record<string, any>) => string | null | undefined;
    overdueDays?: number;
    archiveDays?: number;
}): {
    ingest: (raw: Buffer | string, envelope?: import("./types").Envelope) => Promise<Record<string, any>>;
    sweep: (opts?: {
        now?: number;
    }) => Promise<Record<string, any>>;
    upgradeProofs: ((opts?: {
        now?: string;
    }) => Promise<Record<string, any>>) | undefined;
    createEvent: (partialEvent: Partial<MailproofEvent> & Record<string, any>) => Promise<MailproofEvent>;
    activateEvent: (eventId: string, opts?: {
        now?: string;
    }) => Promise<Record<string, any>>;
    editEvent: (eventId: string, patch: any, opts?: any) => Promise<Record<string, any>>;
    loadEvent: (eventId: string) => Promise<MailproofEvent | null>;
    listCommits: (eventId: string) => Promise<Record<string, any>[]>;
    loadCommit: (eventId: string, sequence: number) => Promise<Record<string, any> | null>;
    verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: {
        email?: string;
    }) => Promise<Record<string, any>>;
    hashDocument: (bytes: Buffer | Uint8Array | string) => string;
    verify: (eventId: string, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>;
    reverify: (eventId: string, targetSequence: number, candidateBytes: Buffer | string, opts?: Record<string, any>) => Promise<Record<string, any>>;
};
