export type DsnRecipient = {
    originalRecipient: string | null;
    finalRecipient: string | null;
    action: string | null;
    status: string | null;
    diagnostic: string | null;
};
export type Dsn = {
    reporting: Record<string, string>;
    recipients: DsnRecipient[];
    note?: string;
};
/**
 * @typedef {Object} DsnRecipient
 * @property {string | null} originalRecipient
 * @property {string | null} finalRecipient
 * @property {string | null} action
 * @property {string | null} status
 * @property {string | null} diagnostic
 */
/**
 * @typedef {Object} Dsn
 * @property {Record<string, string>} reporting
 * @property {DsnRecipient[]} recipients
 * @property {string} [note]
 */
/**
 * Is this a multipart/report delivery-status message? Pure.
 * @param {string | null} headerBlock
 * @returns {boolean}
 */
export function isDeliveryStatusReport(headerBlock: string | null): boolean;
/**
 * Parse a raw DSN message into `{ reporting, recipients }`, or null if it is not
 * a delivery-status report. Pure; no network, no fs.
 * @param {Buffer | string} raw
 * @returns {Dsn | null}
 */
export function extractDsn(raw: Buffer | string): Dsn | null;
/**
 * The recipient blocks representing a PERMANENT failure (worth alerting on).
 * Pure.
 * @param {Dsn | null} dsn
 * @returns {DsnRecipient[]}
 */
export function permanentFailures(dsn: Dsn | null): DsnRecipient[];
/**
 * Parse a message/delivery-status body into `{ reporting, recipients }`. Pure.
 * @param {string} text
 * @returns {Dsn}
 */
export function parseDeliveryStatusBody(text: string): Dsn;
/**
 * Parse one "Field: value" group (folded continuations joined). Pure.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseFieldGroup(text: string): Record<string, string>;
export function stripAddressType(value: any): string;
export function contentTypeOf(headerBlock: any): string;
