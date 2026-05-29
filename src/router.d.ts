/**
 * Parse a plus-tagged address into `{ kind, extension, domain }`, or null. Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ kind: string, extension: string, domain: string } | null}
 */
export function parseAddress(recipient: string | null | undefined): {
    kind: string;
    extension: string;
    domain: string;
} | null;
/**
 * Parse `event+{eventId}-{stepId}@` (stepId optional). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string, stepId: string | null } | null}
 */
export function parseEventTag(recipient: string | null | undefined): {
    eventId: string;
    stepId: string | null;
} | null;
/**
 * Parse `verify+{eventId}@` (public verification endpoint). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string } | null}
 */
export function parseVerifyTag(recipient: string | null | undefined): {
    eventId: string;
} | null;
/**
 * Parse `reverify+{eventId}-{commitSeq}@` (contested-commit re-eval). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string, commitSequence: number } | null}
 */
export function parseReverifyTag(recipient: string | null | undefined): {
    eventId: string;
    commitSequence: number;
} | null;
/**
 * Parse `attest+{eventId}@` (crypto sign-off reply; no step component). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string } | null}
 */
export function parseAttestTag(recipient: string | null | undefined): {
    eventId: string;
} | null;
/**
 * Parse a kernel initiator command (`stats+`/`remind+`). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ command: string, eventId: string } | null}
 */
export function parseInitiatorCommand(recipient: string | null | undefined): {
    command: string;
    eventId: string;
} | null;
