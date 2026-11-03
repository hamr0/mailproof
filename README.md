# mailproof

**A re-checkable proof of an email, kept in a git repo you own.** mailproof records the *signed headers* of each email (never the body) plus the sender's archived public key, so anyone can verify the record offline, years later, even after the sender rotates their DKIM key.

> **Status:** v2 is released as 2.0.0 (see the CHANGELOG). 1.x, the multi-party coordination kernel, is frozen at tag `v1.4.0`.

```js
import { Mailproof } from 'mailproof';

const mp = new Mailproof({ trailDir: './trails' });         // a git repo per trail
const { id } = await mp.record(rawEmailBytes, { direction: 'in', source: 'imap' });

await mp.verify(id);                  // offline, from the record alone
await mp.matchBody(id, rawEmail);     // body hash vs the signed bh= -> "full proof"
await mp.matchFile(id, attachmentBytes);
await mp.check(emlBytes);             // one-off: verdicts only, writes nothing
```

## What a record proves

- The signature over From/To/Subject/Date/Message-ID (whatever the sender signed) was valid at capture time, against a key archived at capture.
- If the body turns up later, it hashes to the signed `bh=`.
- Attachment hashes are self-recorded at capture. They are tied to the signature only if the body is produced.

Honest limits: a message over an input limit (more than 25 MiB; a header block over 256 KiB, 4,000 header lines or 1,000 header fields; more than 10 DKIM-Signature headers, 200 names in one `h=` or a signature field over 16 KiB; more than 200 MIME delimiter lines; a body line over 256 KiB; more than 500,000 body lines) is recorded but never parsed or verified: `unverified`, `reason: 'over limit: <name>'` on both verdicts (so a message whose only valid signature is the 11th is not verified); a message that, under those limits, still costs more than 15 s of CPU or 1,536 MB of memory is stopped by the worker backstop and recorded the same way (`over limit: time` / `over limit: memory`, see below; a worker that dies mid-message is recorded as `over limit: crash`); an unsigned email is recorded as `unverified`; a signature with `l=` leaves part of the body unsigned (flagged `partial_body`); SPF can never be re-checked from stored data, so the **portable** verdict uses DKIM only. `captured` is mailproof's own clock; use OpenTimestamps (`otsBin`) to make "captured no later than T" provable.

Portable `verified` covers the signed headers; read `body_status` for the body (`matched`, `partial`, `mismatch`, with `explain` hints on what changed).

## Worker thread and deadline

`check()` and `record()` parse and verify in a warm worker thread; the commit, the lock and git stay on your thread. The thread is killed, and the message recorded `unverified` as `over limit: time` or `over limit: memory`, when one message uses more than 15 s of the thread's CPU, 120 s of busy wall time (DNS waits excluded) or 1,536 MB of memory. It backs up the input limits, which stay the first line. Waiting in the queue behind other messages does not count. If the thread dies for any other reason, the message is recorded `over limit: crash` and the next one gets a fresh worker. A worker that cannot start at all (before it is ready) rejects the call instead, and nothing is recorded. A DNS lookup your `resolver` (or the system one) has not answered within 5 s is answered as a DNS error (`dns timeout`), and all the lookups of one message together may wait at most 30 s, after which further lookups fail at once the same way, so a resolver that never settles delays one message by about 30 s, not forever. Your resolver must return plain data, as `node:dns` does; anything else is answered as a DNS error (`resolver returned a non-plain value`) rather than crashing the process.

```js
new Mailproof({ trailDir, worker: { size: 1, cpuMs: 15000, wallMs: 120000, maxMemoryMb: 1536 } });  // the defaults
new Mailproof({ trailDir, worker: { size: 0 } });   // no worker: build in-process, no backstop
await mp.close();   // optional: idle workers do not keep your process alive
```

Cost: the first call starts the thread, which loads the parsers (roughly 0.4 to 1 s of wall time and 0.7 s of CPU extra for a program that handles one mail and exits; use `size: 0` there). Warm, a call costs about the same as in-process. Instances with the same options share their workers.

## Two verdicts

| Verdict | Decided | Inputs | Re-checkable later |
|---|---|---|---|
| live | at capture | DKIM + DMARC + SPF + ARC | no (SPF) |
| portable | at capture, recomputable by anyone | DKIM signatures in the record | yes |

Trust levels: `verified` (aligned DKIM pass, and DMARC pass if the domain publishes DMARC), `forwarded`, `authorized` (live only), `unverified`. Each verdict carries its engine/rules version.

