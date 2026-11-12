# mailproof - Usage Guide

The human-facing companion to the [Integration Guide](../../mailproof.context.md) (written for agents and the complete API contract). This is where the deployment patterns, the meaning of each outcome and the operational runbook live, so the README can stay an overview. Wire formats are in [SPEC Part B](SPEC.md); only look there for byte layouts.

## What a proof is

mailproof has two goals.

1. **Verify that an email really came from the sending address, now.** DKIM is always checked; DMARC, SPF and ARC are checked too when the sender publishes them. The result is the **live verdict**, decided at capture.
2. **Keep that verifiable later, offline, even after the sender's key leaves DNS.** At capture mailproof archives the sender's public key and stores a record of the signed headers in a git repo you own (the **trail**, one commit per record). Anyone can re-check the record years later from the record alone: that is the **portable verdict**. Optionally an OpenTimestamps stamp (`otsBin`) makes "captured no later than T" provable, because `captured` is otherwise mailproof's own clock.

A record never holds the body or the raw email (the optional local content store keeps the raw email beside the trail, outside the record: see "What mailproof stores about other people"). It holds the exact headers each DKIM signature covers, the signature, the archived key, both verdicts, attachment hashes and threading ids. If the body turns up later, `matchBody` checks it against the signed body hash (`bh=`).

What a record proves:

- The signature over the headers the sender signed (usually From, To, Subject, Date, Message-ID) was valid at capture time, against a key archived at capture.
- If the body turns up later, it hashes to the signed `bh=`.
- Attachment hashes are self-recorded at capture. They are tied to the signature only if the body is produced.

What it does not: proof of delivery, legal admissibility, or what a message means. A sender who never signs cannot be proven, and SPF can never be re-checked from stored data (the portable verdict is DKIM only).

## What mailproof stores about other people

Not legal advice.

Proof records contain personal data even without a body: email addresses, display names, CC lists, dates and subject lines. Since M3 every record also lists the addresses on its From, To, Cc and Reply-To lines (`addresses`), including the ones no signature covers (marked `signed: false`), so a person who was only copied on an email is in your permanent record. `forget` removes stored content, never this list. The subject is the riskiest, because it can carry sensitive content. It is usually inside the DKIM-signed headers, so it cannot be dropped without breaking offline verification.

**Proofs (git)** hold signed headers, verdicts, archived keys, hashes and addresses. Never the body.

**Content (since 3.0.0):** content (the raw email and attachments) is also stored locally by default, beside the trail and outside git (`<trail>.content/`, owner-only files), and deleted 730 days after the record's `captured` time unless you configure `content.days` (`sync()` checks at most every `content.sweepDays` days, default 7, so content lives between `days` and `days + sweepDays`; `expireContent()` runs it on demand). `forget` deletes the stored content of one email, a list, or everything with one correspondent, now. Proofs stay permanent unless you prune: `prune({ before })` removes every record captured before a date, with its stored content (it rewrites history; the old trail is kept as `<trail>.pre-prune-<date>` until you delete it, or pass `deleteBackup: true`). `content: { store: false }` turns the store off.

Whoever runs mailproof keeps that data and is responsible for it. An individual using it for personal purposes is generally outside GDPR-style rules. A business keeps records as evidence, which is a recognised lawful purpose (the right to erasure has an exception for data needed to establish or defend legal claims). It still needs a stated purpose and a retention policy.

## Which surface do I use

