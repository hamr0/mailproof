export type MailproofEvent = import("./types").MailproofEvent;
export type DeliverArgs = import("./notify").DeliverArgs;
export type DeliverResult = import("./types").DeliverResult;
/**
 * The subset of the event store sweep binds (event-store).
 */
export type SweepEventStore = {
    loadEvent: (id: string) => Promise<MailproofEvent | null>;
    listEventIds: () => Promise<string[]>;
    writeEventAtomic: (id: string, event: MailproofEvent) => Promise<any>;
};
/**
 * The subset of the git ledger sweep binds (gitrepo).
 */
export type SweepGitrepo = {
    syncEventJson: (id: string, event: MailproofEvent, message: string) => Promise<any>;
};
/** @typedef {import('./notify').DeliverArgs} DeliverArgs */
/** @typedef {import('./types').DeliverResult} DeliverResult */
/**
 * The subset of the event store sweep binds (event-store).
 * @typedef {Object} SweepEventStore
 * @property {(id: string) => Promise<MailproofEvent | null>} loadEvent
 * @property {() => Promise<string[]>} listEventIds
 * @property {(id: string, event: MailproofEvent) => Promise<any>} writeEventAtomic
 */
/**
 * The subset of the git ledger sweep binds (gitrepo).
 * @typedef {Object} SweepGitrepo
 * @property {(id: string, event: MailproofEvent, message: string) => Promise<any>} syncEventJson
 */
/**
 * Compose the lifecycle sweep over the bound store/ledger + shared notifier.
 * eventStore/gitrepo/deliver are required — sweep cannot run without them.
 * @param {Object} deps
 * @param {SweepEventStore} deps.eventStore
 * @param {SweepGitrepo} deps.gitrepo
 * @param {(args: DeliverArgs) => Promise<DeliverResult | null>} deps.deliver
 * @param {string | null} [deps.domain]
 * @param {number} [deps.overdueDays]
 * @param {number} [deps.archiveDays]
 * @returns {{ sweep: (opts?: { now?: number }) => Promise<{ overdue: Array<{ eventId: string, daysOver: number }>, archived: Array<{ eventId: string, daysIdle: number }>, notified: DeliverResult[] }> }}
 */
export function createSweep({ eventStore, gitrepo, deliver, domain, overdueDays, archiveDays, }: {
    eventStore: SweepEventStore;
    gitrepo: SweepGitrepo;
    deliver: (args: DeliverArgs) => Promise<DeliverResult | null>;
    domain?: string | null | undefined;
    overdueDays?: number | undefined;
    archiveDays?: number | undefined;
}): {
    sweep: (opts?: {
        now?: number;
    }) => Promise<{
        overdue: Array<{
            eventId: string;
            daysOver: number;
        }>;
        archived: Array<{
            eventId: string;
            daysIdle: number;
        }>;
        notified: DeliverResult[];
    }>;
};
/** @typedef {import('./types').MailproofEvent} MailproofEvent */
/**
 * The reference clock (ms) for overdue/archive decisions, or null if the event
 * has no meaningful clock yet. Pure.
 * @param {MailproofEvent | null} event
 * @returns {number | null}
 */
export function referenceClockMs(event: MailproofEvent | null): number | null;
/**
 * Is the event in the cohort sweep acts on (activated, not archived, not
 * complete)? Pure.
 * @param {MailproofEvent | null} event
 * @returns {event is MailproofEvent}
 */
export function isActive(event: MailproofEvent | null): event is MailproofEvent;
