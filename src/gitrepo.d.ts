export type MailproofEvent = import("./types").MailproofEvent;
export type Commit = import("./types").Commit;
/**
 * Bind a per-event git ledger to a fixed data directory (+ optional OTS stamper).
 * @param {{ dataDir?: string, ots?: any }} [opts]
 * @returns {Record<string, any>}
 */
export function createGitrepo({ dataDir, ots }?: {
    dataDir?: string;
    ots?: any;
}): Record<string, any>;
