export type TrustLevel = import("./types").TrustLevel;
export type MailauthResult = import("./types").MailauthResult;
/**
 * Classify a mailauth `authenticate()` result into a trust level (SPEC §1).
 * Pure — no I/O, no config, no policy.
 * @param {MailauthResult} auth
 * @returns {TrustLevel}
 */
export function classifyTrust(auth: MailauthResult): TrustLevel;
/** @typedef {import('./types').TrustLevel} TrustLevel */
/** @typedef {import('./types').MailauthResult} MailauthResult */
/** @type {readonly TrustLevel[]} */
export const TRUST_LEVELS: readonly TrustLevel[];
