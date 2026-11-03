// Every bound on sender-controlled input, defined once (SPEC Part B, "Limits"). A sender controls
// each of these numbers and each costs real work (DNS, hashing, header matching), so each has a
// hard cap. Every other module imports its bound from here; nothing defines a number of its own.
//
// The first block is ADMISSION: checked once, over the raw bytes, by `admit()` (admit.js) before any
// parser runs. A message over any of them is still recorded, but unverified and never parsed. The
// second block bounds our own work on a message that was admitted.
//
// Sizing: each value is far above anything seen in real mail (the largest of 37 real messages is
// 1.1 MB, its header block 17 KB, 212 header lines, 84 fields, 2 signatures, 17 MIME delimiter
// lines, a longest body line of 1,004 bytes, 14,200 lines) and below the point where a measured cost stops being
// linear: the sub-limits exist because header-only, signature-field, MIME-part and long-line costs
// grow faster than their size (findings F14).

/** Whole message. Over it nothing is scanned. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Header block, including its empty line. */
export const MAX_HEADER_BYTES = 256 * 1024;

/** Physical lines in the header block, folds included. */
export const MAX_HEADER_LINES = 4000;

/** Header fields (lines that do not start with a space or tab). */
export const MAX_HEADER_FIELDS = 1000;

/** DKIM-Signature fields in one message. A message with more is refused whole, not trimmed to the first ones. */
export const MAX_SIGNATURES = 10;

/** Names in one DKIM-Signature `h=`. */
export const MAX_H_NAMES = 200;

/** One DKIM-Signature field, folds included (a padded `b=`/`bh=` costs more than its size). */
export const MAX_SIG_BYTES = 16 * 1024;

/** Body lines that can be a MIME delimiter (they start with `--`); part handling costs more than their count. */
export const MAX_MIME_PARTS = 200;

/** Longest body line, its line ending not counted (mailauth's relaxed body canonicaliser is super-linear in it). */
export const MAX_BODY_LINE = 256 * 1024;

/**
 * Body lines (each ended by LF, plus a last one with no ending; a bare CR does not end one). Every layer behind
 * the gate pays per line, not per byte: mailparser's text conversion, line canonicalisation and the GC
 * measured ~3 us a line, so 1-byte lines cost 45x a byte more than 76-column ones. Sized by a 25 MiB
 * base64 message (~345,000 lines of 76 bytes), which must be admitted; real mail peaks at 14,200.
 */
export const MAX_BODY_LINES = 500_000;

/** Most inner (`message/rfc822`) messages examined per message, one level deep. */
export const MAX_INNER = 10;

/** Body-status mismatch search: cut points further than this many lines from the matching end are not tried. */
export const MAX_LINES = 5000;

/** Body-status mismatch search: cut points further than this many bytes from the matching end are not tried. */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Body-status mismatch search: bytes ALL its (super-linear appended/prepended) searches together may process for one message. Every
 * signature of the message, and every attached original, draws on this one budget, so adding
 * signatures cannot multiply the cost: one signature alone used to get this much, which made 10
 * signatures on a tampered 128 KiB body cost 10x one search (7-16 s before the search was made
 * cheaper per byte). When it runs out the signatures still to come get a `search_capped` explanation
 * and no search (the linear canonicalisation / line-ending detectors are not charged to it and still run); their status and every trust verdict are unchanged. Real messages that do not match
 * their `bh=` need up to ~100 MiB for one signature on a 100 KB body (the cut-point search is
 * O(lines x size)), so this stays where the per-signature cap was: lowering it changes what real mail
 * is explained as.
 */
export const MAX_WORK = 64 * 1024 * 1024;

/** One DNS lookup (a DKIM key, a DMARC record, ...). A lookup that has not answered by then is answered as a DNS error `dns timeout` (resolver-guard.js, keys.js). */
export const DNS_TIMEOUT_MS = 5000;

/**
 * All DNS lookups of ONE message together (mailauth's and the DKIM key fetches, outer and inner signatures), as
 * the wall time during which at least one lookup is in flight (resolver-guard.js). A message with 10 outer and
 * 10 x 10 inner signatures could otherwise cost a 5 s wait per lookup, in turn, for minutes while the worker's
 * busy clock (which excludes DNS) never ran. Once spent, further lookups fail at once as `dns timeout`.
 */
export const DNS_BUDGET_MS = 30_000;

/**
 * The deadline backstop (pool.js), for what the gate above does not measure. `cpuMs`: CPU of the worker
 * thread one message may use; `wallMs`: busy wall time (DNS waits excluded); `maxMemoryMb`: heap plus external
 * memory of the worker thread. Over any of them the message is recorded `over limit: time` / `over limit: memory`. A worker that dies for no reason the pool can name is `over limit: crash`.
 */
export const WORKER_DEFAULTS = Object.freeze({ size: 1, cpuMs: 15_000, wallMs: 120_000, maxMemoryMb: 1536 });

// ---- SYNC (SPEC B4.3): IMAP capture. The server is untrusted input, so each of these bounds what it can make us read or wait for. ----

/** UIDs listed per `UID FETCH lo:hi (UID RFC822.SIZE)` window; bounds the metadata held in memory. `*` is never used. */
export const SYNC_UID_WINDOW = 1000;

/** Messages handled per folder per run (a caller option can only lower it). */
export const SYNC_MAX_MESSAGES = 1000;

/** Message bytes read per folder per run (a caller option can only lower it); a backfill takes several runs. */
export const SYNC_MAX_BYTES = 512 * 1024 * 1024;

/** Largest message that is still read (streamed, to hash it) to be recorded; above it the message is `skipped`. */
export const SYNC_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

/** Wall time of one `sync` call, checked between messages. */
export const SYNC_MAX_MS = 30 * 60 * 1000;

/** TCP/TLS connect and greeting (imapflow `connectionTimeout`, `greetingTimeout`). */
export const SYNC_CONNECT_MS = 30_000;

/** Idle socket (imapflow `socketTimeout`): a server that goes quiet. */
export const SYNC_SOCKET_MS = 5 * 60 * 1000;

/** Wall time of reading ONE message; over it the connection is closed and treated as a drop (catches a server that trickles bytes). */
export const SYNC_FETCH_MS = 5 * 60 * 1000;

/** Reconnects per `sync` run. */
export const SYNC_MAX_RECONNECTS = 3;

/** Wait before the 1st, 2nd and 3rd reconnect. */
export const SYNC_RECONNECT_BACKOFF_MS = Object.freeze([1000, 4000, 16000]);
