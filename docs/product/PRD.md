# mailproof v2 — PRD

> **Status:** v2 is released through 3.3.0 (2026-11-11, the latest). M0-M2 and M3 are complete: M3 steps 1-3 shipped in 3.0.0, `replyFacts` and the `mailproof` CLI in 3.1.0, and the MCP server (`mailproof mcp`, SPEC B12) in 3.3.0. **M4 (seal and pair export) is built and tested on `feat/m4-export` (steps 1-3, the address-first CLI with `people`, the setup guide; release planned as 3.4.0; Node 22.19 run and reviews pending)**; M5 (a `record` command plus a self-hosting guide) is specified for after M4 (guide reviewed by the gitdone operators, local signing proven, `record` command and the bcc copy test pending); M6 is parked. 1.x is frozen at tag `v1.4.0` (v1 code archived in `archive/v1/`; no `v1` branch).
> **Owner:** hamr0 · **Last updated:** 2026-11-11
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
a local git trail: the signed headers, never the body (since 3.0.0 the raw email is also kept in a local content store outside git, expiring; see §7 M3). Anyone can verify the record offline, at any
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

**Never** the body, never the raw email, in the record. Since 3.0.0 (M3 step 1) the raw email and attachments are stored locally beside the trail by default, outside git and outside the record (§7 M3); the record format is unchanged.

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
- Only self-hosting (M5, [guide](self-hosting.md)) gives signed copies of what I send.

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
- **Out of mailproof, the consumer's job** (§10): the strict-keyword interpreter, the calendar-reply interpreter and the LLM hook that earlier drafts listed here. Interpreting the text (approve/decline, any language, an LLM) is guardrail policy and belongs to bareguard. Calendar replies are dropped along with the old M4 appointments module (decisions-log, 2026-11-11).

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

**Status:** specified 2026-11-08, approvals round added 2026-11-09; **build step 1 shipped in 3.0.0: the local content store, retention and `forget`** ([SPEC B7](SPEC.md), [F22](findings.md)); **build step 2 shipped in 3.0.0: trust profiles, the counterparty view and graded thread links** ([SPEC B5, B8](SPEC.md), [F23](findings.md)); **build step 3 shipped in 3.0.0: prune before date** ([SPEC B9](SPEC.md), [F25](findings.md)); **build step 4 shipped in 3.1.0: `replyFacts`** ([SPEC B10](SPEC.md), [F26](findings.md), [F27](findings.md)); **build step 5 shipped in 3.1.0: the `mailproof` CLI, with `Mailproof#upgradeStamps()` and `prune({ dryRun })`** ([SPEC B11](SPEC.md)); **build step 6, the MCP server, is built on `feat/m3-mcp`, not released** ([SPEC B12](SPEC.md), [F30](findings.md)); a few items still open (see Open below). Reasons and options: [decisions-log](decisions-log.md) entry "M3 scope: one trail per owned account, local content store, prune-before-date, CLI + stdlib MCP". Wire formats go to SPEC Part B when each step is built (B7 is the first).

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

Off by default; an explicit command (`Mailproof#prune`, built in step 3; the CLI comes in step 5). Only "everything captured before date X". Never a range in the middle (that is tampering), and no rotation by period. Mechanism and wire format: [SPEC B9](SPEC.md); the POC that corrected the first draft of these steps: [poc/m3-prune](../../poc/m3-prune/README.md), [F24](findings.md).

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
- **mailproof supplies, consumers decide.** mailproof never interprets or filters on a consumer's behalf. A read primitive, `replyFacts({ messageId })` (built, step 4, [SPEC B10](SPEC.md)), returns one fact bundle per direct reply to that Message-ID (In-Reply-To names it, or it is the last entry of References; never deeper thread members), inbound records only, earliest `captured` first, and `[]` when there is none. It supplies every reply (copies of one signed message are separate bundles sharing `messageKey`); it never picks one. The trust profile stays a separate, optional primitive.
- **The bundle is flat JSON with string values only.** Each flag comes from a closed set, and claimed and proven values are sibling keys. This shape was agreed with bareguard's session: its rubric reads only its own top-level keys, compares strings exactly, and no rule reads booleans or nested objects. Field names are indicative; they are final at build.

The final field list and the closed sets are in [SPEC B10.3](SPEC.md). In short:

