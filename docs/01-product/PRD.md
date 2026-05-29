# mailproof — Product Requirements Document (PRD)

**Status:** `0.7.0` published to npm — the first library release (pre-1.0, pre-P2). P0 (POC) complete; **P1 (lift) is COMPLETE, and the two surfaces on top of it — m7c (verification) and m7d (triggers) — are COMPLETE.** Next is **P2** (validate by rebuilding gitdone on mailproof, non-merging branch; §7.1). A consumer can now `create()` a bound instance and `ingest()` inbound replies end to end. Lifted: verify (`classifier.js`), the inbound decoder (`parse.js` — `authenticateMessage` over `mailauth` + `parseMessage` over `mailparser`, m7a; mailproof's **2 runtime deps**, both required because verifying/parsing untrusted mail is security-critical), sequence routing (`router.js`, trimmed to kernel tags), inbound preprocessing (`prefilter.js`, `envelope.js`), outbound triggers (`outbound.js`, config-injected), the full storage/ledger pillar (`event-store.js` + `event-mutex.js` + `gitrepo.js` + optional `ots.js`, factory-injected; the git ledger talks to the `git` binary via `child_process`, no `simple-git`), **both sequencing engines** (`completion.js` — workflow subset, one `dependsOn` model — and `crypto.js` — the parameterized sign-off engine, m6.7), the document notary (`notary.js` — `verifyDocument` + the canonical `hashDocument`, with the mandatory inbound **auto-hash capture** wired through `parseMessage`, §4.1), and **the assembly** (`create.js` + `ingest.js`, m7b-3): `create()` composes the pillars over one `dataDir`; `ingest()` runs prefilter→decode→classify→route→commit-always (accept-with-flag)→advance→persist→`commitCompletion`→trigger the next neutral email, with one optional `composeNotification` hook. ~237 `node --test` tests pass. **m7c (the verification surface) is COMPLETE:** durable DKIM-key archive + DKIM/SPF/DMARC/ARC summaries on every commit (m7c-1, gitdone parity), the offline verifier `core.verify()` (m7c-2 — match a forwarded email/doc to a commit + re-verify DKIM against the *archived* key, so it holds even with live DNS down), `core.reverify()` (m7c-3 — contested-commit re-evaluation + trust upgrade, persisted as an immutable record), a kitchen-sink e2e proving both modes compose end to end (m7c-5), and OTS-proof verification (m7c-4 — `createOts().upgradeProof`/`readBlockHeight` + the pure `parseOtsBlockHeight`, ported from gitdone's `bin/ots-upgrade.js`: fold the Bitcoin attestation into a pending `.ots` and read the anchored block offline, never `ots verify`). With m7c-4, the **9-point gitdone-rebuild capability checklist is fully covered**. **m7c-6 wires the verify primitives into the inbound email path:** `ingest()` routes the public `verify+<id>@` (read-only match + DKIM re-verify against the archived key — never commits) and `reverify+<id>-<seq>@` (contested-commit re-eval — persists its own immutable record), each emitting a neutral `verify_report`/`reverify_report` occasion (report prose is policy, §8.6); the forwarded original is recovered transiently via `parse.extractVerifyCandidates`. The verification surface is now reachable from email (gitdone parity, emails.md #19/#20), bringing the occasion taxonomy to **12 kinds**. **m7d — the trigger pillar widens** from "fire the next email" to *emit every kernel-derivable occasion* (state/time/bounce) as a neutral-templated `kind` over the `composeNotification` hook; branding stays policy (§8.6). **m7d-1 → m7d-4 have landed:** the notification seam is now a shared `createNotifier`/`deliver` (every occasion fires through one seam); `create()` exposes `sweep({ now? })` emitting the time-driven `overdue` (idle nudge) + `archived` (auto-archive transition, ledger-mirrored) occasions (`overdueDays`/`archiveDays`, 14/45, ported from gitdone's `sweep.js`); the bound `activateEvent`/`editEvent` emit the organiser-action occasions `activation` (kickoff to initially-eligible participants / signers, once) and `reassigned` (participant moved onto a currently-eligible step); `ingest()` recognises an inbound **DSN bounce** (`dsn.js`, pure RFC 3464 parser), routes it by the plus-tag return path, records the per-step send error, and emits `bounce` to the initiator (operational, never committed to the ledger); and `create()` exposes `upgradeProofs({ now? })` — when `otsBin` is configured — that drives m7c-4's `ots.upgradeProof` across every event's `.ots` proofs, records the anchored state into the ledger (`gitrepo.commitProofUpgrade` patches each commit JSON with `ots_anchored`/`ots_anchored_at`/`ots_block`), and emits `proof_anchored` on a fresh full-anchor transition. The pending-activation TTL/reminder is reclassified as consumer policy (it presupposes the magic-link self-activation UX mailproof dropped; see the decisions log). **m7d-5 has landed (m7d is COMPLETE):** the completion-edge `composeNotification(ctx)` carries `countedCommits` + a `receipts` array (one per counted reply commit, ordered by sequence — `{sequence, received_at, step_id, sender_domain, sender_hash, trust_level}` — ledger-sourced, salted-hashed, enough to render the proof block PRD §0.1.4 promises); `ingest()` dispatches the initiator-command plus-tags `remind+` (re-fires pending-step prompts through `kind:'advance'` for workflow / `kind:'activation'` for crypto with `ctx.reminder=true` — same body hook, fewer kinds, matches gitdone's `notifyWorkflowParticipants({reminder:true})` reuse) and `stats+` (returns a kernel snapshot on the ingest return AND auto-sends a neutral default reply as `kind:'stats'` — a plain ASCII dump of the snapshot, gitdone-parity shape; the consumer overrides the prose via `composeNotification` keyed on `kind:'stats'`), both authenticated as DKIM-verified + envelope sender == event.initiator (PRD §6.4) and never committed to the ledger (operational, like `bounce`); and a single m7d e2e (`tests/integration/m7d-e2e.test.js`) exercises every one of the **10 kernel occasion kinds** (`activation`/`advance`/`ack`/`stats`/`completion`/`overdue`/`archived`/`reassigned`/`bounce`/`proof_anchored`; `remind` rides on `advance`/`activation` + `ctx.reminder=true`) through ONE `create()` instance against real outbound + per-event git repos + a fake `ots` binary. (m7c-6 later added the `verify_report`/`reverify_report` email-path kinds — **12 kinds** total — and the default email surface was centralised into `src/templates.js`, brand-free.) **307 `node --test` tests pass, 0 fail.** The public surface now ships **TypeScript declarations generated from JSDoc** (`src/*.d.ts`, `checkJs`-type-checked under **full `strict`** + CI-gated; JSDoc is the source of truth — §8.13), so `require('mailproof')` gives TS consumers a checked surface while authoring stays vanilla JS with zero runtime deps. **Then P2:** reconverge `gitdone` onto mailproof as the definitive "delivers everything" proof (refactor to depend on it — *not* a second copy).
**Owner:** hamr0
**Last updated:** 2026-05-29

> **For future Claude:** This PRD is the canonical source of truth for *what
> mailproof is and what it deliberately is not*. §8 (the NO-GO table) is the
> single biggest scope-creep guard — every entry was discussed and rejected
> with reasoning. When a feature request arrives, check §8 first; if it's
> there, point at the rationale rather than reopening it. The PRD wins on
> **intent**; the SPEC (when it lands in P1) wins on **mechanism**. Decisions
> made in design conversations are logged in
> [`../03-logs/decisions-log.md`](../03-logs/decisions-log.md) — don't
> re-litigate them unless the user explicitly asks. For the extraction
> boundary, planned API, and phasing, see
> [`../02-design/DESIGN.md`](../02-design/DESIGN.md).

---

## 1. What mailproof is

**mailproof turns a promise made over email into proof.**

It verifies — via DKIM/DMARC — that a reply genuinely came from the party who
claims to have sent it, commits that fact to a tamper-evident,
offline-verifiable **git** ledger, and triggers the next email. The verification
is grounded in email *by construction*, so the inbox is both the interface and
the trust anchor. Take away email and you take away the proof.

On that substrate — DKIM-verified email plus a docs-hashing notary — mailproof
offers **two generic coordination modes** (mechanism, never domain policy):
- **Events** — register and coordinate ordered/parallel/mixed steps among
  *named* participants.
- **Crypto sign-off** — collect DKIM-verified sign-offs from one designated
  signer, a set of named signers, or open signers (anyone, via a shared
  address), counted toward a threshold; each sign-off optionally bound to a
  hashed document.

It is a standalone vanilla-JS library extracted from `gitdone`. What stays in
`gitdone` is *product policy*, not mechanism: the web UI, branding,
hosting/auth, and the heavy attestation tail (`revoke`, multi-doc manifests,
alternate dedup rules).

## 2. The problem it solves

Any system that needs to answer **"did named party X confirm step Y, provably,
over email, with no app to install?"** has to re-solve the same hard middle:
authenticate the reply, decide whether it advances state, and produce a record
of the decision that survives the system that made it. `gitdone` solved this
once for crypto/work workflows. The engine underneath is reusable; mailproof is
that engine, factored out so the next system doesn't rebuild it.

The rare property that makes this possible is **DKIM/DMARC verification**: a
receiver can confirm an inbound message was authorized by the sending domain
**with no prior relationship and no shared secret**, offline, using public keys
in DNS. Any party with a domain can be verified by any receiver, cold. That is
why the channel is email and cannot be swapped (see §8, and the decisions log).

## 3. Who it's for

mailproof is a **public open-source library**. Target adopters: anyone building a
multi-party, email-grounded confirmation chain — approval routing, contract
sign-offs, compliance attestations, multi-bot handoffs, supply-chain
acknowledgements. Each adopter writes thin glue and layers its own policy on
mailproof's hooks.

- **First consumer:** `gitdone` (P2 reconverges it onto mailproof, reimplementing
  its crypto modes as policy on the hooks).
- **Primary success signal (§7):** a **second, non-gitdone consumer adopts
  mailproof** — proof the kernel generalizes beyond its origin.

## 4. Scope — the four pillars

mailproof does exactly four decoupled things. Each maps to specific `gitdone`
modules lifted in P1 (boundary in [`../02-design/DESIGN.md`](../02-design/DESIGN.md)).

| Pillar | Responsibility |
|---|---|
| **Verify** | Classify an inbound reply's trust level from DKIM/DMARC (+ durable archive-key reverify); verify an attached document against the ledger (§4.1). |
| **Sequence** | Route the reply and advance it — either an **events** workflow (ordered/parallel/mixed steps) or a **crypto sign-off** (signers → threshold). See §4.2. |
| **Git ledger** | Commit every reply to a per-event git repo as a hash-chained `commit-NNN.json`, including the SHA-256 of every attachment (§4.1); optional OTS anchoring. |
| **Email triggers** | Build and send the next notification (bundled Postfix/sendmail); reminders/nudges/bounce handling. |

### 4.1 Document notary — now, and what's deferred

mailproof extends "turn a promise into proof" to **attached documents**. When an
inbound reply carries an attachment, its SHA-256 is recorded — **automatically,
not optionally** — in the same tamper-evident commit as the verified sender and
timestamp. A document that passed through the system is therefore provable
later, offline, by anyone: re-hash the file and check the ledger.

**Now (v1 kernel):**
- **Auto-hash inbound attachments.** Every attachment on every committed reply
  is fingerprinted (SHA-256) into `commit-NNN.json`. Mandatory — *if a doc is
  used, it is hashed.* (Hashing is always on; whether to *use* a doc as a
  verification layer is the consumer's choice.)
- **`verifyDocument(doc)`** — a read-only lookup: re-hash a file, return the
  matching commit(s) with `{ sequence, received_at, trust_level, counted,
  sender_match }`. Answers "did this verified sender submit exactly this
  document, and when?"

**Status:** the verify half (`verifyDocument` + `hashDocument`) is implemented
(m6.5, `src/notary.js`). The mandatory inbound auto-hash is enforced at the m7
parse layer, which hashes each attachment through `hashDocument` before it
reaches the commit — so the stored fingerprint and the verifier agree by
construction.

**Honest security framing (do not oversell):** the document is a
**proof-of-participation receipt, not a secret/password.** Email is not a
confidential channel and inboxes get compromised, so a document that travelled
by email is a weak secret in *either* direction. The **DKIM-verified sender is
the trust factor**; the document adds tamper-evident *binding/context* ("about
this specific recorded exchange"), never independent auth strength.

**Deferred — built only when a concrete consumer needs them (not NO-GO, just not
yet):**
- **Outbound-attachment hashing** — recording docs the system *sends*, so "a doc
  you received before" is matchable. Small extension; no caller exists yet.
- **`listDocuments({ sender })`** — the inverse lookup (which docs are on record
  for a verified sender). Trivial to add later; must gate behind a verified
  sender and return hashes/ids, never filenames, to avoid metadata leak.
- **Retrieval-gating** ("this doc unlocks action X") — the consumer's policy on
  top of `verifyDocument`, never kernel.

### 4.2 Two coordination modes

Both modes are generic mechanisms on the same substrate (verify + ledger +
notary + triggers); a consumer picks the mode per event via `type`.

**Events** (`type: "workflow"`) — named participants complete
ordered/parallel/mixed steps under one `dependsOn` eligibility model; a step may
set `requires_attachment` (hashed by the notary). Engine: `completion.js` (m6).

**Crypto sign-off** (`type: "crypto"`) — collect DKIM-verified sign-offs toward
completion. **One parameterized engine, not three modes** (the same discipline
that made events one `dependsOn` rule):

| Knob | Values | Covers |
|---|---|---|
| `signers` | explicit email list (manually added) **or** open (anyone) | 1 = single-signer *declaration*; N = named multi-signer; open = a shared `attest+{id}@`-style address — the "link" is **just that shared email address**, not a web link/app/webhook |
| `threshold` | N (1 = declaration) | single-signer vs. count-toward-goal |
| `requiredDocHash` | optional single hash | the "email + doc" two-layer, via the notary |

A sign-off **counts iff**: DKIM-verified; sender ∈ `signers` (or any sender, if
open); the sender is **not the initiator** (anti-self-dealing — the initiator
orchestrates and may reply, but their reply is committed for audit, never
counted as a verification); a *distinct* sender not already counted; and — if
set — its attachment matches `requiredDocHash`. Complete when distinct count ≥
`threshold`. (Events differ: there the initiator *may* be a counted
participant.) Trust is hardcoded to `verified` — crypto is all-or-nothing, with
no per-event trust knob. Engine: `crypto.js` (m6.7).

**Lean by exclusion** (stays gitdone policy, §8): no `revoke`, no
`latest`/`accumulating` dedup (distinct-only), no multi-doc manifests, no
attestor-PII redaction, no web/magic-link flow.

## 5. Core invariants (must hold; do not silently break)

1. **Email-grounded verification.** Trust comes from DKIM/DMARC on inbound
   email. The verify and trigger paths are email by construction.
2. **Accept-with-flag.** *Every* inbound reply is committed to the ledger as an
   audit record — even rejected ones (wrong participant, unverified DKIM,
   out-of-order). A separate `counted` flag records whether it advanced state.
   Routing and trust **gate the state transition, never the commit.**
3. **Git-native is canonical.** Event state = JSON + a per-event git repo whose
   commit chain *is* the tamper-evidence and the portable, offline-verifiable
   proof. SQL/other read-models are projections a consumer builds; they never
   replace the ledger.
4. **Mechanism, not policy.** mailproof exposes primitives (+ an optional
   `createReceiver()` with policy hooks). The orchestrator is the consumer's;
   `receive.js` is **not** lifted.
5. **One definition per concept.** Any predicate or filter asked at >1 call
   site has ONE canonical definition (single helper, single import). No
   inline re-derivation, no copy-paste. The schema-level helpers
   (`event-store.isComplete`, `crypto.signatures`, etc.) are the source of
   truth for the field they read; consumers import, never re-derive. Lifted
   in spirit from gitdone's 2026-05-28 DRY pass where three sites read
   `event.completion` differently and silently disagreed for crypto-closed-
   early. Drift-pattern lessons + the future-tense rules (`isClosedByInitiator`
   when `close+` ships; `revokedHashSet` when revoke ships) recorded in the
   Step-1 audit (`docs/03-logs/audit-p2-step1-gitdone-boundary.md`).

## 6. Public API (intent)

CommonJS, mirroring `gitdone` style: `mailproof.create({ dataDir, domain,
sendmailBin, otsBin? })` → `createEvent`, `ingest(rawEmail, envelope)`,
`loadEvent`, `listCommits`, `stats`, `sweep`. Lower-level pieces
(`classifyTrust`, `buildRawMessage`, `commitReply`, …) are exported so a
consumer can compose its own pipeline. The API is **prose-only until P1** — the
authoritative shape is sketched in
[`../02-design/DESIGN.md`](../02-design/DESIGN.md) and becomes `src/index.js`
when real code lands.

**Config injection (no singleton).** There is no `config` module. Fixed-per-
deployment config is bound by **per-pillar factories** — `createEventStore({
dataDir })`, `createGitrepo({ dataDir })`, … — each naming the value once;
`create()` composes them and is the single runtime source of truth. Config that
varies per message (outbound's `domain`/`footer`) is passed per call instead.
The discriminator is the value's nature (fixed vs. varying), not stylistic
uniformity. Rationale in the [decisions log](../03-logs/decisions-log.md)
("Config injection by bound per-pillar factories").

## 7. Success criteria

- **Primary:** a **second, non-gitdone consumer** ships a multi-party
  email-confirmation flow on mailproof.
- **Boundary proof:** `gitdone` reconverges onto mailproof (P2) with its crypto
  modes reimplemented as policy on the hooks and **no feature regression** —
  evidence the keep/leave line was carved correctly.
- **Library bar:** ships as a tested (Testing-Trophy), published, **≤3 runtime
  dep** vanilla library with a real `src/index.js`, matching the `knowless` /
  `bareagent` packaging standard.

### 7.1 Validation roadmap (how P1 → success is actually walked)

P1 (the kernel lift) is complete (2026-05-28). The boundary-proof success
criterion above said "P2 = gitdone reconverges onto mailproof." That
sequencing is **revised here** to protect gitdone's production stability while
still getting the boundary-proof signal. The new two-step plan:

- **Step 1 — API audit (paper, no code).** Walk every module of
  `~/PycharmProjects/gitdone/app/src/` against mailproof's published surface.
  Output: **one boundary table** classifying each gitdone capability as
  `depend-on-mailproof` | `reimplement-as-policy-on-hooks` |
  `gap-mailproof-needs`. Also enumerates known behavioural deltas from the
  lift (e.g. `editEvent` reads top-level `status`; bounce routing via
  plus-tag/VERP; the trimmed `revoke`/`accumulating`/`latest`/multi-doc strict
  manifests/`close+`/`bundle+`/magic-link/pending-TTL paths). Read-only — no
  risk to gitdone. Deliverable answers "what would the reconverge cost, and
  where are the silent-regression risks?" before any code is touched.

- **Step 2 — gitdone-on-mailproof on a BRANCH (NOT to merge — a validation
  harness).** Refactor gitdone on a dedicated branch to fully adopt mailproof,
  module by module, using gitdone's own test suite as the regression gate.
  The branch is explicitly a **validation artifact**: the goal is to surface
  every real gap/awkwardness mailproof has when faced with the full corner-
  case surface of a mature consumer, NOT to ship a refactored gitdone. The
  user has flagged that gitdone carries production tuning and edge cases they
  do not intend to disturb on `main`; the branch is the boundary-proof
  evidence without forcing a merge. Friction surfaced on the branch drives
  kernel-side fixes/extensions (a possible `m7e`, only if needed) — those land
  on mailproof's `main`. gitdone's `main` is untouched.

Rationale: validation that hardens mailproof's kernel without risking
gitdone's production stability. The PRD success criteria above are unchanged
— a non-gitdone consumer is still the **primary** metric, and the gitdone
reconverge is still the **boundary proof**; the branch satisfies the
boundary-proof requirement without the merge-back obligation. (Decisions log,
2026-05-28: validation-via-branch, non-merging.)

## 8. Non-goals (the NO-GO table)

Recorded explicitly. **Re-litigating these is the biggest scope-creep risk.**
When a feature request comes in, point at this table.

| # | Non-goal | Reason |
|---|---|---|
| 8.1 | **Non-email channels in the core verify/trigger path** (webhooks, SMS, push) | DKIM/DMARC is what gives cold, third-party, offline verification; webhooks need pre-shared HMAC/mTLS (kills the "any two parties, no setup" property) and SMS has no real origin verification. Email is the trust anchor, not a channel choice. **Carve-out:** a consumer may fire its own side-effect notifications (webhook/Slack/SMS) from mailproof's `ingest()` result — those carry **no mailproof verification guarantee** and are glue on top, not a core channel. |
| 8.2 | **gitdone's attestation *policy* tail** (`revoke`, `latest`/`accumulating` dedup, attestor-PII redaction, magic-link/web flow) | The lean crypto sign-off *mechanism* (1/N/open signers + threshold + single-doc gate) is now a core mode (§4.2); only this heavy policy tail stays in gitdone. **Supersedes the original "generic workflow only" scope** — see the decisions log. |
| 8.3 | **Multi-doc strict-signing manifests + the `attach` / `reference_docs` channel** | Single-document gating (`requiredDocHash`, §4.2) is core; multi-doc manifests, per-attestor progress, and the `attach` channel stay `gitdone` policy. |
| 8.4 | **`revoke` semantics** (un-counting a signer + recount/reopen) | Threshold/quorum *counting* is now core (the crypto mode's `threshold`, §4.2); reversing a counted signer is policy on the hooks. |
| 8.5 | **Multi-event `bundle`** | A `gitdone` product feature, not a kernel primitive. |
| 8.6 | **Branded / templated email bodies** (`[gitdone]`, marketing headers) | Core builds minimal neutral messages. Branding is the consumer's. |
| 8.7 | **Web dashboard / HTTP server / any UI** | mailproof is a library. Consumers build their own surface. |
| 8.8 | **Login / auth, incl. "document-as-login / second factor"** | Consumer concern, out of the kernel. A document sent over email is a weak, clunky factor — it lives in the same inbox an attacker would compromise, and it's strictly worse than TOTP/passkeys; the DKIM-verified sender is *already* the factor. mailproof records and verifies documents (§4.1); it does **not** become an identity/auth provider. |
| 8.9 | **Lifting `receive.js`** (the orchestrator) | App glue. mailproof exposes primitives + optional `createReceiver()` with hooks; each consumer writes thin glue. |
| 8.10 | **Pluggable third-party mail provider** (SendGrid/SES/Mailgun) | Transport is bundled Postfix/sendmail; opendkim signs outbound at the MTA. Self-hosted = full control, no vendor dep. |
| 8.11 | **SQL/other DB as the canonical store** | Git ledger is canonical (invariant §5.3). SQL is a read-model the consumer projects; mailproof doesn't ship or own it. |
| 8.12 | **Domain-specific modes** beyond the two generic ones (events, crypto sign-off) | The two modes are generic mechanisms; domain semantics are the consumer's policy. |
| 8.13 | **TypeScript source** | Source stays vanilla JS + JSDoc; no `.ts`, no consumer build step. The shipped `src/*.d.ts` are *generated* from the JSDoc by a dev-only `tsc` (`npm run build:types`, which cleans the stale `.d.ts` first so a co-located prior copy can't shadow the emit), checkJs-gated in CI under **full `strict`** (`strictNullChecks` is the non-negotiable floor, `strict:true` the default — every internal helper is annotated, all null-safety is proven; no `any` casts / `@ts-ignore`) — JSDoc is the single source of truth. This **diverges** from `knowless`/`bareagent` (which ship no types at all): a deliberate upgrade for the published-package audience, since TS consumers get a checked surface while JS authoring + zero runtime deps are unchanged. |
| 8.14 | **Hosted SaaS** | It's a library. |
| 8.15 | **Telemetry / phone-home of any kind** | Never. |
| 8.16 | **Per-record erasure / participant self-revoke** (right-to-be-forgotten by deletion) | Directly attacks the three properties that *are* the product — tamper-evidence (deleting a commit rewrites every descendant SHA), non-repudiation (erasing a counted reply rewrites "3 of 3 signed" → "2 of 3"), and offline verifiability. Privacy is served instead by **minimization** (§5, SPEC §6 — no plaintext at rest, only salted hashes) and the "receipt, not secret" framing. The only erasure lever is coarse + opt-in: deleting an **entire event** also destroys its salt, making residual hashes unlinkable (whole-event crypto-shred, free with deletion). See the decisions log (2026-05-27) and §8.17. |

### 8.17 Privacy & GDPR posture (engineering rationale, not legal advice)

mailproof stores **no plaintext personal data at rest** — only per-event salted
`sender_hash`es plus the plaintext `sender_domain` (SPEC §6). A salted hash is
**pseudonymous, not anonymous** (GDPR Recital 26): the public salt lets the
controller re-link a *guessed* address, so GDPR still applies — mailproof does
not claim the data is out of scope. What the design *does* give the operator:

- **Data-protection-by-design/default (Art. 25(1)) + security of processing
  (Art. 32(1)):** both articles name **pseudonymisation** *verbatim* as an
  example technical measure (32(1) pairs "the pseudonymisation and encryption of
  personal data"). Salting at rest + minimization + tamper-evident integrity is
  squarely what they ask for.
- **A lawful basis to *retain* (Art. 6(1)):** an audit of who-signed-what rests
  on legitimate interest (6(1)(f), subject to its balancing test) and/or
  contract (6(1)(b)) / legal obligation (6(1)(c)).
- **Resistance to an erasure demand (Art. 17(3)):** the right to erasure
  expressly does **not** apply where processing is necessary for "compliance
  with a legal obligation" (17(3)(b)) or "for the establishment, exercise or
  defence of legal claims" (17(3)(e), quoted verbatim). A non-repudiable
  sign-off record plausibly sits there — so the records **can be kept** for as
  long as that purpose subsists, with storage-limitation (Art. 5(1)(e))
  satisfied by a documented retention policy.
- **Art. 11(1)–(2):** if the controller is "not in a position to identify the
  data subject" from the data alone, it need not acquire extra data just to
  comply, and Arts. 15–20 do not apply unless the subject supplies identifying
  information. mailproof stores no directly-identifying data — it cannot
  enumerate who is in the ledger without a candidate address.

> **Grounded in** Regulation (EU) 2016/679 (GDPR) — Art. 4(5) (pseudonymisation),
> 5(1)(c)/(e), 6(1), 11, 17(1)/(3)(b)/(e), 25(1), 32(1); Recital 26 (pseudonymous
> data attributable via additional information *is* personal data; the
> "means reasonably likely to be used" identifiability test). Article text
> verified against the consolidated Regulation (EUR-Lex CELEX 32016R0679),
> 2026-05-27 — not paraphrased from memory.

**Boundary:** the *operator/consumer is the data controller*, not mailproof and
not its authors. mailproof is built to *enable* a compliant deployment
(minimization, salting-at-rest, durable lawful retention) — it does not
*discharge* the controller's own duties (privacy notice, documented basis,
DPIA where warranted, retention policy). Final compliance is the controller's
determination, with counsel. Adopters needing hard per-person erasure of
*retained* records need a different posture — the rejected "forgettability-capable"
variant in the decisions log.

## 9. Sibling-project candidates

If genuinely needed later, these become **separate libraries**, not core
features: a SQL read-model projector; a non-email side-effect notifier; a
policy pack for crypto attestation (this is largely `gitdone`'s own job).

## 10. Decisions & open questions

Locked decisions with rationale (storage, sequencing scope, transport, the
email-only lock, and the boundary) live in
[`../03-logs/decisions-log.md`](../03-logs/decisions-log.md). Open question:
whether any pluggable seam (outbound trigger, transport) is ever worth the
"maybe" on the core surface — currently **no** (§8.1, §8.10).
