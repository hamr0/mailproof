# mailproof v2 — SPEC Part B (record, trail, verdicts)

> **Part B is the v2 wire format and wins over everything below it.** The sections
> after "Part A" describe v1 and are archived module by module as v2 lands (M3).
> Rationale for the choices here: [findings F7](findings.md).

## B1. Record (`records/<id>.json`, `"v": 2`)

```jsonc
{
  "v": 2,
  "id": "32 hex",                  // first 32 hex of message.raw_sha256: one record per distinct byte string
  "message_key": "32 hex|null",    // shared by every copy of one signed message; null for an over-limit message (see Limits)
  "captured": "ISO-8601",          // stamped by mailproof's clock, never from Received:
  "direction": "in" | "out",
  "source": "string",              // capture source, default "api"
  "message": {
    "message_id": "<..>|null", "in_reply_to": "<..>|null", "references": ["<..>"],
    "raw_sha256": "sha256:<hex>", "size": 0,
    "from": "addr|null"            // only on unsigned records
  },
  "attachments": [ { "filename": "str|null", "size": 0, "sha256": "sha256:<hex>" } ],
  "signatures": [                  // one per DKIM-Signature header (at most 10); [] when unsigned or over a limit
    {
      "dkim_signature": "base64 of the raw header line",
      "tags": { "d": "", "s": "", "a": "", "c": "", "h": "", "bh": "", "l": null, "t": null, "x": null },
      "signed_headers": ["base64 raw line, RFC 6376 5.4.2 hashing order (bottom-up)"],
      "key": { "k": "rsa|ed25519", "p": "base64" } | null,
      "key_error": "str|null",
      "key_file": "keys/<domain>/<selector>/<h16>.json|null",
      "partial_body": false,       // l= present and shorter than the canonical body
      "body": { "status": "matched|partial|mismatch|not-checked", "explain": [ { "kind": "", "detail": {} } ] }
    }
  ],
  "body_status": "matched|partial|mismatch|not-checked",   // best over the signatures that verify
  "copy": { "kind": "direct|relayed|forward|digest|unknown", "evidence": { } },
  "verdicts": {
    "live":     { "trust": "...", "engine": { "rules": "mp-rules/1", "mailauth": "x.y.z" },
                  "dkim": [ { "d": "", "s": "", "result": "", "aligned": false } ],
                  "dmarc": { "result": "", "published": false, "policy": null, "rr": null },
                  "spf": { "result": "" } | null, "arc": { "result": "", "sealers": [] } | null },
    "portable": { "trust": "verified|unverified", "engine": { }, "basis": "dkim|none", "passing": [0] }
    // both verdicts carry "reason": "over limit: <name>" when the message was refused by the admission gate (see Limits)
  }
}
```

