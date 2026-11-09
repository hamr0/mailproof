# mailproof v2 — PRD

> **Status:** v2 is released as 2.2.0 (M0, M1 and M2 shipped). M3 is specified (2026-11-08), not built. 1.x is frozen at tag `v1.4.0` (v1 code archived in `archive/v1/`; no `v1` branch).
> **Owner:** hamr0 · **Last updated:** 2026-11-08
>
> **For future Claude:** this PRD wins on intent and scope. The *why* behind each choice is in
> [`decisions-log.md`](decisions-log.md). The v1 PRD is archived at
> [`../../archive/v1/docs/PRD.md`](../../archive/v1/docs/PRD.md); `DESIGN.md` and `SPEC.md` still describe v1 and are
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
- the **address list** (`addresses`, M3): every From/To/Cc/Reply-To address of the header block, each marked signed or unsigned (SPEC B1); absent on older records and on a refused over-limit message;
- direction (in/out), capture source, capture time.

**Never** the body, never the raw email, in the record. From M3 (planned) the raw email and attachments are stored locally beside the trail by default, outside git and outside the record (§7 M3); the record format is unchanged.

**What this proves later**

- Anyone can re-check the signature offline, forever (key is archived). That proves
  From/To/Subject/Date/Message-ID came from that domain.
- If the body turns up later (still in the mailbox, or an `.eml`), it is hashed and compared to `bh=`;
  a match upgrades the record to a **full proof**.
- Attachment hashes are self-recorded at capture and timestamped. They are tied to the signature only
  if the body is produced.

**Costs and caveats**