| You want | Use |
|---|---|
| A one-off verdict on an email, nothing written | `mp.check(raw)` |
| Record each mail your own pipeline receives (for example a Postfix pipe) | `mp.record(raw, { direction, source, envelope })` |
| Re-check a record later, offline, or verify an exported record with no trail | `mp.verify(id)` / `verifyRecord(record)` |
| Give a counterparty the proof of what you exchanged, or check one you were given | `mp.export({ with, out })` / `verifyBundle(dir)`; CLI `mailproof export`, `mailproof verify-bundle` |
| Check a body or an attachment you produce later | `mp.matchBody(id, raw)` / `mp.matchFile(id, bytes)` |
| Read what the sender newly wrote in a recorded reply | `mp.replyText(raw)` |
| Read the facts of every signed reply to a request you sent (who, whether it is aligned and signed, the first line) | `mp.replyFacts({ messageId })`; or every reply one person sent: `mp.replyFacts({ address: 'bob@example.org' })` |
| Seal what was recorded since the last run (manifest, stamp, upgrade) | `mp.stamp()` (`mailproof stamp`) |
| Fold pending OpenTimestamps stamps into their Bitcoin attestation | `mp.upgradeStamps()` |
| Capture a mailbox over IMAP, read-only | `mp.sync({ host, user, auth, ... })` |
| Capture a mailbox on a schedule | the `mailproof-sync` CLI under cron or a systemd timer |
| Let an AI agent discover and call the library | `primitives.json` (a machine-readable menu of every primitive, also at `unpkg.com/mailproof/primitives.json`) plus `mailproof.context.md` |

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
- **OpenTimestamps.** On by default and batched: a backfill makes one manifest and one `ots stamp` per due run, never one per message (the old advice to leave it off is withdrawn). The calendars get one 32-byte hash per run; `"ots": false` turns it off.
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

Flags (env fallback `MAILPROOF_<NAME>`): `--trail-dir`, `--trail`, `--host`, `--port`, `--user`, `--folders a,b`, `--sent on|off`, `--pass-command` (split into arguments, run without a shell; first stdout line is the password), `--pass-file` (owned by you, mode 0600, else refused), `--access-token-command` (OAuth2 XOAUTH2). With none of the secret sources, the password is read from stdin. Spaces are stripped only from Google's app-password display shape (four groups of four lowercase letters, `abcd efgh ijkl mnop`); any other password is sent as given, minus leading and trailing whitespace and the line ending.

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

## What leaves your machine

