# Changelog

All notable changes to **mailproof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-library status.** mailproof has no published API yet. Until the P1 lift
> ships a real `src/index.js`, any release is a scaffolding / npm
> name-reservation placeholder — `require('mailproof')` does not resolve to a
> working module. See [`docs/02-design/DESIGN.md`](docs/02-design/DESIGN.md) for
> the phasing.

## [Unreleased]

### Added
- **P1 lift begins — verify pillar, module 1: trust classifier.**
  `src/classifier.js` (`classifyTrust` + `TRUST_LEVELS`), lifted from gitdone as
  a pure function and re-anchored to SPEC §1. First real `src/` module; resolves
  the previously-dangling `main`.
- **Sequence pillar, module 2: address router.** `src/router.js`
  (`parseAddress`, `parseEventTag`, `parseVerifyTag`, `parseReverifyTag`,
  `parseInitiatorCommand`), lifted pure from gitdone and **trimmed to the kernel
  boundary** (SPEC §2): initiator commands cut to `{stats, remind}`; the policy
  parsers `parseAttachTag`/`parseRevokeTag` and the `close+`/`bundle+` tags
  dropped (they stay in gitdone). `tests/unit/router.test.js` proves the trim
  (dropped tags parse to null / are unexported) and adds `verify+` coverage the
  origin suite lacked.
- **Inbound preprocessing, module 3: pre-filter + envelope.** `src/prefilter.js`
  (`preFilter`, `extractHeaderBlock`, `rawHeader` — the humans-only gate that
  rejects auto-responders / mailing lists / bulk / system senders before
  verification) and `src/envelope.js` (`parseEnvelope` — the Postfix pipe-argv
  helper, aligned to OPS.md §5). Both lifted verbatim (generic, no policy
  branches, no config deps) with their gitdone characterization tests.
- **Email-triggers pillar, module 4: outbound send path.** `src/outbound.js`
  (`sendmail`, `buildRawMessage`, `newMessageId`, `rfc5322Date`,
  `sanitizeSubject`, `withSignature`), lifted from gitdone with **config
  injection** (no `GITDONE_SENDMAIL_BIN` / `git-done.com` env defaults — the
  caller passes `binary` and `domain`) and an **injectable, no-default footer**
  (gitdone's branded `SIGNATURE_FOOTER`/`SIGNATURE` dropped per PRD §8.6;
  `noSignature` removed as redundant). First **integration-tier** tests:
  `tests/integration/outbound.test.js` drives the real `sendmail(8)`
  child-process path against fake binaries in tmp (no mocks); pure builders
  stay in `tests/unit/outbound.test.js`.
