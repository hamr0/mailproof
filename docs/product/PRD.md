# mailproof v2 — PRD

> **Status:** v2 planning. 1.x is frozen at tag `v1.4.0` (branch `v1` takes security fixes only).
> **Owner:** hamr0 · **Last updated:** 2026-10-31
>
> **For future Claude:** this PRD wins on intent and scope. The *why* behind each choice is in
> [`decisions-log.md`](decisions-log.md). The v1 PRD is archived at
> [`../archive/v1/PRD.md`](../archive/v1/PRD.md); `DESIGN.md` and `SPEC.md` still describe v1 and are
> replaced module by module as v2 lands. v2 is a **new, smaller product**, not an edit of v1.

## 1. Problem and goal

People and agents make small agreements over email: "I sent you this", "confirmed for Tuesday",
"approved". Later nobody can prove them. Worse, once the sender's DKIM key rotates out of DNS, even
the original email can no longer be re-checked.

**Goal:** mailproof v2 records a re-checkable proof of each email in a **two-party (A↔B) exchange** in
a local git trail: the signed headers, never the body. Anyone can verify the record offline, at any
time, because the sender's public key is archived at capture.

**Why v2 is smaller than v1.** v1 copied `gitdone` (live as signedreply.com) into a library:
multi-party workflows, ordered/parallel steps, thresholds, N-signer sign-off. That is a product and it
already exists. Multi-party stays in gitdone/signedreply.com; mailproof only borrows the engineering
ideas (git trail, key archive, accept-and-flag, OTS), much simplified. The "rebuild gitdone on
mailproof" north star is retired.

## 2. Use cases (in scope)

Small, one-time A↔B transactions:

- "I sent you this file on this date."
- Appointments.
- Sending files and having them verified later.
- **Human approvals for agents.** First real consumer: an approval channel for the sibling library
  `bareguard`, whose `Gate` takes a `humanChannel: async () => ({ decision })` hook.
- **One-off verification of a received `.eml`.** Time-bound: it only works while the sender's key is
  still in DNS. Continuous capture removes that limit by archiving the key at receipt.

## 3. Trust rule (decided)

DKIM is the baseline. **DMARC must pass when the sender's domain publishes a DMARC record; with no
DMARC record, aligned DKIM is enough.** SPF and ARC are recorded when present or available.

Every email gets two verdicts:

| Verdict | Decided | Inputs | Re-checkable later? |
|---|---|---|---|
| **Live** | at capture | DKIM + DMARC + SPF + ARC | No for SPF. SPF is only evaluable when we are the receiving MTA (Postfix pipe) or when taken from a receiving provider's results header; it can never be re-checked from stored data. |
| **Portable** | at capture, recomputable by anyone from the stored record alone | DKIM signatures, plus ARC seals from a configurable list of trusted sealers | Yes. Never uses SPF. |

