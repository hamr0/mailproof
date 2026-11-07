# mailproof (v2) - Integration Guide

## What this is

mailproof records a re-checkable proof of each email in a **two-party (A to B) exchange** in a local git trail: the signed headers, never the body. The sender's DKIM public key is archived at capture, so anyone can verify the record offline, years later, after the key has left DNS. Pure ESM, Node >= 22.19, runtime deps `mailauth` + `mailparser` + `imapflow` (only for `sync`) + `better-sqlite3` (only for `list` and `copies`). Wire formats: `docs/product/SPEC.md` Part B (repo only).

## What mailproof is and is not

- It is a recorder and an offline verifier: `record`, `verify`, `matchBody`, `matchFile`, `check`, `list`, `get`, `replyText`, and a read-only IMAP fetcher in front of `record`: `sync`.
- It is not a mail client, a sender, a web UI or a multi-party workflow engine (those are gitdone/signedreply.com), not proof of delivery, and not a claim of legal admissibility.
- It produces a verdict; acting on it is the consumer's job.

## Minimal usage

```js
import { Mailproof } from 'mailproof';

const mp = new Mailproof({ trailDir: './trails' });
const { id } = await mp.record(rawEmailBytes, { direction: 'in', source: 'imap' });
const v = await mp.verify(id);          // offline, from the record alone: v.ok, v.trust
```

```js
import { Mailproof, verifyRecord, hashDocument, TRUST_LEVELS, RULES_VERSION } from 'mailproof';
```

## All options: `new Mailproof(opts)`

| Option | Meaning |
|---|---|
| `trailDir` (required) | Directory holding trails. Each trail is a git repo at `<trailDir>/<trail>/`. |
| `trail` | Trail name, `/^[a-z0-9][a-z0-9_-]{0,63}$/`, default `default`. |
| `resolver` | mailauth-compatible DNS resolver `(name, type) => [[txt]]` (tests inject one). A lookup it has not answered within 5 s is answered as the error `dns timeout` (`code: 'ETIMEOUT'`); one message's lookups together may wait 30 s, then further ones fail at once the same way. It must return plain data, as `node:dns` does; anything else is a DNS error (`code: 'EBADRESP'`). |
| `otsBin` | Path to the `ots` (OpenTimestamps) binary. Absent = OTS off. |
| `now` | Clock `() => Date`. |
| `trustedSealers` | ARC sealer domains whose chains may yield live `forwarded`. |
| `lockTimeoutMs` | How long `record()` waits for another writer of the same trail (default 30000). On timeout it throws `ERR_TRAIL_LOCKED` and writes nothing. |
| `worker` | The deadline backstop, default on: `{ size: 1, cpuMs: 15000, wallMs: 120000, maxMemoryMb: 1536 }`. `check()`/`record()` build in a warm worker thread that is killed over 15 s of its CPU, 120 s of busy wall time (DNS excluded) or 1,536 MB; the message is then recorded `unverified`, `over limit: time` / `over limit: memory`. `size: 0` builds in-process with no backstop. |

All methods are bound: `const { verify } = mp` works. `await mp.close()` stops the worker threads early; it is never needed for the process to exit. With a worker, a `record()`/`check()` still running when `close()` is called (or when the last instance sharing the pool closes) may reject, and if it rejects that message is not recorded: await in-flight calls first.

## Public API