- **Git-ledger pillar, module 5a: event store + per-event write mutex.**
  `src/event-store.js` and `src/event-mutex.js`, lifted from gitdone as the
  stdlib-only half of the storage pillar (gitrepo + simple-git follow in 5b).
  - **Config injected by a bound factory, not a singleton:**
    `createEventStore({ dataDir })` names `dataDir` once and returns the bound
    primitives (`loadEvent`, `createEvent`, `activateEvent`, `editEvent`,
    `recordStepSendErrors`, `recordProofEmailMessageId`, plus the pure
    `findStep` / `senderMatchesStep` / `generateEventId` / `generateEventSalt`).
    This replaces gitdone's `config` singleton. **Why:** banning the singleton
    moved the single source of truth from *implicit* (ambient `GITDONE_*` env
    read at import) to *explicit* (the create call); a bound factory preserves
    that one explicit binding point, where per-call injection of a fixed value
    would re-fragment `dataDir` across every call site. See the decisions log,
    "Config injection by bound per-pillar factories."
  - **Trimmed of gitdone-web magic-link policy:** dropped `confirmActivationLink`
    and the `activation_ack_token` / `activation_link_clicked_at` fields from
    `createEvent` (dashboard activation-link mechanics, not kernel). The
    pending→active gate (`activated_at` / `activateEvent`) is workflow-core and
    stays. `tests/unit/event-store.test.js` proves the trim (the dropped fields
    are absent; `confirmActivationLink` is unexported).
  - `src/event-mutex.js` (`withEventMutex`) lifted with its in-process
    serialization intact; gitdone-deployment-specific commentary generalized to
    library terms (cross-process locking is the consumer's concern).
  - Tests split by type per the Testing Trophy (matching outbound): pure
    helpers in `tests/unit/event-store.test.js`, the filesystem-backed
    primitives (incl. `activateEvent`'s pending→active gate + idempotency) in
    `tests/integration/event-store.test.js`. The activated-edit audit commit is
    skipped pending 5b.
- **Git-ledger pillar, module 5b: per-event git ledger.** `src/gitrepo.js`,
  `createGitrepo({ dataDir, ots? })` — `initRepoIfNeeded`, `commitReply`,
  `appendEditCommit`, `loadCommit`, `listCommits`, `syncEventJson`,
  `nextSequence`, and the pure salted-hash / metadata helpers.
  - **Zero new dependencies: talks to the `git` binary via stdlib
    `child_process`, not `simple-git`.** The dependency checklist failed
    `simple-git` on necessity — gitrepo uses only 5 git ops (a <100-line
    `execFile` wrapper), `listCommits` reads the filesystem rather than
    `git log`, and the only consumed behaviors (commit SHA, staged detection)
    are `rev-parse HEAD` + `diff --cached`. Keeps the ≤3-dep budget for
    `mailauth` + `mailparser`; consistent with `outbound`→`sendmail`. See the
    decisions log, "git ledger uses the `git` binary via child_process."
  - **OTS anchoring is optional and injected:** with no `ots` stamper wired
    (the default until module 5c), commits are written unanchored
    (`ots_proof_file: null`) per SPEC §0.2 — no hard `ots` coupling.
  - **Trimmed to the kernel:** dropped `commitAttach` / `commitRevoke` (policy;
    their `attach+`/`revoke+` tags were already dropped from the router).
    Deferred `commitReverify` + `nextReverifySequence` (kernel per PRD §4 but
    no caller until the verify-side archive-key re-check lands — shipping a
    writer with no caller is the speculative-code red flag) and
    `commitCompletion` (the `completion.js` boundary walk, module 6).
  - Unit/integration split as above; un-skipped the m5a activated-edit audit
    test (now green against the real ledger).
- **Git-ledger pillar, module 5c: optional OpenTimestamps anchor.**
  `src/ots.js`, `createOts({ otsBin })` → `{ stampFile }` — factory-injected
  (otsBin bound once, matching the storage factories), accept-with-flag
  (`stampFile` never throws; returns `{ proof_path }` or `{ error }`). Wire it
  into `createGitrepo({ ots })` to anchor commits; omit it for unanchored.
  - **Dropped `moveProofIntoTree`** — no caller: `gitrepo` files the proof into
    its own tree (`fs.rename` in `maybeStamp`), which is the cleaner boundary
    (ots *stamps*; the ledger owns its layout).
  - Covered `gitrepo`'s previously-untested `if (ots)` branch via an **injected
    fake stamper** (dependency injection, not a mock): success anchors the
    commit and files the proof; a failing stamp records `ots_archive.error`
    with a null path. The real `ots` happy path needs the client + network and
    is deployment-verified; the binary-missing error path is tested via a real
    spawn.
- **Sequence pillar, module 6: workflow completion engine.** `src/completion.js`
  (`shouldCount`, `applyReply`, `isComplete`, `firstPendingStep`, `stepDepsMet`,
  `eligibleSteps`, `meetsTrust`, `COUNT_REASONS`), lifted from gitdone's
  `completion.js` as **pure** state transitions (no I/O; `applyReply` returns a
  new event, never mutates).
  - **Trimmed to the workflow subset** per the §8 NO-GO table: dropped crypto
    declaration/attestation (§8.2), strict signing + `reference_docs` (§8.3),
    and revoke/threshold/dedup (§8.4) — `shouldCountDeclaration`,
    `shouldCountAttestation`, `applyDedup`, `applyRevoke`, the strict-signing
    matchers, and the attestor-progress/redaction machinery all stay in gitdone
    as policy on the hooks. The engine is **one `dependsOn` eligibility model** —
    no sequential/parallel code-path split.
  - **Re-anchored to SPEC** (not a verbatim lift): machine-code `count_reason`s
    via the exported `COUNT_REASONS` taxonomy (SPEC §4) instead of gitdone's
    English prose; **per-step `minTrust`** (gitdone used a per-event
    `min_trust_level`); top-level `status`/`completed_at` (not gitdone's nested
    `completion` object); camelCase `dependsOn`/`minTrust`; `type: "workflow"`.
    Trust ordering is **imported from `classifier.js`** (`TRUST_LEVELS`), not
    redefined — one source of truth.
  - `flow` (`sequential` default / `parallel` / `custom`) is stored for audit
    and affects only the reason label (`out_of_order` under sequential vs.
    `deps_unmet`); `createEvent` expands `sequential` into a linear `dependsOn`
    chain (wired in m7), so the engine never branches on flow for eligibility.
  - Document-hash *verification* is the notary (PRD §4.1, m6.5), explicitly **not**
    in this engine; `requires_attachment` here is only the generic "carried an
    attachment" gate. The completion ledger commit (`commitCompletion`) and
    cascade notifications are orchestration, wired in m7.
  - `tests/unit/completion.test.js` — 18 pure tests covering the full decision
    tree (every `count_reason`, the sequential/parallel/custom flow split,
    `requires_attachment`, the two-step→complete transition, input immutability,
    and the `eligibleSteps`/`stepDepsMet` predicates), re-anchored from gitdone's
    characterization suite (domains neutralized to `example.com`).
- **Verify pillar, module 6.5: document notary (verify half).** `src/notary.js`
  — `hashDocument(bytes)` (the canonical `sha256:`-prefixed fingerprint) and
  `createNotary({ gitrepo, eventStore })` → `verifyDocument(eventId, bytes,
  { email })`. **Net-new** primitive (NOT a gitdone lift — gitdone has only
  manifest-matching strict signing, which stays policy per §8.3), designed from
  PRD §4.1.
  - `verifyDocument` is **read-only over the ledger**: re-hashes a document,
    scans every committed reply (counted or not — accept-with-flag), and returns
    `{ found, matches: [{ sequence, received_at, trust_level, counted,
    sender_domain, sender_match, filename }] }`. With `email`, `sender_match`
    flags whether the verified sender (salted via `gitrepo.saltedSenderHash`)
    submitted it — the second layer; without it, `sender_match` is null.
  - Framed as a **proof-of-participation receipt, not a secret** (PRD §4.1): the
    DKIM-verified sender is the trust factor; a matching document only adds
    tamper-evident binding.
  - **`hashDocument` is the one source of truth for the fingerprint format** — m7's
    parser will hash inbound attachments through it, so committed
    `attachments[].sha256` matches what `verifyDocument` recomputes
    (`verifyDocument` also normalises a bare-hex vs `sha256:`-prefixed value
    defensively).
  - **Capture half deferred to m7:** mandatory auto-hashing of inbound
    attachments needs the parsed bytes, which only exist at the mailparser layer
    (m7); at commit time the ledger holds attachment metadata, not bytes. Building
    a capture enforcer now (no byte source) would be the speculative-code red
    flag — so the parser populates the hashes in m7 and this module reads them.
  - Tests: `tests/unit/notary.test.js` (pure `hashDocument` format/determinism +
    factory guards) and `tests/integration/notary.test.js` (real store + per-event
    repo: exact-match, the email layer's match/reject, tampered-doc and
    unknown-event non-matches — no mocks).
- **Sequence pillar, module 6.7: crypto sign-off engine.** `src/crypto.js`
  (`shouldCount`, `applyReply`, `isComplete`, `signatures`, `CRYPTO_REASONS`) —
  mailproof's **second coordination mode** (`type: "crypto"`, PRD §4.2),
  re-exported as `shouldCountSignoff` / `applySignoff`. Pure (no I/O, no crypto),
  parallel to `completion.js`.
  - **One parameterized engine, lifted from gitdone's `shouldCountDeclaration` +
    `shouldCountAttestation` + the `applyReply` crypto branches and collapsed**
    per the two-mode pivot: `signers` (allow-list or `open`), `threshold`
    (1 = single-signer *declaration*, N = count-to-goal), optional single
    `requiredDocHash` (the "email + doc" two-layer, in the notary's `sha256:`
    format). A reply counts iff activated/not-archived/not-complete, DKIM-`verified`,
    **not the initiator**, a matched signer, a *distinct* sender, and (if set) an
    attachment hash matches; the event locks at distinct count ≥ `threshold`.
  - **Trust hardcoded to `verified`, NOT per-event configurable** — crypto is the
    high-assurance mode; a forwarded/authorized reply must never stand as a
    signature.
  - **Initiator self-reply is committed for audit but never counts**
    (`initiator_self_reply`) — anti-self-dealing: the initiator orchestrates and
    cannot also be a verifier. (Events differ: there the initiator *may* be a
    counted participant.)
  - **Sender-identity resolution stays in the orchestrator** (like workflow's
    `participant_match`): the engine reads precomputed `signer_match` /
    `is_initiator` booleans and dedups on the salted `sender_hash`, so plaintext
    never reaches the engine or ledger (SPEC §6).
  - **Trimmed to the lean mechanism** per §8.2–8.4: dropped `revoke`,
    `latest`/`accumulating` dedup (distinct-only), multi-doc strict manifests +
    `reference_docs`, per-attestor progress buckets, and attestor-PII redaction —
    all stay gitdone policy. Re-anchored to SPEC: machine-code `count_reason`s,
    camelCase, top-level `status`/`completed_at` (not gitdone's nested
    `completion`). ~150 lines vs. completion.js's ~500.
  - Tests: `tests/unit/crypto.test.js` (declaration / distinct-count / initiator
    exclusion / trust gate / open mode / `requiredDocHash` / lifecycle / purity)
    including a **provable-trim** test that gitdone's dropped policy fields
    (`dedup`, `revoked_senders`, `reference_docs`, `mode`) are inert, not honored.
  - **Router `attest+{id}@` tag + SPEC §2 promotion deferred to m7b assembly**,
    where the route is exercised end-to-end — m6.7 mirrors how m6 landed
    (the engine, pure; the router untouched).
- **Verify + inbound pillar, module 7a: inbound decoder + the first external
  deps.** `src/parse.js` (`authenticateMessage`, `parseMessage`) — the two
  primitives gitdone composed inline in `bin/receive.js` (the orchestrator,
  **not lifted**), extracted as standalone functions.
  - **First 2 runtime deps: `mailauth` (DKIM/DMARC/ARC) + `mailparser` (MIME).**
    Both passed the AGENT_RULES External Dependency Checklist: DKIM/MIME of
    untrusted input is security-critical (a vetted lib is *required*, never
    hand-rolled), both are actively maintained by the Nodemailer author, and
    they are the same packages gitdone already ships — **no new supply-chain
    surface**. Budget 2 of ≤3 (the git ledger still uses the `git` binary, not
    `simple-git`). MIT-licensed.
  - `authenticateMessage(raw, envelope, { mtaHostname, resolver })` is a thin
    wrapper that **pins `trustReceived: false`** (mailproof never trusts
    pre-existing `Received`/`Authentication-Results` headers — forged headers
    are the attack) and injects `mtaHostname`/`resolver` as config (no env
    singleton). Its result feeds `classifyTrust` (m1).
  - `parseMessage(raw)` → `{ from:{address,name}, messageId, attachments, rawSha256 }`.
    **This is the notary's CAPTURE half** (deferred from m6.5): every inbound
    attachment is auto-hashed through `notary.hashDocument`, so committed
    `attachments[].sha256` is byte-identical to what `verifyDocument` recomputes
    — one fingerprint format across the kernel.
  - **Boundary correction:** the stash labelled this a `verify.js` lift, but
    `verify.js` is gitdone's `verify+{id}@` *endpoint* (forwarded-email report +
    reverify-against-archived-PEM); that endpoint, DSN bounce handling, and
    durable `dkim-archive` reverify are **deferred** to later modules.
  - Tests: `tests/unit/parse.test.js` — `parseMessage` over a fixture with a
    base64 attachment (asserts the notary-hashed sha256, size, `from`,
    `messageId`) and `authenticateMessage` run **offline** via an injected
    no-DNS resolver (asserts the result shape and that nothing authenticates →
    `classifyTrust` returns `unverified`). No network, no mocks of the deps.
- **Assembly prep, module 7b-1: accept-with-flag commit fields + `commitCompletion`.**
  The storage slice the `ingest()` pipeline (m7b) needs, landed first because it
  is independent of the pipeline wiring.
  - `buildCommitMetadata` now emits `kind: "reply"` and the **accept-with-flag**
    pair `counted` / `count_reason` (SPEC §4) — previously omitted. Invariant
    enforced in one place: `counted ⇒ count_reason: null`; an absent flag
    defaults to `counted: false` (never `undefined`). The orchestrator computes
    these from the engine's decision before the commit is written.
  - `commitCompletion(eventId, event, { completedAt, triggeringSequence, summary? })`
    **lifted from gitdone** (deferred since m5b): writes the one-shot
    `commits/completion.json`, idempotent (a second call is a no-op), OTS-stamped
    via the same `maybeStamp` path as replies. gitdone's per-mode `event_mode`
    is **dropped** (the two-mode model has no `mode`; `event_type` suffices).
  - Tests: `tests/unit/gitrepo.test.js` (kind/counted/count_reason incl. the
    invariant + defensive default) and `tests/integration/gitrepo.test.js`
    (real repo: completion.json written once, idempotent, `event_mode` absent).
- **Assembly prep, module 7b-2: two-mode `createEvent` + the `attest+` route.**
  - `event-store.js` gains two pure, exported helpers: **`expandFlow(steps, flow)`**
    turns the `flow` sugar into the canonical per-step `dependsOn` graph the
    engine reads (sequential → linear chain, parallel → no deps, custom →
    verbatim — the engine has ONE eligibility model, so `flow` exists only at
    creation, SPEC §3); **`buildEventRecord(partialEvent)`** normalizes a
    caller's partial event into the canonical two-mode record (workflow §3 /
    crypto §3.1) with structural-only validation — rejects an unknown `type`, a
    workflow step without a unique id, a crypto event with `threshold < 1` or
    with neither `signers` nor `open` (nothing could ever count). `createEvent`
    is now a thin writer over `buildEventRecord` (collision check + atomic
    write); crypto events init `signatures: []`, signers are lowercased.
  - **`router.parseAttestTag`** (`attest+{eventId}@`, no step component) — the
    crypto sign-off route, **promoted from a policy tag to a kernel tag** (SPEC
    §2; deferred here from m6.7, now that it's exercised). `attach+`/`revoke+`/
    `manage+`/`close+`/`bundle+` stay dropped.
  - **Fixed a stale value**: the event-store integration tests used the gitdone
    `type: 'event'` literal; the canonical mailproof value (SPEC §3, PRD §4.2,
    every other test) is `'workflow'`. `buildEventRecord`'s type validation
    surfaced it; the 14 occurrences are corrected.
  - Tests: `tests/unit/event-store.test.js` (`expandFlow` 3 flows; `buildEventRecord`
    workflow/crypto normalization + every validation throw), `tests/unit/router.test.js`
    (`parseAttestTag` accept/reject), `tests/integration/event-store.test.js`
    (both modes normalize + persist to disk). 174 → 185, 0 fail.
- **Assembly, module 7b-3 (Commit A): the `create()` composition root.**
  `src/create.js` — `create({ dataDir, domain, sendmailBin?, otsBin? })` wires
  the four pillars into ONE bound instance: it composes `createOts` (only when
  `otsBin` is set) → `createGitrepo` → `createEventStore` → `createNotary` over a
  single `dataDir`, so config is injected here and nowhere else (decisions log,
  "Config injection by bound per-pillar factories"). Returns the create/read/verify
  surface — `createEvent`, `activateEvent`, `editEvent`, `loadEvent`, `listCommits`,
  `loadCommit`, `verifyDocument`, `hashDocument`. `dataDir`/`domain` are required
  (validated at composition); `sendmailBin`/`otsBin` are optional. **`ingest()` is
  deferred to Commit B** (the inbound verify→route→commit→advance→trigger pipeline,
  added to this same returned object). Re-exported from `src/index.js`. Tests:
  `tests/integration/create.test.js` drives the real store + ledger + notary on a
  tmp dir (validation, surface shape, both-mode `createEvent`↔`loadEvent` round
  trip, notary/gitrepo sharing the bound dataDir, otsBin-optional). 185 → 191, 0 fail.
- **Assembly, module 7b-3 (Commit B): the `ingest()` core.** `src/ingest.js` —
  `createIngest(deps)` returns `ingest(raw, envelope)`, the one path every inbound
  reply takes (mailproof's answer to gitdone's NOT-lifted `receive.js main()`):
  **prefilter** (humans-only gate; non-human mail returns `routed:false`, never
  committed) → **decode** (`parseMessage` + `authenticateMessage`) → **classify**
  trust → **route** by plus-tag (`event+`→workflow, `attest+`→crypto) → **load** →
  **match** (workflow `participant_match`; crypto `signer_match` + `is_initiator`,
  resolved from the lowercased plaintext sender, never persisted) → **commit ALWAYS**
  (accept-with-flag: the engine's `shouldCount` verdict drives both the commit's
  `counted`/`count_reason` and the transition) → **advance** (`applyReply`, routed
  by mode) → **persist** master JSON + repo mirror → **`commitCompletion`** on the
  newly-complete edge → return a summary `{ routed, mode, eventId, trustLevel,
  committedSeq, counted, count_reason, completedStep|signatureCount, eventComplete,
  notified }`. The whole load→commit→advance→persist section runs inside ONE
  `withEventMutex(eventId)` (the in-process mutex is non-reentrant and `commitReply`
  allocates its sequence by reading the dir, so concurrent replies must serialise);
  DNS-bound auth stays outside the lock. **The trigger/send layer is deferred to
  Commit C** — `notified` is always `[]` here.
  - `event-store.js` now exposes **`writeEventAtomic(eventId, event)`** — the raw
    (mutex-less) atomic master writer `ingest` needs from inside the lock it
    already holds (the mutex-taking `activateEvent`/`editEvent` would deadlock).
  - `create()` gains optional **`mtaHostname`** + **`resolver`** (threaded into
    mailauth) and composes + returns `ingest`. `resolver` lets tests authenticate
    offline; production uses the system resolver.
  - Tests: `tests/integration/ingest.test.js` drives the real store + ledger +
    both engines + the real mailauth/mailparser decode path offline (workflow
    count→complete, crypto verified sign-off→lock, accept-with-flag for
    wrong-participant + unverified-trust + initiator self-reply, prefilter drop,
    unknown-event + tagless). New TEST-ONLY `tests/helpers/dkim.js` (per-call
    keypair + `signDkim` + matching in-process resolver → `verified` offline).
    191 → 198, 0 fail.
- **Assembly, module 7b-3 (Commit C): the trigger/send layer + `composeNotification`
  hook — m7b-3 (and the m7b assembly) COMPLETE.** `ingest()` now closes the
  email loop: on a COUNTED reply it sends the next neutral notification(s) via the
  injected `sendmailBin` (real `buildRawMessage` + `sendmail`), OUTSIDE the event
  lock, and reports them in the result's `notified` array.
  - **What fires:** workflow → ping the participant(s) of every step that just
    became eligible (`eligibleSteps` whose `dependsOn` includes the completed
    step); crypto → ack the verified signer; both → notify the `initiator` on the
    completing edge. Non-counting replies send nothing. Each message's `From` is
    the plus-tagged reply address (`event+{id}-{step}@`, `attest+{id}@`) so the
    recipient's reply routes straight back; `Auto-Submitted: auto-generated` marks
    it machine-sent. No `proof_email_sent_at` idempotency state is needed — the
    distinct-only kernel completes an event exactly once (a later reply hits
    `already_complete`), so the completion notice can't double-fire (gitdone's
    revoke/reopen re-fire guard stays policy).
  - **`composeNotification(ctx) → body`** — the ONE optional hook (branding is a
    NO-GO §8.6, so the body needs a consumer seam). `ctx` carries
    `{ kind: 'advance'|'ack'|'completion', mode, eventId, event, to, replyAddress,
    step?|signatureCount? }`; a falsy return (or absent hook, or a throw) falls
    back to a neutral default body. Subjects are kernel-defaulted. No
    `onCounted`/`onRejected`/`onCompleted` hooks — redundant with the `ingest()`
    return value.
  - `create()` gains the optional `composeNotification` param and threads the
    outbound builders + `sendmailBin` into `ingest`.
  - Tests: `tests/integration/ingest-triggers.test.js` drives the real outbound
    path to a fake capture binary in tmp (workflow advance→completion, crypto
    ack+completion, no-send on non-counting, `composeNotification` override vs
    neutral default, graceful `ok:false` when `sendmailBin` is absent). New
    `verifiedSigner` helper (one keypair/resolver signing many senders @one
    domain). 198 → 203, 0 fail.