## Capture over IMAP (`sync`)

`sync` reads one mailbox, read-only, and records every message in it (INBOX as `in`, the Sent folder as `out`). Nothing is marked seen, moved or deleted. It is meant for a cron job or a one-off backfill:

```js
const res = await mp.sync({
  host: 'imap.gmail.com', user: 'you@gmail.com',
  auth: { pass: process.env.APP_PASSWORD },        // or { accessToken } (OAuth2; you obtain and refresh the token)
  folders: ['INBOX'], sent: true,                  // sent: true finds the \Sent folder; a string is a path; false skips it
});
// res.complete, res.folders[i].{ recorded, duplicate, over_limit, skipped, error, last_uid }
```

Run it again to pick up new mail; a capped run (1,000 messages or 512 MiB per folder, 30 minutes per call) is continued by calling again until `res.complete` is true. A resume cursor lives in `<trailDir>/.<trail>.sync.json`, beside the trail and not in git: a trail restored from an older backup or replaced is detected from the cursor and rescanned (`reset: 'trail'`; same bytes are never recorded twice). TLS is always on with certificate checking (only `tls: { ca }` can be added). Mail over 25 MiB is stream-hashed and recorded `over limit: total_bytes`; over 128 MiB it is listed in `skipped`. A Sent copy is normally unsigned by the provider, so it is recorded `unverified`; the counterparty's signed copy is the proof. Leave OpenTimestamps off for a backfill. A second `sync` on the same trail while one runs throws `ERR_SYNC_LOCKED` at once. Other errors: `ERR_IMAP_AUTH`, `ERR_IMAP_CONNECT`; per folder `ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`. The first trail error stops the run. Details: `docs/product/SPEC.md` B4.

## Run on a timer

`mailproof-sync` (shipped as `bin/mailproof-sync.js`, on `PATH` after `npm i mailproof`) is one `sync` run for cron or a systemd timer. It reads the password from a command, a file or stdin, never from a flag or a plain env value, and prints one JSON line (the sync result, no secret) on stdout and errors on stderr.

```bash
mailproof-sync --trail-dir /var/lib/mailproof --user you@gmail.com \
  --pass-command "pass show mailproof/gmail_pass"      # host imap.gmail.com, folders INBOX, sent on
```

Flags (env fallback `MAILPROOF_<NAME>`): `--trail-dir`, `--trail`, `--host`, `--port`, `--user`, `--folders a,b`, `--sent on|off`, `--pass-command` (split into arguments, run without a shell; first stdout line is the password), `--pass-file`, `--access-token-command` (OAuth2 XOAUTH2). With none of the secret sources, the password is read from stdin. Spaces are stripped only from Google's app-password display shape (four groups of four lowercase letters, `abcd efgh ijkl mnop`); any other password is sent as given, minus leading and trailing whitespace and the line ending.

Exit codes: `0` finished (a run cut short by a cap also exits 0 with `"complete": false` and no error: the next run continues from the cursor); `75` try later (`ERR_SYNC_LOCKED` or `ERR_TRAIL_LOCKED`, server unreachable, timeout, throttled); `77` login refused; `64` bad usage; `1` anything else.

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

## Concurrency

A trail has a single writer at a time, enforced by a lock file (`<trailDir>/.<trail>.lock`) that also covers separate processes; local filesystems only. A writer that cannot get the lock within `lockTimeoutMs` (default 30000) throws an error with `code: 'ERR_TRAIL_LOCKED'`. Postfix pipe consumers should map `ERR_TRAIL_LOCKED` to exit code 75 (`EX_TEMPFAIL`) so Postfix retries the mail.

`records/` and `keys/` are library-managed. After a crash, uncommitted files mailproof itself wrote there are cleaned up on the next write; other files are left alone, but don't keep your own files in a trail.

**Recovery.** If `ERR_TRAIL_LOCKED` persists and no writer is running (check the `pid` and `host` in `<trailDir>/.<trail>.lock`), delete that file, and `.<trail>.lock.break` if present. A lock from another host is never taken over automatically, including after a hostname change or from a killed container on a shared volume; shared volumes across hosts are unsupported beyond that manual step.

## Docs

`docs/README.md` is the map. The record and trail formats are in `docs/product/SPEC.md` (Part B); the adopter contract is `mailproof.context.md`. Three runtime dependencies: `mailauth`, `mailparser`, `imapflow` (used only by `sync`). Node >= 22.19. Pure ESM.
