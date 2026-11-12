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

/** Wall time of one `sync` call, checked between messages and between UID windows. */
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

// ---- INDEX (SPEC B5): what one record may add to the trail index. A record is trusted local data, but its address and
// Message-ID lists come from a sender-controlled header (up to 256 KiB), so the rows one record adds are capped. ----

/** Participant rows (From/To/Cc/Reply-To addresses) the index takes from one record; the rest are not indexed. */
export const INDEX_MAX_PARTICIPANTS = 500;

/** Longest address that is indexed (RFC 5321 path limit); a longer token is not an address. */
export const INDEX_MAX_ADDRESS = 254;

/** Thread-link rows the index takes from one record: In-Reply-To, then the LAST References ids (the nearest ancestors). */
export const INDEX_MAX_LINKS = 200;

/** Longest subject (code points) the index keeps per record; a longer one is cut (the record still holds the whole header). */
export const INDEX_MAX_SUBJECT = 500;

/** Rows of one `list()` call whose subject is read from the content store (a claimed subject, SPEC B5): the cost of that read is bounded; later rows keep `subject: null`. */
export const LIST_CLAIMED_MAX = 500;

/** Bytes read from the front of a stored raw email to find its claimed Subject (no hash check: the value is a claim, never proof). */
export const CLAIMED_HEAD_BYTES = 65_536;

/** Children `linked()` returns by default (a popular Message-ID can be named by any number of records); `{ limit }` overrides. */
export const LINKED_CHILDREN_DEFAULT = 1000;

// ---- PRUNE (SPEC B9) ----

/** Bytes of one git listing (`ls-tree`, `diff-tree`) that prune and the content sweep read whole: about 1,000,000 record paths. Above it they fail instead of growing without bound. */
export const GIT_LISTING_MAX_BYTES = 256 * 1024 * 1024;

/** Git's delta-base cache for every git process prune starts (`core.deltaBaseCacheLimit`; git's default is 96m per process). Measured at 80,000 records: it takes the peak of the process tree from 375 MB to 268 MB (findings F25) with no change in time beyond noise. */
export const PRUNE_GIT_CONFIG = ['core.deltaBaseCacheLimit=16m'];

/** How long a prune waits for a running `sync` to finish before it gives up with `ERR_SYNC_LOCKED` (a sync call is capped at SYNC_MAX_MS; the margin covers its cleanup). Nothing is changed when it gives up. */
export const PRUNE_SYNC_WAIT_MS = SYNC_MAX_MS + 60_000;

/** A prune journal whose owner pid is alive is left to that process only this long (a reused pid must not block recovery for ever). */
export const PRUNE_JOURNAL_LIVE_MS = 60 * 60 * 1000;

/** The most direct replies `replyFacts` returns for one Message-ID; more rejects with `ERR_TOO_MANY_REPLIES` (never a silent cut). */
export const REPLY_FACTS_MAX = 200;

// ---- STAMP JOB (SPEC B13.1.13): the batch OpenTimestamps seal. ----

/** Default cadence of the automatic stamp job, in hours, and the range `stamp.everyHours` accepts. */
export const STAMP_EVERY_HOURS = 6;

/** The longest `status({ refresh: true })` waits for the trail lock to catch the index up (ms): a writer holding it must not make a status call hang; the read-only answer follows. */
export const STATUS_REFRESH_LOCK_MS = 500;
export const STAMP_EVERY_HOURS_MIN = 1;
export const STAMP_EVERY_HOURS_MAX = 720;

/** Entries (records and replies together) in one manifest: about 2 MB; one `ots stamp` hashes it in milliseconds. */
export const STAMP_MAX_ENTRIES = 20_000;

/** Manifests one job makes (at most 200,000 entries); the rest of a backlog waits for the next job. */
export const STAMP_MAX_MANIFESTS = 10;

/** One `ots stamp` / `ots upgrade` call outside the trail lock. `record` mode keeps the in-lock clamp (SPEC B3). */
export const STAMP_OTS_TIMEOUT_MS = 30_000;

/** The upgrade pass of a job stops here; the next job continues. */
export const STAMP_JOB_MAX_MS = 600_000;

// ---- PAIR BUNDLE (SPEC B13.2.8): `export` and `verify-bundle` read the same constants. ----

/** `with` entries of one export. */
export const EXPORT_MAX_ADDRESSES = 20;

/** Selected records in one bundle; more is `ERR_EXPORT_TOO_BIG` (narrow with dates). A bundle is a pair's exchange, not the trail. */
export const EXPORT_MAX_RECORDS = 10_000;

/** Files in a bundle. */
export const BUNDLE_MAX_FILES = 100_000;

/** All files of a bundle together (export stops as it passes this; the verifier refuses a bigger directory without reading it). */
export const BUNDLE_MAX_BYTES = 256 * 1024 * 1024;

/** One record file (a hostile bundle can name any size). */
export const BUNDLE_MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** One manifest (`STAMP_MAX_ENTRIES` x about 120 bytes is 2.4 MB). */
export const BUNDLE_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** One `.ots` proof (real ones are a few KB). */
export const BUNDLE_MAX_OTS_BYTES = 1024 * 1024;

/** One reply-text or key file. */
export const BUNDLE_MAX_SMALL_BYTES = 256 * 1024;

/** `bundle.json`. */
export const BUNDLE_MAX_JSON_BYTES = 64 * 1024 * 1024;

/** `README.txt` (about 2 KiB a record at most; long fields are cut). */
export const BUNDLE_MAX_README_BYTES = 32 * 1024 * 1024;

/** One `ots info` call of `verify-bundle`. */
export const BUNDLE_OTS_TIMEOUT_MS = 10_000;

/** All `ots info` calls of one `verify-bundle` run; the proofs after it are reported `unchecked`. */
export const BUNDLE_OTS_MAX_MS = 300_000;

/** `ots info` output read per call. */
export const BUNDLE_OTS_OUTPUT_BYTES = 65_536;