Three things use the network, each with an off switch: IMAP (`sync`: your login and read-only requests, to your mail provider), DNS (the sender's DKIM, DMARC and SPF records, at capture), and the OpenTimestamps calendars (the stamp job: one 32-byte hash of a manifest per run, at most every `stamp.everyHours`; the calendars see your IP address and the timing, never content, subjects or addresses; off with `otsBin: null` or `"ots": false`). `record()`, `check()`, `verify()` and every read never contact the calendars. The full table is in the README.

## The `mailproof` command

`mailproof` (`bin/mailproof.js`, on `PATH` after `npm i -g mailproof`) is the whole library from a terminal. With no arguments on a terminal it shows a grouped menu (every command, numbered 1 to 19, one line of help each; pick by number or name); every menu item is also a subcommand (`check .eml` is the library `check` on a file), and both run the same code. Menu item 4 (list) is a browser: it asks only `Who (address, empty = everyone)`, then shows the latest 5 emails, newest first, three lines each (when, age, verdict, who; the subject, with `· subject not signed` when no verifying signature covers it; a short reason such as `verifies`, `no DKIM key in DNS` or `signature fails`, plus the attachment count; the full sentence is in the opened email) with `N of TOTAL` below; the menu never clears the screen: each screen opens with a dim path line (`── mailproof › 4 list › bob@example.org › #3 › v verify ──`) and one sentence saying what the screen is for, and a dim rule separates the result from the options below it, so you can tell in the scrollback where you were; every question backs out on an empty answer or `q`, and what mailproof writes for you (exports, backups, a saved attachment) goes under `~/mailproof/exports/`, `backups/` and `saved/`; `m` shows the next 5, `f` filters (role, direction, after, before), `s` searches the subject, a number opens that email (the same text as `show <id>`) with `r` raw email, `a` save attachment (never over an existing file, mode 0600), `v` verify again, `t` thread (the parent and direct replies with their signed or unsigned link) and `p` this person (their row and their latest 5, then `11 export`); Enter goes back one level. `mailproof help` lists the commands, `mailproof help <command>` describes one (the text is the library's own JSDoc). SPEC B11 is the contract.

**1. Describe your mailbox once.** `mailproof config add-account` asks for the account name, IMAP user and host, folders, where the trail lives, and where the password comes from, with a hint and a default for each (`?` shows the hint). It shows the account JSON and writes `~/.config/mailproof/config.json` (mode 0600) only after you answer yes; other accounts in the file are kept, and an existing name is replaced only after a confirmation. It never asks for the password: you name a command that prints it (`pass show mailproof/personal`), a file whose first line is it (owned by you, mode 0600, or it is refused), or a command that prints an OAuth2 token. `mailproof config template` prints an example; `mailproof config validate` checks the file without reading any secret. The file must be owned by you and mode 0600 or no command runs (exit 77); unknown keys and a plaintext `password` key are refused (exit 64).

**2. Capture.** `mailproof sync --account personal` reads the mailbox read-only, records every message, runs the content sweep and, unless `"ots": false`, the stamp job when it is due (every `stamp.everyHours`, default 6): one manifest of file hashes, one OpenTimestamps stamp, and the upgrade of older pending proofs (`mailproof stamp` runs it now; a trail filled only by the Postfix pipe should run `mailproof stamp` from cron). With one account `--account` is optional; with several it is always required (nothing runs on "all accounts"; only `status` lists them all). `mailproof watch` repeats that every `--interval` (default 5 minutes, minimum 30 s) in the foreground: transient errors back off (doubling, up to 1 hour), a refused login stops it (exit 77), Ctrl-C or SIGTERM finishes the sync in progress and exits 0. There is no daemon; let your init system run it.

systemd (`~/.config/systemd/user/mailproof-watch@.service`; then `systemctl --user enable --now mailproof-watch@personal`, and `loginctl enable-linger $USER` to keep it running when you are logged out):

```ini
[Unit]
Description=mailproof watch %i

[Service]
ExecStart=/usr/bin/env mailproof watch --account %i
Restart=on-failure
RestartPreventExitStatus=77 64
```

cron instead of a loop (exit 75 on a held lock is normal; the next run continues from the cursor):

```cron
*/5 * * * * mailproof sync --account personal --json >> $HOME/.local/state/mailproof/personal/cron.log 2>&1
```

**3. Look.** `mailproof list [--with <address>] [--role from|to|cc|reply-to] [--direction in|out] [--subject <text>] [--before <date>] [--after <date>] [--limit n]` (newest first; `--subject` is a case-insensitive piece of the subject; dates are `YYYY-MM-DD` in UTC or a full ISO time), `mailproof people` (who is in the trail), `mailproof show <address|<message-id>|id>` (an address lists every email naming it, each with the same labelled lines, `N/A` where absent; `--after/--before/--limit/--full`; a record id shows one record in full; `--raw` prints the stored email), `mailproof replies <messageId>`, `mailproof status` (records, last sync, content size, index, pending stamps, last backup, whether a watch runs). An id is 32 hex characters or a unique prefix of at least 8.

**4. Check.** `mailproof verify <address|<message-id>|id> [--at <date>] [--all]` re-checks offline: for an address it checks every email naming it and the exit code follows the RECEIVED ones (your own Sent copies are normally unsigned, so they are counted apart unless `--all`): exit 0 when they all verify, **2** when one does not or none was received; for an id, exit 0 when it verifies, **2** when it does not. `mailproof check <id> --profile <file|name> [--parent <messageId>]` runs a trust profile (a JSON file, or a name looked up in `~/.config/mailproof/profiles/<name>.json`): exit 0 pass, 2 fail with the failed rules. Exit 2 means "the check ran and the answer is no", so a script can branch on it.

**5. Delete on purpose.** `mailproof forget <id>... | --with <address> [--before d] [--after d]` deletes stored mail content only; the proofs stay. `mailproof prune --before <date>` rewrites the trail without everything older. Both print a dry-run summary first and refuse to act without `--yes` (exit 64); `--dry-run` prints the summary and stops. In the menu you type the account name instead. A prune keeps the old trail as `<trail>.pre-prune-<date>` beside it until you delete it (or pass `--delete-backup`).

**6. Back up, and restore.** `mailproof backup` writes a git bundle of the whole trail (records, keys, replies, stamps; never message bodies) to `~/mailproof/backups/<account>-<UTC time>.bundle` and prints the path; `--out <path>` chooses it (never overwrites, and an existing `<file>.content.tar` is refused too). `--with-content` adds `<file>.content.tar` made by the `tar` binary: that is other people's mail and it is **not encrypted**, so encrypt the file or the disk. Restore the proofs with `git clone <file>.bundle <trailDir>/<trail>` and point the account at it; the next `sync` rescans the mailbox from the start and skips what it already has. Restore the content with `tar -C <trailDir>/<trail>.content -xf <file>.content.tar`. `--push` also pushes the trail to the account's `backupRemote` (a plain remote such as `git@host:path`: a URL with a token in it is refused, use a credential helper or an ssh key; needs `--yes`, prints a warning that proof records hold sender and recipient addresses, subjects and dates). It **never forces**: after a `prune` the history is rewritten, the remote refuses the push and keeps the pre-prune history as an archive; push to a new remote or force it yourself outside mailproof if you mean to replace it.

**7. Hand someone the proof (`export`), and check one you were handed (`verify-bundle`).** `mailproof export --with bob@example.org[,bob@work.example] [--after <date>] [--before <date>] [--out <dir>] [--tar]` writes a bundle: a directory (default `~/mailproof/exports/mailproof-bundle-<account>-<UTC time>`; `--tar` also packs it into one file) holding, for every email that names any of those addresses on From, To, Cc or Reply-To, the proof record (signed header lines, signatures, the sender's public key as fetched at capture) and the seal files it needs, plus a `README.txt` for the recipient. It holds no email bodies or attachments, and the new directory is private (0700/0600). Run `mailproof stamp` first, so the seals are as far along as they can be; export never stamps, it warns when some are pending or missing. `export --dry-run` (and the menu, before it asks `Write it?`) first previews the emails and what the bundle reveals and writes nothing. The result says `saved to ~/mailproof/exports/...` and prints the `sha256`: tell the recipient that number by another channel (the cover email). The recipient runs `mailproof verify-bundle <dir-or-.tar> [--expect <sha256>] [--strict]` (the `.tar` that `--tar` wrote is checked directly, unpacked into a private temp folder that is removed afterwards) (or `npx mailproof verify-bundle`), with no account and no network: exit 0 when it checks out, **2** when something does not. Install `opentimestamps-client` on the recipient side for the seals to be checked (`MAILPROOF_OTS=off` skips it). What it proves, plainly: each signed header set was signed by the sender's domain; each record existed no later than its seal. `anchored` means a Bitcoin block attestation is in the proof for exactly those bytes; the block header itself is not checked (use `ots verify`). It does not prove completeness (you chose what to include), the content of any email, or when mail was received. Sharing the bundle shares the addresses and subjects in it, and shows that other records existed (their number and sealing times, never their content).

**8. Update.** `mailproof update` prints `npm install -g mailproof@latest`; `mailproof update --run` runs it. In the menu, Update asks `Run it now? [y/N]`.

**Safe to print.** Text output is terminal-safe: control characters, bidi overrides and zero-width characters in a sender's headers are shown as escapes like `\x1b` or `\u202e` (a backslash is `\\`), so a mail cannot move your cursor or retitle your terminal. `--json` is data as received: treat its strings as untrusted. `show --raw` prints the stored bytes unchanged.

**Scripting.** `--json` prints exactly one JSON document on stdout (`watch` prints one line per tick); errors go to stderr and stdout stays empty, so check the exit code first. Exit codes: 0 done (a partial sync is still 0), 2 a check ran and the answer is no, 64 bad usage, 75 try again later (lock held, server unreachable, throttled, secret command failed), 77 permission (config mode) or a refused login, 1 anything else. `mailproof-sync` stays available for a single run from flags and the environment; it shares the secret handling and exit codes.

## AI agents: the MCP server (`mailproof mcp`)

`mailproof mcp` is a stdio MCP server over the same accounts and config as the CLI (SPEC B12). Register it once:

```bash
claude mcp add mailproof -- mailproof mcp                      # every account in the config, one server
claude mcp add mailproof-work -- mailproof mcp --account work  # one server per account, so each gets its own rules
```

or put `{ "command": "mailproof", "args": ["mcp"] }` under `mcpServers` in `.mcp.json`. In the menu, item 19 (`mcp`) does it for you: it shows whether `mailproof` is registered in Claude Code, the `mailproof` binary on your PATH, the config file, `mcp.log`, the input and output folders in effect (`~/mailproof` and its `exports`, `backups` and `saved` unless the config sets `mcp.inputDirs` and `mcp.outputDir`), says in plain words where it is registered (`registered for all your projects (user scope)`), and offers, when not registered, `1 install in Claude Code` (`claude mcp add --scope user mailproof -- mailproof mcp`); when registered, `1 reinstall` (remove, then add) and `2 uninstall` (`claude mcp remove --scope user mailproof`), each after a `[y/N]`, and `3 other clients`: the same JSON block (`{"mcpServers":{"mailproof":{"command":"mailproof","args":["mcp"]}}}`) printed and saved to `~/mailproof/mcp/mcp.json`; copy it into your client's config (most clients use an `mcpServers` block). mailproof never edits another program's config file. Without the `claude` command the screen says so and shows the same block. Every account-bound tool takes `account` (optional with one account, required with two or more; the names are an enum in the schema); `accounts` lists them (names and paths, no secrets).

**Tools** (named like the library methods): read `accounts`, `status`, `list`, `get`, `describe`, `copies`, `counterparties`, `linked`, `verify`, `verifyWith`, `verifyRecord`, `verifyBundle`, `proofParts`, `checkProfile`, `profiles`, `replyFacts`, `matchBody`, `matchFile`, `rawEmail`, `attachment`, `check`; write `record`, `replyText`, `sync`, `stamp`, `upgradeStamps`, `export`, `backup`; destructive `forget`, `prune` (30 in all, parity with the CLI; `watch`, `config add-account`, `help` and `mcp` are not tools). All are always listed; there is no read-only switch. Results are JSON text; ids may be a unique prefix of 8+ hex.

**Scoping: do it by tool name.** Each tool carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, but **Claude Code (2.1.322, measured, findings F30) does not act on them**: it refuses every MCP tool that is not allowed, read-only ones included, and once `forget` is allowed it runs it. Allow what you want by name, for example `--allowedTools 'mcp__mailproof__list' 'mcp__mailproof__get' 'mcp__mailproof__replyFacts'`, and leave `forget`, `prune`, `sync`, `record`, `rawEmail` and `attachment` out unless you mean it (`rawEmail` and `attachment` hand over other people's mail although they are read-only). A client with a hint-based policy can use the annotations directly.

**Known limits.** The hints are advisory metadata; no current client enforces them. To scope in Claude Code use per-tool allow rules by name, or one server per account (`mailproof mcp --account <name>`). The preview-then-`confirm: true` step is the only server-side guard for `forget` and `prune`; if your client allows every tool, a model can run them after a preview. On shutdown the server waits 5 s for in-flight calls, but a call still blocked in I/O can keep the process alive until its own timeout (measured: a `sync` stuck connecting held it 29.7 s, the 30 s `SYNC_CONNECT_MS`; worst case `SYNC_SOCKET_MS`, 5 min); MCP clients normally kill the child.

**Export and backup.** `export` (a proof bundle for a counterparty) and `backup` (a git bundle of the trail, optionally the content store and a push to the account's `backupRemote`) return a preview until called with `confirm: true`: the export preview lists the emails it would include and says what the bundle discloses (the addresses and subjects of the exchange, the signed headers and keys; bodies are not copied; completeness is not proven). Both write only into the CLI's own folders (`~/mailproof/exports` and `~/mailproof/backups`, or the config's `mcp.outputDir`), under a plain name you give, never a path, and never overwrite. `verifyBundle` checks a bundle folder or `.tar` from under `~/mailproof` (or `mcp.inputDirs`). `checkProfile` takes a profile by name (`default`, or a file in your profiles folder; `profiles` lists them with one line each) or inline, and `status` returns the same counts as `mailproof status`, plus how mailproof is installed (`install`: `dev-link` or `npm`).

**Deleting.** `forget` and `prune` delete nothing unless called with `confirm: true`; without it they return `{ executed: false, preview, next }` (the library's own dry run). This makes the model show you the plan; it is not a human gate, because a model can pass `confirm: true` itself. The gate is your client's allow list.

**Files in and out.** A tool that takes an email or a file takes `base64` (the exact bytes) or an absolute `path`. Paths are read only from under `~/mailproof` (the folder the CLI writes into) unless the config says otherwise: `"mcp": { "inputDirs": ["~/Downloads"], "outputDir": "~/mailproof-out" }` replaces the defaults, and `"inputDirs": []` with `"outputDir": null` turns path reading and all writing off (symlinks out of the folders, directories and FIFOs are refused). Before 3.4.0 both were off until set. `rawEmail` and `attachment` return the bytes as an embedded blob (Claude Code saves it to a file and tells the model the path) up to `maxBinaryBytes` (default 1 MiB); for anything larger, or to put the file where you want it, pass `saveTo` (a file name, written into `~/mailproof/saved` or `outputDir`, never overwriting). `maxResponseBytes` (default 512 KiB) caps a result; a result over it is an error that says how to narrow the call, never a truncation.

**`sync` from an agent** reads at most 100 messages per folder per call (about 8 s here; the argument can lower it); call again while `complete` is false. A login refused is `ERR_IMAP_AUTH` and not retryable.

**Errors** are results with `isError: true` and `{"error":{"code":"ERR_...","message":"...","retryable":true|false}}`: the library's code, `ERR_BAD_ARGUMENT` for a bad argument or unknown account, `ERR_PATH_NOT_ALLOWED`, `ERR_TOO_LARGE`, `ERR_RESPONSE_TOO_LARGE`, `ERR_INTERNAL`. `retryable` is true for a held lock or a transient IMAP failure (the CLI's exit 75 set).

**Untrusted data.** Addresses, subjects, reply text, filenames and Message-IDs come from third parties. Every tool description says so; a rubric in your consumer decides, never the mail's own words (see "Reading a reply").

**Audit and logs.** Every write or destructive call appends one JSON line to `~/.local/state/mailproof/mcp.log` (time, account, tool, a summary of the arguments without bytes, outcome); at start, a file over 1 MiB is renamed to `mcp.log.1` (replacing the older one) and a new one starts, so at most about 2 MiB stay on disk. stdout carries only protocol and stderr stays silent; `--log <file>` keeps diagnostics. Several accounts share one warm worker thread; a slow message on one account delays `check`, `record` and `replyFacts` on the others.

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

`list` and `copies` read a rebuildable SQLite index kept beside the trail (`<trailDir>/.<trail>.index.sqlite`, not in git, safe to delete). It is opened for each call and closed before the call returns, so no handle stays open between calls (and `close()` has nothing to do for it). It is built on the first call, then caught up from the trail's git HEAD on the first call after a `record()`. While it catches up, these calls wait on the trail lock (`ERR_TRAIL_LOCKED` after `lockTimeoutMs`). If the `better-sqlite3` native addon cannot load on your platform, they reject with `code: 'ERR_INDEX_UNAVAILABLE'` (there is no fallback). A rebuild streams git's listings, so it has no trail-size limit (memory stays near 150 MB at 20,000 records, F27). `record`, `get`, `verify`, `matchBody`, `matchFile`, `replyText` and `sync` never need it. Equal `captured` values come in ascending id order. The index is navigation, not proof: re-check with `verify`.

`copies(idOrKey)` returns every recorded copy of one signed message. The id is the hash of the raw bytes, so a list-relayed or forwarded copy is its own record; `message_key` groups them, and each record carries `copy: { kind: direct|relayed|forward|digest|unknown, evidence }`.

## Requirements

- Node >= 22.19 (the CPU deadline needs `Worker#cpuUsage`); pure ESM (`import`, no `require`).
- The `git` binary on `PATH` (the trail is a git repo; mailproof calls `git` directly).
- Four runtime dependencies: `mailauth` (DKIM/DMARC/SPF/ARC verification), `mailparser` (MIME parsing), `imapflow` (used only by `sync`) and `better-sqlite3` (used only by `list` and `copies`, for their index). The optional `ots` binary is needed only if you turn OpenTimestamps on.
- Trail names match `/^[a-z0-9][a-z0-9_-]{0,63}$/`; record ids are 32 hex characters.
