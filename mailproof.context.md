# mailproof (v2) - adopter contract

Records a re-checkable proof of each email in a local git trail: the signed headers, never the body. Pure ESM, Node >= 22.5, runtime deps `mailauth` + `mailparser`. Wire formats: `docs/product/SPEC.md` Part B.

```js
import { Mailproof, verifyRecord, hashDocument, TRUST_LEVELS, RULES_VERSION } from 'mailproof';
```

## `new Mailproof(opts)`

| Option | Meaning |
|---|---|
| `trailDir` (required) | Directory holding trails. Each trail is a git repo at `<trailDir>/<trail>/`. |
| `trail` | Trail name, `/^[a-z0-9][a-z0-9_-]{0,63}$/`, default `default`. |
| `resolver` | mailauth-compatible DNS resolver `(name, type) => [[txt]]` (tests inject one). |
| `otsBin` | Path to the `ots` (OpenTimestamps) binary. Absent = OTS off. |
| `now` | Clock `() => Date`. |
| `trustedSealers` | ARC sealer domains whose chains may yield live `forwarded`. |

All methods are bound: `const { verify } = mp` works.

## Methods

- `check(raw, { envelope? })` -> `{ live, portable, signatures, unsigned, partial_body, key_errors }`. Writes nothing. Judged as of now.
- `record(raw, { direction: 'in'|'out', source?, envelope? })` -> `{ id, duplicate, commit, record?, ots? }`. One commit per record. Never throws on unverifiable mail (it is recorded `unverified`); throws on empty input, a bad `direction`, or a git failure. A repeat capture returns `duplicate: true` and writes nothing. `ots` is `'off'`, `'pending'` or `{ error }` (an OTS failure never blocks the commit).
- `verify(recordOrId, { at? })` -> `{ ok, trust, basis, at, engine, signatures[] }`. Offline, from the record alone. `at` defaults to the record's `captured`; a missing or garbled `captured` fails closed. `trust` is recomputed now.
- `matchBody(recordOrId, raw)` -> `{ match, full, signatures[] }`. `full` = body matches `bh=` AND the signature verifies at capture time.
- `matchFile(recordOrId, bytes)` -> `{ match, attachment }`.
- `list({ limit?, direction? })`, `get(id)`.

`verifyRecord(record, { at? })` is the same offline check as a pure function, so a third party can verify an exported record with no trail.

## Failure modes worth knowing

- Mail altered in transit or by an export tool fails `matchBody` while `verify` still passes (headers intact).
- A signature whose key is gone from DNS at capture is stored with `key_error`; it cannot verify.
- Concurrent writers in one process are serialised; across processes only git's `index.lock` protects the trail.
