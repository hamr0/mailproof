# mailproof — Product Requirements Document (PRD)

**Status:** Pre-library — P0 (POC) complete; **P1 (lift) in progress.** Lifted so far: verify (`classifier.js`), sequence routing (`router.js`, trimmed to kernel tags), inbound preprocessing (`prefilter.js`, `envelope.js`), and outbound triggers (`outbound.js`, config-injected). Still pending: the storage/ledger modules (`event-store`, `gitrepo`), the workflow-sequencing engine (the contested `completion.js` subset), and the `create()` / `ingest()` assembly.
**Owner:** hamr0
**Last updated:** 2026-05-23

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
offline-verifiable **git** ledger, sequences it through a workflow, and triggers
the next email. The verification is grounded in email *by construction*, so the
inbox is both the interface and the trust anchor. On top of that proof, mailproof
is the **generic mechanism — never the policy** — for coordinating any
multi-party interaction between people or bots. Take away email and you take
away the proof.

It is a standalone vanilla-JS library extracted from `gitdone`. No web UI, no
branding, no crypto-attestation policy — those stay in `gitdone` as a consumer
on top.

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
| **Verify** | Classify an inbound reply's trust level from DKIM/DMARC (+ durable archive-key reverify). |
| **Sequence** | Route the reply to its event/step and advance an ordered/parallel/mixed workflow. |
| **Git ledger** | Commit every reply to a per-event git repo as a hash-chained `commit-NNN.json`; optional OTS anchoring. |
| **Email triggers** | Build and send the next notification (bundled Postfix/sendmail); reminders/nudges/bounce handling. |

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

## 6. Public API (intent)

CommonJS, mirroring `gitdone` style: `mailproof.create({ dataDir, domain,
sendmailBin, otsBin? })` → `createEvent`, `ingest(rawEmail, envelope)`,
`loadEvent`, `listCommits`, `stats`, `sweep`. Lower-level pieces
(`classifyTrust`, `buildRawMessage`, `commitReply`, …) are exported so a
consumer can compose its own pipeline. The API is **prose-only until P1** — the
authoritative shape is sketched in
[`../02-design/DESIGN.md`](../02-design/DESIGN.md) and becomes `src/index.js`
when real code lands.

## 7. Success criteria

- **Primary:** a **second, non-gitdone consumer** ships a multi-party
  email-confirmation flow on mailproof.
- **Boundary proof:** `gitdone` reconverges onto mailproof (P2) with its crypto
  modes reimplemented as policy on the hooks and **no feature regression** —
  evidence the keep/leave line was carved correctly.
- **Library bar:** ships as a tested (Testing-Trophy), published, **≤3 runtime
  dep** vanilla library with a real `src/index.js`, matching the `knowless` /
  `bareagent` packaging standard.

## 8. Non-goals (the NO-GO table)

Recorded explicitly. **Re-litigating these is the biggest scope-creep risk.**
When a feature request comes in, point at this table.

| # | Non-goal | Reason |
|---|---|---|
| 8.1 | **Non-email channels in the core verify/trigger path** (webhooks, SMS, push) | DKIM/DMARC is what gives cold, third-party, offline verification; webhooks need pre-shared HMAC/mTLS (kills the "any two parties, no setup" property) and SMS has no real origin verification. Email is the trust anchor, not a channel choice. **Carve-out:** a consumer may fire its own side-effect notifications (webhook/Slack/SMS) from mailproof's `ingest()` result — those carry **no mailproof verification guarantee** and are glue on top, not a core channel. |
| 8.2 | **Crypto declaration / attestation modes** | Stay in `gitdone` as policy on mailproof's hooks. v1 core is generic workflow only. |
| 8.3 | **Strict signing + `reference_docs` / `attach` enforcement** | Policy, not kernel. Layer it on the hooks. |
| 8.4 | **`revoke` / threshold / quorum semantics** | Policy on hooks. The core advances steps; quorum rules belong to the consumer. |
| 8.5 | **Multi-event `bundle`** | A `gitdone` product feature, not a kernel primitive. |
| 8.6 | **Branded / templated email bodies** (`[gitdone]`, marketing headers) | Core builds minimal neutral messages. Branding is the consumer's. |
| 8.7 | **Web dashboard / HTTP server / any UI** | mailproof is a library. Consumers build their own surface. |
| 8.8 | **Login / manage auth** (e.g. knowless-based) | Consumer concern, out of the kernel. |
| 8.9 | **Lifting `receive.js`** (the orchestrator) | App glue. mailproof exposes primitives + optional `createReceiver()` with hooks; each consumer writes thin glue. |
| 8.10 | **Pluggable third-party mail provider** (SendGrid/SES/Mailgun) | Transport is bundled Postfix/sendmail; opendkim signs outbound at the MTA. Self-hosted = full control, no vendor dep. |
| 8.11 | **SQL/other DB as the canonical store** | Git ledger is canonical (invariant §5.3). SQL is a read-model the consumer projects; mailproof doesn't ship or own it. |
| 8.12 | **Domain-specific workflow types** beyond generic ordered/parallel/mixed | v1 is generic workflow only. Domain semantics are policy. |
| 8.13 | **TypeScript source** | JSDoc + shipped `.d.ts`, no build step — matches the family convention (`knowless`, `bareagent`). |
| 8.14 | **Hosted SaaS** | It's a library. |
| 8.15 | **Telemetry / phone-home of any kind** | Never. |

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
