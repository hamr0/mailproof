export type MailproofEvent = import("./types").MailproofEvent;
export type Step = import("./types").Step;
/**
 * Bind an event store to a fixed data directory. All disk-touching primitives
 * close over `dataDir`; pure helpers are returned as-is.
 * @param {{ dataDir?: string }} [opts]
 * @returns {{
 *   loadEvent: (eventId: string) => Promise<MailproofEvent | null>,
 *   listEventIds: () => Promise<string[]>,
 *   findStep: typeof findStep,
 *   senderMatchesStep: typeof senderMatchesStep,
 *   isComplete: typeof isComplete,
 *   createEvent: (partialEvent: Partial<MailproofEvent> & Record<string, any>) => Promise<MailproofEvent>,
 *   activateEvent: (eventId: string, opts?: { now?: string }) => Promise<{ event: MailproofEvent, alreadyActive: boolean }>,
 *   editEvent: (eventId: string, patch: any, opts?: { now?: string, organiserHandle?: string | null }) => Promise<{ event: MailproofEvent, prev: MailproofEvent, changes: any[], commitSequence: number | null }>,
 *   writeEventAtomic: (id: string, event: MailproofEvent) => Promise<void>,
 *   recordStepSendErrors: (eventId: string, errorsByStepId: Record<string, any>) => Promise<MailproofEvent | null>,
 *   recordProofEmailMessageId: (eventId: string, messageId: string) => Promise<string | null>,
 *   generateEventId: typeof generateEventId,
 *   generateEventSalt: typeof generateEventSalt,
 * }}
 */
export function createEventStore({ dataDir }?: {
    dataDir?: string;
}): {
    loadEvent: (eventId: string) => Promise<MailproofEvent | null>;
    listEventIds: () => Promise<string[]>;
    findStep: typeof findStep;
    senderMatchesStep: typeof senderMatchesStep;
    isComplete: typeof isComplete;
    createEvent: (partialEvent: Partial<MailproofEvent> & Record<string, any>) => Promise<MailproofEvent>;
    activateEvent: (eventId: string, opts?: {
        now?: string;
    }) => Promise<{
        event: MailproofEvent;
        alreadyActive: boolean;
    }>;
    editEvent: (eventId: string, patch: any, opts?: {
        now?: string;
        organiserHandle?: string | null;
    }) => Promise<{
        event: MailproofEvent;
        prev: MailproofEvent;
        changes: any[];
        commitSequence: number | null;
    }>;
    writeEventAtomic: (id: string, event: MailproofEvent) => Promise<void>;
    recordStepSendErrors: (eventId: string, errorsByStepId: Record<string, any>) => Promise<MailproofEvent | null>;
    recordProofEmailMessageId: (eventId: string, messageId: string) => Promise<string | null>;
    generateEventId: typeof generateEventId;
    generateEventSalt: typeof generateEventSalt;
};
/**
 * Normalize a caller's partial event into the canonical record both engines
 * read (SPEC §3 workflow / §3.1 crypto). Pure; structural validation only.
 * @param {Partial<MailproofEvent> & Record<string, any>} partialEvent
 * @param {{ now?: string }} [opts]
 * @returns {MailproofEvent}
 */
export function buildEventRecord(partialEvent: Partial<MailproofEvent> & Record<string, any>, { now }?: {
    now?: string;
}): MailproofEvent;
/**
 * Expand the `flow` sugar into the canonical per-step `dependsOn` graph. Pure.
 * @param {Step[]} steps
 * @param {'sequential' | 'parallel' | 'custom'} flow
 * @returns {Step[]}
 */
export function expandFlow(steps: Step[], flow: "sequential" | "parallel" | "custom"): Step[];
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/** @typedef {import('./types').Step} Step */
/**
 * Canonical "is this event complete?" predicate (schema-level). Pure.
 * @param {MailproofEvent | null | undefined} event
 * @returns {boolean}
 */
export function isComplete(event: MailproofEvent | null | undefined): boolean;
/**
 * Find a step by id on an event, or null. Pure.
 * @param {MailproofEvent | null} event
 * @param {string | null} stepId
 * @returns {Step | null}
 */
declare function findStep(event: MailproofEvent | null, stepId: string | null): Step | null;
/**
 * Does a sender address match a step's participant (normalised)? Pure.
 * @param {string | null} senderAddr
 * @param {Step | null} step
 * @returns {boolean}
 */
declare function senderMatchesStep(senderAddr: string | null, step: Step | null): boolean;
/**
 * Generate a short url-safe alphanumeric event ID.
 * @returns {string}
 */
declare function generateEventId(): string;
/**
 * Generate an event's public salt (32 bytes hex). Pure.
 * @returns {string}
 */
declare function generateEventSalt(): string;
export {};
