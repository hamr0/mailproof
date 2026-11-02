# mailproof

**A re-checkable proof of an email, kept in a git repo you own.** mailproof records the *signed headers* of each email (never the body) plus the sender's archived public key, so anyone can verify the record offline, years later, even after the sender rotates their DKIM key.

> **Status:** v2 in development on branch `v2` (M0 of `docs/product/PRD.md`). 1.x, the multi-party coordination kernel, is frozen at tag `v1.4.0`.

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

`check()` and `record()` parse and verify in a warm worker thread; the commit, the lock and git stay on your thread. The thread is killed, and the message recorded `unverified` as `over limit: time` or `over limit: memory`, when one message uses more than 15 s of the thread's CPU, 120 s of busy wall time (DNS waits excluded) or 1,536 MB of memory. It backs up the input limits, which stay the first line. Waiting in the queue behind other messages does not count. If the thread dies for any other reason, the message is recorded `over limit: crash` and the next one gets a fresh worker.

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

## Concurrency

A trail has a single writer at a time, enforced by a lock file (`<trailDir>/.<trail>.lock`) that also covers separate processes; local filesystems only. A writer that cannot get the lock within `lockTimeoutMs` (default 30000) throws an error with `code: 'ERR_TRAIL_LOCKED'`. Postfix pipe consumers should map `ERR_TRAIL_LOCKED` to exit code 75 (`EX_TEMPFAIL`) so Postfix retries the mail.

`records/` and `keys/` are library-managed. After a crash, uncommitted files mailproof itself wrote there are cleaned up on the next write; other files are left alone, but don't keep your own files in a trail.

**Recovery.** If `ERR_TRAIL_LOCKED` persists and no writer is running (check the `pid` and `host` in `<trailDir>/.<trail>.lock`), delete that file, and `.<trail>.lock.break` if present. A lock from another host is never taken over automatically, including after a hostname change or from a killed container on a shared volume; shared volumes across hosts are unsupported beyond that manual step.

## Docs

`docs/README.md` is the map. The record and trail formats are in `docs/product/SPEC.md` (Part B); the adopter contract is `mailproof.context.md`. Two runtime dependencies: `mailauth`, `mailparser`. Node >= 22.19. Pure ESM.
