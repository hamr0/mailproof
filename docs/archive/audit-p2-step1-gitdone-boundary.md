# P2 Step 1 — gitdone → mailproof API audit (boundary table)

> **Date:** 2026-05-28
> **Type:** Read-only paper exercise (PRD §7.1 Step 1).
> **Status:** Deliverable for the Step 2 decision (gitdone-on-mailproof validation branch).
> **Source-of-truth target:** every file in `~/PycharmProjects/gitdone/app/src/` + `~/PycharmProjects/gitdone/app/bin/receive.js`.
> **Mailproof surface used as the reference:** `src/index.js` re-exports + `create({...})` from `src/create.js`, as of commit `e4878ad`.

## How to read this

For **every gitdone module**, one of three buckets:

| Bucket | Meaning |
|---|---|
| **A. depend-on-mailproof** | Responsibility fully covered by mailproof's surface. A validation-branch refactor would replace the module with calls to mailproof primitives. |
| **B. reimplement-as-policy-on-hooks** | Gitdone-specific policy (branding, web, magic-link, dashboard, revoke, multi-doc strict, close+/bundle+, attestor-PII, etc.). Stays gitdone-internal but rewritten over mailproof's hooks (`composeNotification`, `ingest()` results, `listCommits`/`loadCommit`, etc.). |
| **C. gap-mailproof-needs** | Gitdone does something mailproof's current surface does not expose / cannot express. Candidate for an `m7e` kernel extension (or for the validation branch to confirm the gap is real). |

Split classifications noted inline.

## Module-by-module table

