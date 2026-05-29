export type MailproofEvent = import("./types").MailproofEvent;
/**
 * Compose the lifecycle sweep over the bound store/ledger + shared notifier.
 * @param {Object} [deps]
 * @param {any} [deps.eventStore]
 * @param {any} [deps.gitrepo]
 * @param {(args: any) => Promise<any>} [deps.deliver]
 * @param {string | null} [deps.domain]
 * @param {number} [deps.overdueDays]
 * @param {number} [deps.archiveDays]
 * @returns {{ sweep: (opts?: { now?: number }) => Promise<{ overdue: Array<{ eventId: string, daysOver: number }>, archived: Array<{ eventId: string, daysIdle: number }>, notified: any[] }> }}
 */
export function createSweep({ eventStore, gitrepo, deliver, domain, overdueDays, archiveDays, }?: {
    eventStore?: any;
    gitrepo?: any;
    deliver?: (args: any) => Promise<any>;
    domain?: string | null;
    overdueDays?: number;
    archiveDays?: number;
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
        notified: any[];
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
 * @returns {boolean}
 */
export function isActive(event: MailproofEvent | null): boolean;
