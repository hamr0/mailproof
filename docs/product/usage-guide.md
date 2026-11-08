# mailproof - Usage Guide

The human-facing companion to the [Integration Guide](../../mailproof.context.md) (written for agents and the complete API contract). This is where the deployment patterns, the meaning of each outcome and the operational runbook live, so the README can stay an overview. Wire formats are in [SPEC Part B](SPEC.md); only look there for byte layouts.

## What a proof is

mailproof has two goals.

1. **Verify that an email really came from the sending address, now.** DKIM is always checked; DMARC, SPF and ARC are checked too when the sender publishes them. The result is the **live verdict**, decided at capture.
2. **Keep that verifiable later, offline, even after the sender's key leaves DNS.** At capture mailproof archives the sender's public key and stores a record of the signed headers in a git repo you own (the **trail**, one commit per record). Anyone can re-check the record years later from the record alone: that is the **portable verdict**. Optionally an OpenTimestamps stamp (`otsBin`) makes "captured no later than T" provable, because `captured` is otherwise mailproof's own clock.

A record never holds the body or the raw email. It holds the exact headers each DKIM signature covers, the signature, the archived key, both verdicts, attachment hashes and threading ids. If the body turns up later, `matchBody` checks it against the signed body hash (`bh=`).

What a record proves:

- The signature over the headers the sender signed (usually From, To, Subject, Date, Message-ID) was valid at capture time, against a key archived at capture.
- If the body turns up later, it hashes to the signed `bh=`.
- Attachment hashes are self-recorded at capture. They are tied to the signature only if the body is produced.

What it does not: proof of delivery, legal admissibility, or what a message means. A sender who never signs cannot be proven, and SPF can never be re-checked from stored data (the portable verdict is DKIM only).

## What mailproof stores about other people

Not legal advice.

Proof records contain personal data even without a body: email addresses, display names, CC lists, dates and subject lines. The subject is the riskiest, because it can carry sensitive content. It is usually inside the DKIM-signed headers, so it cannot be dropped without breaking offline verification.

**Today (2.2.0)** mailproof stores proofs only: signed headers, verdicts, archived keys and hashes. Never the body.

**Planned (M3, not built):** content (the raw email and attachments) is also stored locally by default and deleted after 730 days unless you configure otherwise. Proofs are permanent. Prune-before-date is the tool for a proof retention policy.

Whoever runs mailproof keeps that data and is responsible for it. An individual using it for personal purposes is generally outside GDPR-style rules. A business keeps records as evidence, which is a recognised lawful purpose (the right to erasure has an exception for data needed to establish or defend legal claims). It still needs a stated purpose and a retention policy.

## Which surface do I use

| You want | Use |
|---|---|
| A one-off verdict on an email, nothing written | `mp.check(raw)` |
| Record each mail your own pipeline receives (for example a Postfix pipe) | `mp.record(raw, { direction, source, envelope })` |
| Re-check a record later, offline, or verify an exported record with no trail | `mp.verify(id)` / `verifyRecord(record)` |
| Check a body or an attachment you produce later | `mp.matchBody(id, raw)` / `mp.matchFile(id, bytes)` |
| Read what the sender newly wrote in a recorded reply | `mp.replyText(raw)` |
| Capture a mailbox over IMAP, read-only | `mp.sync({ host, user, auth, ... })` |
| Capture a mailbox on a schedule | the `mailproof-sync` CLI under cron or a systemd timer |
| Let an AI agent discover and call the library | `primitives.json` (a machine-readable menu of the 14 primitives, also at `unpkg.com/mailproof/primitives.json`) plus `mailproof.context.md` |

```js
import { Mailproof } from 'mailproof';

const mp = new Mailproof({ trailDir: './trails' });         // a git repo per trail
const { id } = await mp.record(rawEmailBytes, { direction: 'in', source: 'imap' });
await mp.verify(id);                  // offline, from the record alone
await mp.matchBody(id, rawEmail);     // body hash vs the signed bh= -> "full proof"
await mp.check(emlBytes);             // one-off: verdicts only, writes nothing
```