| File | Bucket | 1-line summary | Mailproof primitive(s) / hook(s) called OR gap |
|---|---|---|---|
| `ack-progress.js` | B | strict-signing ack-progress block formatter | Reads `event.reference_docs[].signed_at`, `event.attestor_progress[].signed_doc_hashes` — policy rendering over completion data |
| `auth.js` | B | knowless session-auth bootstrap (magic-link login) | No mailproof equivalent; gitdone web-auth surface |
| `auth-mailer.js` | B | knowless mailer adapter (sendmail) | `sendmail`, `buildRawMessage` re-exported, but knowless integration is gitdone-specific |
| `bundle.js` | C | tar.gz proof bundle export + multipart MIME attachment builder | `locateRepo(eventId)` requires gitrepo access; `buildAttachmentMessage` is custom RFC-822 with attachment; **mailproof has no attachment-in-email surface** |
| `classifier.js` | A | trust-level classifier | `classifyTrust` — re-exported identically |
| `completion.js` | A/B (split) | workflow + declaration + attestation engines + revoke + strict-signing | **A:** `shouldCount`, `applyReply`, `isComplete`, `stepDepsMet`, `eligibleSteps`, `meetsTrust` — re-exported. **B:** `applyRevoke`, `revokedHashSet` (Module 8 — not in mailproof); attestor-PII redaction (`redactAttestorEmails`); `reference_docs` + `attestor_progress` field mutations (Module 4c strict signing) |
| `config.js` | A | 12-factor env-var config | `mailproof.create({dataDir, domain, ...})` — gitdone wraps in `config.js`; surface is the same |
| `dkim-archive.js` | A | DKIM key fetch + archive + PEM wrap | `fetchDkimKey`, `pickSignatureToArchive`, `extractPublicKey`, `toPem` — re-exported |
| `dsn.js` | A | RFC 3464 DSN parser | `isDeliveryStatusReport`, `extractDsn`, `parseDeliveryStatusBody` — re-exported |
| `email-commands.js` | C | initiator email commands (stats+, remind+, close+, bundle+) | `stats+`/`remind+` bodies are policy; `close+` is a two-step email close with token confirmation — **no mailproof equivalent**; `bundle+` triggers bundle streaming — **no mailproof equivalent** |
| `envelope.js` | A | Postfix envelope parser | `parseEnvelope` re-exported |
| `event-mutex.js` | A | per-event write serialization | `withEventMutex` re-exported |
| `event-store.js` | A/B (split) | event JSON CRUD + creation defaults + field marshalling | **A:** `loadEvent`, `createEvent`, `generateEventId`, `generateEventSalt` — re-exported. **B:** `activateEvent` magic-link/token flow (gitdone web policy); `editEvent` bounds on reachable steps (gitdone uses dashboard not email); `recordStepSendErrors`, `findStep`, `senderMatchesStep` are exported but used differently |
| `forward.js` | C | forwarded-message prepend (X-GitDone-* headers) + forwarding to initiator | `forwardToOwner` + byte-preserving forward logic — **mailproof has no "forward original email" seam** |
| `gitrepo.js` | A/B (split) | per-event git repo, commit writing, DKIM/OTS proof storage | **A:** `createGitrepo`, `commitReply`, `listCommits`, `loadCommit`, sync/persist — re-exported. **B:** `commitCompletion`, `commitAttach`, `commitRevoke` (gitdone-specific commit types); `saltedSenderHash`, `saltedMessageIdHash` (gitdone-specific helpers, though mailproof uses them internally) |
| `logger.js` | B | JSON-line logger (stdout + file) | No mailproof logger surface; gitdone embeds across all modules |
| `notifications.js` | B/C (split) | participant notifications + progress + completion | **B:** `notifyWorkflowParticipants`, `notifyEventCompletion`, `notifyOrganiserOfStepProgress` orchestrate over `deliver()`. **C:** `notifyDeclarationSigner` + per-event-type bodies — call `deliver()` but bodies are gitdone policy; formatters use gitdone's `proofRender` |
| `ots.js` | A | OTS stamping + file ops | `createOts`, `stampFile`, `parseOtsBlockHeight` — re-exported |
| `outbound.js` | A | buildRawMessage, sendmail, subject sanitization, Message-ID/date, signature footer | `sendmail`, `buildRawMessage`, `sanitizeSubject`, `newMessageId`, `rfc5322Date`, `withSignature` — re-exported; `SIGNATURE_FOOTER` is gitdone branding |
| `prefilter.js` | A | auto-responder / list / system-sender pre-filter | `preFilter`, `extractHeaderBlock`, `rawHeader` — re-exported |
| `reverify.js` | C | `reverify+{id}-{seq}@` contested-commit re-verify path + trust upgrade | mailproof has `reverify()` but **gitdone's `reverify.js` orchestrates the email-triggered flow and record persistence** — fits the ingest pipeline, not the standalone verifier |
| `router.js` | A | address parser | `parseEventTag`, `parseAttestTag`, `parseVerifyTag`, `parseReverifyTag`, `parseInitiatorCommand`, `parseAddress` — re-exported. Gitdone adds `parseAttachTag`, `parseRevokeTag` (Modules 4a + 8) |
| `stats.js` | B | aggregate event counters | Walks `events/*.json` and counts by type/status — gitdone policy on top of event-store primitives |
| `sweep.js` | B | lifecycle sweep (activation TTL delete, overdue nudge, auto-archive) | mailproof's `createSweep()` emits `overdue`/`archived` via `deliver()`; gitdone wraps it + adds activation-TTL-delete (PRD §8: consumer policy) |
| `verify.js` | C | `verify+{id}@` public verification endpoint — match forwarded email/attachment to commit + DKIM re-verify | mailproof's `verifier.verify()` exists, **but gitdone's `verify.js` orchestrates the email-ingest side + report email composition** — partially fits ingest, report is policy |
| `web/*` (8 files) | B | HTTP dashboard, event creation, manage UI, proof rendering, design lab | All gitdone-specific web UI; PRD §8.7 explicit NO-GO for mailproof |
| `bin/receive.js` | C | main inbound orchestrator — ingest pipeline glue | Mailproof's `ingest()` is the semantic equivalent BUT gitdone's `receive.js` is the Postfix-pipe-transport adapter; also orchestrates `bundle+`, `revoke`, `reverify` email paths (Modules 8, 9, 1.L.3) which are gitdone-specific |
| `bin/server.js` | B | HTTP server | gitdone web UI orchestration |
| `bin/sweep.js` | B | hourly cron invoker for sweep | Wraps mailproof's `sweep()` + gitdone's `sweep.js` logic |
| `bin/stats.js` | B | telemetry reporter | Calls `stats.js` `collect()` |
| `bin/stats-weekly.js` | B | weekly aggregate stats | Reads gitdone telemetry file |
| `bin/ots-upgrade.js` | B | OTS proof upgrade cron | Calls mailproof's `upgradeProofs()` |

