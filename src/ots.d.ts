/**
 * Bind an OpenTimestamps stamper to the `ots` binary. Each method reports its
 * outcome and never throws.
 * @param {{ otsBin?: string, timeoutMs?: number }} [opts]
 * @returns {{
 *   stampFile: (absPath: string) => Promise<{ proof_path: string } | { error: string }>,
 *   upgradeProof: (absPath: string) => Promise<{ ok: boolean, changed: boolean, anchored: boolean, pending: boolean, exit: number, block_height?: number | null, error?: string }>,
 *   readBlockHeight: (absPath: string) => Promise<number | null>,
 * }}
 */
export function createOts({ otsBin, timeoutMs }?: {
    otsBin?: string;
    timeoutMs?: number;
}): {
    stampFile: (absPath: string) => Promise<{
        proof_path: string;
    } | {
        error: string;
    }>;
    upgradeProof: (absPath: string) => Promise<{
        ok: boolean;
        changed: boolean;
        anchored: boolean;
        pending: boolean;
        exit: number;
        block_height?: number | null;
        error?: string;
    }>;
    readBlockHeight: (absPath: string) => Promise<number | null>;
};
/**
 * Parse the Bitcoin block height out of `ots info` stdout, or null. Pure.
 * @param {string | null} stdout
 * @returns {number | null}
 */
export function parseOtsBlockHeight(stdout: string | null): number | null;