- **Body status (`signatures[].body`, `body_status`).** Computed from the raw email at capture (`record()` and `check()`); it never changes a trust verdict. The portable verdict covers the signed headers only: read `body_status` for the body. Per signature: `matched` = the body hashes to the signed `bh=` (mailauth's canonicalization, honouring `l=`); `partial` = `l=` is shorter than the canonical body and the signed prefix matches (`explain` = `l_tag` with `signed`/`canonical`/`unsigned` byte counts); `mismatch` = it does not; `not-checked` = nothing to check against (unsigned, or no raw email; unreachable in M0 for signed mail). `body_status` = the best (`matched` > `partial` > `mismatch`) over the signatures whose headers verify at capture, over all signatures when none does, `not-checked` when there is none. `explain` is machine-readable and **never contains body text**, only counts, byte sizes and domains. On a mismatch the detectors run cheapest first and stop at the first that explains it: `appended` (a canonical prefix cut at a line boundary hashes to `bh=`; `detail.bytes`/`lines` appended, e.g. a mailing-list footer), `prepended` (a canonical suffix does; e.g. an external-sender banner), `canonicalisation` (the body hashes under the other `c=` body rule), `line_endings` (it hashes after lone CRs become CRLF), else `unknown`. `appended`/`prepended` are skipped when `l=` is present. Search caps (all in `src/proof/limits.js`): 5,000 lines, 2 MB of changed bytes, and ONE work budget of 64 MiB of bytes processed per message, drawn on by every signature and every attached original together (`MAX_WORK`; it used to be 64 MiB per signature, so ten signatures on one tampered body cost ten searches). Only the super-linear `appended`/`prepended` searches draw on it; the linear `canonicalisation` and `line_endings` detectors always run. A search the remaining budget cannot cover is skipped; hitting any cap adds a `search_capped` entry before `unknown`. The budget changes only which explanation is attempted: never a status, never a verdict, and a message that fits the budget gets the same explanations as with an unlimited one. Context hints sit alongside whenever the status is not `matched`: `forwarded` (`{sealers:[d...], arc}` from ARC-Seal `d=` tags and the ARC result at capture) and `mailing_list` (`{list_id_domain}`, the List-Id minus its first label). Hints are not explanations. `matchBody` stays the later check against a produced body, and `full` is unchanged.
- OpenTimestamps state is not a record field (the stamp hashes the record file's own bytes): the proof is the sibling file `records/<id>.json.ots`, present only when OTS was on.
- **Limits (the admission gate).** A sender controls every one of these numbers and each costs real work (DNS, hashing, header matching, parsing), so each has a hard cap, defined once in `src/proof/limits.js`. `admit()` (`src/proof/admit.js`) checks all of them in ONE linear pass over the raw bytes, with no regex and no per-line re-scan, before mailparser, mailauth or any search sees the message. It runs in `record()`, `check()`, `matchBody()` (an over-limit message matches nothing) and on each attached original. The first limit the scan meets is the one reported; the total size is checked before anything is read.

  | Limit | Value | `over limit:` name | Why it exists |
  |---|---|---|---|
  | Whole message | 25 MiB | `total_bytes` | A common mail-provider size limit; the cost of everything behind the gate is linear in it. Over it nothing is scanned. |
  | Header block, up to and including its empty line | 256 KiB | `header_bytes` | Header-only parsing costs about 0.27 ms a KiB. |
  | Header lines, folds included | 4,000 | `header_lines` | |
  | Header fields (lines that do not start with a space or tab) | 1,000 | `header_fields` | Header matching by name. |
  | DKIM-Signature fields | 10 | `signatures` | Each costs a DNS key fetch (up to 5 s) and a body hash. |
  | Names in one `h=` | 200 | `h_names` | Counted as the colons in the tag plus one. |
  | One DKIM-Signature field, folds and continuation lines included | 16 KiB | `sig_bytes` | A padded `b=`/`bh=` costs more than its size. |
  | Body lines that can be a MIME delimiter: start with `--` (or a lone CR then `--`, which mailsplit also takes) | 200 | `mime_parts` | Part handling costs more than the count of parts. |
  | Longest body line, its line ending not counted | 256 KiB | `body_line` | mailauth's relaxed body canonicaliser is super-linear in a long line (a 1/2/4/8 MiB single line with a matching `bh=` cost 0.11/0.24/0.71/2.5 s of CPU). |
  | Body lines: each LF ends one, empty lines count, a last line with no ending counts, a bare CR does not end one | 500,000 | `body_lines` | Everything behind the gate also pays per LINE: mailparser's text conversion, our line canonicalisation and the GC measured about 3 µs a line (a 4 MiB body of 76-column lines, 55,000 lines: 0.7 s; 1 MiB of one-byte lines, 0.35 million lines: 0.85 s), so cost per MiB is not a constant. A body of bare LFs is converted to CRLF once per message before the `relaxed` hashing, not once per signature. Sized by a 25 MiB base64 message, which is about 345,000 lines of 76 bytes and must be admitted; the largest of 37 real messages has 14,200. |

  The header block and the fields are read the way the parsers read them, so the gate cannot be shown fewer signatures or a shorter header block than they see: the block ends at the first empty line (`\n` or `\r\n`), an empty FIRST line included (then the message has no headers); a bare CR is not a line end. A DKIM-Signature field is `DKIM-Signature`, optional blanks, then the colon (on the same line or, after a fold, the next), and it runs until the next line that opens a field, so junk lines with no colon belong to the signature above them, as in mailauth's header parser. These are checked against mailsplit, mailauth's `MessageParser` and `parseHeaders` in `tests/unit/admit.test.js`.

  **Over any limit the message is still recorded (accept-with-flag), but never parsed**: mailauth and mailparser do not run, no DNS is asked, nothing throws. The record holds only what the raw bytes give without a parser:

  ```jsonc
  { "v": 2, "id": "<first 32 hex of the sha256 of the raw bytes>", "message_key": null,
    "captured": "...", "direction": "in|out", "source": "...",
    "message": { "message_id": null, "in_reply_to": null, "references": [], "raw_sha256": "sha256:<hex>", "size": 0 },  // no "from"
    "attachments": [], "signatures": [], "body_status": "not-checked", "copy": { "kind": "unknown", "evidence": {} },
    "verdicts": {
      "live":     { "trust": "unverified", "engine": {}, "dkim": [], "dmarc": { "result": "none", "published": false, "policy": null, "rr": null }, "spf": null, "arc": null, "reason": "over limit: body_line" },
      "portable": { "trust": "unverified", "engine": {}, "basis": "none", "passing": [], "reason": "over limit: body_line" } } }
  ```

  The reason has one form, `over limit: <name>`, with the name from the table. `check()` returns the same: `signatures` 0, `unsigned` false (the message was not looked at, so it is not reported as unsigned), `body_status` `not-checked`. The id is the hash of the bytes, so the same bytes recorded twice are one record, as for any message. An attached original over a limit is not examined: its `attached_original` entry is `{ message_key: null, dkim: "none", d: null, body_status: "not-checked", over_limit: "<name>" }`. More than 10 signatures refuses the WHOLE message (it is not trimmed to the first 10: a message whose only valid signature is the 11th is recorded `unverified`, `over limit: signatures`), and mailauth is handed the message exactly as received. A header block the decoder used to reject with `EMAXLEN` (over 1 MiB), and now any over 256 KiB, is recorded as `header_bytes` instead of nothing. `verifyRecord` still refuses to canonicalise a stored signature whose `h=` lists more than 200 names (`why: "h= too long"`): an offline record does not carry the raw bytes the gate reads, and a stored or hand-made record may hold one.
- **The backstop (worker deadline).** The gate above is the deterministic first line: it bounds the dimensions we have measured, the same way on every machine. It cannot bound what nobody has measured yet (six review rounds each found another cost driver on input that was under every limit), so the build half of `check()`/`record()` (gate, header split, mailparser, mailauth, signatures, body status; `src/proof/build.js`) also runs in a warm worker thread (`src/proof/worker.js`, `pool.js`) that the main thread kills when one message spends more than its budget. The backstop bounds the unmeasured remainder; it does not replace the gate, and the gate's limits are not loosened because it exists. Defaults (option `worker` of `new Mailproof()`; defined once in `limits.js`):

  | Budget | Default | `over limit:` name | Measured how |
  |---|---|---|---|
  | CPU of the worker thread | 15,000 ms | `time` | `Worker#cpuUsage` of that thread, polled every 50 ms and read once more when the job finishes (a job that went over between two polls is still `over limit: time`), counted from when the worker starts the job. CPU, not wall time: a loaded machine stretches wall time of the same message several times over, but not the CPU it burns, so legitimate mail is not killed because its neighbours were busy. |
  | Busy wall time | 120,000 ms | `time` | Wall time since the job started with DNS waits subtracted (the worker idles while the main thread asks the caller's resolver). Only a cap for a job that hangs without burning CPU. |
  | Worker crash | n/a | `crash` | The worker thread exits, or throws outside the build, while it holds the job. Not a budget: the third way a worker can end without an answer. |
  | Worker memory | 1,536 MB | `memory` | `used_heap_size + external_memory` of that thread (`Worker#getHeapStatistics`, every 50 ms), plus V8's own old-generation limit at the same value. Process RSS is not used: it includes the host program's own memory and every other worker. |

  A worker that goes over is terminated, and the message is recorded exactly like a gate refusal (the over-limit record below), with `reason: "over limit: time"` or `"over limit: memory"` on both verdicts: `unverified`, nothing parsed, `id`/`raw_sha256`/`size` from the bytes. The worker writes nothing: the commit, the lock, git and `now()` stay on the main thread and run only after the worker has returned, so a killed worker leaves no partial state. DNS goes through the caller's `resolver` (the system resolver when none is given) with the error `code` kept. A lookup that has not answered within `DNS_TIMEOUT_MS` (5,000 ms, `limits.js`, also the bound `fetchDkimKey` uses) is answered as the error `dns timeout` with `code: 'ETIMEOUT'`, a temporary error, and the job goes on; the lookups of one message together may wait at most `DNS_BUDGET_MS` (30,000 ms, `limits.js`): the wall time during which at least one lookup is in flight, so a burst of parallel lookups counts once; each lookup is bounded by the budget left, and once it is spent further lookups fail at once with the same error. It is the same in a worker and in-process, so a resolver that never settles costs one message at most about `DNS_BUDGET_MS` of DNS time plus its CPU (DNS waits are not busy time, so the worker deadline does not see them) and then lets the messages queued behind it run. The resolver returns plain data, as `node:dns` does: an answer that structured clone refuses (a function, a symbol, ...), which is what a worker's `postMessage` would refuse, is answered as the error `resolver returned a non-plain value` with `code: 'EBADRESP'`, in a worker and in-process alike, and is recorded like any unreachable key (`unverified`, a temporary error). The deadline never counts time spent waiting in the queue behind other messages. `worker.size` is the number of warm workers (default 1); `size: 0` runs everything in-process with no backstop, as before. Results are identical either way (checked on 37 real messages and the test fixtures). A worker that dies for a reason nobody can name (the thread exits, or throws outside the build) is recorded the same way with `reason: "over limit: crash"` (name `crash`, unverified): every message is recorded, including one that deterministically crashes its worker, and the pool starts a fresh worker for the next (also when the worker died while idle: it is dropped at once, never handed to the next message). An `Error` thrown by the build itself is not a crash: `check()`/`record()` reject exactly as in-process. A worker that fails before it is ready (its file cannot load, its thread cannot start) is not a crash of a job: `check()`/`record()` reject and nothing is recorded, so the same message can be recorded once the cause is fixed. `close()` stops the workers (and, when instances share a pool, the last one to close does): with a worker (`size` 1 or more), a `record()` or `check()` still running at that moment may reject, and if it rejects that message is not recorded, so await in-flight calls before `close()`. A call made after `close()` starts a fresh worker. Only the envelope fields `clientIp`, `clientHelo` and `sender` are read (and passed to the worker; others are ignored). Each of the three is a string or `null`: a value of any other type (a function, a number) is treated as `null`, with a worker and with `size: 0` alike, so the same envelope gives the same result either way. An envelope that is not itself an object (a function, a string) is treated as no envelope, the same way. Needs Node 22.19 or later (`Worker#cpuUsage`).
- Never the body, never the raw email. No `Subject` outside `signed_headers`.
- Serialisation: fixed key order, 2-space indent, trailing newline (stable bytes, stable OTS stamps).
- Signed header lines are byte-exact (base64). Names in `h=` with no matching header are oversigned and add nothing.
- **Identity: one record per distinct copy.** `id` = the first 32 hex of `message.raw_sha256` (the sha256 of the raw bytes; one definition). The same bytes captured again are a no-op (`duplicate: true`, the existing commit); any byte difference (a list footer, an added `Received:`, an ARC seal) is its own record, so a relayed copy never hides the direct one. The capture route (`source`, `direction`, `captured`) is the first capture's; later captures of the same bytes are not logged.
- **`message_key`** groups the copies of one message: `sha256("mp2\n" + identity)` first 32 hex, `identity` = the first DKIM-Signature's raw `b=` value (copies of a signed message share it, whatever they added around it). Unsigned mail: `sha256("mp2\nmid\n" + normalised Message-ID)` first 32 hex (angle brackets stripped, lower-cased), else `null`.
- **`copy`** (separate from `body_status`; evidence is domains and flags only, never text). Precedence, first match wins: (1) `forward` by Subject prefix: `Fwd:`/`Fw:`/`WG:`/`TR:`/`RV:` (case-insensitive; `Re:` is not a forward), evidence `{subject_prefix: true}`; (2) `digest`: a List-Id header or a `multipart/digest` part, AND the message has `message/rfc822` parts (a list digest carrying messages); (3) `forward` by attachment: `message/rfc822` parts with no List-Id and no `multipart/digest`; (4) `relayed`: an ARC-Seal and/or a List-Id, evidence `{arc_sealers: [d...], list_id_domain}`; (5) `direct`: signed, no ARC-Seal and no List-Id; (6) `unknown`: no evidence (unsigned mail with no relay headers). Relay evidence is also kept on forwards and digests, and `attached_original` (below) is kept on all of them; `capped: true` if more than 10 inner messages were present. `direct` is the absence of relay evidence, not proof of the route.
- **Forward as attachment.** For each `message/rfc822` part (at most 10, one level deep: an inner message's own attachments are not examined) mailproof runs the same signature check on the inner message at capture, using the key from DNS, and archives the inner signer's key in the same key archive (same dedupe). `attached_original[i]` = `{ message_key, dkim: "pass|fail|none", d, body_status }`: only the key and the verdict; the inner headers and body are NOT stored. A user who wants the inner email's full record calls `record()` on it separately. Inline forwards (quoted text) cannot be verified; `subject_prefix` alone marks them. Digests keep these links too ("this digest contains message X"); bounce and abuse reports also carry `message/rfc822` parts and are classified by the same rules, so the evidence says what was found, not why.
- **Deriving the "original".** There is no per-record `original` flag. Across the copies sharing a `message_key`, the original is the earliest `direct` copy whose `body_status` is `matched` (`copies()` returns it as `original`, or `null`). Records whose `attached_original` carries that key (forwards and digests) are reported separately as `contained_in`.
- Offline re-check (`verifyRecord`): canonicalise with `mailauth/lib/dkim/header`, verify with Node crypto. `at` defaults to `captured`; a signature expired at `at` (`x=`), a `t=` more than 300 s after `at`, or an unusable `captured` fails closed.

## B2. Verdicts

Trust levels `verified`, `forwarded`, `authorized`, `unverified` (PRD §3).
- **Live**: `verified` = aligned DKIM pass AND (`dmarc.published` ? DMARC pass : true), with `published = result !== 'none' || rr present` (temperror/permerror count as published, so they fail closed). `forwarded` = ARC pass and a sealer on `trustedSealers`. `authorized` = SPF pass + DMARC pass (live only). Else `unverified`.
- **Portable**: recomputed from the record only. `verified` = at least one signature passes at `at` and is aligned with the signed `From:` domain (relaxed unless the stored `dmarc.rr` has `adkim=s`). A signature whose `h=` omits `From` never aligns. Never uses SPF or ARC.
- Each verdict carries its `engine` stamp and is never recomputed in place.

## B3. Trail (one git repo per trail)

```
<trailDir>/<trail>/        trail name /^[a-z0-9][a-z0-9_-]{0,63}$/, default "default"
  trail.json               {v:2, name, created}
  records/<id>.json        (+ records/<id>.json.ots when OTS is on)
  keys/<domain>/<selector>/<sha256(p)[0:16]>.json   {v:2, domain, selector, k, p, txt, lookup, first_fetched}
```
- One commit per record (record, new key files, `.ots`). Message: `record <id[0:12]> <direction> <live.trust>/<portable.trust>`; never header or body text.
- A key file is written once per domain+selector+key-hash and never rewritten.
- Capturing the same bytes again (the id exists) is a no-op (`duplicate:true`).

### Concurrency (single writer per trail)
- Writers take a lock file `<trailDir>/.<trail>.lock`: beside the repo, not inside it, so it also guards the first `git init`, never shows in `git status` and never travels in a clone. Created with `O_CREAT|O_EXCL`; contents JSON `{pid, host, started}` (ISO time). It is held across the whole write (duplicate check, files, `git add`, `git commit`, OTS) and released in `finally`, only if the file still holds the writer's own content.
- A waiting writer retries with jittered backoff (about 20 ms growing to 500 ms) for `lockTimeoutMs` (constructor option, default 30000). On timeout it throws an error with `code: 'ERR_TRAIL_LOCKED'` and writes nothing.
- A lock is taken over only when `host` equals this machine's hostname AND the pid is dead (`kill(pid, 0)` gives `ESRCH`; `EPERM` means alive). An unparseable lock counts as stale only once its mtime is older than `lockTimeoutMs`. A live or other-host lock is never taken over. Takeover goes through a break lock: a waiter that judges the lock stale first creates `<trailDir>/.<trail>.lock.break` with `O_EXCL` (contents `{pid, host, started}`); a waiter that does not get it leaves the main lock alone and backs off. The holder re-reads the main lock, unlinks it only if it still holds the content judged stale, releases the break lock in `finally` (only if it still holds its own content), then everyone retries the `O_EXCL` open. This is safe because, while the main lock belongs to a dead owner, only a break-lock holder may remove it (the dead owner never releases; a live writer's release removes only its own lock; acquirers need the file absent), so the main lock cannot change between the holder's re-read and its unlink. For the same reason a writer's own read-then-unlink on release is safe: its pid is alive, so its lock is never judged stale. A break lock is held for milliseconds, so it counts as stale when it is same-host with a dead pid, or older than `max(lockTimeoutMs, 10000)` ms by mtime; a stale break lock is removed by a plain unlink and never taken over through another lock.
- On failure a writer removes only the files it newly created and that git does not track; it never deletes a committed file.
- The OTS stamp runs inside the lock, so it is cut off after `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms (reported as `ots: {error: 'ots timeout'}`; the record is still committed), so a hanging calendar cannot make every waiting writer hit `ERR_TRAIL_LOCKED`. A short `lockTimeoutMs` therefore shortens the stamp, with a 5000 ms floor; writers that wait less than that can still hit `ERR_TRAIL_LOCKED` behind a slow stamp.
- Local filesystems only: `O_EXCL` is not reliable on NFS.
- `records/` and `keys/` are library-managed. At the start of every write (under the lock) the writer runs `git reset -q`, then deletes the untracked files under `records/` and `keys/` that match the library's own paths, and nothing else: `records/<32 lowercase hex>.json`, `records/<32 lowercase hex>.json.ots`, `keys/<domain>/<selector>/<16 hex>.json` (domain and selector lowercase, characters `[a-z0-9._-]`, no `..`, no leading `.`). Key directories this pass emptied are removed. Any other file there is left alone (so `git status` may show it), but a trail is not a place for your own files.
- **Recovery.** If `ERR_TRAIL_LOCKED` persists and no writer is running (check the `pid` and `host` in `<trailDir>/.<trail>.lock`), delete that file, and `.<trail>.lock.break` if present. A lock from another host is never taken over automatically, including after a hostname change or from a killed container on a shared volume. Volumes shared across hosts are unsupported beyond that manual step. **A trail restored from a backup or clone, or replaced, needs no extra step for the `sync` cursor (`<trailDir>/.<trail>.sync.json`, B4.2): `sync` detects that the cursor is ahead of the trail and rescans (`reset: 'trail'`).** A stale `sync` lock is `.<trail>.sync.lock` (and `.break`), recovered the same way.

## B4. IMAP capture (`sync`, M1)

> **Built** (branch `feat/m1-capture`): limits and over-limit digest record `bce9377`, `imapflow` dependency `1e46039`, `src/proof/imap.js` `1a578e2` (the only `imapflow` importer), `src/proof/sync.js` and `Mailproof#sync` `265e3bc`, docs `750b266`; the `mailproof-sync` CLI follows (B4.1). Mechanism choices are made here; the six product forks were decided by the owner on 2026-11-03 (list at the end of this section). Evidence: [findings F16](findings.md) (imapflow checklist), [F17](findings.md) (Gmail POC: login, byte-exact fetch, `N:*` quirk, size knobs), F3 (Sent copies are unsigned). Out of scope for M1: the portable SPF/ARC verdict (PRD §12 Q10), an IDLE watcher, the OAuth flow itself, whole-inbox recording, multi-account orchestration.

`sync` is a **fetcher in front of `record()`**: it reads raw messages from one mailbox over IMAP and hands each to the existing `record()` path (gate, worker backstop, trail lock, dedup by `id`). It adds no second way to build a record, no second verdict, no second lock for the trail. The one new piece of state is the resume cursor.

### B4.1 Public surface

A method on the instance, bound like the others (`const { sync } = mp` works). It takes everything about the mailbox as arguments; the `Mailproof` constructor is unchanged.

```js
const res = await mp.sync({
  host: 'imap.gmail.com',              // required
  port: 993,                           // default 993; TLS only (see B4.6)
  user: 'you@gmail.com',               // required
  auth: { pass: 'app password' },      // exactly one of:  { pass }  |  { accessToken }  (XOAUTH2)
  folders: ['INBOX'],                  // default ['INBOX']; each is a folder or label path as the server names it; direction 'in'
  sent: true,                          // true (default): discover the folder with the \Sent special-use flag; a string: that exact path; false: skip. Direction 'out'
  maxMessages: 1000, maxBytes: 536870912,  // optional, per folder per run; can only LOWER the limits.js value (see B4.3)
  tls: { ca: pem },                    // optional: extra CA (private server, tests). Certificate checking is never off
})
```

```ts
type SyncResult = { complete: boolean,               // true when every folder reached the server's end (uidNext - 1) with no error and no cap hit
                    folders: SyncFolderResult[] }
type SyncFolderResult = {
  folder: string, direction: 'in' | 'out',
  attempted: boolean,                                // false: the run stopped before this folder (see "stops")
  uidvalidity: string | null,                        // as a decimal string, never a Number
  reset: null | 'uidvalidity' | 'unreadable' | 'trail',  // why the cursor was discarded and the folder rescanned from UID 1
  last_uid: number | null,                           // the cursor after this run
  seen: number,                                      // messages listed in the window(s) fetched this run
  recorded: number,                                  // new records, over-limit ones included
  duplicate: number,                                 // the id already existed (a re-fetch, or the same bytes in another folder/label)
  over_limit: number,                                // subset of `recorded` with `reason: "over limit: ..."` (incl. time/memory/crash)
  skipped: Array<{ uid: number, size: number, why: string }>,  // not recorded at all (see B4.3: only above SYNC_MAX_MESSAGE_BYTES)
  bytes: number,                                     // message bytes read from the server (buffered or streamed)
  complete: boolean,                                 // false when a cap was hit, an error stopped it, or it was not attempted
  error: { code: string, message: string } | null
}
```

- **Credentials.** `auth.pass` is the app password (login works on Gmail, F17); `auth.accessToken` is a ready OAuth2 access token sent with `AUTHENTICATE XOAUTH2`. **The caller obtains and refreshes the token** (a fresh one per cron run; a run is capped at 30 minutes, inside a one-hour token life, B4.3). It is a string, not a callback: mailproof owns no OAuth client. The secret is passed to the wrapper and nowhere else: it is never logged, never in a result, an error message, a record or the cursor file (a test greps for it, B4.8).
- **Read-only.** Every folder is opened with `EXAMINE` (imapflow `getMailboxLock(path, { readOnly: true })`) and every message is read with `BODY.PEEK[]`: nothing is marked `\Seen`, and the library never issues `STORE`, `APPEND`, `COPY`, `MOVE`, `DELETE`, `EXPUNGE` or `IDLE` (a test checks the command log).
- **Errors.** Option errors throw before any connection (`TypeError`-class, like the constructor). After that `sync` throws only for failures that make the whole run pointless: `ERR_IMAP_AUTH` (login refused; the message never echoes the credential), `ERR_IMAP_CONNECT` (cannot reach the server or TLS verification failed), `ERR_SYNC_LOCKED` (B4.5). Anything scoped to a folder lands in that folder's `error` and the run goes on to the next folder: `ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT` (`sent: true` and no `\Sent` folder; reported on a folder entry named `\Sent`), `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED` (a `[THROTTLED]`/bandwidth-limit answer; not retried), `ERR_IMAP_UIDVALIDITY` (changed mid-run, see B4.2). **The `\Sent` lookup** (the `LIST` that finds the special-use folder) follows the same split: with `sent: true`, a failure of it that is a connect or auth failure throws, and any other (`ERR_IMAP_THROTTLED`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`) is reported on the `\Sent` entry with its own code while the other folders still sync; with `sent: false` or a `sent` path the lookup is not needed, so its failure is ignored (listed folders stay `in`). **The run stops at the first trail error** (`ERR_TRAIL_LOCKED` or any `record()` throw): the trail is shared by every folder, so the same error would repeat. The current folder carries the error; later folders are returned with `attempted: false`. Progress already recorded stays recorded and the cursor stays where the last committed record left it. `sync` never throws because a message is unsigned, fails verification or is over a limit.
- **Folder rules.** Duplicates in `folders` (and the discovered Sent folder) are synced once. A folder whose special-use is `\Sent` is `out` wherever it was listed; everything else is `in`. Gmail labels are IMAP folders; one message under two labels has two UIDs and the same bytes, so the second is `duplicate` (one definition of identity, B1).

**CLI: `mailproof-sync`** (`bin/mailproof-sync.js`, in `package.json` `bin` and `files`). A thin wrapper for cron and systemd timers: it builds one `Mailproof`, calls `sync` once, always `close()`s, and prints the result. No logic of its own beyond argument and secret handling.
- Config: flags with env fallbacks `MAILPROOF_TRAIL_DIR`, `_TRAIL`, `_HOST` (default `imap.gmail.com`), `_PORT`, `_USER`, `_FOLDERS` (comma-separated, default `INBOX`), `_SENT` (`on`/`off`, default on).
- Secret, exactly one source, never a flag or a plain env value: `--pass-command` (`MAILPROOF_PASS_COMMAND`; split into argv, `execFile`, no shell; first stdout line), `--pass-file` (first line), or stdin when neither is given and stdin is not a TTY; or `--access-token-command` for XOAUTH2. Whitespace inside an app password is stripped. The command's own stderr and stdout are never echoed.
- Output: one JSON line on stdout (the `sync` result); errors on stderr.
- Exit codes: `0` finished, including a partial run (a cap hit, `complete: false`, no `error`: the next run continues from the cursor); `75` (EX_TEMPFAIL) for `ERR_SYNC_LOCKED`, `ERR_TRAIL_LOCKED`, `ERR_IMAP_CONNECT`, a folder `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`, or a failing secret command; `77` for `ERR_IMAP_AUTH`; `64` for bad usage (including option errors `sync` rejects); `1` for anything else. When a folder carries an error the JSON is still printed and the exit code follows the first such error.

### B4.2 Resume state

- **What.** Per account and folder: `uidvalidity` (decimal string; imapflow gives a BigInt and the wrapper stringifies it once; compared as strings, never as Numbers, which lose precision above 2^53) and `last_uid` (highest UID fully processed); and once per file `head`, the trail's git HEAD commit when the file was last written (`null` while the trail has no commits). Nothing else: no message list, no headers.
- **Where: a sidecar file beside the trail, not in the git repo** (rationale: the cursor is not proof, "one commit per record" stays true, and a clone of a trail must not inherit a cursor for someone else's mailbox; the cost is B4.2 "Restore" below).

  ```
  <trailDir>/.<trail>.sync.json         beside .<trail>.lock; never in git status, never in a clone
  { "v": 1, "head": "<trail git HEAD, or null>", "accounts": { "<host>/<user>": { "<folder path>": { "uidvalidity": "1234", "last_uid": 57, "updated": "ISO-8601" } } } }
  ```
  Fixed key order, 2-space indent, trailing newline. Written by write-temp (`.<trail>.sync.json.tmp`, same directory) + `fsync` + `rename`, so a reader sees the old or the new file, never half. An unparseable or wrong-`v` file counts as absent: every folder is rescanned (`reset: 'unreadable'`), which is safe (below) but costs a re-download.
- **Order of writes (the crash contract).** For one message: `record()` resolves (the git commit is durable, or `duplicate: true`) THEN the cursor moves to that UID and the file is rewritten. Messages are processed in ascending UID with no holes, so `last_uid` means "everything at or below was handled". A crash or kill between the commit and the cursor write leaves the cursor one message behind: **at-least-once fetch**. The re-fetched message has the same bytes, so the same `id`, so `record()` returns `duplicate: true` and writes nothing. Nothing is lost and nothing is committed twice. The cursor is never ahead of the trail within one trail's lifetime. The rewrite per message is a tiny file; it is not a git commit.
- **A message that cannot be recorded stops the folder** at that UID (the cursor stays below it), so the next run retries it; it is never skipped silently. The one exception is `skipped` (B4.3), which is reported and moves the cursor.
- **Window and the `N:*` quirk.** After `EXAMINE` the wrapper reads `uidNext`. The run lists `UID FETCH <last_uid+1>:<hi> (UID RFC822.SIZE)` where `hi = min(last_uid + SYNC_UID_WINDOW, uidNext - 1)` (`SYNC_UID_WINDOW` 1,000, `limits.js`), repeated window by window until `hi` reaches `uidNext - 1` or a cap is hit. **`*` is never used**, so RFC 3501's "`N:*` always matches the highest message" cannot return the last message again (F17.5), and the untrusted server cannot send more entries than the window holds. The wrapper still **drops every returned UID not in `(last_uid, hi]`** (and sorts ascending), because it does not trust the server's range handling. UIDs added after `EXAMINE` wait for the next run.
- **`UIDVALIDITY` change** (the stored string differs from the server's): the old UIDs mean nothing. The cursor is discarded (`reset: 'uidvalidity'`), the folder is rescanned from UID 1, and the new value is stored. The rescan re-downloads every message and records none twice (same bytes, same `id`). A change seen on a **reconnect inside a run** stops that folder with `ERR_IMAP_UIDVALIDITY`; the next run does the rescan. A first run (no cursor) is the same scan from UID 1 without a `reset` flag.
- **Restore (detected).** Restoring a trail from a backup or clone while the sidecar stays can leave the cursor AHEAD of the trail (mail silently missing). Every cursor write records the trail's HEAD in `head`. At the start of a run, if `head` is not the trail's current HEAD or an ancestor of it (`git merge-base --is-ancestor`), or the trail now has no commits, the whole file's cursors are discarded and each folder that had one is rescanned from UID 1 with `reset: 'trail'`; the id dedup makes the rescan record nothing twice. A file with no `head` key counts as stale. A file written while the trail had no commits (`head: null`) is never stale. Deleting the sidecar by hand is no longer required (still harmless: it is the same rescan, without the `reset` flag).

### B4.3 Bounds

Everything bounded here is defined once in `src/proof/limits.js` (a second block, "SYNC", beside the admission and worker blocks). The server is untrusted input; the order is the same as for a pipe message: **size first, then bytes, then the gate.**

| Limit | Value | Meaning |
|---|---|---|
| `SYNC_UID_WINDOW` | 1,000 | UIDs listed per `UID FETCH ... (UID RFC822.SIZE)` window; bounds metadata held in memory |
| `SYNC_MAX_MESSAGES` | 1,000 | messages handled per folder per run |
| `SYNC_MAX_BYTES` | 512 MiB | message bytes read per folder per run (Gmail also meters IMAP download per day; a backfill is meant to take several runs) |
| `SYNC_MAX_MESSAGE_BYTES` | 128 MiB | largest message that is still read (streamed) to be recorded; above it, `skipped` |
| `SYNC_MAX_MS` | 30 min | wall time of one `sync` call, checked between messages and between UID windows; a run past it stops cleanly (`complete: false`) |
| `SYNC_CONNECT_MS` | 30 s | TCP/TLS connect and greeting (imapflow `connectionTimeout`, `greetingTimeout`) |
| `SYNC_SOCKET_MS` | 5 min | idle socket (imapflow `socketTimeout`). It covers a server that goes quiet; the record build time (up to the worker's 15 s CPU + 30 s DNS) is well inside it |
| `SYNC_FETCH_MS` | 5 min | wall time of reading ONE message; over it the connection is closed and treated as a drop (below). Catches a server that trickles bytes and never trips the idle timer |
| `SYNC_MAX_RECONNECTS` | 3 | reconnects per run, backoff 1 s, 4 s, 16 s |

Caller options `maxMessages` / `maxBytes` take the **smaller** of the option and the constant (a caller can tighten, never loosen: "every bound lives in `limits.js`"). Values are first estimates to be measured in the Gmail run (B4.8), the same way F14's were. A cap that is hit ends that folder cleanly (`complete: false`, cursor saved); calling `sync` again continues. A caller loops until `complete: true`.

- **Size first.** The window listing gives each message's `RFC822.SIZE` (about 100 bytes on the wire per message, F17.6; the POC saw it equal the fetched length 9/9). Messages are then read **one at a time**, in ascending UID, never inside the listing loop (imapflow cannot run a second command while a `fetch` iterator is open; the list is collected first).
- **Within the gate size (`size <= MAX_TOTAL_BYTES`).** `BODY.PEEK[]<0.MAX_TOTAL_BYTES+1>` (`source: { start: 0, maxLength: MAX_TOTAL_BYTES + 1 }`, F17.6): a server that lies about the size cannot make us buffer more than the gate limit plus one byte. If the returned length is `<= MAX_TOTAL_BYTES` the Buffer goes to `record()` unchanged (`admit()` and the worker backstop decide the rest). If it is longer than the limit the server lied; treat it as an over-size message (next bullet).
- **Over the gate size (`size > MAX_TOTAL_BYTES`).** Accept-with-flag says it is still recorded. The record `id` is the sha256 of the **whole** raw bytes (B1), so the bytes must be seen once. The wrapper **streams** the message (`download`), feeding a sha256 and a byte counter and keeping nothing (memory is the chunk size, not the message). The result is recorded through an internal path that builds the existing over-limit record from `{ raw_sha256, size }` instead of a Buffer: `over-limit.js` already uses nothing but those two values, so its `overLimitRecord(buf, ...)` becomes a thin wrapper over a digest form (one definition, B1/Limits). The record is exactly the one `record()` would write for the same bytes (`reason: "over limit: total_bytes"`, same `id`): a later pipe capture of that message is `duplicate: true`. This is the only new write path and it is internal (not an export, not a primitive). Nothing is parsed, no DNS asked.
- **A truncated record is not possible.** A prefix would need a different `id` (the hash of fewer bytes), which would collide with nothing and match no other copy, and it would store a hash that is not the message's. We refuse that: either the whole bytes are hashed or the message is not recorded.  Decided: stream-hash and record; above `SYNC_MAX_MESSAGE_BYTES` report as `skipped` and move on, so one monster cannot block the folder forever.
- **Connection drop / reconnect.** An error or `close` while reading a message (including `SYNC_FETCH_MS`) ends that attempt: the message is NOT recorded from partial bytes (a short literal is never passed to `record()`). The wrapper reconnects (up to `SYNC_MAX_RECONNECTS` per run, with backoff), re-`EXAMINE`s, re-checks `UIDVALIDITY` (B4.2) and resumes from the in-memory cursor, which equals the file. Out of reconnects: the folder ends with `ERR_IMAP_TIMEOUT` or `ERR_IMAP_PROTOCOL`, cursor at the last committed UID. An auth failure on reconnect is `ERR_IMAP_AUTH`. A token that expired mid-run is that same error; the run cap keeps this unlikely.
- **No compression.** `disableCompression: true`: wire bytes are not literal bytes under COMPRESS=DEFLATE (F17.6), and a compressed stream is a decompression-bomb surface the caps would have to count a second way.

### B4.4 Direction, copy kind, `source`

- **Direction.** `folders` → `in`; the `\Sent` folder → `out`. The record's `direction` is passed to `record()` as for any capture; nothing else is special-cased.
- **Sent copies.** Mailbox providers do not sign the Sent copy (F3: msn.com 4/4; Gmail 1/1, F17.3), so a Sent record is what `record()` already makes of unsigned mail: `signatures: []`, `unverified` on both verdicts (`basis: "none"`), `copy.kind` `unknown`, `message.from` set. **No flag is added**; "unverified out" is the whole expression, and the proof of sending is the counterparty's signed copy (F3, PRD §5). If a provider ever does sign a Sent copy, it verifies like any other: sync does not assume.
- **`source`** = `imap:<folder path>` (e.g. `imap:INBOX`, `imap:[Gmail]/Sent Mail`), clipped by `record()` to 200 chars. The account (user, host) is deliberately NOT in `source`: a trail may be shared or published and the cursor file already knows the account. The first capture's `source` wins when the same bytes are met again in another label (B1).
- **`captured`** is `record()`'s clock (B1) = when sync fetched it, not the mail's receive time. For a backfill that is "now" for old mail; the evidence of age is the signed `Date`/`t=` in the record. `INTERNALDATE` is not stored.
- **No envelope.** IMAP carries no client IP/HELO, so `record()` runs without an `envelope`: the live verdict has `spf: null` and `authorized` cannot occur; `verified` (aligned DKIM + DMARC when published) and `forwarded` (ARC with a trusted sealer) can. Gmail's own `Authentication-Results`/ARC set is **not used** for any verdict (F17.4; PRD Q10 is later).

### B4.5 Concurrency

- **sync vs the Postfix pipe (or any other `record()`).** Both go through `commitRecord`, which takes the trail lock for each write (B3, Concurrency). `sync` **never holds the trail lock across IMAP I/O**: it takes it only inside `record()`, per message, for the same few hundred milliseconds as a pipe write. A pipe delivery that arrives during a backfill waits behind at most one message's commit, within its own `lockTimeoutMs`, and keeps its exit-75 mapping for `ERR_TRAIL_LOCKED`. In the other direction, a `record()` inside `sync` that times out surfaces as `ERR_TRAIL_LOCKED` in the folder result and stops the run (B4.1); the cursor is untouched, so the next run retries that message. If the pipe and `sync` capture the same bytes, whichever commits first wins and the other gets `duplicate: true`.
- **Two syncs at once on one trail.** A second lock file `<trailDir>/.<trail>.sync.lock` with the **same mechanism as the trail lock** (`O_EXCL`, `{pid, host, started}`, dead-pid same-host takeover through a break lock; implementation: `withTrailLock` takes the lock file name as an argument, so there is one lock implementation) guards the whole `sync` call and therefore the cursor file. It is **fail-fast**: a second `sync` on the same trail gets `ERR_SYNC_LOCKED` at once (a cron job should skip an overlapping run, not queue). The sync lock and the trail lock are never taken in the opposite order (sync lock first, then trail lock inside `record()`), so they cannot deadlock. The recovery rule for a stale lock is B3's, with the file name `.<trail>.sync.lock`.
- **Different trails, or accounts.** Different trails never share a lock or a cursor file. One trail with two accounts is allowed: the cursor file keys by account, calls are serialised by the sync lock, the caller loops over accounts (multi-account orchestration is not in M1).
- **Worker.** Each message is one `record()` call, so the worker pool is used exactly as for a pipe message (one build at a time per `sync`). While a build runs the IMAP connection is idle (bounded by `SYNC_SOCKET_MS`). One message is in memory at a time on the main thread, plus one in the worker. `worker.size: 0` works too.
- **OTS.** `record()` stamps each record when `otsBin` is set, inside the trail lock, so a 1,000-message backfill with OTS on makes 1,000 sequential stamps. M1 changes nothing (per email, as `record()` does today); recommended: leave OTS off for backfills. Decided (PRD §12 Q8): per record; docs advise OTS off for backfills.

### B4.6 Dependency and wrapper

- **imapflow is the third (last) runtime dependency** (F16; the ceiling of 3 is reached). The lockfile is the pin (it releases weekly); `check:lockfile` stays a CI gate.
- **One importer.** `src/proof/imap.js` is the only module that imports `imapflow`. It exposes a small plain-data interface and nothing from imapflow's types leaks out (no `BigInt`, no stream objects other than a Node `Readable` consumed inside it):

  ```js
  openSession({ host, port, user, auth, tls, timeouts }) => Promise<{
    findSent():       Promise<string | null>,                         // path with specialUse '\\Sent'
    select(path):     Promise<{ uidvalidity: string, uidNext: number }>,   // EXAMINE; releases the previous folder
    list(lo, hi):     Promise<Array<{ uid: number, size: number }>>,       // UID FETCH lo:hi (UID RFC822.SIZE); explicit range only
    fetch(uid, max):  Promise<Buffer>,                                // BODY.PEEK[]<0.max>; may return max bytes
    hash(uid):        Promise<{ sha256: string, size: number }>,      // streamed, nothing kept
    close():          Promise<void>,
  }>
  ```
  `src/proof/sync.js` holds all logic (window loop, cursor, caps, direction, reconnect policy) against that interface, so it is tested with an in-memory fake session; the wrapper is tested against a fake IMAP server (B4.8). `Mailproof#sync` is a thin method that builds the session and calls `sync.js`.
- **imapflow settings, fixed in the wrapper and not options:** `secure: true` (implicit TLS, default port 993; no plain connection, no STARTTLS upgrade, `tls.rejectUnauthorized` never false, only `tls.ca` can be added), `logger: false`, `emitLogs: false` (logging off; the library would otherwise be a place where credentials and message text reach a log), `disableCompression: true`, `disableAutoIdle: true` (no background IDLE), `verifyOnly` unused, the timeouts of B4.3. `auth` is `{ user, pass }` or `{ user, accessToken }`.
- **Types and ESM.** imapflow is CJS with an ESM entry and ships `.d.ts` (F16): `import { ImapFlow } from 'imapflow'`; JSDoc types for the interface above are the single source, per LIBRARY_CONVENTIONS. `package.json` gains `"imapflow"` under `dependencies`; `sync` is added to the class JSDoc (`@when`/`@fails`/`@example`) so `primitives.json` regenerates (`check:primitives`).
- **Fallback, not taken:** PRD §12 Q9's separate `mailproof-imap` package (depends on `mailproof` and imapflow); the interface above is already the seam if this is ever revisited.

### B4.7 Out of scope for M1 (and why)

| Not in M1 | Why / when |
|---|---|
| Portable SPF/ARC verdict from Gmail's `Authentication-Results`/ARC set | PRD §12 Q10; owner: later. Needs its own spec and POC. M1 stores the headers' signed parts as M0 does and adds no verdict |
| IMAP IDLE watcher | M1 is a cron/systemd-timer `sync`; IDLE is a separate state machine (F16), added behind the same wrapper |
| The OAuth flow (consent, refresh) | The caller passes a ready access token; mailproof has no HTTP client and no client secret |
| Whole-inbox recording | A later setting on this code (PRD M6 note, §10); M1 syncs named folders |
| Multi-account orchestration, CLI `sync` subcommand | The method takes one account per call; the CLI is M3 |
| Any write to the mailbox | Read-only by construction (B4.1) |
| Non-Gmail providers | Gmail first (F4: Outlook/Exchange bodies are altered on their side); the code is plain IMAP4rev1 and nothing Gmail-specific except the documented `\Sent`/label behaviour |
| POP3, mbox/Maildir import | Not planned |

### B4.8 Test plan

Two layers plus one manual run. Each test below must be written so that a plausible bug makes it fail (the cause of failure is named). Tests use `makeTmpDir` and leave nothing in `/tmp`; timing assertions use counts or generous margins, not wall-clock.

**Layer 1: `sync.js` against an in-memory fake session** (records real messages from `tests/integration/fixtures/` into a real trail with `worker: { size: 0 }`; the fake logs every call and can inject faults).
1. *Fresh run, then re-run.* All messages recorded, cursor = highest UID; the second run lists but **fetches zero** messages (the fake's fetch counter) and records zero. Fails if the cursor is not persisted or not read.
2. *`N:*` quirk.* A fake that ignores the requested range and always also returns the last message: the filter drops it (no fetch, no `duplicate` counted, `seen` excludes it). A second assertion: no `list` call ever contains `*`. Fails if the filter or the explicit range is removed.
3. *Crash window.* Throw between the `record()` commit and the cursor write (inject into the cursor writer), then run again: the re-fetched message is `duplicate: true`, `git log` has exactly one commit per distinct message, nothing is lost. Fails if the order of writes is reversed (a cursor written first would skip the message in a run that crashes after it) or if dedup is bypassed.
4. *Never skip a failure.* Make the 3rd of 5 `record()` calls throw (hold the trail lock past a tiny `lockTimeoutMs`): the folder result has `ERR_TRAIL_LOCKED`, cursor = UID of the 2nd, later folders `attempted: false`, messages 4 and 5 not recorded; after releasing the lock the next run records 3-5 and no duplicate. Fails if the loop continues past an error or advances the cursor on it.
5. *`UIDVALIDITY`.* A changed value: cursor discarded, `reset: 'uidvalidity'`, all messages re-fetched and all `duplicate`, new value stored. Two values that differ only above 2^53 (`"9007199254740993"` vs `"...992"`) are different. Fails if the comparison goes through `Number`. A change on reconnect inside a run gives `ERR_IMAP_UIDVALIDITY` and no records.
6. *Oversize, honest size.* A 26 MiB message (size above `MAX_TOTAL_BYTES`): the fake counts bytes served through `fetch` (must be 0) and through `hash`; the trail has a record with `reason: "over limit: total_bytes"` whose `id` equals the independent sha256 of the bytes and `size` the true length; then `mp.record()` of the same Buffer returns `duplicate: true`. Fails if it was buffered, hashed wrongly, recorded truncated, or its id differs from the pipe path's.
7. *Oversize, lying size.* Metadata says 1 KiB, the literal is 26 MiB: `fetch` is asked for at most `MAX_TOTAL_BYTES + 1` and returns that; the sync switches to `hash`, result identical to 6. Above `SYNC_MAX_MESSAGE_BYTES` (limits lowered through the test's constants) the message is in `skipped`, not recorded, cursor moves. Fails if a short or truncated Buffer reaches `record()`.
8. *Caps.* `SYNC_MAX_MESSAGES`/`SYNC_MAX_BYTES`/`SYNC_MAX_MS` (made small by the test): the folder ends `complete: false`, cursor at the last processed UID, the next run continues with no duplicates; an option larger than the constant is clamped to it (assert the effective cap).
9. *Direction and source.* INBOX records have `direction: 'in'`, `source: 'imap:INBOX'`; the `\Sent` folder `out`, `unverified`/`unverified`, `signatures: []`; a folder listed in `folders` that is the `\Sent` one is `out`, synced once; `sent: true` with no `\Sent` folder → `ERR_IMAP_NO_SENT` on its entry while INBOX still succeeds. The account name is absent from every record.
10. *Concurrency.* A second `sync` while the first holds the sync lock (the fake blocks mid-run): `ERR_SYNC_LOCKED` at once, cursor unchanged. A separate `Mailproof` instance (another lock holder path) calling `record()` while `sync` runs: both finish, all records present, none lost. A stale sync lock (dead pid, this host) is taken over.
11. *Cursor file.* After every message the file parses and no `.tmp` is left; a corrupt file gives `reset: 'unreadable'` and a full rescan without error; the file sits outside the git repo (`git status` clean after a run).
12. *Secrets.* With a distinctive password/token, `JSON.stringify` of every result and thrown error, every file under the trail dir, and the cursor file contain it nowhere.
13. *Reconnect policy.* A drop mid-message: that message is not recorded from partial bytes, the session reconnects, resumes at the same UID, final state equals an uninterrupted run; more drops than `SYNC_MAX_RECONNECTS` → folder error, cursor at the last committed UID.

**Layer 2: `imap.js` (real imapflow) against a fake IMAP server** (a small IMAP4rev1 server on `node:tls`; the test generates a throwaway self-signed certificate with `openssl` into `makeTmpDir` and passes it as `tls.ca`; if `openssl` is missing the test **fails**, not skips). The server logs every command line and can drop the socket, lie about sizes, send a bad literal length and change `UIDVALIDITY`.
14. *Auth.* `LOGIN`/`AUTHENTICATE PLAIN` with a password and `AUTHENTICATE XOAUTH2` with a token (the server checks the exact SASL payload); wrong credentials → `ERR_IMAP_AUTH` and the message does not contain the secret.
15. *TLS is mandatory.* An untrusted certificate, a hostname mismatch and a server that speaks plain text all give `ERR_IMAP_CONNECT`; the server sees no `LOGIN` or `AUTHENTICATE` in any of them (no credential leaves before the certificate is accepted).
16. *Read-only command log.* After a full run the server's log contains only `CAPABILITY`, `ID` (if imapflow sends it), `LOGIN`/`AUTHENTICATE`, `LIST`, `EXAMINE`, `UID FETCH`, `NOOP`, `LOGOUT`; `BODY.PEEK` and never `BODY[]`; no `SELECT`, `STORE`, `APPEND`, `COPY`, `MOVE`, `EXPUNGE`, `IDLE`, `COMPRESS`. Fails if a default of imapflow changes under the pinned version.
17. *Bytes are exact.* A message with bare LF, CRLF mixed and 8-bit bytes (`FF FE 00`): the recorded `raw_sha256` equals the sha256 of the server's bytes (F16 did this by hand; now a regression test). `\Sent` discovery via `SPECIAL-USE` and folder names with spaces/brackets.
18. *Literal handling.* A server that announces `{n}` and sends fewer bytes then closes: `fetch` rejects, no Buffer is returned; one that sends more than `max`: bounded by `maxLength`. `hash()` of a large literal (100 MiB, generated by the server on the fly) keeps peak `external` + heap growth under a generous margin (e.g. 64 MiB, measured with sampling), proving it streams. The F17 gap "huge literal" is closed here and in the manual run.
19. *Single importer.* A test greps `src/` for `from 'imapflow'` / `require('imapflow')`: exactly `src/proof/imap.js`; and `dependencies` in `package.json` has exactly `mailauth`, `mailparser`, `imapflow`.

**Manual run against real Gmail** (owner's account, app password from `pass`, a temp trail; records the numbers as a new F-entry, since the POC mailbox was 9 messages):
- INBOX + Sent: counts equal the POC (8 `verified`, `body_status` matched; 1 Sent `unverified`); re-run: 0 fetched; delete the cursor file: re-run all `duplicate`, `git log` unchanged.
- `kill -9` mid-run, then re-run: no lost message, no duplicate commit.
- A label of at least 500 messages (or a lowered `maxMessages`): caps, several runs to `complete: true`; note throughput and any `[THROTTLED]`.
- One message over 25 MiB (self-send a 24 MiB attachment: base64 makes it about 32 MiB): `over limit: total_bytes`, id equals the sha256 of a downloaded copy, memory flat.
- XOAUTH2 with a real access token (the F17 gap), once.
- A pipe-style `record()` of the same message from a second process while `sync` runs.

### Decided (2026-11-03)

Owner decisions on the six forks; rationale in [decisions-log](decisions-log.md).

- **Over-size mail:** stream-hash and record `over limit: total_bytes`; above 128 MiB `skipped`. Keeps accept-with-flag; costs bandwidth only.
- **First run:** the whole folder history over capped runs. The folder is a deliberate choice.
- **Cursor:** sidecar beside the trail, stamped with the trail's HEAD so a restored trail is detected. Simple; keeps one commit per record.
- **`captured`:** the fetch time, no new field. The age evidence is the signed `Date`/`t=`.
- **OTS:** per record as today; advise OTS off for backfills. No new proof type.
- **IMAP:** in core as the third dependency (F16). One library, one entry point.

---

# Part A — v1 (archived at M3)

# mailproof — SPEC (wire formats)

> The authority on **mechanism**: byte layouts, schemas, and grammars. If
> this disagrees with DESIGN.md on a wire format, **SPEC wins** (per
> `docs/README.md` precedence). If it disagrees with the PRD on *intent or
> scope*, the PRD wins and this doc must be corrected.

**Status:** P1 is not yet lifted. This SPEC is **prescriptive** — it pins the
formats the lift must produce, derived from the `gitdone` source being
extracted (`event-store.js`, `gitrepo.js`, `classifier.js`, `router.js`,
`outbound.js`) minus the policy that stays in `gitdone`. Where mailproof
deliberately diverges from gitdone, it is called out.

## 0. Scope

mailproof is the **two-mode coordination kernel** (PRD §4.2): an
ordered/parallel multi-step confirmation (**events**, `type: "workflow"`, §3)
*and* a verified-signer sign-off (**crypto**, `type: "crypto"`, §3.1). Both
formats are covered here. The heavy *policy* tail of gitdone's crypto — strict
multi-doc signing, `revoke`, `latest`/`accumulating` dedup, reference-doc
registration, attestor-PII redaction — stays gitdone policy; its wire artifacts
(`attach`/`revoke` commit kinds, `reference_docs`, `revoked_senders`, per-event
`dedup`/`mode`) are **out of scope here** and are noted only to mark the
boundary.

---

## 1. Trust levels

A pure classification of one inbound reply's authentication result
(`classifier.js`). Input is a [`mailauth`](https://github.com/postalsys/mailauth)
`authenticate()` result; output is exactly one level. Ranked ascending:

| Level | Rule | Meaning |
|---|---|---|
| `unverified` | none of the below | No usable authentication. |
| `authorized` | SPF pass **and** DMARC pass | Sending MTA is authorized for the domain, but no aligned DKIM signature. |
| `forwarded` | ARC pass via a trusted intermediary | DKIM broke in transit (e.g. a mailing list), but the ARC chain vouches for the original. |
| `verified` | DKIM pass **and** aligned **and** DMARC pass | Strongest: the message is cryptographically bound to the sending domain. |

```
TRUST_LEVELS = ['verified', 'forwarded', 'authorized', 'unverified']   // rank: index 0 strongest
```

Evaluation order is `verified → forwarded → authorized → unverified`; the
first matching rule wins. A step's `minTrust` gate is satisfied when the
reply's level is **at least as strong** as the step's requirement.

---

## 2. Address grammar

Inbound routing keys off the envelope recipient (Postfix preserves
`${original_recipient}` through the pipe transport). All tags share one shape:

```
{kind}+{extension}@{domain}
ADDR_RE      = /^([a-z][a-z0-9]*)\+([^@\s]+)@([^\s@]+)$/i
EVENT_ID_RE  = /^[a-zA-Z0-9]+$/        // eventId is alphanumeric, validated at creation
```

### Kernel tags (in scope)

| Tag | Meaning |
|---|---|
| `event+{eventId}-{stepId}@` | Workflow reply for a specific step. Everything after the **first** dash is the `stepId` (step ids may contain dashes; eventId may not). |
| `event+{eventId}@` | Workflow reply, step unspecified (kernel resolves the step from sender/state). |
| `remind+{eventId}@` | Initiator asks to re-nudge pending participants. |
| `stats+{eventId}@` | Initiator requests a status summary. |
| `verify+{eventId}@` | Public, durable verification endpoint (no step component). |
| `reverify+{eventId}-{commitSeq}@` | Contested-commit re-evaluation: submitter supplies a raw `.eml` that must validate against the DKIM key archived for `commit-{commitSeq}`. `commitSeq` is `1..99999`. |
| `attest+{eventId}@` | Crypto sign-off reply (§3.1). No step component — sign-off events have no steps; the engine resolves the signer from the verified sender. **Promoted from a policy tag to a kernel tag with the two-mode pivot.** |

### Policy tags (gitdone, NOT lifted)

`manage+`, `attach+`, `revoke+`, `close+`, `bundle+`. The mailproof router must
**not** parse these — a consumer that needs them adds its own parser. (gitdone's
`router.js` parses all of them; the lift drops these. `attest+` was in this set
until crypto sign-off became a core mode — it is now a kernel tag above.)

---

## 3. `event.json` — workflow state

One file per event at `{dataDir}/events/{eventId}.json`, written atomically
(temp + rename), serialized as `JSON.stringify(event, null, 2) + '\n'` — this
exact serialization is an **invariant** (see §5).

```jsonc
{
  "id": "a1b2c3",                    // alphanumeric; 12-char base36 if generated
  "title": "Contract sign-off",
  "type": "workflow",               // "workflow" (this section) | "crypto" (§3.1)
  "flow": "sequential",             // "sequential" (default) | "parallel" | "custom"; expanded to per-step dependsOn at createEvent
  "initiator": "organiser@acme.com",
  "status": "open",                 // "open" | "complete"
  "salt": "9f3a…",                  // 32-byte hex, PUBLIC; salts the commit hashes (§6)
  "created_at": "2026-05-22T20:27:04.210Z",
  "activated_at": null,             // ISO string once activated; null = pending, replies don't count
  "completed_at": null,             // ISO string when status flips to complete
  "archived_at": null,              // ISO string if archived (reversible; never auto-completed)
  "steps": [
    {
      "id": "legal",                // unique within the event
      "name": "Legal review",
      "participant": "legal@acme.com",
      "dependsOn": [],              // step ids that must be complete first
      "minTrust": "verified",       // gate: reply level must be >= this (§1)
      "status": "pending",          // "pending" | "complete"
      "commit_sequence": null,      // the commit-NNN that completed it (§4); null until done
      "deadline": "2026-06-01",     // optional, YYYY-MM-DD
      "requires_attachment": false, // optional
      "details": "…"                // optional, free text shown to participant
    }
  ]
}
```

**gitdone-only event fields (policy, not core):** `activation_ack_token`,
`activation_link_clicked_at` (web magic-link flow), `declaration`,
`attestation`, `mode`, `reference_docs`, `revoked_senders`,
`proof_email_message_id`. The kernel ignores them if present.

**Activation gate.** `activated_at == null` ⇒ the event is pending and replies
are committed for audit but never `counted`. *How* an event gets activated is
the consumer's policy (gitdone uses a magic link); the kernel only reads the
timestamp.

---

## 3.1 `event.json` — crypto sign-off state

The second mode (`type: "crypto"`, PRD §4.2). Same file location, atomic write,
and serialization invariant as §3, and the same lifecycle fields
(`activated_at`/`archived_at`/`status`/`completed_at`/`salt`). It has **no
`steps`**; instead a flat signer/threshold shape. Engine: `archive/v1/src/crypto.js`.

```jsonc
{
  "id": "c1d2e3",
  "title": "Series A board consent",
  "type": "crypto",
  "initiator": "counsel@example.com", // orchestrates; a self-reply NEVER counts
  "status": "open",                   // "open" | "complete"
  "salt": "9f3a…",                    // 32-byte hex, PUBLIC (§6)
  "created_at": "2026-05-22T20:27:04.210Z",
  "activated_at": null,
  "completed_at": null,
  "archived_at": null,

  "signers": ["a@example.com", "b@example.com"], // allow-list, lowercased
  "open": false,                      // true ⇒ ANY verified sender may sign (a shared address)
  "threshold": 2,                     // distinct signatures to complete; 1 = single-signer declaration
  "requiredDocHash": "sha256:…",      // optional; a counting reply must attach a file whose sha256 matches (notary format) | null
  "manualCompletion": false,          // optional; true ⇒ engine never auto-locks — replies still count, but only completeEvent finalises (consumer owns completion)

  "signatures": [                     // the distinct count-to-threshold record (non-PII, §6)
    {
      "sender_hash": "sha256:…",      // salted; the dedup key
      "sender_domain": "example.com",
      "commit_sequence": 4,           // the commit-NNN (§4) that counted this signer
      "received_at": "2026-05-22T20:27:04.235Z",
      "trust_level": "verified"
    }
  ]
}
```

**A reply COUNTS as a signature iff** (machine-code `count_reason`s, §4): the
event is activated, not archived, not complete; `trust_level === "verified"`
(**hardcoded** — crypto is all-or-nothing, no per-event `minTrust`); the sender
is **not** the initiator (`initiator_self_reply` — anti-self-dealing); the
sender is a signer (or `open`); the sender is **distinct** from those already in
`signatures` (`already_signed`); and, if `requiredDocHash` is set, some
attachment's sha256 matches (`doc_hash_mismatch`). The event locks
(`status:"complete"` + `completed_at`) when `signatures.length ≥ threshold`,
**unless `manualCompletion` is set** — then the count still accrues but the
engine never auto-locks, and the consumer finalises via `completeEvent` (the
same flag suppresses the workflow engine's all-steps-done auto-complete).

**Signer-identity resolution is the orchestrator's**, mirroring workflow's
`participant_match`: it compares the plaintext sender against
`signers`/`open`/`initiator` at ingest and passes the engine precomputed
`signer_match` / `is_initiator` booleans (plaintext never reaches the engine or
ledger). The engine dedups on the commit's salted `sender_hash`.

**crypto count_reasons:** `event_not_activated`, `event_archived`,
`already_complete`, `unverified_trust`, `initiator_self_reply`, `not_a_signer`,
`already_signed`, `doc_hash_mismatch`.

**gitdone-only crypto fields (policy, NOT core):** `mode`, `dedup`,
`reference_docs`, `revoked_senders`, `attestor_progress` (strict multi-doc
signing, dedup variants, revoke, per-attestor buckets). The kernel **ignores
them if present** — distinct-count-to-threshold is the only rule.

---

## 4. Per-event git repo — the ledger

One **non-bare** git repo per event at `{dataDir}/repos/{eventId}/`. The
working tree *is* the inspectable, `git clone`-able proof. Layout:

```
{dataDir}/repos/{eventId}/
  .git/                       # the commit chain IS the tamper-evidence (§5)
  event.json                  # mirror of the master state, synced on every transition
  commits/
    commit-001.json           # one per accepted reply, zero-padded, monotonic
    commit-002.json
    reverify-001.json         # durable re-verification records (separate namespace)
    completion.json           # the current completion; rewritten + re-committed if reopened then re-completed (prior records stay in the chain)
  dkim_keys/                  # archived signer PEMs for durable verify (optional)
    commit-001.pem
  ots_proofs/                 # optional OpenTimestamps anchors (one per commit)
    commit-001.ots
```

### `commit-NNN.json` — reply audit record

The core invariant is **accept-with-flag**: *every* inbound reply that routes
to an event is committed — even rejected ones (wrong participant, unverified,
out of order). Routing and trust never gate the commit; they gate `counted`.

```jsonc
{
  "schema_version": 2,
  "kind": "reply",                  // "reply" | "event_edit" | "completion" | "reverify"
  "sequence": 3,                    // matches NNN in the filename
  "event_id": "a1b2c3",
  "step_id": "legal",               // null if the tag carried no step

  "received_at": "2026-05-22T20:27:04.235Z",
  "trust_level": "verified",        // §1
  "participant_match": true,        // sender == the step's participant
  "counted": false,                 // ← did this reply ADVANCE state? (the flag)
  "count_reason": "unverified_trust", // why not counted (null when counted)

  "sender_hash": "sha256:…",        // salted (§6); NO plaintext sender
  "sender_domain": "acme.com",      // domain is non-PII, kept plaintext
  "message_id_hash": "sha256:…",    // salted hash of the RFC-5322 Message-ID
  "raw_sha256": "sha256:…",         // notary hashDocument of the raw RFC-822 bytes
  "raw_size": 4096,
  "attachments": [                  // one entry per inbound attachment (may be [])
    { "filename": "doc.pdf", "size": 8192, "sha256": "sha256:…" }
  ],

  "dkim": { },                      // auth result fragments, structured
  "spf": { },
  "dmarc": { },
  "arc": { },
  "envelope": { "client_ip": null, "client_helo": null },

  "dkim_key_file": null,            // "dkim_keys/commit-003.pem" if archived (durable verify)
  "ots_proof_file": null            // "ots_proofs/commit-003.ots" if OTS anchoring enabled
}
```

**`counted` is mailproof's addition.** gitdone's `buildCommitMetadata` records
`trust_level` + `participant_match` and lets the orchestrator decide counting
out-of-band; the kernel makes the decision explicit and durable in the commit,
because "did this reply count, and why not" is exactly what an auditor reads.

**`attachments` is the notary capture half.** `parseMessage` (m7a) hashes every
inbound attachment's bytes through `hashDocument`, so each `sha256` is
`sha256:`-prefixed and byte-identical to what `verifyDocument` (§4.1) recomputes
and to a crypto event's `requiredDocHash` (§3.1). Hashing is unconditional; the
bytes themselves are never persisted (only the fingerprint, filename, and size).

**A reply is `counted` iff all hold:** the event is activated, not archived, and
not already complete; `participant_match` is true; the reply names a known,
not-yet-complete step; `trust_level` ≥ that step's `minTrust`; the step's
`dependsOn` are all complete; and, if the step sets `requires_attachment`, the
reply carried an attachment. (`createEvent` expands `flow:'sequential'` into a
linear `dependsOn` chain, so "earliest pending step" *is* the deps rule — the
engine has one eligibility model, no second sequential code path.) Otherwise
`counted` is false with a machine-code `count_reason`: `event_not_activated`,
`event_archived`, `already_complete`, `wrong_participant`, `no_step`,
`unknown_step`, `unverified_trust`, `deps_unmet`, `out_of_order` (deps unmet
under `sequential` flow), or `missing_attachment`. Matching a *specific*
document hash is the notary's `verifyDocument` (§4.1), never a completion gate.

**Other kernel commit kinds:** `event_edit` (participant/deadline/title change
as a before/after audit record; participant changes stored as salted
`from_hash`/`to_hash`), `completion` (records `completed_at` +
`triggering_commit_sequence`; written when the event reaches `complete`, and
*rewritten + re-committed* if the event is reopened then re-completes — via
either `completeEvent` or a fresh inbound reply through `ingest` — so the record
tracks the current completion while every prior record stays in the git chain;
a byte-identical re-completion writes no commit), `reverify` (durable
re-verification against an archived PEM; never mutates the target commit).

**gitdone-only commit kinds (policy, NOT core):** `attach`, `revoke`.

---

## 5. Tamper-evidence model

1. **Primary: the git commit chain.** Each accepted reply is a git commit.
   Git's content-addressing means every commit SHA covers its tree *and* its
   parent SHA — a Merkle DAG. Altering any historical `commit-NNN.json` changes
   that commit's tree hash and breaks every descendant SHA, which is detectable
   by anyone with a clone. This is the portable, offline-verifiable proof.
2. **Optional: OpenTimestamps.** When an `otsBin` is configured, each commit
   file is OTS-stamped (`commit-NNN.ots`), anchoring its existence to Bitcoin.
   This is **accept-with-flag**: stamp failure is recorded in the commit
   (`ots_archive.error`) and never blocks delivery. The kernel works fully
   without OTS. The initial stamp is a *calendar-pending* commitment; the
   Bitcoin attestation is folded in later by `createOts().upgradeProof(abs)`
   (runs `ots upgrade` in place — the proof file's sha256 *changing* is the
   authoritative "now anchored" signal, never `ots verify`). The anchored block
   is read offline with `readBlockHeight(abs)` (`ots info`, no network). Driving
   `create().upgradeProofs({ now? })` (m7d-4, present when `otsBin` is set)
   drives the upgrade across every event's proofs, patches each sibling commit
   JSON with `ots_anchored`/`ots_anchored_at`/`ots_block` via
   `gitrepo.commitProofUpgrade`, and emits the `proof_anchored` occasion on a
   fresh full-anchor transition. The schedule is the consumer's; the
   orchestration is the kernel's.
3. **Serialization invariant.** Every writer of `event.json` MUST emit
   `JSON.stringify(event, null, 2) + '\n'`. The repo's no-op-sync check is
   **byte-strict**: identical bytes ⇒ no commit. Any drift (indent, key order,
   trailing newline) produces spurious ledger commits. Enforced by convention +
   a regression test.

**Concurrency:** v1 relies on Postfix pipe-transport serialization
(`maxproc=1`, see archive/v1/docs/OPS.md) so only one delivery touches a repo at a time. The
kernel adds a per-event in-process mutex for non-pipe writers (edits,
activation).

---

## 6. Plaintext discipline (salted hashes)

mailproof never persists plaintext sender addresses, subjects, bodies, or raw
Message-IDs to the ledger — those live only in any email forwarded to the
organiser by a consumer. The ledger stores **salted hashes**:

```
salt              = event.salt              // 32-byte hex, public, per-event
sender_hash       = "sha256:" + sha256(`${salt}|${sender.toLowerCase()}`)
message_id_hash   = "sha256:" + sha256(`${salt}|${normalizedMessageId}`)
normalizedMessageId = messageId without surrounding <>, lowercased
```

A verifier re-hashes a *claimed* address with the event's public salt and
matches; a random observer cannot bulk rainbow-table across events because the
salt differs per event. `sender_domain` is kept plaintext (non-PII, useful for
at-a-glance audit).

**Pseudonymous, not anonymous — and durable by design.** Because the salt is
public and lives in the committed `event.json`, a `sender_hash` is *re-linkable*
to a guessed address; it is pseudonymized personal data, not anonymized. This is
deliberate: it is what makes the proof publicly, offline-verifiable. The records
are therefore **durable by design** — there is no per-record erasure (it would
rewrite the Merkle chain and the non-repudiation it carries; PRD §8.16). The
**only** erasure lever is coarse and opt-in: deleting an *entire* event removes
its repo and `event.json`, destroying that event's salt, after which any
residual exported hashes are unlinkable (whole-event crypto-shred). Privacy
rests on minimization (no plaintext at rest) + lawful retention, not deletion
(PRD §8.17 for the GDPR posture).

---

## 7. Outbound RFC-822 message

mailproof composes plaintext (`text/plain; charset=utf-8`, `8bit`) RFC-822
messages with **CRLF** line endings and submits them to the local MTA via
`sendmail(8)` (opendkim signs at the MTA — no Node-side crypto). Required
headers: `From`, `To`, `Subject` (CR/LF stripped to prevent header injection),
`Message-Id` (`<{ts}.{16-hex}@{domain}>`), `Date` (RFC-5322), `MIME-Version`,
`Content-Type`, `Content-Transfer-Encoding`. Threading replies set
`In-Reply-To`/`References`. Notifications set `Auto-Submitted` (RFC 3834:
`auto-generated` for pure notifications, `auto-replied` for responses).
Non-ASCII subjects are RFC-2047 encoded.