## GAPS section (Bucket-C items)

Each gap has: (a) what gitdone does, (b) what mailproof offers, (c) what mailproof would need, (d) impact size.

### Gap 1 — bundle+ email command + email attachment hook
- **gitdone**: `bundle+{id}@` returns a tar.gz of the event repo as multipart MIME attachment
- **mailproof**: No surface for "bundle the repo and email it back as an attachment"
- **needs**: `composeNotification`-style hook returning `{body, attachment: {filename, contentType, content: Buffer}}` + `deliver()` multipart variant; OR expose `bundleToBuffer(eventId)` and let consumer handle MIME
- **impact**: Small

### Gap 2 — close+ two-step email close with token confirmation
- **gitdone**: Initiator emails `close+{id}@`; first reply gets a token, second reply (≤30 min, token in subject/body) commits the close; `event.pending_close` field + `executeCloseRequest` state machine
- **mailproof**: `editEvent()` can set completion programmatically; no email-triggered two-step flow
- **needs**: Expose `event.pending_close` as optional field; let completion engine handle pure state machine; consumer wires email orchestration
- **impact**: Small

### Gap 3 — revoke sender-hash (Module 8) — retroactive attestor removal
- **gitdone**: `revoke+{id}@` with attestor list → `event.revoked_senders[]` → `applyRevoke()` recounts → optionally flips complete → open
- **mailproof**: No revoke surface; completion engine has no `revoked_senders`; no `applyRevoke`
- **needs**: `revoked_senders` field on event; `applyRevoke(event, hashes, opts)` in completion engine; ingest routing for `revoke+`
- **impact**: **Medium**

### Gap 4 — strict-signing attestation (Module 4c): per-attestor progress
- **gitdone**: In crypto attestation w/ `reference_docs`, tracks `event.attestor_progress[sender_hash] = {signed_doc_hashes, complete, ...}`; completion only counts an attestor when their bucket is complete
- **mailproof**: No `attestor_progress` field; completion counts all replies (deduped by latest/unique sender) regardless of per-signer doc progress
- **needs**: `attestor_progress` schema; `applyReply()` extension for attestation mode
- **impact**: **Medium-Large**

### Gap 5 — strict-signing with reference_docs + reference_url (Modules 4a/4b): manifest freezing
- **gitdone**: `event.reference_url` + `attach+{id}@` emails register `reference_docs[]`; once registered, manifest is frozen; strict signing requires every signature to match manifest hashes
- **mailproof**: No `reference_docs`, `reference_url`, or `attach+` command; no manifest-freezing semantics
- **needs**: `reference_docs` + `reference_url` schema; `parseAttachTag()` router; `commitAttach()` in gitrepo; manifest-freezing logic in completion.js
- **impact**: **Medium-Large**

### Gap 6 — attestor email capture + redaction (Module 4e): PII in strict attestation
- **gitdone**: Stores plaintext email at completion; `redactAttestorEmails()` clears them post-completion + stamps `attestor_emails_redacted_at`
- **mailproof**: No `attestor_progress.email` field; no redaction hook
- **needs**: Optional `email` field on attestor_progress buckets; post-completion redaction hook
- **impact**: Small

### Gap 7 — forward-to-initiator + X-GitDone-* headers
- **gitdone**: Every counted reply forwarded to the initiator with `X-GitDone-Event/Step/Commit/Trust/Received-At/Forwarded-At` headers; byte-preserving (original DKIM intact)
- **mailproof**: No forwarding surface; `deliver()` is outbound notifications only
- **needs**: Forwarding hook or path in `ingest()`; OR sibling to `deliver()` for inbound-reply forwarding
- **impact**: Small-Medium

