export type MailproofEvent = import("./types").MailproofEvent;
export type Signature = import("./types").Signature;
export type Attachment = import("./types").Attachment;
/**
 * The in-memory sign-off reply input the engine reasons over.
 */
export type SignoffInput = {
    trust_level?: string | undefined;
    is_initiator?: boolean | undefined;
    signer_match?: boolean | undefined;
    sender_hash?: string | null | undefined;
    sender_domain?: string | null | undefined;
    received_at?: string | undefined;
    sequence?: number | undefined;
    attachments?: import("./types").Attachment[] | undefined;
};
/**
 * Decide whether a reply counts as a distinct sign-off (accept-with-flag). Pure.
 * @param {MailproofEvent} event
 * @param {SignoffInput} commit
 * @returns {{ count: boolean, reason?: string }}
 */
export function shouldCount(event: MailproofEvent, commit: SignoffInput): {
    count: boolean;
    reason?: string;
};
/**
 * Apply a sign-off reply, returning a NEW event (never mutates input). Appends
 * the distinct signature and locks the event at threshold. Pure.
 * @param {MailproofEvent} event
 * @param {SignoffInput} commit
 * @param {{ now?: string }} [opts]
 * @returns {{ event: MailproofEvent, applied: boolean, decision: { count: boolean, reason?: string }, signatureCount?: number, completedEvent?: boolean }}
 */
export function applyReply(event: MailproofEvent, commit: SignoffInput, { now }?: {
    now?: string;
}): {
    event: MailproofEvent;
    applied: boolean;
    decision: {
        count: boolean;
        reason?: string;
    };
    signatureCount?: number;
    completedEvent?: boolean;
};
import { isComplete } from "./event-store";
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/** @typedef {import('./types').Signature} Signature */
/** @typedef {import('./types').Attachment} Attachment */
/**
 * The in-memory sign-off reply input the engine reasons over.
 * @typedef {Object} SignoffInput
 * @property {string} [trust_level]
 * @property {boolean} [is_initiator]
 * @property {boolean} [signer_match]
 * @property {string | null} [sender_hash]
 * @property {string | null} [sender_domain]
 * @property {string} [received_at]
 * @property {number} [sequence]
 * @property {Attachment[]} [attachments]
 */
/**
 * The distinct signatures already counted on an event. Pure.
 * @param {MailproofEvent} event
 * @returns {Signature[]}
 */
export function signatures(event: MailproofEvent): Signature[];
export const CRYPTO_REASONS: Readonly<{
    EVENT_NOT_ACTIVATED: "event_not_activated";
    EVENT_ARCHIVED: "event_archived";
    ALREADY_COMPLETE: "already_complete";
    UNVERIFIED_TRUST: "unverified_trust";
    INITIATOR_SELF_REPLY: "initiator_self_reply";
    NOT_A_SIGNER: "not_a_signer";
    ALREADY_SIGNED: "already_signed";
    DOC_HASH_MISMATCH: "doc_hash_mismatch";
}>;
export { isComplete };
