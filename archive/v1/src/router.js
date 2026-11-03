// Address router (SPEC §2). Pure parsing of the envelope recipient
// (Postfix preserves ${original_recipient} through the pipe transport) into
// structured routing fields. No I/O, no config, no policy.
//
// Kernel tags (the only ones this router parses):
//   event+{eventId}-{stepId}@      → workflow reply for a specific step
//   event+{eventId}@               → workflow reply, step unspecified
//   remind+{eventId}@              → re-nudge pending participants
//   stats+{eventId}@               → status summary
//   verify+{eventId}@              → public durable-verification endpoint
//   reverify+{eventId}-{commitSeq}@→ contested-commit re-evaluation
//   attest+{eventId}@              → crypto sign-off reply (no step component)
//
// `attest+` became a kernel tag with the two-mode pivot (crypto sign-off is now
// a core mode, SPEC §2/§3.1). Policy tags still stay in the consumer (gitdone)
// and are deliberately NOT parsed here: manage+, attach+, revoke+, close+,
// bundle+. A consumer that needs them adds its own parser on top.
//
// Constraint: eventId is alphanumeric only (validated at event creation).
// Step IDs may contain dashes; everything after the FIRST dash in an
// event+ extension is the stepId.


const ADDR_RE = /^([a-z][a-z0-9]*)\+([^@\s]+)@([^\s@]+)$/i;
const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;

/**
 * Parse a plus-tagged address into `{ kind, extension, domain }`, or null. Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ kind: string, extension: string, domain: string } | null}
 */
function parseAddress(recipient) {
  if (!recipient || typeof recipient !== 'string') return null;
  const m = recipient.trim().match(ADDR_RE);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase(),
    extension: m[2],
    domain: m[3].toLowerCase(),
  };
}

/**
 * Parse `event+{eventId}-{stepId}@` (stepId optional). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string, stepId: string | null } | null}
 */
function parseEventTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'event') return null;
  const dashIdx = a.extension.indexOf('-');
  const eventId = dashIdx < 0 ? a.extension : a.extension.slice(0, dashIdx);
  const stepId = dashIdx < 0 ? null : a.extension.slice(dashIdx + 1);
  if (!EVENT_ID_RE.test(eventId)) return null;
  return { eventId, stepId };
}

// verify+{eventId}@ — public verification endpoint. No step component.
/**
 * Parse `verify+{eventId}@` (public verification endpoint). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string } | null}
 */
function parseVerifyTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'verify') return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { eventId: a.extension };
}

// attest+{eventId}@ — a crypto sign-off reply. No step component (sign-off
// events have no steps); the engine resolves the signer from the verified
// sender. eventId is alphanumeric, like every other kernel tag.
/**
 * Parse `attest+{eventId}@` (crypto sign-off reply; no step component). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string } | null}
 */
function parseAttestTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'attest') return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { eventId: a.extension };
}

// reverify+{eventId}-{commitSeq}@ — contested-commit upgrade path. commitSeq
// is the sequence of the commit being re-evaluated (e.g. 3 for
// commit-003.json). Authentication is cryptographic — the submitter must
// supply a raw .eml that validates against the archived DKIM key for that
// commit; this just parses the address.
/**
 * Parse `reverify+{eventId}-{commitSeq}@` (contested-commit re-eval). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ eventId: string, commitSequence: number } | null}
 */
function parseReverifyTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'reverify') return null;
  const dashIdx = a.extension.lastIndexOf('-');
  if (dashIdx < 0) return null;
  const eventId = a.extension.slice(0, dashIdx);
  const seqStr = a.extension.slice(dashIdx + 1);
  if (!EVENT_ID_RE.test(eventId)) return null;
  if (!/^\d+$/.test(seqStr)) return null;
  const commitSequence = parseInt(seqStr, 10);
  if (commitSequence < 1 || commitSequence > 99999) return null;
  return { eventId, commitSequence };
}

// Initiator commands share one shape — one eventId, no step suffix.
// Kernel scope is the workflow-status pair only; close+/bundle+ are gitdone
// policy and are intentionally absent from this set, so they parse to null.
// Authentication (DKIM + envelope sender == event.initiator) is the
// consumer's job; this just parses.
const INITIATOR_COMMANDS = new Set(['stats', 'remind']);
/**
 * Parse a kernel initiator command (`stats+`/`remind+`). Pure.
 * @param {string | null | undefined} recipient
 * @returns {{ command: string, eventId: string } | null}
 */
function parseInitiatorCommand(recipient) {
  const a = parseAddress(recipient);
  if (!a || !INITIATOR_COMMANDS.has(a.kind)) return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { command: a.kind, eventId: a.extension };
}

export {
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag,
  parseAttestTag, parseInitiatorCommand,
};