### Gap 8 — reverify+ contested-commit re-verify (Module 1.L.3): email-triggered path
- **gitdone**: Forwarded raw `.eml` as `reverify+{id}-{seq}@`; extracts inner email, re-runs DKIM against archived key, creates `reverify-NNN.json` record
- **mailproof**: `reverify()` exists on verifier but **not wired to email pipeline**; no `reverify+` address parsing in ingest; no `reverify.js` orchestration
- **needs**: Wire `parseReverifyTag` into `ingest()`; orchestrate `reverify()` calls; persist records
- **impact**: Small

### Gap 9 — initiator commands (stats+, remind+, close+, bundle+) full email path
- **gitdone**: All four with DKIM + sender==initiator auth; auto-generated responses
- **mailproof**: `parseInitiatorCommand` recognises stats/remind only (NOT close/bundle); ingest routes stats/remind; no close/bundle hooks or state transitions
- **needs**: Extend `parseInitiatorCommand` (or expose router parsers + let consumer extend); add close+/bundle+ routing in ingest; bodies stay policy
- **impact**: Small-Medium (touches several seams)

### Gap 10 — web dashboard + session auth + UI
- **gitdone**: Magic-link auth (knowless), event creation forms, manage UI, activation flow
- **mailproof**: None — PRD §8.7 NO-GO
- **needs**: **Out of scope by design.** Mailproof is email-native; web is consumer surface
- **impact**: N/A — branch keeps gitdone's web layer unchanged

### Gap 11 — DSN bounce routing (partial)
- **gitdone**: `receive.js` parses DSN reports and routes to `recordStepSendErrors()`
- **mailproof**: `extractDsn` + `permanentFailures` exported; `ingest()` emits `bounce` occasion via `deliver()` AND calls `recordStepSendErrors` internally
- **needs**: Already covered — verify on the validation branch that gitdone's expectation is identical to mailproof's behaviour
- **impact**: **Already implemented** in m7d-3; this gap is "audit-only, may be a no-op"

## Behavioural-delta addendum (deltas not in the original known-list)

