export type Envelope = import("./types").Envelope;
export type ParsedMessage = import("./types").ParsedMessage;
export type AuthSummary = import("./types").AuthSummary;
export type MailauthResult = import("./types").MailauthResult;
/**
 * The subset of mailparser's `ParsedMail` the kernel reads. mailparser ships no
 * type declarations, so this local shape pins exactly the fields used here
 * (the `simpleParser` require is typed against it below).
 */
export type ParsedMail = {
    from?: {
        value?: Array<{
            address?: string;
            name?: string;
        }>;
    } | null | undefined;
    messageId?: string | null | undefined;
    attachments?: {
        filename?: string;
        size?: number;
        content?: Buffer;
    }[] | undefined;
};
/** @typedef {import('./types').Envelope} Envelope */
/** @typedef {import('./types').ParsedMessage} ParsedMessage */
/** @typedef {import('./types').AuthSummary} AuthSummary */
/** @typedef {import('./types').MailauthResult} MailauthResult */
/**
 * Authenticate an inbound message via mailauth (DKIM/DMARC/ARC/SPF). Pins
 * `trustReceived:false`. Config is injected (no env singleton).
 * @param {Buffer | string} raw
 * @param {Envelope} [envelope]
 * @param {{ mtaHostname?: string | null, resolver?: any }} [opts]
 * @returns {Promise<MailauthResult>}
 */
export function authenticateMessage(raw: Buffer | string, envelope?: Envelope, { mtaHostname, resolver }?: {
    mtaHostname?: string | null;
    resolver?: any;
}): Promise<MailauthResult>;
/**
 * Parse raw bytes into the structured shape the kernel consumes. Attachment
 * bytes are hashed (notary capture) then dropped. Deterministic, no network.
 * @param {Buffer | string} raw
 * @returns {Promise<ParsedMessage>}
 */
export function parseMessage(raw: Buffer | string): Promise<ParsedMessage>;
/**
 * Reduce a mailauth result to the compact auth summaries the ledger records
 * (SPEC §4). Pure — interprets the auth object, no I/O.
 * @param {MailauthResult} auth
 * @returns {AuthSummary}
 */
export function summariseAuth(auth: MailauthResult): AuthSummary;
/**
 * Recover the raw bytes of every attachment part (+ the message-id) from a
 * forwarded message. Transient read-path only — never persisted (SPEC §6).
 * @param {Buffer | string} raw
 * @returns {Promise<{ messageId: string | null, candidates: Buffer[] }>}
 */
export function extractVerifyCandidates(raw: Buffer | string): Promise<{
    messageId: string | null;
    candidates: Buffer[];
}>;