| Field | Meaning |
|---|---|
| `messageId`, `messageKey` | Message-ID of the reply (`""` when it has none); `message_key`, which groups copies of one signed message |
| `recordId`, `commit`, `trail`, `captured` | where and when the reply is recorded; `commit` is the commit that added the record (from the trail index) |
| `from`, `fromRaw` | the first From address, lower-cased / exactly as written |
| `fromDomain` | the domain of `from` (after the last `@`, lower-case, one trailing `.` removed; `""` when none). A claim like `from`; subdomains are not folded |
| `fromDkimAligned` | `pass`: an aligned DKIM signature that verifies offline and covers From exists. `fail`: signatures, none qualifies. `none`: no signature |
| `to`, `cc`, `toRaw`, `ccRaw` | claimed addresses, lower-cased / as written; multi-value, `,` with no space |
| `date`, `subject`, `dateSource`, `subjectSource` | the signed value when a verifying signature covers the header, else the raw email's header (subject RFC 2047-decoded), else `""`; the source is `signed`, `claimed` or `none` |
| `dkim`, `dmarc`, `spf`, `arc` | live results at capture, mapped to closed sets (`dkim`: `pass`/`fail`/`none`; the rest add `other`) |
| `live`, `portable` | the two trust levels (`verified`, `forwarded`, `authorized`, `unverified`), not DKIM results |
| `link` | `signed`: the request's Message-ID is in a DKIM-signed In-Reply-To/References. `unsigned`: present but not signed. `none`: absent |
| `text`, `firstLine`, `textSource` | the new reply text (M2) and its first line, read from the content store without writing to the trail; `textSource` is `content`, `none` (no stored email) or `over-limit` |
| `bodyProven`, `quote`, `trailing` | `proven`/`unproven`; `found`/`not-found`/`inline`; `yes`/`no` (text written below the quote, not in `text`) |
| `attachments` | hashes, multi-value |

  **Address fields are supplied normalised.** `from`, `to`, `cc` (and any domain field) are lower-cased, and the contract says so. Reason: bareguard's `in` rule is exact and case-sensitive, so `Ana@Company.com` would not match `ana@company.com` and a genuine approval would be denied. Domains are case-insensitive and mailbox local parts are case-insensitive in practice. The address exactly as written is also supplied as a sibling (`fromRaw`; `toRaw` and `ccRaw` if convenient), so nothing is hidden.

  Multi-value fields (`to`, `cc`, `toRaw`, `ccRaw`, `attachments`) are one string joined with `,` (no space), in header order, `""` for none (SPEC B10.3).
