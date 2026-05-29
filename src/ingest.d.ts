export type Envelope = import("./types").Envelope;
export type MailproofEvent = import("./types").MailproofEvent;
export type Step = import("./types").Step;
export type Commit = import("./types").Commit;
export type ParsedMessage = import("./types").ParsedMessage;
/**
 * A parsed plus-tag command (remind+/stats+) from router.parseInitiatorCommand.
 */
export type InitiatorCommand = {
    /**
     * 'remind' | 'stats'
     */
    command: string;
    eventId: string;
};
/**
 * A parsed verify+/reverify+ plus-tag from router.parseVerifyTag/parseReverifyTag.
 */
export type VerifyTag = {
    eventId: string;
    /**
     * Present on reverify+<id>-<seq>@.
     */
    commitSequence?: number | undefined;
};
/** @typedef {import('./types').Envelope} Envelope */
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/** @typedef {import('./types').Step} Step */
/** @typedef {import('./types').Commit} Commit */
/** @typedef {import('./types').ParsedMessage} ParsedMessage */
/**
 * A parsed plus-tag command (remind+/stats+) from router.parseInitiatorCommand.
 * @typedef {Object} InitiatorCommand
 * @property {string} command   'remind' | 'stats'
 * @property {string} eventId
 */
/**
 * A parsed verify+/reverify+ plus-tag from router.parseVerifyTag/parseReverifyTag.
 * @typedef {Object} VerifyTag
 * @property {string} eventId
 * @property {number} [commitSequence]   Present on reverify+<id>-<seq>@.
 */
/**
 * Compose the inbound pipeline over already-bound pillars. create() passes the
 * store/ledger/engines/decoders + auth config; ingest closes over them. The
 * dependency bag is all injected primitives (see the inline notes below).
 * @param {Record<string, any>} [deps]
 * @returns {(raw: Buffer | string, envelope?: Envelope) => Promise<Record<string, any>>}
 */
export function createIngest({ eventStore, gitrepo, workflowEngine, cryptoEngine, parseMessage, extractVerifyCandidates, authenticateMessage, summariseAuth, classifyTrust, fetchDkimKey, pickSignatureToArchive, parseEventTag, parseAttestTag, parseInitiatorCommand, parseVerifyTag, parseReverifyTag, verify, reverify, preFilter, extractHeaderBlock, isDeliveryStatusReport, extractDsn, permanentFailures, deliver, domain, mtaHostname, resolver, }?: Record<string, any>): (raw: Buffer | string, envelope?: Envelope) => Promise<Record<string, any>>;