- Signed headers must be stored verbatim. We cannot hash the subject and still re-check.
- They include other people's addresses and the subject. Privacy note: [usage-guide](usage-guide.md#what-mailproof-stores-about-other-people) (§12 Q7; not legal advice).
- A signature with an `l=` (body length) tag leaves part of the body unsigned. The record flags it.
- Unsigned mail is still recorded (v1's "commit every message, flag it" idea), with verdict
  `unverified` and minimal metadata.

**Contrast with v1.** v1's `verify()` needed the user to bring the email back
(`findMatch(candidateBytes, commits)` in `archive/v1/src/verifier.js`) because v1 stored only salted hashes and no
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

**Status:** shipped in 2.1.0; see [SPEC B4](SPEC.md) and [F17](findings.md).

A `sync` run (cron/systemd timer first; a long-running IMAP IDLE watcher later) over **one Gmail label
or folder plus Sent**, via IMAP. The owner's Gmail account is the target. Resumes where it left off,
no duplicates. The existing Postfix pipe stays as a capture source.

IMAP needs a **third runtime dependency** (candidate: `imapflow`, same author as mailauth/mailparser).
It must pass the AGENT_RULES External Dependency Checklist, and it reaches the ≤3 runtime-dep ceiling. (The ceiling was later lifted by the owner on 2026-11-07 for a fourth dependency, `better-sqlite3`, behind the trail index: [decisions-log](decisions-log.md), [SPEC B5](SPEC.md).)

**POC:** fetched mail still verifies; which Gmail
login method works (Gmail Sent-copy signing is moot, [F3](findings.md)). Already known: msn.com Sent copies are unsigned ([F3](findings.md)); Outlook/Exchange mail
exported via Thunderbird has altered bodies, so M1 is Gmail-first (F4).

### M2 — Reply text (shipped)

**Status:** shipped in 2.2.0 as `Mailproof#replyText` (stripper `mailproof-quote/1`); wire format [SPEC B6](SPEC.md), evidence [F20](findings.md).

**Re-scoped 2026-11-07** from "Reading replies"; see the [decisions-log](decisions-log.md) entry "M2 is reply text, not reply interpretation".

**Goal:** given a recorded reply and its raw bytes, return only the text the sender newly wrote (quoted history removed), plus proof that this text came from that signed email. The chain: the text comes from the body; the body matches the DKIM `bh=`; the signature is the sender domain's. The trap: a reply quoting "Approve payment of $5,000?" read as an approval.

- Stripping is **deterministic and versioned** (e.g. `mailproof-quote/1`): anyone with the raw email re-runs it and gets the same text byte for byte.
- Only quoted history is stripped. **Signatures are not stripped**: it is text the sender wrote, and detecting it is another fragile heuristic. The consumer can ignore it.
- **Out of mailproof, the consumer's job** (§10): the strict-keyword interpreter, the calendar-reply interpreter and the LLM hook that earlier drafts listed here. Interpreting the text (approve/decline, any language, an LLM) is guardrail policy and belongs to bareguard. A calendar reply is not dropped as a concept; if needed it belongs with M4.

**Honest limits, built into the output**

1. The text counts as **proven only when `body_status` is `matched`**. `partial` (an `l=` signed prefix) is unproven in v1: mapping the signed canonical byte count onto the decoded text is not proven, so it fails closed; revisit with evidence (the 3 Foxmail samples in [F20](findings.md) were `partial`). Outlook/Exchange-received copies have bodies altered on Microsoft's side ([F4](findings.md), [F10](findings.md)): their text is returned but marked unproven, never silently.
2. No quote boundary found: return the whole body, flagged `quote: not-found`. Never guess.
3. Inline replies (answers written inside the quote) are detected and flagged `quote: inline`, not merged. The POC measures how common they are.
4. Unquoted text that follows the quoted part (a signature below the quote, or bottom-posted text) is not returned: the text is what is above the first quote boundary. When such text exists the result carries `trailing: true`, so nothing is dropped silently and nothing is merged (9 of 23 real replies, all Thunderbird, [F20](findings.md)). The consumer who needs it reads the raw email.

**Reply-text record** (wire format: [SPEC B6](SPEC.md)). One small record is committed to the trail per extraction:

```json
{ "v": 2, "kind": "reply-text", "record_id": "...", "text_sha256": "...", "text_bytes": 0,
  "stripper": "mailproof-quote/1", "quote": "found|not-found|inline", "trailing": false,
  "source": "text/plain|html-only", "boundary": "...|null", "body_status": "...", "extracted_at": "..." }
```

It stores no text, no body bytes and no subject (the trail stays header-only). In a dispute the consumer shows the text it acted on; its hash matches `text_sha256` in a commit dated before the action; with the raw email anyone re-runs the same stripper version.

**Started with** ledger item C2 (`list`/`copies` read every record, measured in [F18](findings.md)): done, they now answer from a rebuildable SQLite index ([SPEC B5](SPEC.md), [F19](findings.md)).

**POC (done: GO, owner-reviewed 2026-11-07, [F20](findings.md)):** quote stripping on real replies from real clients (Gmail web, the Gmail app, Outlook/msn, iPhone where available), including a short top reply and an inline answer. Real samples stay outside the repo.

### M3 — Two-party record (specified)

**Status:** specified 2026-11-08, approvals round added 2026-11-09; **build step 1 built 2026-11-09 (not released): the local content store, retention and `forget`** ([SPEC B7](SPEC.md), [F22](findings.md)); **build step 2 built 2026-11-09 (not released): trust profiles, the counterparty view and graded thread links** ([SPEC B5, B8](SPEC.md), [F23](findings.md)); **build step 3 built 2026-11-09 (not released): prune before date** ([SPEC B9](SPEC.md), [F25](findings.md)); the rest is not built; a few items still open (see Open below). Reasons and options: [decisions-log](decisions-log.md) entry "M3 scope: one trail per owned account, local content store, prune-before-date, CLI + stdlib MCP". Wire formats go to SPEC Part B when each step is built (B7 is the first).

**Goal.** M3 makes mailproof a two-party record for three use cases on one substrate:

- **(a) Approval channel for agents.** First user: bareguard's `humanChannel` hook.
- **(b) Request/reply on record.** "I sent you this, you replied."
- **(c) A record of agreement or communication between two people.** Appointments, document exchange, and agent audit replay: when an agent receives or reads an email in a flow, the email can be verified at $0, locally, and re-verified later.

mailproof records everything, always, in and out. The use cases are read-side primitives and policies over the same record. Multi-party stays in gitdone/signedreply.com.

#### Trail and counterparties

- **One trail (one git) per email account the user owns.** Every counterparty of that account lands in that account's trail.
- Separate accounts (business, personal) are separate trails, never merged.
- Addresses that deliver into the same mailbox (a send-as alias, a plus-address) are the same trail.
- **A counterparty is one exact email address.** `bob@gmail.com` and `bob@company.com` are different counterparties. There is no grouping or aliasing. DKIM proves a domain or an address, not a person.
- **Organisation inside a trail is unchanged:** one commit per email (each copy), one linear branch, `records/<id[0:2]>/<id>.json`, sharded by the first two hex chars of the id so a commit's git tree write stays small ([SPEC B3](SPEC.md), F24). No branch or folder per counterparty (a CC'd mail would need two homes, creating them on receive happens inside the lock, and threads cross structures).
- **Retrieval goes through the rebuildable SQLite index** ([SPEC B5](SPEC.md)). It gains participants (record, address, role: from/to/cc/reply-to as available) and thread links (Message-ID, In-Reply-To, References). Each record proves itself (signed headers, archived key, verdicts, OTS); git supplies the append-only history of the whole account.