- **`firstLine` is a contract.** Take the new reply text that `replyText` returns (quoted history removed). Split it on any line break (`\r\n`, `\n`, `\r`). Take the first line that is non-empty after trimming. Trim with ECMAScript `String.prototype.trim` (spaces, tabs, NBSP, BOM and other WhiteSpace/LineTerminator characters at both ends). No case folding, no Unicode normalisation. It is `""` when there is no such line. When the text is unproven, `text` and `firstLine` are still supplied and `bodyProven` is `unproven`. When the content store no longer holds the raw email (off, expired, forgotten), they are `""` and `textSource` is `none`.
- **Reference recipe (bareguard side, not mailproof behaviour).** The question email asks the human to reply with an exact approval word chosen by the user (for example `APPROVE`, or any word the user picks) as the first line, and nothing else on that line: the question email must say so. The user-signed rubric uses bareguard's existing `in` rule: `firstLine` in the approval word(s), matched exactly and case-sensitively by default, like a password (bareguard ruling #74, owner decision 2026-11-10; `Mashy` passes only on exactly `Mashy`). Bareguard adds an opt-in `ignoreCase: true` on `in`/`notIn` (bareguard's, being built, not mailproof's): it folds case only (`toLowerCase`), still whole-value, so punctuation, extra words and spacing must match and there is no Unicode normalisation; a real reply `Approved.` matches neither `approve` nor `approved` even with it. For a "trusted sender domain" rule use `fromDomain` in `["company.example", ...]` (each domain listed; `eu.company.example` is not `company.example`) together with `fromDkimAligned` in `["pass"]`: `fromDomain` alone is a claim, and a substring rule on `from` is unsafe (`@company.example` matches `bob@company.example.evil.io`). `ignoreCase` needs bareguard `^0.34.0` (a 0.x caret: `^0.33.0` does not cover it). The rubric also needs `from` in the allowed addresses (write rubric values for `from` in lower case), `fromDkimAligned` in `["pass"]`, `bodyProven` in `["proven"]`, `link` in `["signed"]`. Anything not green is not approved: "I do not approve", any other wording or punctuation, and empty replies all fail. The adapter (bareguard's `humanChannel`) is documented on mailproof's side, because bareguard imports no peers. It sends the question, polls `replyFacts` until the array is non-empty or its own timer fires (set below bareguard's `humanChannelTimeoutMs`; bareguard denies on its timeout but does not cancel the channel), groups the bundles by `messageKey` (copies of one reply), runs bareguard's `checkStep` on each distinct reply, and returns `{decision}`: **ALLOW only when at least one distinct reply is green and none is red; zero replies, all red, or mixed is DENY** (agreed with bareguard's session, 2026-11-10; the rule lives in the adapter, not in mailproof, [decisions-log](decisions-log.md)). A second, contradictory reply (or a flood of replies) can therefore only turn an approval into a denial, never the reverse. One answer per ask: once the adapter has returned a decision, later mail cannot change it. The proof reference goes into bareguard's audit through `reason` (`mailproof:<recordId>@<commit>`) and/or `gate.annotate` meta. Bareguard's approval line drops extra keys today; a first-class field would be a bareguard change and is not needed now.
- **Known limitation, Microsoft (documented; no workaround, no carve-out).**
  - Microsoft does not sign In-Reply-To/References ([F11](findings.md)). A reply from a Microsoft-hosted sender (outlook.com, msn.com, Microsoft 365 business domains) gets `link` = `unsigned`. Its text is still extracted (the stripper recognises Outlook's quote block) and, when received at a Gmail-like mailbox, is still proven.
  - Mail received at an Outlook/Exchange mailbox has altered bodies ([F10](findings.md)), so `bodyProven` is always `unproven` there. Receive approvals at a non-Microsoft mailbox.
  - A strict rubric (`link` in `["signed"]`) rejects Microsoft approvers. A relaxed one (`link` in `["signed","unsigned"]`) accepts them, at a cost: a genuine old approval from the same sender could be re-sent and accepted, because nothing signed ties it to the new question. That choice belongs to the bareguard user.
  - Considered and rejected: a per-question tag in the subject or quoted body (it works, since Microsoft signs Subject, but the owner chose to keep this a known limitation); a tag in git (git only proves what we sent, not what their signed reply answers).

#### Interfaces

- **Library** (exists).
- **One `mailproof` CLI** (SPEC B11). Run with no arguments it shows a readline menu (stdlib, no TUI framework) that prompts for each action's parameters; every menu action is also a subcommand with flags for scripts and cron: `sync`, `watch` (a foreground command, no daemon; run it under systemd --user or cron), `list`, `show`, `verify`, `replies`, `check`, `forget`, `prune`, `backup`, `status`, `update`, `config`, `export`, `mcp`. With more than one account every command needs `--account`; `forget` and `prune` need `--yes` (menu: type the account name). `export` writes the pair bundle (§7 M4 part b) and `verify-bundle` checks one (account-free). The existing `mailproof-sync` bin keeps working.
- **Config:** one JSON file, `~/.config/mailproof/config.json` (XDG; JSON so there is no new dependency), with `accounts` keyed by account name. Per-account fields such as `user`, `host`, `trailDir`, `trail`, `passCommand` | `passFile` | `accessTokenCommand` (never a plain password), `content` (`store`, `attachments`, `days` 730), `ots`, `backupRemote`. Refused unless owned by the user and mode 0600. Runtime state (last runs, logs, backups) lives in `~/.local/state/mailproof/`, never in the config.
- **MCP server inside the same package** (`mailproof mcp`): stdio JSON-RPC written with the stdlib, no MCP SDK dependency. Proven first by a POC against a real MCP client (Claude Code). Switch to the SDK only if the protocol work proves larger; that needs the dependency checklist and an owner decision. Full toolset, all always listed, with tool annotations the client scopes by; tool names = library method names; one server for all accounts (an `account` argument); preview-then-`confirm` for the destructive tools: [SPEC B12](SPEC.md), decisions-log "M3 MCP: stdlib, method names, full toolset with annotations" (2026-11-11; supersedes "starts read-only"). Mailproof never sends mail. **Export through MCP is allowed since 2026-11-12** (owner: "MCP should be on parity with the CLI"; this reverses the earlier "No export or send through MCP" for export): `export` and `backup` preview first and write only under `mcp.outputDir` once called with `confirm: true` (SPEC B12.5 item 2a).
- **One source of truth:** CLI help, MCP tool descriptions and `primitives.json` all come from the same JSDoc.
- **No new runtime dependency for M3.**

#### Build order

1. Content store, retention and `forget`.
2. Trust profiles, counterparty view and graded thread links.
3. Prune before date.
4. `replyFacts`, after the content store and read primitives (steps 1-2); POC on real replies first (F26). **Shipped in 3.1.0** ([SPEC B10](SPEC.md), F27).
5. `mailproof` CLI, config and menu (shipped in 3.1.0; SPEC B11).
6. MCP, after its POC.

Reordered 2026-11-09: `replyFacts` moves ahead of the CLI and MCP, because it needs only steps 1-2 and unblocks bareguard's approval channel. Reasons: [decisions-log](decisions-log.md) entry "M3 build order: `replyFacts` before the CLI and MCP".

POC first where the mechanism is unproven: `replyFacts` on real replies, the stdlib MCP server, and the prune replay. Approvals via bareguard become a recipe on top of steps 2, 4 and 6.

#### Open (not decided)

- **MCP:** shipped in 3.3.0 (SPEC B12, F30); the hint choices (B12.10) still await owner confirmation, and F30 shows Claude Code does not act on the hints, so scoping is by tool name. Elicitation as a real human gate is a later POC.
- **`watch` mechanism:** interval vs IMAP IDLE. A mechanism choice, decided at build.
- **Pair/thread export:** answered 2026-11-11: it ships in M4 (below), not M3 or M6.
- **Observed senders and a real walkthrough:** [F34](findings.md), [F35](findings.md), [F36](findings.md). Microsoft consumer IMAP needs OAuth2 and is untested ([F37](findings.md)).
- **Provider sampling (evidence task, not done):** sample one reply each from Yahoo, iCloud, Proton and Fastmail to see whether they sign In-Reply-To/References. Signing is per-provider configuration; only Gmail and Microsoft are measured.

### M4 — Seal and pair export (specified)

**Status:** steps 1-3 (stamp job, `export`, `verify-bundle`) built and tested on `feat/m4-export` (2026-11-11), plus the address-first CLI and `people` ([decisions-log](decisions-log.md) "Address-first CLI", [F34](findings.md)) and the [setup guide](setup-guide.md); release planned as 3.4.0 (OTS on by default in the library too: decisions-log "OTS on by default in the library too"); the Node 22.19 run and /self-review and /branch-review are pending. Defaults confirmed: decisions-log "M4 export and verify-bundle defaults confirmed". Cost of the stamp job: [F31](findings.md). Reasons and options: [decisions-log](decisions-log.md) entry "M4: drop appointments; seal and pair export". Wire formats go to [SPEC B13](SPEC.md) when each step is built. No POC is needed: both parts are built from existing parts.

**Appointments is dropped.** The old M4 (calendar and iTIP replies) is not built. A meeting confirmed between A and B, with later events (a bill of quantities, a possible commission), is already served by the A<->B trail: `list({ with })`, `counterparties`, `linked`, attachment hashes, OTS and the key archive. An agreement ceremony (send a statement, require a confirm, close it) is the Declaration in signedreply/gitdone, so building it here would copy gitdone. Known limit, documented and not fixed: B's signed reply proves B answered my Message-ID, not what my mail or attachments contained (my Sent copy is unsigned; Microsoft signs From/Date/Subject but not To/In-Reply-To/References and alters bodies, [F11](findings.md)). A later idea, not scheduled: a content-hash token in the Subject, the one header Gmail and Microsoft both sign, to bind a reply to exact content.

#### Part a: the seal (OTS on by default, per batch)

- OTS is **on by default** and stamped **per batch, not per record**. This supersedes the "per record" default of §12 Q8; per record stays an option.
- Capture (`record`, `sync`, `watch`) no longer stamps inside the trail lock.
- A **stamp job** writes a sha256 manifest of the records added since the last stamp, plus the hash of the previous manifest (a chain), commits it, and OTS-stamps the manifest once. The same pass upgrades older pending stamps (today's `upgradeStamps`).
- **Cadence:** due every 6 hours (configurable, for example 12). `sync` and `watch` run it when the last stamp is at least that old (the same pattern as the content sweep's `sweepDays`: no timer). An explicit `mailproof stamp` command and library method always run it.
- A missing `ots` binary never blocks capture: record and flag (accept-with-flag).
- A record finds its `.ots` through the manifest that lists it. The manifest shows other records only as hashes.
- OTS time is "no later than", up to the cadence after capture. The git commit keeps the exact capture time.

#### Part b: pair export

- `export({ with: [addresses], after?, before? })` and the CLI `export` (built; it replaced the exit-64 stub). Selection is one or more exact addresses, matched the way `list({ with })` matches them (From/To/Cc/Reply-To, one definition), plus a date range on `captured`.
- The bundle holds only what the trail has: the matching records (signed headers, verdicts, attachment names and sha256), their archived keys, their reply-text records, the stamp manifests that list them with their `.ots`, and a README saying per record what is proven and what is best effort.
- Raw emails and attachments are **not copied**. Each record says whether its content is still in the owner's content store (with the id and sha256 to fetch it by `rawEmail` / `attachment`) or expired or forgotten.
- The recipient checks it with `npx mailproof verify-bundle <dir>`: the same verifier code, one source of truth, no copied standalone verifier.
- Export stays off in MCP (SPEC B12).

#### Build order

1. Stamp job (manifest chain, cadence, `mailproof stamp`, default on).
2. `export`.
3. `verify-bundle`.

#### Out of scope for M4

Calendar or iTIP handling; an agreement ceremony; raw email or attachment copies in a bundle; a standalone verifier; ZK (M6); signed own sends (M5).

After M4 the v2 promise of §1 and §2 is met. "I sent you this" without a reply stays partial until signed own sends exist (M5).

### M5 — Hosting your own (specified, after M4)

**Status:** re-scoped 2026-11-11 by the owner. Reasons and options: [decisions-log](decisions-log.md) entry "M5: a record command and a self-hosting guide, not a Docker image". Two deliverables, built after M4:

1. **`mailproof record --direction in|out`**: a small CLI command that reads one raw email from stdin and calls the existing `record()` (outline: [SPEC B14](SPEC.md)). It is in the npm package like every other command.
2. **A self-hosting guide**, [`self-hosting.md`](self-hosting.md): the step-by-step setup of the user's own Postfix + OpenDKIM server that signs their outbound mail and pipes every mail in and out into `mailproof record`. A guide in `docs/`, **never code in the npm package**.

**No Docker image.** The hard parts (DNS, PTR, port 25, IP reputation) cannot be containerised, and an image would make mailproof a mail-server product to patch. In-library signing (mailauth's `dkimSign`) stays an option, not the default: the key stays in the MTA. Prior art: the gitdone operators' records and knowless `OPS.md` §5 (knowless declined to host anything, 2026-11-11).

**Evidence so far (gitdone operators, real box, 2026-11-11; [F32](findings.md), review [F33](findings.md)):** a locally submitted, locally delivered copy of an outbound message carries OpenDKIM's `DKIM-Signature` and verifies. The OpenDKIM default `h=` lists only `From:To:Subject:Date:From`, so the guide sets `SignHeaders` (Message-ID, In-Reply-To, References, ...) explicitly; that line is recommended, not yet tested. **One open evidence task:** prove on a real box, end to end with `mailproof record` and `mailproof verify`, that the `sender_bcc_maps` copy carries the DKIM-Signature (strongly implied by the mechanism: the same queue file; not tested). The guide's "verified and unverified" table tracks every other step.

**Guide choices:** decisions-log "M5 guide choices". **Open (not covered yet):** sending from a mail client. The guide covers local `sendmail(8)` submission only, which is what a real box proves; a submission service (port 587, SASL, `smtpd_sender_login_maps` with `reject_sender_login_mismatch` so signing and the BCC copy apply only to authenticated senders) is a later addition (owner scope decision, 2026-11-11).

**Out of scope:** an image, a mail-server product, sending (mailproof never sends mail), multi-user hosting.

### M6 — Zero-knowledge disclosure (PARKED)

Parked until a real user asks. The headers-only export moved into M4. What stays is the ZK one-bit-out level: ZK Email's circuits in a separate package (`mailproof-zk`), never our own circuits. Owner's related projects follow the same rule: proof in, one bit out; the crypto is never ours. Unconfirmed: whether google/longfellow-zk (used by the 8een project) can handle RSA DKIM; ZK Email targets RSA DKIM.

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
| Reshape for M3 (M4 is now seal + export, not appointments) | `completion` (249), `sweep` (216), `templates` (236), `notify` (100), `proof-anchor` (152), `router` (131, cut down) |
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
8. OTS stamp per sync run vs per email. **Decided (owner, 2026-11-03): per record, as today; advise OTS off for backfills, see [SPEC B4.5](SPEC.md). Superseded 2026-11-11 (M4): on by default, stamped per batch; per record stays an option, see [M4](#m4--seal-and-pair-export-specified) and [SPEC B13](SPEC.md).**
9. IMAP as an in-core dependency vs a separate package, if the dependency checklist fails. **Decided (owner, 2026-11-03): in core as the third dependency (checklist passed, [F16](findings.md)), see [SPEC B4.6](SPEC.md).**
10. Portable ARC: an offline re-check of a trusted-sealer ARC chain (archived ARC headers and sealer keys), so `forwarded` could be re-verified later; needs its own spec and POC (findings F7 D1).
