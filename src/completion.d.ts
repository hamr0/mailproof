export type MailproofEvent = import("./types").MailproofEvent;
export type Step = import("./types").Step;
export type CountDecision = import("./types").CountDecision;
/**
 * The in-memory reply input the engine reasons over (the orchestrator computes
 * the identity booleans; the engine stays pure).
 */
export type ReplyInput = {
    step_id?: string | null;
    participant_match?: boolean;
    trust_level?: string;
    has_attachment?: boolean;
    sequence?: number;
};
/**
 * Decide whether a workflow reply counts toward its step (accept-with-flag).
 * Pure.
 * @param {MailproofEvent} event
 * @param {ReplyInput} commit
 * @returns {CountDecision}
 */
export function shouldCount(event: MailproofEvent, commit: ReplyInput): CountDecision;
/**
 * Apply a workflow reply, returning a NEW event (never mutates input). Only
 * transitions when `shouldCount(...).count`. Pure.
 * @param {MailproofEvent} event
 * @param {ReplyInput} commit
 * @param {{ now?: string }} [opts]
 * @returns {{ event: MailproofEvent, applied: boolean, decision: CountDecision, completedStep?: string | null, completedEvent?: boolean }}
 */
export function applyReply(event: MailproofEvent, commit: ReplyInput, { now }?: {
    now?: string;
}): {
    event: MailproofEvent;
    applied: boolean;
    decision: CountDecision;
    completedStep?: string | null;
    completedEvent?: boolean;
};
import { isComplete } from "./event-store";
/**
 * The first step that isn't complete, or null. Pure.
 * @param {MailproofEvent} event
 * @returns {Step | null}
 */
export function firstPendingStep(event: MailproofEvent): Step | null;
/**
 * Is every id in a step's `dependsOn` complete? Empty deps ⇒ eligible. Pure.
 * @param {MailproofEvent} event
 * @param {Step} step
 * @returns {boolean}
 */
export function stepDepsMet(event: MailproofEvent, step: Step): boolean;
/**
 * Every not-complete step whose dependencies are met. Pure.
 * @param {MailproofEvent} event
 * @returns {Step[]}
 */
export function eligibleSteps(event: MailproofEvent): Step[];
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/** @typedef {import('./types').Step} Step */
/** @typedef {import('./types').CountDecision} CountDecision */
/**
 * The in-memory reply input the engine reasons over (the orchestrator computes
 * the identity booleans; the engine stays pure).
 * @typedef {Object} ReplyInput
 * @property {string | null} [step_id]
 * @property {boolean} [participant_match]
 * @property {string} [trust_level]
 * @property {boolean} [has_attachment]
 * @property {number} [sequence]
 */
/**
 * Does a reply's trust level meet a step's `minTrust` gate (SPEC §1)? Pure.
 * @param {ReplyInput} commit
 * @param {Step & { minTrust?: string }} step
 * @returns {boolean}
 */
export function meetsTrust(commit: ReplyInput, step: Step & {
    minTrust?: string;
}): boolean;
export const COUNT_REASONS: Readonly<{
    EVENT_NOT_ACTIVATED: "event_not_activated";
    EVENT_ARCHIVED: "event_archived";
    ALREADY_COMPLETE: "already_complete";
    WRONG_PARTICIPANT: "wrong_participant";
    NO_STEP: "no_step";
    UNKNOWN_STEP: "unknown_step";
    UNVERIFIED_TRUST: "unverified_trust";
    DEPS_UNMET: "deps_unmet";
    OUT_OF_ORDER: "out_of_order";
    MISSING_ATTACHMENT: "missing_attachment";
}>;
export { isComplete };