`check` and `record` never throw on unverifiable mail; it comes back (or is recorded) as `unverified`. Every inbound mail is recorded, even unsigned or over a limit: limits and trust gate the verdict, never the record.

## Two verdicts, trust levels, body status

| Verdict | Decided | Inputs | Re-checkable later |
|---|---|---|---|
| live | at capture | DKIM + DMARC + SPF + ARC | no (SPF) |
| portable | at capture, recomputable by anyone | DKIM signatures in the record | yes |

Trust levels: `verified` (aligned DKIM pass, and DMARC pass if the domain publishes DMARC), `forwarded`, `authorized` (live only; needs an SMTP envelope, which IMAP capture does not have), `unverified`. Each verdict carries its engine/rules version. `x=` / `t=` signature expiry is judged as of capture time, and a bad capture time fails closed.

`body_status` is a separate field on every record (and per signature): it says whether the body is covered by the signature. It never changes a trust verdict, so a verified verdict means "the signed headers are authentic", not "the body is intact".

| `body_status` | Meaning |
|---|---|
| `matched` | The body hashes to the signed `bh=`: full proof. |
| `partial` | The signature has `l=` and covers only a prefix of the body. |
| `mismatch` | The body does not hash to `bh=`; it was altered after signing (`explain` hints at why when it can be told). |
| `not-checked` | Nothing to check: unsigned mail, over limit, or your own Sent copy. |

`explain` entries are counts and domains only: `l_tag`, `appended`, `prepended`, `canonicalisation`, `line_endings`, `forwarded`, `mailing_list`, `search_capped`, `unknown`.

## Reading a reply: what each outcome means

`replyText(raw)` takes a reply you already recorded and returns only what the sender newly wrote (quoted history removed), so a reply that merely quotes "Approve payment of $5,000?" is not read as an approval. Its stripper is versioned and deterministic: anyone with the raw email re-runs it and gets the same text and the same `text_sha256`. mailproof never interprets the words; that is the consumer's job.

**Privacy note.** The trail stores no reply text, only its `text_sha256`. For a short reply ("yes", "approve", "no") that hash can be recovered by hashing candidate words, so the trail is as private as the people who can read it: whoever can read it can confirm a guessed short answer. Keep the trail readable only by those you would trust with the replies themselves.

**Is the text proven (`proven`)?** `proven` is true only when `body_status` is `matched` and the text came from a `text/plain` part.

| Outcome | `proven` | What it means |
|---|---|---|
| body `matched` | true | The words are exactly what the signing server sent. |
| body `partial` | false | Only an `l=` prefix is signed; the rest could be anything. Text is returned, flagged. |
| body `mismatch` | false | The body was altered after signing (commonly Outlook/Exchange-received mail, below). Text is returned, flagged. |
| body `not-checked` | false | Unsigned, over limit, or your own Sent copy. Text is returned, flagged. |
| `source: 'html-only'` | false | No `text/plain` part; nothing is extracted (`text` is empty). |

**Where is the quote (`quote`) and what is below it (`trailing`)?**

| Field | Meaning | What to do |
|---|---|---|
| `quote: 'found'` | A quote boundary was cut; `text` is what sits above it. | Normal case. |
| `quote: 'not-found'` | No boundary; the whole body is returned, never a guess. | A human reads it. |
| `quote: 'inline'` | The answers are written inside the quote; not merged. | A human reads it. |
| `trailing: true` | Unquoted text follows the quote (a signature, or bottom-posted text) and is NOT in `text`. Signatures are not stripped. | Read the raw mail if it matters. |

**What stays proven when the body is not.** The sender domain and the signed headers still verify (the portable verdict is unaffected). Threading, "this sender replied to that email" via `In-Reply-To`, is proven only when the signer covers `In-Reply-To` in its signed headers: Gmail does, Microsoft does not. So a Gmail-signed reply keeps its threading proof even when its body is altered, and a Microsoft-signed reply never has it, even when its body matches. The words are proven only when `proven` is true.

**The receiving rule.** Where the mail is received decides whether the body survives:

