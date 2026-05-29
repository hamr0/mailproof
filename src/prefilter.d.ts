/**
 * Decide whether an inbound message should be rejected before any crypto/ledger
 * work — auto-responders, lists, bulk mail, system senders. Pure.
 * @param {string} headerBlock
 * @param {string | null} [fromAddr]
 * @returns {{ rejected: boolean, reason: string | null }}
 */
export function preFilter(headerBlock: string, fromAddr?: string | null): {
    rejected: boolean;
    reason: string | null;
};
/**
 * Slice the leading header block out of raw message bytes (up to `maxBytes`),
 * stopping at the first blank line. Pure.
 * @param {Buffer} raw
 * @param {number} maxBytes
 * @returns {string}
 */
export function extractHeaderBlock(raw: Buffer, maxBytes: number): string;
/**
 * Read a single unfolded header value from a header block (case-insensitive),
 * or null if absent. Pure.
 * @param {string} headerBlock
 * @param {string} name
 * @returns {string | null}
 */
export function rawHeader(headerBlock: string, name: string): string | null;
