# mailproof (v2) - Integration Guide

## What this is

mailproof records a re-checkable proof of each email in a **two-party (A to B) exchange** in a local git trail: the signed headers, never the body. The sender's DKIM public key is archived at capture, so anyone can verify the record offline, years later, after the key has left DNS. Pure ESM, Node >= 22.19, runtime deps `mailauth` + `mailparser` + `imapflow` (the last only for `sync`). Wire formats: `docs/product/SPEC.md` Part B (repo only).

## What mailproof is and is not

- It is a recorder and an offline verifier: `record`, `verify`, `matchBody`, `matchFile`, `check`, `list`, `get`, and a read-only IMAP fetcher in front of `record`: `sync`.
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
- `sync({ host, port?, user, auth: { pass } | { accessToken }, folders?, sent?, maxMessages?, maxBytes?, tls?: { ca } })` -> `{ complete, folders: [{ folder, direction, attempted, uidvalidity, reset, last_uid, seen, recorded, duplicate, over_limit, skipped[], bytes, complete, error }] }`. Reads one mailbox over IMAP (implicit TLS, certificate always checked, `EXAMINE` + `BODY.PEEK`, so nothing is marked seen, moved or deleted) and `record()`s each message: `folders` (default `['INBOX']`) as `in`, the `\Sent` folder (`sent: true`, default; a path string; `false` skips) as `out`, `source` `imap:<folder>`. One account per call; you obtain and refresh an OAuth token yourself. A resume cursor is kept in `<trailDir>/.<trail>.sync.json` beside the trail (not in git); caps per folder per run are 1,000 messages and 512 MiB (options can only lower them) and 30 minutes per call, so loop until `complete` is true. **Delete the cursor file when you restore or replace a trail.** A re-fetched message has the same bytes, so it is `duplicate`, never a second record. Over 25 MiB: streamed through a hash and recorded `over limit: total_bytes`; over 128 MiB: in `skipped`. Provider Sent copies are unsigned, so they record `unverified`. No envelope on IMAP, so `authorized` cannot occur. Throws a TypeError for bad options, then only `ERR_IMAP_AUTH`, `ERR_IMAP_CONNECT` or `ERR_SYNC_LOCKED` (a second `sync` on the trail: fails at once); everything else is in a folder's `error` (`ERR_IMAP_NO_FOLDER`, `ERR_IMAP_NO_SENT`, `ERR_IMAP_PROTOCOL`, `ERR_IMAP_TIMEOUT`, `ERR_IMAP_THROTTLED`, `ERR_IMAP_UIDVALIDITY`, `ERR_TRAIL_LOCKED`). The first trail error stops the run. The credential is never logged, returned or stored. Leave OTS off for a backfill.
- `copies(idOrKey)` -> `{ message_key, original, copies[], contained_in[] }`: every recorded copy of one signed message (the id is the raw-bytes hash, so a list-relayed or forwarded copy is its own record; `message_key` groups them), the derived `original` (earliest `direct` copy with a matched body), and the records (forwards, list digests) that carry it as an attached original. Each record has `copy: { kind: direct|relayed|forward|digest|unknown, evidence }`.

`verifyRecord(record, { at? })` is the same offline check as a pure function, so a third party can verify an exported record with no trail.

Portable `verified` covers the signed headers; read `body_status` for the body. Each record carries `body_status` and, per signature, `body: { status, explain[] }` (`matched` / `partial` / `mismatch` / `not-checked`; `explain` entries `{ kind, detail }` are counts and domains only: `l_tag`, `appended`, `prepended`, `canonicalisation`, `line_endings`, `forwarded`, `mailing_list`, `search_capped`, `unknown`). It never changes a trust verdict.

## What's NOT in mailproof, and why

- **The body and the raw email are never stored.** A record is the signed headers, the signature, the archived key and hashes; this keeps other people's mail content out of your trail. `matchBody` re-checks a body you produce later.
- **No per-record erasure.** Records are durable by design (a git chain); privacy is minimisation plus lawful retention, not deletion.
- **No sending, no IDLE watcher, no OAuth flow, no whole-mailbox recording, no multi-account orchestration.** You hand mailproof raw bytes, or point `sync` at named folders of one mailbox.
- **No acting on a verdict.** `verified` is a statement about the signature, not a decision.

## Threat model summary

- Guaranteed: a record cannot be edited without failing `verify` (signed headers are re-hashed against the archived key); every tamper in findings F6 fails closed; a bad `captured` fails closed.
- Assumed: your trail directory is yours. `captured` is mailproof's own clock; turn on OpenTimestamps (`otsBin`) to make "captured no later than T" provable.
- Out of scope: SPF can never be re-checked from stored data (the portable verdict is DKIM only); a sender who never signs cannot be proven.

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