- Mail received at Gmail keeps its body intact whoever sent it (checked on every Gmail-received sample, including mail sent from Outlook).
- Mail from outside received at Outlook/msn is altered by Microsoft after signing (`mismatch` on every such sample), so its words are unproven. The headers still verify.
- Mail sent from msn to msn matched once. That is a hint that Microsoft alters only mail from outside, not a rule.

So replies whose words matter should be received at Gmail (or another mailbox that does not alter bodies) and captured with `sync`.

**Decision rule for a consumer.**

- `proven: false`: show the text to a human; do not act on it alone.
- `trailing: true`: there is more below the quote; read the raw mail if it matters.
- `quote: 'not-found'` or `'inline'`: a human reads it.
- Otherwise (`proven`, `quote: 'found'`, not `trailing`): the text is the sender's new words and is provably from that signed email; interpreting them is yours.

Show the text you acted on: its hash matches `text_sha256` in a commit dated before the action. One small `reply-text` record (hash, byte count, flags, `body_status`, time; never the text, body or subject) is committed to `replies/<id>.mailproof-quote-1.json`; the same message again is `duplicate: true` and writes nothing. Errors: `ERR_NOT_RECORDED` (record the message first), `ERR_OVER_LIMIT` with `err.limit` (nothing written), `ERR_TRAIL_LOCKED`.

Known limits of the stripper: it is tested on English-style attributions and Outlook/Foxmail header blocks; the name after the verb (`... schreef Amr <a@x>:`) and, above a `>` run, any language's attribution line (ends in `:` with a year, hh:mm or `@`) are cut. A quote without `>` marks in a language whose verb is not listed falls through to `not-found`. Apple Mail and html-only replies are not covered by real samples.

## Capture over IMAP (`sync`)

`sync` reads one mailbox, read-only, and records every message in it (INBOX as `in`, the Sent folder as `out`). It uses implicit TLS with the certificate always checked (only `tls: { ca }` can be added), `EXAMINE` and `BODY.PEEK`, so nothing is marked seen, moved or deleted.

```js
const res = await mp.sync({
  host: 'imap.gmail.com', user: 'you@gmail.com',
  auth: { pass: process.env.APP_PASSWORD },        // or { accessToken } (OAuth2; you obtain and refresh the token)
  folders: ['INBOX'], sent: true,                  // sent: true finds the \Sent folder; a string is a path; false skips it
});
// res.complete, res.folders[i].{ recorded, duplicate, over_limit, skipped, error, last_uid }
```

