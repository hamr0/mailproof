/**
 * Compose the document notary over a bound gitrepo + event store (PRD §4.1).
 * @param {{ gitrepo?: any, eventStore?: any }} [deps]
 * @returns {{ hashDocument: typeof hashDocument, verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: { email?: string }) => Promise<{ found: boolean, matches: Array<Record<string, any>> }> }}
 */
export function createNotary({ gitrepo, eventStore }?: {
    gitrepo?: any;
    eventStore?: any;
}): {
    hashDocument: typeof hashDocument;
    verifyDocument: (eventId: string, docBytes: Buffer | Uint8Array | string, opts?: {
        email?: string;
    }) => Promise<{
        found: boolean;
        matches: Array<Record<string, any>>;
    }>;
};
/**
 * Canonical document fingerprint: `sha256:`-prefixed lowercase hex. Accepts a
 * Buffer, Uint8Array, or utf8 string. Pure.
 * @param {Buffer | Uint8Array | string} bytes
 * @returns {string}
 */
export function hashDocument(bytes: Buffer | Uint8Array | string): string;
