# mailproof (v2) - Integration Guide

## What this is

mailproof records a re-checkable proof of each email in a **two-party (A to B) exchange** in a local git trail: the signed headers, never the body. The sender's DKIM public key is archived at capture, so anyone can verify the record offline, years later, after the key has left DNS. Pure ESM, Node >= 22.5, runtime deps `mailauth` + `mailparser`. Wire formats: `docs/product/SPEC.md` Part B (repo only).

## What mailproof is and is not

- It is a recorder and an offline verifier: `record`, `verify`, `matchBody`, `matchFile`, `check`, `list`, `get`.
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
| `resolver` | mailauth-compatible DNS resolver `(name, type) => [[txt]]` (tests inject one). |
| `otsBin` | Path to the `ots` (OpenTimestamps) binary. Absent = OTS off. |
| `now` | Clock `() => Date`. |
| `trustedSealers` | ARC sealer domains whose chains may yield live `forwarded`. |

All methods are bound: `const { verify } = mp` works.

## Public API

- `check(raw, { envelope? })` -> `{ live, portable, signatures, unsigned, partial_body, key_errors, body_status, body[] }`. Writes nothing. Judged as of now.
- `record(raw, { direction: 'in'|'out', source?, envelope? })` -> `{ id, duplicate, commit, record?, ots? }`. One commit per record. Never throws on unverifiable mail (it is recorded `unverified`); throws on empty input, a bad `direction`, or a git failure. The same bytes captured again return `duplicate: true` and write nothing; a copy with any byte difference is a new record. `ots` is `'off'`, `'pending'` or `{ error }` (an OTS failure never blocks the commit).
- `verify(recordOrId, { at? })` -> `{ ok, trust, basis, at, engine, signatures[] }`. Offline, from the record alone. `at` defaults to the record's `captured`; a missing or garbled `captured` fails closed. `trust` is recomputed now.
- `matchBody(recordOrId, raw)` -> `{ match, full, signatures[] }`. `full` = body matches `bh=` AND the signature verifies at capture time.
- `matchFile(recordOrId, bytes)` -> `{ match, attachment }`.
- `list({ limit?, direction? })`, `get(id)`.
- `copies(idOrKey)` -> `{ message_key, original, copies[], forwards[] }`: every recorded copy of one signed message (the id is the raw-bytes hash, so a list-relayed or forwarded copy is its own record; `message_key` groups them), the derived `original` (earliest `direct` copy with a matched body), and the records that carry it as an attached original. Each record has `copy: { kind: direct|relayed|forward|unknown, evidence }`.

`verifyRecord(record, { at? })` is the same offline check as a pure function, so a third party can verify an exported record with no trail.

Portable `verified` covers the signed headers; read `body_status` for the body. Each record carries `body_status` and, per signature, `body: { status, explain[] }` (`matched` / `partial` / `mismatch` / `not-checked`; `explain` entries `{ kind, detail }` are counts and domains only: `l_tag`, `appended`, `prepended`, `canonicalisation`, `line_endings`, `forwarded`, `mailing_list`, `search_capped`, `unknown`). It never changes a trust verdict.

## What's NOT in mailproof, and why

- **The body and the raw email are never stored.** A record is the signed headers, the signature, the archived key and hashes; this keeps other people's mail content out of your trail. `matchBody` re-checks a body you produce later.
- **No per-record erasure.** Records are durable by design (a git chain); privacy is minimisation plus lawful retention, not deletion.
- **No sending, no IMAP, no third-party mail provider.** You hand mailproof raw bytes.
- **No acting on a verdict.** `verified` is a statement about the signature, not a decision.

## Threat model summary

- Guaranteed: a record cannot be edited without failing `verify` (signed headers are re-hashed against the archived key); every tamper in findings F6 fails closed; a bad `captured` fails closed.
- Assumed: your trail directory is yours. `captured` is mailproof's own clock; turn on OpenTimestamps (`otsBin`) to make "captured no later than T" provable.
- Out of scope: SPF can never be re-checked from stored data (the portable verdict is DKIM only); a sender who never signs cannot be proven.

## Gotchas

- Mail altered in transit or by an export tool fails `matchBody` while `verify` still passes (headers intact); `body_status` says so at capture, with hints when the change can be explained.
- A signature whose key is gone from DNS at capture is stored with `key_error`; it cannot verify.
- Concurrent writers in one process are serialised; across processes only git's `index.lock` protects the trail.

## Constraints

- Node >= 22.5; pure ESM (`import`, no `require`).
- One trail = one git repo; in-process writers are serialised, across processes only git's `index.lock` protects it.
- Trail names match `/^[a-z0-9][a-z0-9_-]{0,63}$/`; record ids are 32 hex characters.