- **Resuming.** A capped run (1,000 messages or 512 MiB per folder, 30 minutes per call) is continued by calling again until `res.complete` is true. A resume cursor lives in `<trailDir>/.<trail>.sync.json`, beside the trail and not in git. A trail restored from an older backup or replaced is detected from the cursor (it records the trail's HEAD) and rescanned (`reset: 'trail'`, no manual step); the same bytes are never recorded twice.
- **Size.** Mail over 25 MiB is stream-hashed and recorded `over limit: total_bytes`; over 128 MiB it is listed in `skipped`.
- **Sent copies.** A provider's Sent copy is normally unsigned, so it is recorded `unverified`; the counterparty's signed copy is the proof.
- **OpenTimestamps.** Leave it off for a backfill.
- **Locking.** A second `sync` on the same trail while one runs throws `ERR_SYNC_LOCKED` at once. `sync` holds `<trailDir>/.<trail>.sync.lock` for the whole call but never holds the trail lock across IMAP I/O, so a pipe delivery during a backfill waits behind at most one message's commit.
- **Errors.** A TypeError for bad options; otherwise only `ERR_IMAP_AUTH`, `ERR_IMAP_CONNECT` or `ERR_SYNC_LOCKED` are thrown. Everything else is in a folder's `error`: `ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`, `ERR_TRAIL_LOCKED`. The first trail error stops the run. The credential is never logged, returned or stored.
- There is no envelope on IMAP, so `authorized` cannot occur.

Details: [SPEC B4](SPEC.md).

## Run on a timer (`mailproof-sync`)

`mailproof-sync` (shipped as `bin/mailproof-sync.js`, on `PATH` after `npm i mailproof`) is one `sync` run for cron or a systemd timer. It reads the password from a command, a file or stdin, never from a flag or a plain env value, and prints one JSON line (the sync result, no secret) on stdout and errors on stderr.

```bash
mailproof-sync --trail-dir /var/lib/mailproof --user you@gmail.com \
  --pass-command "pass show mailproof/gmail_pass"      # host imap.gmail.com, folders INBOX, sent on
```

Flags (env fallback `MAILPROOF_<NAME>`): `--trail-dir`, `--trail`, `--host`, `--port`, `--user`, `--folders a,b`, `--sent on|off`, `--pass-command` (split into arguments, run without a shell; first stdout line is the password), `--pass-file`, `--access-token-command` (OAuth2 XOAUTH2). With none of the secret sources, the password is read from stdin. Spaces are stripped only from Google's app-password display shape (four groups of four lowercase letters, `abcd efgh ijkl mnop`); any other password is sent as given, minus leading and trailing whitespace and the line ending.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Finished. A run cut short by a cap also exits 0 with `"complete": false` and no error: the next run continues from the cursor. |
| `75` | Try later: `ERR_SYNC_LOCKED` or `ERR_TRAIL_LOCKED`, server unreachable, timeout, throttled. |
| `77` | Login refused. |
| `64` | Bad usage. |
| `1` | Anything else. |

`~/.config/systemd/user/mailproof-sync.service`:

```ini
[Unit]
Description=mailproof IMAP capture

[Service]
Type=oneshot
ExecStart=/usr/bin/env mailproof-sync --trail-dir %h/mailproof-trails --user you@gmail.com --pass-command "pass show mailproof/gmail_pass"
SuccessExitStatus=75
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=%h/mailproof-trails
ProtectHome=read-only
```

`~/.config/systemd/user/mailproof-sync.timer` (then `systemctl --user enable --now mailproof-sync.timer`):

```ini
[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

For a system unit add `User=mailproof`. `ProtectHome=read-only` keeps the `pass` store readable; the trail directory needs `ReadWritePaths` because `ProtectSystem=strict` makes everything else read-only. `SuccessExitStatus=75` keeps an overlapping or temporarily unreachable run from marking the unit failed. Equivalent cron line:

```cron
*/15 * * * * mailproof-sync --trail-dir $HOME/mailproof-trails --user you@gmail.com --pass-command "pass show mailproof/gmail_pass" >> $HOME/mailproof-sync.log 2>&1
```

## Worker thread and deadline

`check()` and `record()` parse and verify in a warm worker thread; the commit, the lock and git stay on your thread. The thread is killed, and the message recorded `unverified` as `over limit: time` or `over limit: memory`, when one message uses more than 15 s of the thread's CPU, 120 s of busy wall time (DNS waits excluded) or 1,536 MB of memory. It backs up the input limits, which stay the first line. Waiting in the queue behind other messages does not count. If the thread dies for any other reason, the message is recorded `over limit: crash` and the next one gets a fresh worker. A worker that cannot start at all (before it is ready) rejects the call instead, and nothing is recorded.

DNS: a lookup your `resolver` (or the system one) has not answered within 5 s is answered as a DNS error (`dns timeout`, `code: 'ETIMEOUT'`), and all the lookups of one message together may wait at most 30 s, after which further lookups fail at once the same way. A resolver that never settles therefore delays one message by about 30 s, not forever. Your resolver must return plain data, as `node:dns` does; anything else is answered as a DNS error (`resolver returned a non-plain value`, `code: 'EBADRESP'`) rather than crashing the process.

```js
new Mailproof({ trailDir, worker: { size: 1, cpuMs: 15000, wallMs: 120000, maxMemoryMb: 1536 } });  // the defaults
new Mailproof({ trailDir, worker: { size: 0 } });   // no worker: build in-process, no backstop
await mp.close();   // optional: idle workers do not keep your process alive
```

Cost: the first call starts the thread, which loads the parsers (roughly 0.4 to 1 s of wall time and 0.7 s of CPU extra for a program that handles one mail and exits; use `size: 0` there). Warm, a call costs about the same as in-process. Instances with the same options share their workers. With a worker, a `record()`/`check()` still running when `close()` is called (or when the last instance sharing the pool closes) may reject, and if it rejects that message is not recorded: await in-flight calls first.

## Input limits

A message over an input limit is still recorded, but never parsed or verified: `unverified`, `reason: 'over limit: <name>'` on both verdicts. The limits are: more than 25 MiB; a header block over 256 KiB, 4,000 header lines or 1,000 header fields; more than 10 DKIM-Signature headers (so a message whose only valid signature is the 11th is not verified), 200 names in one `h=` or a signature field over 16 KiB; more than 200 MIME delimiter lines; a body line over 256 KiB; more than 500,000 body lines. A message that stays under those limits but costs more than the worker budget above is recorded `over limit: time` / `memory` / `crash`. Other recorded-but-weaker cases: an unsigned email is `unverified`; a signature with `l=` leaves part of the body unsigned (flagged `partial_body`); a signature whose key is gone from DNS at capture is stored with `key_error` and cannot verify. Only `envelope.clientIp`, `clientHelo` and `sender` are read, each a string or `null`; any other type is treated as `null`. The limits are listed in [SPEC Part B (Limits)](SPEC.md).

## Concurrency, locks and recovery

A trail has a single writer at a time, enforced by a lock file (`<trailDir>/.<trail>.lock`) that also covers separate processes; local filesystems only. A writer that cannot get the lock within `lockTimeoutMs` (default 30000) throws an error with `code: 'ERR_TRAIL_LOCKED'` and writes nothing. Postfix pipe consumers should map `ERR_TRAIL_LOCKED` to exit code 75 (`EX_TEMPFAIL`) so Postfix retries the mail.

`records/` and `keys/` are library-managed. After a crash, uncommitted files mailproof itself wrote there are cleaned up on the next write; other files are left alone, but do not keep your own files in a trail.

**Recovery.** If `ERR_TRAIL_LOCKED` persists and no writer is running (check the `pid` and `host` in `<trailDir>/.<trail>.lock`), delete that file, and `.<trail>.lock.break` if present. A lock from another host is never taken over automatically, including after a hostname change or from a killed container on a shared volume; shared volumes across hosts are unsupported beyond that manual step.

## Listing and the trail index (`list`, `copies`)

`list` and `copies` read a rebuildable SQLite index kept beside the trail (`<trailDir>/.<trail>.index.sqlite`, not in git, safe to delete). It is opened for each call and closed before the call returns, so no handle stays open between calls (and `close()` has nothing to do for it). It is built on the first call, then caught up from the trail's git HEAD on the first call after a `record()`. While it catches up, these calls wait on the trail lock (`ERR_TRAIL_LOCKED` after `lockTimeoutMs`). If the `better-sqlite3` native addon cannot load on your platform, they reject with `code: 'ERR_INDEX_UNAVAILABLE'` (there is no fallback). A first build (or a rebuild) of a trail with more than about 350,000 records rejects with `code: 'ERR_INDEX_REBUILD'` (the list of committed records, or of the changes since the last call, outgrows a 16 MB git output limit). `record`, `get`, `verify`, `matchBody`, `matchFile`, `replyText` and `sync` never need it. Equal `captured` values come in ascending id order. The index is navigation, not proof: re-check with `verify`.

`copies(idOrKey)` returns every recorded copy of one signed message. The id is the hash of the raw bytes, so a list-relayed or forwarded copy is its own record; `message_key` groups them, and each record carries `copy: { kind: direct|relayed|forward|digest|unknown, evidence }`.

## Requirements

- Node >= 22.19 (the CPU deadline needs `Worker#cpuUsage`); pure ESM (`import`, no `require`).
- The `git` binary on `PATH` (the trail is a git repo; mailproof calls `git` directly).
- Four runtime dependencies: `mailauth` (DKIM/DMARC/SPF/ARC verification), `mailparser` (MIME parsing), `imapflow` (used only by `sync`) and `better-sqlite3` (used only by `list` and `copies`, for their index). The optional `ots` binary is needed only if you turn OpenTimestamps on.
- Trail names match `/^[a-z0-9][a-z0-9_-]{0,63}$/`; record ids are 32 hex characters.