#### Linked emails

Threading is not a core feature. mailproof reports "these emails look linked" with a graded **link strength**, and never asserts "this is definitely the reply chain":

- **signed link:** In-Reply-To/References are inside the DKIM `h=` list;
- **unsigned link:** present but not signed (for example Microsoft senders, [F11](findings.md));
- **none.**

Best effort, offered when available.

#### Local content store

- **On by default.** Stores the raw email (keyed by record id, which is already the sha256 of the raw bytes, so reading it back self-verifies) and attachments (keyed by their sha256, already in the record; stored once however often they are sent).
- **Separate opt-outs per account:** content, and attachments on their own.
- **Placement:** beside the trail, outside git (so an exported or shared proof never carries content), and not inside the SQLite index. The index is a disposable cache; content is primary data, and after the mailbox deletes the email it is the only copy. Files are write-once.
- **What it enables:** primitives work offline forever: `replyText(id)` without re-supplying raw bytes, `matchBody`, reading old threads, audit replay.
- **"Proof only" accounts** (content off) keep today's behaviour: the caller supplies the raw bytes.
- This changes §4's "never the raw email" for local storage only; the record format is unchanged.

#### Retention and forget

- **Content retention per account in days, default 730 (2 years).** Expired content is deleted automatically.
- **Proof records are permanent.** Signed headers, the from/to/cc/reply-to address list (every address, signed or not, each marked; absent on an over-limit record), subject, date, verdicts, archived keys and hashes stay. mailproof never deletes proof on its own.
- **`forget`** is the same content deletion, earlier, for one email (and per counterparty or date range as a convenience).
- **After content is gone:** the headers still re-verify offline; `body_status` stays a recorded fact but can no longer be re-checked; `replyText` text and attachments are gone, only hashes remain. Anyone who later produces the raw email (sha256 = record id) or the attachment (sha256 match) gets everything re-verified. Caveat: a short reply's text hash is guessable.
- Privacy note: [usage-guide](usage-guide.md#what-mailproof-stores-about-other-people).

#### Prune before date

Off by default; an explicit command (`Mailproof#prune`, built in step 3; the CLI comes in step 4). Only "everything captured before date X". Never a range in the middle (that is tampering), and no rotation by period. Mechanism and wire format: [SPEC B9](SPEC.md); the POC that corrected the first draft of these steps: [poc/m3-prune](../../poc/m3-prune/README.md), [F24](findings.md).

1. **Plan without blocking writers.** Build the pruned trail from a snapshot of HEAD with no trail lock, so `record()` and `sync()` carry on; take the trail lock (and the sync lock) only to append the commits made since and swap. The cutoff is the longest *prefix* of history in which every record is before the date: a record captured earlier but committed after a later one (a clock step) is **kept** and reported as a straggler.
2. Write a new first commit, the **prune notice**: cutoff date, previous HEAD hash, records removed, kept, stragglers and dropped commits, and the notices of earlier prunes (cumulative). Its tree is not empty: it holds `trail.json` and the archived keys that kept records still need (a key first committed with a removed record but named by a kept one).
3. Replay each kept commit onto it with its original message, author and date, removing the pruned records' files (record JSON, `.ots`, reply-text records, archived keys no kept record names) from every tree. A kept commit that then touches nothing (a reply-text commit for a removed record) is **dropped**, not replayed empty.
4. Re-verify every kept record offline (`verifyRecord`) and **report** the result; a record that does not verify is listed, never a reason to stop (accept-with-flag, and the files are byte-identical so the prune cannot have changed the outcome). OTS stamps are left byte-identical (`ots` is not run).
5. Build in a separate directory and swap with a **journal**: the swap is two renames with a moment in between when no trail exists, so every trail-lock holder first finishes or undoes an interrupted swap (a writer in that gap would otherwise create a fresh empty trail). A crash at any point leaves exactly the old trail or exactly the pruned one. The old trail stays as `<trail>.pre-prune-<date>` until the user deletes it (or passes `deleteBackup`).
6. After the swap: **rewrite the sync cursor's `head`** to the new HEAD (otherwise `sync` sees a rewritten trail, rescans every folder and records the removed mail again, undoing the prune); delete the removed records' content from the content store (raw emails with no record in the new HEAD, then attachments no remaining email lists). The index rebuilds on the next read by itself; content expiry's "history was rewritten" abort is unchanged.

Commit ids after the cutoff change. Kept record files, DKIM proofs, keys, OTS stamps and content are byte-identical. A cutoff that removes nothing is a no-op (no rewrite, no backup); one that would remove every record is refused. Time is about quadratic in the commit count on git's side; the sharded layout puts it at minutes for tens of thousands of records (F25). "Removed" is only true once the backup is deleted.

#### Trust profiles and graded proof

- **Trust profile:** a read-side policy primitive. It sets allowed senders or domains (for example only `@gmail.com`), required checks (DKIM aligned, DMARC, SPF, ARC), required body level (proven / partial / any) and required link strength. Agents use it to gate which email they act on. It is local, deterministic and costs nothing, and can be re-evaluated later on the same record (audit replay).
- **Graded proof per part:** the email and each attachment have separate results ("email valid, attachment is not the one recorded").

#### Approvals and the fact bundle

Owner decisions, 2026-11-09. Reasons and options: [decisions-log](decisions-log.md) entry "M3 approvals: mailproof never sends; supplies a flat fact bundle; bareguard decides".

- **mailproof never sends email.** It silently shadows the mailbox. Whoever starts an exchange (an agent, bareguard's approval recipe) sends the question with its own tools from the user's own account, ideally setting its own Message-ID. mailproof records the request from Sent and the reply from Inbox like any other mail. The "no third-party sending provider" rule stays intact (§12 Q6).
- **mailproof supplies, consumers decide.** mailproof never interprets or filters on a consumer's behalf. A new read primitive, `replyFacts({ messageId })` (name proposed), returns a fact bundle for the reply to that Message-ID, or null when there is none. It comes later, after the content store and the read primitives exist. The trust profile stays a separate, optional primitive.
- **The bundle is flat JSON with string values only.** Each flag comes from a closed set, and claimed and proven values are sibling keys. This shape was agreed with bareguard's session: its rubric reads only its own top-level keys, compares strings exactly, and no rule reads booleans or nested objects. Field names are indicative; they are final at build.

| Field | Meaning |
|---|---|
| `messageId` | Message-ID of the reply |
| `recordId`, `commit`, `trail` | where the reply is recorded |
| `from` | claimed From address, lower-cased |
| `fromRaw` | the From address exactly as written |
| `fromDkimAligned` | `pass`, `fail` or `none`: proven |
| `to`, `cc` | claimed addresses, lower-cased |
| `toRaw`, `ccRaw` | the same addresses exactly as written (if convenient) |
| `date`, `subject` | claimed headers |
| `dkim`, `dmarc`, `spf`, `arc`, `live`, `portable` | mailproof's existing string verdicts |
| `link` | `signed`: the request's Message-ID is in a DKIM-signed In-Reply-To/References. `unsigned`: present but not signed. `none`: absent |
| `text` | the new reply text (M2) |
| `firstLine` | see below |
| `bodyProven` | `proven` or `unproven` |
| `quote` | `found`, `not-found` or `inline` |
| `attachments` | hashes, as one string |

  **Address fields are supplied normalised.** `from`, `to`, `cc` (and any domain field) are lower-cased, and the contract says so. Reason: bareguard's `in` rule is exact and case-sensitive, so `Ana@Company.com` would not match `ana@company.com` and a genuine approval would be denied. Domains are case-insensitive and mailbox local parts are case-insensitive in practice. The address exactly as written is also supplied as a sibling (`fromRaw`; `toRaw` and `ccRaw` if convenient), so nothing is hidden.

  Multi-value fields (`to`, `cc`, `attachments`) are one string with a stated separator, decided at build and documented then.
- **`firstLine` is a contract.** Take the new reply text that `replyText` returns (quoted history removed). Split it on any line break (`\r\n`, `\n`, `\r`). Take the first line that is non-empty after trimming. Trim with ECMAScript `String.prototype.trim` (spaces, tabs, NBSP, BOM and other WhiteSpace/LineTerminator characters at both ends). No case folding, no Unicode normalisation. It is `""` when there is no such line. When the text is unproven, `text` and `firstLine` are still supplied and `bodyProven` is `unproven`.
- **Reference recipe (bareguard side, not mailproof behaviour).** The question email asks the human to reply with an exact approval word chosen by the user (for example `APPROVE`) as the first line. The user-signed rubric uses bareguard's existing `in` rule: `firstLine` in the approval word(s) (exact, case-sensitive), `from` in the allowed addresses (write rubric values for `from` in lower case), `fromDkimAligned` in `["pass"]`, `bodyProven` in `["proven"]`, `link` in `["signed"]`. Anything not green is not approved: "I do not approve", unlisted lower-case variants and empty replies all fail. The adapter (bareguard's `humanChannel`) is documented on mailproof's side, because bareguard imports no peers. It sends the question, polls `replyFacts` until non-null or its own timer fires (set below bareguard's `humanChannelTimeoutMs`; bareguard denies on its timeout but does not cancel the channel), runs bareguard's `checkStep` on the bundle, and returns `{decision}`. One answer per ask: later mail cannot change a returned decision. The proof reference goes into bareguard's audit through `reason` (`mailproof:<recordId>@<commit>`) and/or `gate.annotate` meta. Bareguard's approval line drops extra keys today; a first-class field would be a bareguard change and is not needed now.
- **Known limitation, Microsoft (documented; no workaround, no carve-out).**
  - Microsoft does not sign In-Reply-To/References ([F11](findings.md)). A reply from a Microsoft-hosted sender (outlook.com, msn.com, Microsoft 365 business domains) gets `link` = `unsigned`. Its text is still extracted (the stripper recognises Outlook's quote block) and, when received at a Gmail-like mailbox, is still proven.
  - Mail received at an Outlook/Exchange mailbox has altered bodies ([F10](findings.md)), so `bodyProven` is always `unproven` there. Receive approvals at a non-Microsoft mailbox.
  - A strict rubric (`link` in `["signed"]`) rejects Microsoft approvers. A relaxed one (`link` in `["signed","unsigned"]`) accepts them, at a cost: a genuine old approval from the same sender could be re-sent and accepted, because nothing signed ties it to the new question. That choice belongs to the bareguard user.
  - Considered and rejected: a per-question tag in the subject or quoted body (it works, since Microsoft signs Subject, but the owner chose to keep this a known limitation); a tag in git (git only proves what we sent, not what their signed reply answers).

#### Interfaces

- **Library** (exists).
- **One `mailproof` CLI.** Run with no arguments it shows a simple readline menu (stdlib, no TUI framework). The same actions are subcommands for scripts and cron: `sync`, `watch`, `list` (for example `--with <address>`), `show`, `verify`, `export`, `forget`, `prune`, `status`, `mcp`. `export` depends on M6's proof bundle (§7 M6). The existing `mailproof-sync` bin keeps working.
- **Config:** a JSON file per user (for example `~/.config/mailproof/accounts.json`; JSON so there is no new dependency). Per-account fields such as `user`, `host`, `trailDir`, `trail`, `passCommand`, `contentDays` (730), `storeContent`, `storeAttachments`.
- **MCP server inside the same package** (`mailproof mcp`): stdio JSON-RPC written with the stdlib, no MCP SDK dependency. Proven first by a POC against a real MCP client (Claude Code). Switch to the SDK only if the protocol work proves larger; that needs the dependency checklist and an owner decision. It starts read-only: verify, show, list, check a record against a trust profile, "did X reply to my request". No forget, export or send through MCP without a human gate.
- **One source of truth:** CLI help, MCP tool descriptions and `primitives.json` all come from the same JSDoc.
- **No new runtime dependency for M3.**

#### Build order

1. Content store, retention and `forget`.
2. Trust profiles, counterparty view and graded thread links.
3. Prune before date.
4. `mailproof` CLI, config and menu.
5. MCP, after its POC.
6. `replyFacts`, after the content store and read primitives (steps 1-2).

POC first where the mechanism is unproven: the stdlib MCP server, and the prune replay. Approvals via bareguard become a recipe on top of steps 2, 5 and 6.

#### Open (not decided)

- **MCP write tools** and their human gate.
- **`watch` mechanism:** interval vs IMAP IDLE. A mechanism choice, decided at build.
- **Pair/thread export:** whether a minimal one ships in M3 or waits for M6.
- **Provider sampling (evidence task, not done):** sample one reply each from Yahoo, iCloud, Proton and Fastmail to see whether they sign In-Reply-To/References. Signing is per-provider configuration; only Gmail and Microsoft are measured.

### M4 — Appointments (highlights)

Calendar replies, propose/accept back-and-forth, reminders. Built on M3. (M3's CLI `export` waits on M6's proof bundle.)

### M5 — Hosting your own (highlights)

Postfix + opendkim, capture via pipe, signing your own outgoing mail. Shipped as a Docker image or
privcloud module, **not inside the npm package** (mailproof must not become a mail server). Signing
default is opendkim (key stays in the MTA); in-library signing via mailauth's `dkimSign` is an option.

### M6 — Proof export, then ZK (highlights)

Export a self-contained proof bundle (M3's CLI `export` command depends on it). Disclosure levels: **full email** / **headers-only** (no ZK) /
**ZK one-bit-out** using ZK Email's circuits in a separate package (`mailproof-zk`), never our own
circuits. Owner's related projects follow the same rule: proof in, one bit out; the crypto is never
ours. Unconfirmed: whether google/longfellow-zk (used by the 8een project) can handle RSA DKIM; ZK
Email targets RSA DKIM.

**Recording scope.** M1 capture of INBOX plus Sent already records mail in and out (M3: "record everything, always"). Capturing all folders stays a config option on M1's capture code, not a separate module.

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
frozen at tag `v1.4.0`; the v1 code is archived in `archive/v1/` (no `v1` branch). **No compatibility layer** for 1.x's
`create()` (the only known user is the frozen `mailproof-probe`). POCs only where the mechanism is
unproven (M0, M1, M2), not for modules whose mechanism exists and is tested.

**Reuse map** (v1 `archive/v1/src/`, lines from `wc -l`):

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
- Interpreting reply text (approve/decline, keywords, an LLM): the consumer's job. M2 returns the new text with proof.
- Writing our own ZK circuits.
- Mail encryption (S/MIME, PGP).
- Spam filtering, or anything like a mail client.
- Any claim of legal admissibility.
- Per-record proof erasure, deleting a date range in the middle of a trail, trail rotation by period, and a separate git per counterparty.
- (In scope since M3: content forget/expiry and prune-before-date.)

## 11. Process

AGENT_RULES applies: no commits to `main`; merging and releasing are the owner's call; dependency
hierarchy vanilla → stdlib → external, with the External Dependency Checklist; types per
LIBRARY_CONVENTIONS (checkJs + strictNullChecks, generated `.d.ts`, never committed); pure ESM;
Node ≥ 22.19 (`Worker#cpuUsage`, see F15).

## 12. Open questions (recorded, not assumed)

1. Is there a public DKIM-key archive for looking up old mail? (Believed: ZK Email runs one; unconfirmed.)
2. Does Gmail sign `In-Reply-To`/`References`? **Answered: yes for Gmail, no for Microsoft, see [F11](findings.md).**
3. Gmail login method: OAuth or app password? **Answered for app passwords: `AUTHENTICATE PLAIN` over TLS works on the owner's account; OAuth not tested, see [F17](findings.md).**
4. Are Gmail's Sent copies DKIM-signed? **Closed (owner, 2026-11-01): moot.** Own sent records are `unverified` regardless ([F3](findings.md)); the proof of sending is the counterparty's signed copy, and Gmail does sign outbound from the owner's gmail.com address (the batch-3 gmail.com-signed message, [F11](findings.md)).
5. Does Gmail add its own ARC seal / `Authentication-Results` on inbound that could make its SPF verdict portable? **Answered: yes on 8/8 inbound copies (google.com ARC set plus Authentication-Results with spf=); whether to use it is open, see [F17](findings.md).**
6. Sending from a normal mailbox in M3 vs the no-third-party-provider rule. **Answered 2026-11-09: mailproof does not send.** The initiator sends with its own tools; the rule stays intact, see M3 "Approvals and the fact bundle".
7. Privacy wording for storing other people's addresses and subjects (not legal advice). **Answered 2026-11-08:** see the note [What mailproof stores about other people](usage-guide.md#what-mailproof-stores-about-other-people).
8. OTS stamp per sync run vs per email. **Decided (owner, 2026-11-03): per record, as today; advise OTS off for backfills, see [SPEC B4.5](SPEC.md).**
9. IMAP as an in-core dependency vs a separate package, if the dependency checklist fails. **Decided (owner, 2026-11-03): in core as the third dependency (checklist passed, [F16](findings.md)), see [SPEC B4.6](SPEC.md).**
10. Portable ARC: an offline re-check of a trusted-sealer ARC chain (archived ARC headers and sealer keys), so `forwarded` could be re-verified later; needs its own spec and POC (findings F7 D1).
