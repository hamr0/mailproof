export type Envelope = import("./types").Envelope;
/** @typedef {import('./types').Envelope} Envelope */
/**
 * Parse a Postfix pipe-transport argv into the structured envelope. The four
 * transport fields live at argv indices 2-5. Pure.
 * @param {string[]} argv
 * @returns {Envelope}
 */
export function parseEnvelope(argv: string[]): Envelope;
