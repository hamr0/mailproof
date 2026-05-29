export type DkimArchive = import("./types").DkimArchive;
export type MailauthResult = import("./types").MailauthResult;
/**
 * Fetch + PEM-wrap the DKIM public key at `{selector}._domainkey.{domain}`.
 * Never throws; failure is reported in the `error` field. The resolver is
 * injected so tests run offline.
 * @param {string} domain
 * @param {string} selector
 * @param {{ resolver?: (name: string) => Promise<string[][]>, timeoutMs?: number }} [opts]
 * @returns {Promise<DkimArchive>}
 */
export function fetchDkimKey(domain: string, selector: string, { resolver, timeoutMs }?: {
    resolver?: (name: string) => Promise<string[][]>;
    timeoutMs?: number;
}): Promise<DkimArchive>;
/** @typedef {import('./types').DkimArchive} DkimArchive */
/** @typedef {import('./types').MailauthResult} MailauthResult */
/**
 * Extract a DKIM record's `p=` base64 public key. Pure.
 * @param {string | string[] | null} txtRecord
 * @returns {string | null}
 */
export function extractPublicKey(txtRecord: string | string[] | null): string | null;
/**
 * Wrap base64 SubjectPublicKeyInfo bytes into PEM. Pure.
 * @param {string | null} base64
 * @returns {string | null}
 */
export function toPem(base64: string | null): string | null;
/**
 * Pick the DKIM signature to archive from a mailauth result (prefer pass+aligned,
 * then any pass, then first present, else null). Pure.
 * @param {MailauthResult} auth
 * @returns {Record<string, any> | null}
 */
export function pickSignatureToArchive(auth: MailauthResult): Record<string, any> | null;
