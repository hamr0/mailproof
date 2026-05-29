export type Envelope = import("./types").Envelope;
/** @typedef {import('./types').Envelope} Envelope */
/**
 * Compose the inbound pipeline over already-bound pillars. create() passes the
 * store/ledger/engines/decoders + auth config; ingest closes over them. The
 * dependency bag is all injected primitives (see the inline notes below).
 * @param {Record<string, any>} [deps]
 * @returns {(raw: Buffer | string, envelope?: Envelope) => Promise<Record<string, any>>}
 */
export function createIngest({ eventStore, gitrepo, workflowEngine, cryptoEngine, parseMessage, extractVerifyCandidates, authenticateMessage, summariseAuth, classifyTrust, fetchDkimKey, pickSignatureToArchive, parseEventTag, parseAttestTag, parseInitiatorCommand, parseVerifyTag, parseReverifyTag, verify, reverify, preFilter, extractHeaderBlock, isDeliveryStatusReport, extractDsn, permanentFailures, deliver, domain, mtaHostname, resolver, }?: Record<string, any>): (raw: Buffer | string, envelope?: Envelope) => Promise<Record<string, any>>;
