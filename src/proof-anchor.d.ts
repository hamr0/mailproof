/**
 * Compose the proof-anchor pass (m7d-4) over the bound store/ledger/ots + the
 * shared notifier. Requires `ots` (createOts).
 * @param {Object} [deps]
 * @param {any} [deps.eventStore]
 * @param {any} [deps.gitrepo]
 * @param {any} [deps.ots]
 * @param {(args: any) => Promise<any>} [deps.deliver]
 * @param {string | null} [deps.domain]
 * @returns {{ upgradeProofs: (opts?: { now?: string }) => Promise<{ events: Array<Record<string, any>>, anchored: number, pending: number, notified: any[] }> }}
 */
export function createProofAnchor({ eventStore, gitrepo, ots, deliver, domain, }?: {
    eventStore?: any;
    gitrepo?: any;
    ots?: any;
    deliver?: (args: any) => Promise<any>;
    domain?: string | null;
}): {
    upgradeProofs: (opts?: {
        now?: string;
    }) => Promise<{
        events: Array<Record<string, any>>;
        anchored: number;
        pending: number;
        notified: any[];
    }>;
};