M0 ships the portable verdict from DKIM only; the offline re-check of ARC seals is deferred to a follow-up POC (see [findings F7](findings.md#f7--m0-design-decisions)).

Each verdict records the **engine/rules version** that produced it. Verdicts are not timeless:
upgrading mailauth 4→8 already changed DMARC outcomes.

**Trust-level names are kept from v1** (one name per concept): `verified`, `forwarded`, `authorized`,
`unverified`.

| Level | v1 meaning (`src/classifier.js`) | v2 meaning |
|---|---|---|
| `verified` | DKIM pass + aligned + DMARC pass | DKIM pass + aligned + (DMARC pass **if the domain publishes DMARC**) — **changed** |
| `forwarded` | DKIM fail/none, ARC pass | unchanged in idea; ARC sealer must be on the trusted list for the portable verdict |
| `authorized` | DKIM fail/none, SPF pass + DMARC pass | unchanged; **live-only, never portable** |
| `unverified` | none of the above | unchanged |

The `verified` change is deliberate and explicit: v1 would call a domain with no DMARC record
`unverified` even when its DKIM signature is valid and aligned.

## 4. Storage: the signed-header record (decided, "option B")

DKIM signs the headers, and the headers include a hash of the body (the `bh=` tag). So the record
stores:

- the **exact header fields the sender signed** (those named in the signature's `h=` tag), kept
  byte-exact as received;
- the `DKIM-Signature` header(s);
- the archived public key(s);
- both verdicts (§3);
- **attachment hashes** (sha256 of each attachment, computed at capture);
- threading ids: `Message-ID`, `In-Reply-To`, `References`;
- direction (in/out), capture source, capture time.

**Never** the body, never the raw email.

**What this proves later**

- Anyone can re-check the signature offline, forever (key is archived). That proves
  From/To/Subject/Date/Message-ID came from that domain.
- If the body turns up later (still in the mailbox, or an `.eml`), it is hashed and compared to `bh=`;
  a match upgrades the record to a **full proof**.
- Attachment hashes are self-recorded at capture and timestamped. They are tied to the signature only
  if the body is produced.

**Costs and caveats**

- Signed headers must be stored verbatim. We cannot hash the subject and still re-check.
- They include other people's addresses and the subject. Privacy wording is an open question (§9);
  this is not legal advice.
- A signature with an `l=` (body length) tag leaves part of the body unsigned. The record flags it.
- Unsigned mail is still recorded (v1's "commit every message, flag it" idea), with verdict
  `unverified` and minimal metadata.

**Contrast with v1.** v1's `verify()` needed the user to bring the email back
(`findMatch(candidateBytes, commits)` in `src/verifier.js`) because v1 stored only salted hashes and no
plaintext. v2's record re-checks without the email. This **reverses v1's "no plaintext at rest /
salted hashes only" posture for headers**. Erasure is whole-trail deletion.

**Technical fact (verified):** mailauth 8 exports its DKIM header canonicalization
(`mailauth/lib/dkim/header`, confirmed in the installed mailauth 8.0.4 `package.json` exports), so the
header-only re-check can use vetted canonicalization plus Node's built-in crypto. No hand-rolled
crypto. M0's POC shows it works end to end on real Gmail mail (GO, [findings](findings.md) F1/F6).

## 5. Two-party transactions

A transaction is **my email + your reply**, matched by standard email threading: the reply's
`In-Reply-To`/`References` point at my `Message-ID` (usually in the signed `h=` list: signed by Gmail, not by Microsoft, see [F11](findings.md)). No plus-address
tags.

Honest limits for "I sent you this":

- My own sent record is self-recorded and timestamped. A provider's Sent-folder copy is saved
  without a DKIM signature (msn.com Sent copies: 0 of 4 signed, [F3](findings.md)), so it is `unverified`
  (a Gmail-address Sent copy: moot, [F3](findings.md)).
- The strong proof is the counterparty's **signed reply** that references my Message-ID.
- If they never reply, only my own timestamped record exists.
- Only self-hosting (M5) gives signed copies of what I send.

## 6. Go / no-go (M0)

A **header-only DKIM re-check, built from the stored record alone** (signed headers + signature +
archived key), **passes on real mail from the owner's Gmail account and fails when the record is
tampered with.** Real, uncrafted mail only: AGENT_RULES requires a test that can fail.

If it fails on real mail: stop and rethink the record format.

**Status (2026-10-31): GO**, see [findings](findings.md) F1/F2/F6. Expiry (`x=`/`t=`) is judged as of capture time, not now (F2).

## 7. Modules (sharp near, loose far)

Every module's definition of done includes its `primitives.json` entries (§8).

### M0 — Record and re-check (fully specified)

Raw email bytes in (plus capture context: direction, source, time) →

1. both verdicts;
2. signed-header record;
3. key archive (deduped per domain+selector within a trail);
4. git commit. One git repo per **trail** (a named collection; one default trail), one commit per
   record;
5. optional OTS timestamp (off by default; needs the `ots` binary);
6. offline re-check from the record alone, plus **body-match** (given a raw email) and **file-match**
   (given an attachment) helpers;
7. one-off `.eml` verification.

Also sets up the agent menu (§8).

**POC:** the go/no-go in §6. Done: GO ([findings](findings.md) F1).

API sketch (**sketch; names finalised during M0**). A class instance with bound methods, so
`const { verify } = mp` works:

```js
const mp = new Mailproof({ trailDir, resolver?, otsBin? })
mp.check(raw)               // verdicts only, writes nothing
mp.record(raw, ctx)         // verdicts + record + key archive + commit
mp.verify(recordOrId)       // offline re-check from the record alone
mp.matchBody(record, raw)   // body hash vs bh=
mp.matchFile(record, bytes) // attachment hash match
mp.list(); mp.get(id)
```

Reuse v1 names where the concept is the same (`verify`, `hashDocument`).

### M1 — Capture (fully specified)

A `sync` run (cron/systemd timer first; a long-running IMAP IDLE watcher later) over **one Gmail label
or folder plus Sent**, via IMAP. The owner's Gmail account is the target. Resumes where it left off,
no duplicates. The existing Postfix pipe stays as a capture source.

IMAP needs a **third runtime dependency** (candidate: `imapflow`, same author as mailauth/mailparser).
It must pass the AGENT_RULES External Dependency Checklist, and it reaches the ≤3 runtime-dep ceiling.

**POC:** fetched mail still verifies; which Gmail
login method works (Gmail Sent-copy signing is moot, [F3](findings.md)). Already known: msn.com Sent copies are unsigned ([F3](findings.md)); Outlook/Exchange mail
exported via Thunderbird has altered bodies, so M1 is Gmail-first (F4).

### M2 — Reading replies (specified: goals and design)

- Extract only the **new** text of a reply (drop quoted history and signature). The trap: a reply
  quoting "Approve payment of $5,000?" read as an approval.
- Pluggable interpreters: strict keyword (first line approve/decline); calendar reply (`text/calendar`
  sent when someone clicks Accept); a hook for an agent's LLM.
- A **decision record** storing the decision, the hash of the exact text it was based on, and which
  interpreter decided, so a dispute can re-run it. No plaintext stored.

**POC:** quoted-text stripping on real replies from real clients.

### M3 — Two-party coordination (goals only)

Re-interviewed and simplified when its turn comes.

- A transaction = request + reply matched by threading.
- First user: agent approvals via bareguard.
- Interfaces: a CLI (plain subcommands such as `verify`/`sync`/`log`/`prove`, plus a simple readline
  menu when run with no arguments; no TUI framework), an MCP server for agents, and the full
  `primitives.json`.
- CLI help, MCP tool descriptions and `primitives.json` all come from the **same JSDoc** (one source
  of truth).
- Open: sending from a normal mailbox partly reopens the "no third-party sending provider" rule.

### M4 — Appointments (highlights)

Calendar replies, propose/accept back-and-forth, reminders. Built on M3.

### M5 — Hosting your own (highlights)

Postfix + opendkim, capture via pipe, signing your own outgoing mail. Shipped as a Docker image or
privcloud module, **not inside the npm package** (mailproof must not become a mail server). Signing
default is opendkim (key stays in the MTA); in-library signing via mailauth's `dkimSign` is an option.

### M6 — Proof export, then ZK (highlights)

Export a self-contained proof bundle. Disclosure levels: **full email** / **headers-only** (no ZK) /
**ZK one-bit-out** using ZK Email's circuits in a separate package (`mailproof-zk`), never our own
circuits. Owner's related projects follow the same rule: proof in, one bit out; the crypto is never
ours. Unconfirmed: whether google/longfellow-zk (used by the 8een project) can handle RSA DKIM; ZK
Email targets RSA DKIM.

**Later setting, not in scope now:** whole-inbox recording ("watch everything") is a setting on M1's
capture code.

## 8. Agent menu: `primitives.json`

Sibling repos `bareguard`, `bare-agent` (directory `bareagent`) and `litectx` ship a `primitives.json`
generated from JSDoc `@when`/`@fails`/`@example` tags by a shared, hash-pinned
`scripts/primitives-core.mjs`, plus a per-repo `primitives.config.mjs`, a completeness test (every
public export is a primitive or on an EXCLUDED list with a reason), and `check:primitives` in CI.
mailproof v2 follows the same pattern. The generator resolves top-level exports and **class methods**
only, which is one reason v2's instance is class-shaped.

## 9. Approach and reuse

Same repo, same npm name, released as **2.0.0**. Build a new layered structure on the `v2` branch and
**move** the tested v1 modules into it (`git mv`, history kept); rewrite only the tangled core. 1.x is
frozen at tag `v1.4.0`; branch `v1` takes security fixes only. **No compatibility layer** for 1.x's
`create()` (the only known user is the frozen `mailproof-probe`). POCs only where the mechanism is
unproven (M0, M1, M2), not for modules whose mechanism exists and is tested.

**Reuse map** (v1 `src/`, lines from `wc -l`):

| Fate | Modules (lines) |
|---|---|
| Move mostly as-is (proof core + send) | `parse` (156), `classifier` (41, rule change per §3), `dkim-archive` (122), `verifier` (268, reshaped to record-based re-check), `notary` (109), `ots` (182), `outbound` (194), `dsn` (255), `envelope` (32), `prefilter` (74), `event-mutex` (46) |
| Reshape for M3/M4 | `completion` (249), `sweep` (216), `templates` (236), `notify` (100), `proof-anchor` (152), `router` (131, cut down) |
| Reshape (shared types) | `types` (170): keep and extend the typedefs v2 reuses (trust level, DKIM/auth result shapes, envelope); replace the event/commit-ledger types with the new record and verdict types; drop types that only served dropped modules (crypto sign-off, plus-address command grammar) |
| Rewrite | `gitrepo` (853; every function takes an `eventId`, the ledger's unit is an "event", so a single received email cannot be recorded on its own; v2's unit is the record), `ingest` (708; mixes proof, coordination and gitdone's command grammar), `event-store` (680), `create` (291), `index` (134; the v1 barrel re-exporting about 60 symbols; replaced by per-layer entry points matching the subpath exports, e.g. `mailproof` for the proof core, `mailproof/coordinate`, `mailproof/send`; exports only what is a primitive in `primitives.json` or deliberately public, enforced by the completeness test) |
| Drop / leave to gitdone | `crypto` (205; thresholds/N signers); the reopen/complete lifecycle pair; plus-address command grammar (initiator commands, stats replies, attest+); `verify+`/`reverify+` email endpoints unless M3 revives them |

## 10. Out of scope for all of v2

- Multi-party workflows (gitdone).
- Third-party sending providers (SES, SendGrid, …).
- Web UI or hosted service.
- RPost-style proof of delivery. We prove what was received; a signed reply is the receipt.
- Acting as a login/identity provider. mailproof produces a verdict; acting on it is the consumer's job.
- Writing our own ZK circuits.
- Mail encryption (S/MIME, PGP).
- Spam filtering, or anything like a mail client.
- Any claim of legal admissibility.
- Whole-inbox recording (a later setting, see M1/M6).

## 11. Process

AGENT_RULES applies: no commits to `main`; merging and releasing are the owner's call; dependency
hierarchy vanilla → stdlib → external, with the External Dependency Checklist; types per
LIBRARY_CONVENTIONS (checkJs + strictNullChecks, generated `.d.ts`, never committed); pure ESM;
Node ≥ 22.5.

## 12. Open questions (recorded, not assumed)

1. Is there a public DKIM-key archive for looking up old mail? (Believed: ZK Email runs one; unconfirmed.)
2. Does Gmail sign `In-Reply-To`/`References`? **Answered: yes for Gmail, no for Microsoft, see [F11](findings.md).**
3. Gmail login method: OAuth or app password? (M1 POC)
4. Are Gmail's Sent copies DKIM-signed? **Closed (owner, 2026-11-01): moot.** Own sent records are `unverified` regardless ([F3](findings.md)); the proof of sending is the counterparty's signed copy, and Gmail does sign outbound from the owner's gmail.com address (the batch-3 gmail.com-signed message, [F11](findings.md)).
5. Does Gmail add its own ARC seal / `Authentication-Results` on inbound that could make its SPF verdict portable? (M1 POC)
6. Sending from a normal mailbox in M3 vs the no-third-party-provider rule.
7. Privacy wording for storing other people's addresses and subjects (not legal advice).
8. OTS stamp per sync run vs per email.
9. IMAP as an in-core dependency vs a separate package, if the dependency checklist fails.
10. Portable ARC: an offline re-check of a trusted-sealer ARC chain (archived ARC headers and sealer keys), so `forwarded` could be re-verified later; needs its own spec and POC (findings F7 D1).