- `check(raw, { envelope? })` -> `{ live, portable, signatures, unsigned, partial_body, key_errors, body_status, body[] }`. Writes nothing. Judged as of now.
- `record(raw, { direction: 'in'|'out', source?, envelope? })` -> `{ id, duplicate, commit, record?, ots? }`. One commit per record. Never throws on unverifiable mail (it is recorded `unverified`); throws on empty input, a bad `direction`, a git failure, or `ERR_TRAIL_LOCKED` (another writer held the trail longer than `lockTimeoutMs`; nothing is written, retry later). The same bytes captured again return `duplicate: true` and write nothing; a copy with any byte difference is a new record. `ots` is `'off'`, `'pending'` or `{ error }` (an OTS failure never blocks the commit).
- `verify(recordOrId, { at? })` -> `{ ok, trust, basis, at, engine, signatures[] }`. Offline, from the record alone. `at` defaults to the record's `captured`; a missing or garbled `captured` fails closed. `trust` is recomputed now.
- `matchBody(recordOrId, raw)` -> `{ match, full, signatures[] }`. `full` = body matches `bh=` AND the signature verifies at capture time.
- `matchFile(recordOrId, bytes)` -> `{ match, attachment }`.
- `list({ limit?, direction? })`, `get(id)`.
- `sync({ host, port?, user, auth: { pass } | { accessToken }, folders?, sent?, maxMessages?, maxBytes?, tls?: { ca } })` -> `{ complete, folders: [{ folder, direction, attempted, uidvalidity, reset, last_uid, seen, recorded, duplicate, over_limit, skipped[], bytes, complete, error }] }`. Reads one mailbox over IMAP (implicit TLS, certificate always checked, `EXAMINE` + `BODY.PEEK`, so nothing is marked seen, moved or deleted) and `record()`s each message: `folders` (default `['INBOX']`) as `in`, the `\Sent` folder (`sent: true`, default; a path string; `false` skips) as `out`, `source` `imap:<folder>`. One account per call; you obtain and refresh an OAuth token yourself. A resume cursor is kept in `<trailDir>/.<trail>.sync.json` beside the trail (not in git); caps per folder per run are 1,000 messages and 512 MiB (options can only lower them) and 30 minutes per call, so loop until `complete` is true. A trail restored from an older backup or replaced is detected (the cursor records the trail's HEAD) and the folders rescan with `reset: 'trail'`; no manual step. A re-fetched message has the same bytes, so it is `duplicate`, never a second record. Over 25 MiB: streamed through a hash and recorded `over limit: total_bytes`; over 128 MiB: in `skipped`. Provider Sent copies are unsigned, so they record `unverified`. No envelope on IMAP, so `authorized` cannot occur. Throws a TypeError for bad options, then only `ERR_IMAP_AUTH`, `ERR_IMAP_CONNECT` or `ERR_SYNC_LOCKED` (a second `sync` on the trail: fails at once); everything else is in a folder's `error` (`ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`, `ERR_TRAIL_LOCKED`). The first trail error stops the run. The credential is never logged, returned or stored. Leave OTS off for a backfill.
- `copies(idOrKey)` -> `{ message_key, original, copies[], contained_in[] }`: every recorded copy of one signed message (the id is the raw-bytes hash, so a list-relayed or forwarded copy is its own record; `message_key` groups them), the derived `original` (earliest `direct` copy with a matched body), and the records (forwards, list digests) that carry it as an attached original. Each record has `copy: { kind: direct|relayed|forward|digest|unknown, evidence }`.
- `list` and `copies` read a rebuildable SQLite index kept beside the trail (`<trailDir>/.<trail>.index.sqlite`, not in git, safe to delete; built on the first call, then kept current from the trail's git HEAD). If the `better-sqlite3` native addon cannot load on the platform they reject with `code: 'ERR_INDEX_UNAVAILABLE'` (no fallback); `record`, `get`, `verify`, `matchBody`, `matchFile` and `sync` never need it. While the index catches up they wait on the trail lock (`ERR_TRAIL_LOCKED` after `lockTimeoutMs`). Equal `captured` values come in ascending id order. The index is navigation, not proof: re-check with `verify`.

`verifyRecord(record, { at? })` is the same offline check as a pure function, so a third party can verify an exported record with no trail.

Portable `verified` covers the signed headers; read `body_status` for the body. Each record carries `body_status` and, per signature, `body: { status, explain[] }` (`matched` / `partial` / `mismatch` / `not-checked`; `explain` entries `{ kind, detail }` are counts and domains only: `l_tag`, `appended`, `prepended`, `canonicalisation`, `line_endings`, `forwarded`, `mailing_list`, `search_capped`, `unknown`). It never changes a trust verdict.

## Reply text (`replyText`)

`replyText(raw)` -> `{ id, text, text_sha256, text_bytes, quote, trailing, source, boundary, stripper, body_status, proven, commit, duplicate }`. Give it the raw bytes of a reply you already recorded; it returns only what the sender newly wrote (quoted history removed), so a reply that merely quotes "Approve payment of $5,000?" is not read as an approval. Interpreting the text is yours; mailproof does not decide what a reply means.
- `proven` is true only when the recorded `body_status` is `matched` (the body matches the signed `bh=`) and the text came from a `text/plain` part. `partial` (an `l=` prefix), `mismatch` (for example Outlook/Exchange-received copies) and `not-checked` (unsigned, over limit, your own Sent copy) are unproven: the text is still returned, flagged.
- `quote`: `found` (a quote boundary was cut), `not-found` (none; the whole body is returned, never a guess), `inline` (answers written inside the quote; not merged). `trailing: true`: unquoted text follows the quote (a signature, or bottom-posted text) and is NOT in `text`; read the raw email if you need it. Signatures are not stripped.
- `source: 'html-only'`: no text/plain part, nothing extracted (`text` '', `proven` false).
- The stripper is versioned and deterministic (`mailproof-quote/1`): anyone with the raw email re-runs it and gets the same text and `text_sha256` (over its UTF-8 bytes). One small `reply-text` record (hash, byte count, flags, `body_status`, time; never the text, body or subject) is committed to `replies/<id>.mailproof-quote-1.json`; the same message again is `duplicate: true` and writes nothing. Show the text you acted on; its hash matches `text_sha256` in a commit dated before the action.
- Errors: `ERR_NOT_RECORDED` (record the message first), `ERR_OVER_LIMIT` with `err.limit` (nothing written), `ERR_TRAIL_LOCKED`. It runs in the worker pool like `record`. Known limits of `/1`: tested on English-style attributions and Outlook/Foxmail header blocks; the name after the verb (`... schreef Amr <a@x>:`) and, above a `>` run, any language's attribution line (ends in `:` with a year, hh:mm or `@`) are cut; a quote WITHOUT `>` marks in a language whose verb is not listed falls through to `not-found`. Wire format: `docs/product/SPEC.md` B6.

## What's NOT in mailproof, and why

- **The body and the raw email are never stored.** A record is the signed headers, the signature, the archived key and hashes; this keeps other people's mail content out of your trail. `matchBody` re-checks a body you produce later.
- **No per-record erasure.** Records are durable by design (a git chain); privacy is minimisation plus lawful retention, not deletion.
- **No sending, no IDLE watcher, no OAuth flow, no whole-mailbox recording, no multi-account orchestration.** You hand mailproof raw bytes, or point `sync` at named folders of one mailbox.
- **No acting on a verdict.** `verified` is a statement about the signature, not a decision.

## Threat model summary

- Guaranteed: a record cannot be edited without failing `verify` (signed headers are re-hashed against the archived key); every tamper in findings F6 fails closed; a bad `captured` fails closed.
- Assumed: your trail directory is yours. `captured` is mailproof's own clock; turn on OpenTimestamps (`otsBin`) to make "captured no later than T" provable.
- Out of scope: SPF can never be re-checked from stored data (the portable verdict is DKIM only); a sender who never signs cannot be proven.

## Run on a timer (`mailproof-sync`)

`mailproof-sync` (shipped as `bin/mailproof-sync.js`, on `PATH` after `npm i mailproof`) is one `sync` run for cron or a systemd timer. It reads the password from a command, a file or stdin, never from a flag or a plain env value, and prints one JSON line (the sync result, no secret) on stdout and errors on stderr.

```bash
mailproof-sync --trail-dir /var/lib/mailproof --user you@gmail.com \
  --pass-command "pass show mailproof/gmail_pass"      # host imap.gmail.com, folders INBOX, sent on
```

Flags (env fallback `MAILPROOF_<NAME>`): `--trail-dir`, `--trail`, `--host`, `--port`, `--user`, `--folders a,b`, `--sent on|off`, `--pass-command` (split into arguments, run without a shell; first stdout line is the password), `--pass-file`, `--access-token-command` (OAuth2 XOAUTH2). With none of the secret sources, the password is read from stdin. Spaces inside an app password are stripped.

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

## Gotchas

- Mail altered in transit or by an export tool fails `matchBody` while `verify` still passes (headers intact); `body_status` says so at capture, with hints when the change can be explained.
- A signature whose key is gone from DNS at capture is stored with `key_error`; it cannot verify.
- A message over an input limit (25 MiB, 10 DKIM signatures, 256 KiB per body line, 500,000 body lines, ...) or one the worker backstop stops is still recorded, but never parsed: `unverified`, `reason: 'over limit: <name>'` (`time` / `memory` / `crash` for the backstop). A worker that cannot start rejects `check()`/`record()` and records nothing. Only `envelope.clientIp`, `clientHelo` and `sender` are read; each is a string or `null`: any other type (a function, a number) is treated as `null`, in a worker and with `worker.size: 0` alike; an `envelope` that is not itself an object counts as no envelope. Limits are in `docs/product/SPEC.md` Part B (Limits).
- `sync` holds a second lock file, `<trailDir>/.<trail>.sync.lock`, for the whole call; it never holds the trail lock across IMAP I/O. A pipe delivery during a backfill waits behind at most one message's commit.
- Writers are serialised per trail by a lock file that also covers separate processes (local filesystems only); a writer that waits longer than `lockTimeoutMs` gets `ERR_TRAIL_LOCKED`. Map it to a retry (Postfix: exit 75).

## Constraints

- Node >= 22.19; pure ESM (`import`, no `require`).
- One trail = one git repo; one writer at a time per trail, across processes too (lock file `<trailDir>/.<trail>.lock`, local filesystems only).
- Trail names match `/^[a-z0-9][a-z0-9_-]{0,63}$/`; record ids are 32 hex characters.
