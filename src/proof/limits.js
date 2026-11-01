// Every bound on sender-controlled input, defined once (SPEC Part B, "Limits"). A sender controls
// each of these numbers and each costs real work (DNS, hashing, header matching), so each has a
// hard cap. Every other module imports its bound from here; nothing defines a number of its own.

/** Most DKIM-Signature headers evaluated per message (a signature costs a DNS key fetch and a body hash). */
export const MAX_SIGNATURES = 10;

/** Most names in one DKIM-Signature `h=`. */
export const MAX_H_NAMES = 200;

/** Most header fields in one message. */
export const MAX_HEADER_FIELDS = 1000;

/** Most inner (`message/rfc822`) messages examined per message, one level deep. */
export const MAX_INNER = 10;

/** Body-status mismatch search: cut points further than this many lines from the matching end are not tried. */
export const MAX_LINES = 5000;

/** Body-status mismatch search: cut points further than this many bytes from the matching end are not tried. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Total bytes the prepended search may hash (it is O(candidates x size)). */
export const MAX_WORK = 64 * 1024 * 1024;