- **`mailproof.context.md`** — the dense AI-assistant/developer integration guide
  (modeled on knowless's): both modes, `create()` options, the `create()` return
  surface + `ingest()` result shape, the accept-with-flag invariant, trust levels,
  the `composeNotification` hook, the four-pillar architecture, the
  what's-NOT-in-mailproof policy boundary, gotchas, and constraints.
- **Verify pillar, m7c-1: durable DKIM-key archive + auth summaries on commit
  (gitdone parity).** `src/dkim-archive.js` (lifted, generic, config-free):
  `fetchDkimKey` (resolves `{selector}._domainkey.{domain}` via the INJECTED
  resolver, extracts `p=`, wraps SPKI in PEM), `pickSignatureToArchive`,
  `extractPublicKey`, `toPem`. `parse.js` gains pure **`summariseAuth(auth)`** →
  `{ dkim, spf, dmarc, arc }` (DKIM per-signature result/domain/selector/aligned;
  SPF/DMARC verdicts; ARC chain depth). `ingest()` now, right after authenticate
  (still outside the event lock), computes the summaries and best-effort archives
  the signer's public key, then records both on the commit via the existing
  `commitReply` ctx (`dkim`/`spf`/`dmarc`/`arc` + `dkimArchive` → `dkim_key_file`
  + `dkim_archive`). This is what lets a commit re-verify OFFLINE after the signer
  rotates DNS — the substrate for the `verify+`/`reverify` endpoints (m7c-2/3).
  Re-exported from `src/index.js`. Tests: `tests/unit/dkim-archive.test.js`
  (parse/PEM/pick + `fetchDkimKey` via offline resolver, error paths) +
  `tests/integration/ingest.test.js` (a verified reply records the DKIM summary +
  archives the key on its commit). 203 → 209, 0 fail.
- **Verify pillar, m7c-2: offline durable verification.** `src/verifier.js` —
  `createVerifier({ gitrepo, eventStore, resolver })` → `verify(eventId, bytes,
  { messageId?, resolver? })`, exposed as **`core.verify()`**. Two lifted kernel
  primitives (gitdone's verify.js/reverify.js, trimmed — report *formatting* stays
  policy §8.6): **`findMatch`** (re-hash a candidate against committed
  `raw_sha256` → salted `message_id_hash` → attachment hashes, one
  `sha256:`-tagged format end to end) and **`reverifyDkim`** (re-run mailauth DKIM
  against the ARCHIVED PEM via a resolver that serves the archived key and
  delegates everything else to an injected base resolver — so the signature
  re-verifies OFFLINE, even with live DNS down, after the signer rotates keys).
  `gitrepo` gains **`loadDkimPem`** (allowlisted to `dkim_keys/commit-*.pem`).
  Re-exported from `src/index.js` (`createVerifier`, `findMatch`, `reverifyDkim`).
  Tests: `tests/unit/verifier.test.js` (the `findMatch` cascade + precedence) +
  `tests/integration/verifier.test.js` (ingest a signed reply → re-verify the
  exact bytes against the archived key with **live DNS disabled**; tampered ⇒
  no match; attachment-hash match; unknown event). 209 → 218, 0 fail.
- **Verify pillar, m7c-3: contested-commit `reverify` + trust upgrade.**
  `verifier.js` gains pure **`resolveUpgrade`** (below-`verified` → `verified` on a
  DKIM pass; already-verified records the attempt, no upgrade) and **`pickSigner`**
  (the commit's signing domain/selector), plus **`reverify(eventId, targetSeq,
  rawEml, { resolver? })`** (exposed as **`core.reverify()`**): re-runs DKIM against
  the target commit's archived key and, on a pass, upgrades the recorded trust —
  persisting an **immutable** `reverify-NNN.json` via new **`gitrepo.commitReverify`**
  (separate sequence namespace; the original `commit-NNN.json` is never rewritten;
  OTS-stamped like a reply). Re-exported from `src/index.js`. Tests:
  `tests/unit/verifier.test.js` (`resolveUpgrade`/`pickSigner`) +
  `tests/integration/reverify.test.js` (a non-aligned commit recorded `unverified`
  upgrades to `verified` against the archived key with live DNS disabled; an
  already-`verified` commit records the attempt without upgrading; missing target
  ⇒ `found:false`). 218 → 223, 0 fail.
- **m7c-5: kitchen-sink end-to-end proof.** `tests/integration/e2e.test.js` drives
  a FULL lifecycle of each mode through the public `create()` API against the real
  ledger + mailauth + a fake capture transport — the "all the pillars compose"
  proof before the gitdone reconverge. Workflow: two sequential steps advance
  themselves (advance→completion triggers) to completion, salted-at-rest is
  asserted (no plaintext sender on the ledger), and step 1's email re-verifies
  offline. Crypto: an open threshold-2 sign-off counts two distinct verified
  signers, rejects the initiator's self-reply (`initiator_self_reply`) and a
  duplicate (`already_signed`), and locks — acking the signer + notifying the
  initiator, with the ledger showing `counted` `[true,false,false,true]`. The
  m7c verification surface is now complete bar **m7c-4** (OTS-proof verification,
  skip-gated on the `ots` binary). 223 → 225, 0 fail.
- **Verify pillar, m7c-4: OTS-proof verification (Bitcoin-anchor upgrade/read).**
  `createOts` gains `upgradeProof(abs)` and `readBlockHeight(abs)`, plus the pure
  `parseOtsBlockHeight` (re-exported from `src/index.js`) — **ported from
  gitdone's `bin/ots-upgrade.js` worker**, trimmed to the kernel primitive.
  `upgradeProof` runs `ots upgrade` in place and treats the proof file's sha256
  *changing* as the authoritative "now anchored in Bitcoin" signal
  (`{ ok, changed, anchored, pending, exit, block_height? }`); `readBlockHeight`
  reads which block via `ots info` (local parse, **no network**).
  - **Follows gitdone's proven design:** we do NOT shell out to `ots verify`
    (which masks pending state by querying calendars live) — the upgraded `.ots`
    carries the Bitcoin attestation offline, so the upgrade-changed-the-file
    signal is the trust anchor. `ots upgrade`'s non-zero exit on a still-pending
    proof is modelled as `{ pending: true }`, **not** an error (accept-with-flag).
  - **Left in the worker (policy/glue → m7d):** the `$dataDir/repos/*` walk, the
    per-repo git-commit batching, `patchCommitJsonAnchored` (writing `ots_anchored`
    into the ledger), the `.anchored-notified` sentinel, and `notifyProofAnchored`.
    The event-level "upgrade an event's proofs + record anchored + emit the
    `proof_anchored` occasion" is m7d, riding the `composeNotification` seam.
  - Tests: `tests/unit/ots.test.js` (8 — the pure parser across every
    opentimestamps-client output shape + null/degenerate cases) and 4 added to
    `tests/integration/ots.test.js` (binary-missing → `{error}`/`null`, never
    throws; + real-`ots` smoke tests, skip-gated on the client, asserting a
    non-proof input reports `pending`/`null` and leaves the file untouched). The
    fully-confirmed-proof path stays deployment-verified (needs ~1h of Bitcoin
    confirmations). **225 → 237, 0 fail. The 9-point gitdone-rebuild checklist is
    now fully covered — OTS-proof verification was the last gap.**
- **Triggers pillar widens — m7d-1: time-driven occasions (`sweep()`).** The
  trigger pillar grows from "fire the next email on an inbound reply" to also
  emitting the occasions that fall out of the passage of TIME, executing the
  locked occasions-are-kernel / bodies-are-policy boundary (decisions-log
  2026-05-27). `create()` returns a new `sweep({ now? })` — a consumer-scheduled
  scan (the schedule is the consumer's) that derives and emits two occasions:
  - **`overdue`** — an active event idle past `overdueDays` (default 14) past its
    reference clock: ONE neutral nudge to the initiator, idempotent via
    `event.nudged_overdue_at` (bookkeeping only — not mirrored to the repo).
  - **`archived`** — idle past `archiveDays` (default 45): a STATE TRANSITION
    (`archived_at` + `archive_reason: 'auto_stale'`) persisted to the master JSON
    **and mirrored into the per-event ledger**, plus a neutral notice to the
    initiator. `sweep()` returns `{ overdue, archived, notified }`.
  - **Shared notifier (`src/notify.js`, `createNotifier` → `deliver`).** The
    notification seam was extracted out of `ingest.js` so **every** occasion —
    workflow `advance` / crypto `ack` / `completion` *and* `overdue` / `archived`
    (and the m7d occasions to come) — fires through ONE `deliver`, with
    `composeNotification(ctx)` (keyed by `kind`) the single body hook. One source
    of truth for occasion→email; ingest's behaviour is unchanged.
  - **Ported from gitdone's `app/src/sweep.js`**, trimmed to the kernel boundary:
    the `config` singleton becomes injected `overdueDays`/`archiveDays`; the send
    goes through `deliver` instead of a bespoke binary; predicates re-anchored to
    mailproof's shape (`type==='workflow'`, `status==='complete'`). **Deferred to
    m7d-2** (activation lifecycle): the pending-activation TTL-delete + about-to-
    expire reminder passes. **Divergence** (simpler, justified in the module
    header): archive takes precedence over a same-tick overdue — no point nudging
    an event being archived — one fewer wasted email than gitdone's two
    independent passes.
  - New `eventStore.listEventIds()` (enumerate events for the scan). The pure
    `referenceClockMs`/`isActive` are re-exported.
  - Tests: `tests/unit/sweep.test.js` (7 — the pure clock + active-cohort
    predicates) and `tests/integration/sweep.test.js` (8 — overdue-once +
    idempotency, archive transition persisted + ledger-mirrored, archive-over-
    overdue precedence, deadline-driven reference clock, not-yet-due no-op,
    `composeNotification` body override, custom thresholds) against the real
    store + ledger + a fake capture transport. **237 → 252, 0 fail.**
- **Triggers pillar — m7d-2: organiser-action occasions (activation + edit).**
  `create()`'s `activateEvent`/`editEvent` are now bound wrappers that run the
  (pure) store transition, then emit the resulting occasion through the shared
  `deliver`, appending `notified` to the return:
  - **`activation`** — on the FIRST `activateEvent`, ping every initially-eligible
    participant (workflow: `eligibleSteps`) / listed signer (crypto). Idempotent
    (a re-activate notifies no one). Open crypto events have no roster, so they
    notify no one — the initiator distributes the `attest+` link themselves.
  - **`reassigned`** — on `editEvent`, ping a participant moved ONTO a currently-
    eligible step of an ACTIVATED event. A blocked step's new owner is pinged
    later via `advance`; a pending event's edits and non-participant edits ping
    no one.
  - **Boundary refinement (supersedes m7d-1's "deferred to m7d-2" line):** the
    pending-activation TTL-delete and about-to-expire reminder are NOT lifted —
    they presuppose the magic-link self-activation UX mailproof dropped, so they
    are consumer policy (whole-event deletion is the consumer's lever per the
    privacy decision; a draft-idle reminder is composable on `listEventIds` +
    the shared notifier). Recorded in the decisions log.
  - Tests: `tests/integration/activation-edit.test.js` (7 — sequential/parallel/
    crypto/open activation, idempotency, eligible/blocked/pending/non-participant
    edit re-notify). **252 → 259, 0 fail.**
- **Triggers pillar — m7d-3: inbound bounce (DSN) → the `bounce` occasion.**
  `src/dsn.js` — an RFC 3464 delivery-status-notification parser (PURE,
  stdlib-only): `isDeliveryStatusReport` / `extractDsn` / `permanentFailures`
  (+ `parseDeliveryStatusBody` / `stripAddressType` / `contentTypeOf`). `ingest()`
  now recognises a DSN from the header block **before** the humans-only prefilter
  (which would otherwise reject the machine-generated report), routes it to the
  event/step, records a per-step send error (`recordStepSendErrors`), and emits
  the `bounce` occasion to the initiator. A bounce is **operational, not a
  participant reply** — it is *never* committed to the ledger.
  - **Ported from gitdone's `app/src/dsn.js`**, re-anchored to operate on RAW
    bytes (gitdone keyed off mailparser's `parsed.headers`, which mailproof's
    `parseMessage` intentionally doesn't expose; mailparser also folds
    message/delivery-status into `.text`) — so the parser is self-contained and
    adds no dependency. **Routing divergence:** mailproof signs outbound mail
    *from the plus-tag* (`event+{id}-{step}@` / `attest+{id}@`), so a bounce's
    return path — its inbound envelope recipient — *is* that tag; ingest routes
    by the address it already parses (VERP-style), rather than gitdone's
    fixed-sender + body inspection. Only **permanent** failures (Action: failed,
    or a 5.x status when Action is absent) alert; transient `delayed` (4.x)
    reports are ignored.
  - Tests: `tests/unit/dsn.test.js` (10 — the pure parser: detection incl. folded
    headers, recipient/status/diagnostic extraction, permanent-vs-transient,
    address-type stripping, multi-recipient blocks) and
    `tests/integration/ingest-bounce.test.js` (4 — route + step-error + notify +
    not-committed; transient no-op; untagged/unknown-event reported-not-routed;
    crypto event notifies without a step error). **259 → 273, 0 fail.**
- **Triggers pillar — m7d-4: OTS proof anchoring + the `proof_anchored` occasion.**
  `create()` exposes `upgradeProofs({ now? })` — a consumer-scheduled pass that
  walks every event's repo, drives **m7c-4's `ots.upgradeProof`** across each
  pending `.ots` proof, records the anchored state into the ledger, and emits
  `proof_anchored` to the initiator when an event newly crosses fully-Bitcoin-
  anchored. Only stood up when `otsBin` is configured (otherwise `undefined`).
  - **Ledger recording (`gitrepo.commitProofUpgrade`)** — patches the sibling
    commit JSON with `ots_anchored: true` + `ots_anchored_at` + (when known)
    `ots_block`, git-adds the upgraded proofs AND the patched JSONs, writes ONE
    summary commit per event. Idempotent backfill: a re-run on already-anchored
    proofs writes nothing if nothing actually changed. Plus
    `gitrepo.listProofFiles(eventId)` (basename map `commit-NNN.ots ↔
    commit-NNN.json`, `reverify-NNN.ots ↔ reverify-NNN.json`, `completion.ots ↔
    completion.json`).
  - **`proof_anchored` once-only** — gitdone's `.anchored-notified` SENTINEL
    FILE becomes a top-level `event.ots_proof_anchored_notified_at` flag (same
    store as the sweep flags — one source of truth). Gated on `status==='complete'`
    (collapses gitdone's `completion.status || threshold_reached_at`), at least
    one proof NEWLY anchored this run (a pure backfill never re-sends), and no
    proofs still pending.
  - **Concurrency:** the slow per-file `ots upgrade` runs OUTSIDE the per-event
    mutex (talks to calendar servers); the ledger commit + the flag flip happen
    INSIDE one mutex section per event, so they can't race with a concurrent
    ingest writing into the same `.git`. The send fires outside the lock.
  - **Ported** from gitdone's `app/bin/ots-upgrade.js` `processRepo`/`run` +
    `notifyProofAnchored` gate, trimmed to the kernel boundary: no `bin/` cron
    glue, no notify-bodies (the `composeNotification` seam owns the body).
  - Tests: `tests/integration/proof-anchor.test.js` (6 — pending no-op, fresh
    anchor → patch + emit + idempotent re-run, mixed proofs hold the notify
    until all anchored, incomplete event records but doesn't emit, no-repo
    skipped, composition guards). Stub-`ots` injection exercises the
    orchestration without subprocesses (the real `upgradeProof` is m7c-4's
    integration test). **SPEC §4 corrected** (the OTS section no longer says
    "the consumer's scheduler" — `upgradeProofs` is the kernel mechanism).
    **273 → 279, 0 fail.**

### Fixed
- **`editEvent` completeness guard reads top-level `status`.** It refused edits
  on a complete event via `event.completion.status` — gitdone's nested shape,
  which mailproof never writes (the completion/crypto engines and `sweep`'s
  `isActive` use top-level `status === 'complete'`). The guard never fired on a
  real completed event; the test passed only because it built the event with the
  legacy shape. Now reads `event.status` (the engines' field) — one source of
  truth, and a prerequisite for m7d-2's edit-renotify not firing on a done event.
- `src/index.js` — public entry point, re-exporting each pillar as it lands.
- `tests/unit/classifier.test.js` — 14 behavior tests (every trust level,
  precedence ordering, alignment edges, defensive input), reconciled with
  gitdone's characterization fixtures (real mailauth shape).
- `docs/02-design/SPEC.md` — wire-format authority: trust taxonomy, address
  grammar, `event.json` / `commit-NNN.json` schemas, tamper-evidence model, and
  the salted-hash plaintext discipline. Kernel-vs-policy boundary marked throughout.
- `OPS.md` — operator checklist for the bundled Postfix/opendkim stack
  (DNS, PTR/FCrDNS, the `master.cf` pipe transport, port-25 ingress/egress).
- `config.example.env` — `MAILPROOF_*` reference template (env → injected
  `create()` config).
- **Identity pivot: two generic coordination modes (PRD §1, §4.2).** A design
  conversation widened mailproof from "generic workflow only" to **events** +
  **crypto sign-off**, both on the DKIM-verified-email + notary substrate —
  "gitdone's engine, public." Crypto is **one parameterized engine**: `signers`
  (explicit email list *or* open via a shared `attest+{id}@`-style address — the
  "link" is an email address, **not** a web link/app/webhook), `threshold`
  (1 = single-signer declaration; N = count-to-goal), optional single
  `requiredDocHash`. **Lean by exclusion** — `revoke`, `latest`/`accumulating`
  dedup, multi-doc manifests, attestor-PII redaction, and the magic-link/web flow
  stay `gitdone` policy. This **supersedes** the "generic workflow only" decision
  and narrows NO-GO §8.2–8.4/§8.12; the m6 events engine is unchanged, crypto is
  an additive engine (m6.7) and `ingest()` routes by `type`. See the decisions log.
- **Scope locked: document-notary primitive (PRD §4.1).** A design conversation
  on using attachments for verification resolved to a minimal kernel notary —
  mandatory SHA-256 auto-hashing of inbound attachments + a read-only
  `verifyDocument(doc)` lookup — framed as a *proof-of-participation receipt, not
  a secret*. Distinct from gitdone's strict-signing (§8.3, still policy): the
  notary records and verifies, it never gates workflow completion. Outbound-doc
  hashing, `listDocuments`, and retrieval-gating are **deferred** (built only on
  a concrete need); **document-as-login / second factor is NO-GO** (§8.8). See
  the decisions log.

### Changed
- `package.json`: added the `test` script (`node --test`), an `exports` map, and
  shipped `OPS.md` + `config.example.env` in the `files` allowlist.

## [0.0.1] - 2026-05-22

First release published to npm — **reserves the `mailproof` name**. Pre-library:
there is still no working API (`main` resolves to `src/index.js`, which lands in
P1), so this publish is a documentation + POC scaffold, not a functional module.

### Changed
- **Renamed `gitcore` → `mailproof`.** The name reflects the identity: verification
  is grounded in DKIM/DMARC — i.e. email — by construction, so the channel is the
  trust anchor, not an implementation detail.

### Added
- `docs/` tier: `01-product/PRD.md` (with the §8 NO-GO table), `02-design/DESIGN.md`
  (moved into the design tier), `03-logs/decisions-log.md`, and `docs/README.md`
  (index + document precedence).
- npm publish workflow via OIDC trusted publishing (`.github/workflows/publish.yml`).
- Full publish metadata in `package.json` (repository, bugs, homepage, author,
  keywords, `files` allowlist, `publishConfig`); removed the `private` flag and the
  non-standard `_intendedDependencies` placeholder.
- This changelog.

## [0.0.0] - 2026-05-22

### Added
- Initial public scaffold (published as `gitcore`): a stdlib-only POC
  (`poc/pipeline.js`) proving the four pillars compose — verify → sequence →
  git ledger → email triggers — plus the original DESIGN doc and an Apache-2.0
  license. The POC is throwaway: it gets rewritten in P1 and is never shipped.