| gitdone behaviour | mailproof behaviour | impact on validation branch |
|---|---|---|
| `event.pending_close` field + `executeCloseRequest` two-step close state machine | No `pending_close` field; `editEvent` sets completion directly | Branch must add the field + state machine (or keep gitdone's email-commands.js as-is and only call mailproof for the underlying transition) |
| `event.revoked_senders[]` + `applyRevoke()` recount in locking-dedup events | No revoke surface; completion is sticky at threshold | Branch must add revoke support; **biggest single feature gap** |
| `event.attestor_progress[sender_hash]` with per-signer doc progress + manifest freezing | Attestation replies deduped by latest/unique only; no progress buckets | Branch must extend attestation completion |
| `event.reference_docs[]` + `event.reference_url` + `attach+` + manifest freezing | No reference_docs field or `attach+` routing | Branch must add schema + lifecycle |
| `event.attestor_emails_redacted_at` + post-completion PII redaction | No attestor-email storage or redaction hook | Branch adds redaction hook |
| X-GitDone-* forwarding headers + initiator inbox gets every reply | No forwarding surface | Branch adds `forwardToOwner` hook |
| `revoke+` command parsing + email-triggered revocation | No `parseRevokeTag` or revoke routing | Branch adds `parseRevokeTag` + ingest path (under revoke gap) |
| Bundle email multipart/mixed body | No attachment-body deliver hook | Branch extends `deliver()` or adds bundling hook |
| Attestor progress in ack subjects/bodies ("3 of 5 signed") | Completion has no per-signer progress; notifications use global count | Branch exposes `attestor_progress` to notification body composers |

## Reconverge complexity verdict

**MEDIUM-LARGE — 3–5 weeks of focused work on the validation branch.**

**Tier 1 (load-bearing, ~2 weeks)**
- **Revoke (Module 8)** — `revoked_senders[]`, `applyRevoke()`, recount, ingest routing. ~3–5 days.
- **Strict-signing attestation (Module 4c)** — `attestor_progress` buckets, per-signer completion gates. ~3–5 days.
- **Reference_docs + manifest (Modules 4a/4b)** — schema, `attach+`, manifest freezing across event/gitrepo/completion/ingest. ~4–6 days.

**Tier 2 (feature-complete wiring, ~1 week)**
- `close+` two-step email — small, ~2 days
- Attestor email redaction (Module 4e) — small, ~1 day
- Forwarding + X-GitDone-* — small, ~1 day
- `close+`/`bundle+` initiator-command routing in ingest — small-medium, ~2 days
- Bundle email path (multipart attachment) — small, ~1–2 days
- `reverify+` email path — small, ~1 day
- DSN bounce routing alignment — small, may be no-op, ~1 day

**Tier 3 (parallel / consumer-optional, ~1 week)**
- Web dashboard + session auth — gitdone-internal, no kernel dependency

**Load-bearing gates**: revoke, strict-signing attestation, reference_docs. These interact with completion semantics — they have to land (either as kernel extensions in mailproof, or as gitdone-internal extensions on top of mailproof's hooks) before completion-engine consumers can rely on the surface.

**Risk vectors**
1. Attestation completion is already complex (dedup modes, threshold, locking); per-signer progress multiplies the state-space.
2. Reference-docs manifest-freezing interacts with attachment handling, revocation, and completion gates — high test-case density.
3. Revoke can flip completion from `complete` → `open`; audit-trail mutations are subtle.

**Conservative**: 3 weeks (core + tier-2). **Aggressive**: 2 weeks if tier-1 can be parallelised.

## The key Step-2 decision point

For each Tier-1 gap, the validation branch has to pick:

1. **Reimplement gitdone-internally as policy on mailproof's hooks** — i.e. gitdone keeps `applyRevoke`, `attestor_progress` mutations, manifest logic; calls mailproof for the underlying primitives (`commitReply`, `eligibleSteps`, `writeEventAtomic`). Per PRD §8.2/§8.3/§8.4, this is the *intended* placement.
2. **Lift to mailproof as an `m7e` kernel extension** — only if (1) turns out to be impossible because mailproof's primitives don't expose enough.

The audit can't answer this — only the validation branch attempting (1) and hitting friction can. That's the entire point of Step 2.

## Drift-pattern lessons from gitdone's 2026-05-28 DRY pass (apply on the validation branch)

In parallel with this audit, gitdone shipped a DRY-up fix for two cases where
"same concept, multiple call sites" had silently diverged:
1. `isClosedByInitiator(event)` — three sites read `event.completion`
   differently and disagreed for crypto-closed-early.
2. `revokedHashSet(event)` — five copy-pasted inline filter implementations,
   replaced by one canonical helper.

**Cross-check on mailproof's current src/**:

- **`closed_by` drift**: NOT present today — mailproof has no `close+`
  command + no `closed_by` field (audit Gap #2). **Future-tense rule** for
  the validation branch: when `close+` ships (whether as gitdone-internal
  policy or as `m7e`), define `isClosedByInitiator(event)` from day one and
  use it everywhere, never re-derive `event.completion.closed_by` inline.
- **`revoked_senders` duplication**: NOT present today — mailproof has no
  revoke surface (Gap #3). **Future-tense rule**: when revoke ships, export
  `revokedHashSet(event)` once from the engine (or schema module) and import
  it at every read site; never inline the filter.
- **Underlying pattern in mailproof today** (FIXED on the same commit as this
  doc update): the `event.status === 'complete'` predicate was re-derived at
  5 sites (`ingest.js:239`, `sweep.js:65`, `event-store.js:332`,
  `proof-anchor.js:90`, plus byte-identical duplicates in `completion.js` /
  `crypto.js`). Canonicalised to a single `isComplete(event)` exported from
  `event-store.js` (schema-level); both engines re-export it; every consumer
  imports it. Same lesson, same fix shape — applied proactively before the
  validation branch had a chance to widen the duplication. Same pass also
  unified the 4 inline `Array.isArray(event.signatures) ? event.signatures :
  []` accesses in `ingest.js` to `crypto.signatures(event)` (the engine's
  canonical helper).

**Rule for the validation branch**: any concept asked at >1 call site gets
one definition. If a new helper is needed, lift it; don't re-derive.

## Recommendation for Step 2 sequencing

Suggest doing Tier-1 first (in any order) because they're the load-bearing gates. If one of them forces an `m7e` kernel extension, better to find that early than after a week of tier-2 wiring built on assumptions that don't hold.
