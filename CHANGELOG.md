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
