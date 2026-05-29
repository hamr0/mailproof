# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What mailproof is

An **email-native multi-party coordination kernel**, being extracted from the sibling `gitdone` project (`~/PycharmProjects/gitdone`) into a standalone vanilla JS library. It does four things: **verify** an inbound reply (DKIM/DMARC trust level), **sequence** it through a workflow of ordered/parallel steps, **commit** it to a tamper-evident per-event **git** ledger, and **trigger** the next email. No web UI, no branding, no crypto-attestation policy — those stay in `gitdone` as a consumer on top.

## Project status — read this first

**P1 (the lift) is COMPLETE, and so are the two surfaces built on it — m7c (verification) and m7d (triggers).** `src/` holds the lifted, tested modules: verify (`classifier`), the inbound decoder (`parse` — DKIM/DMARC auth + MIME), sequence routing (`router`), inbound preprocessing (`prefilter`, `envelope`), outbound (`outbound`), the full git-ledger storage (`event-store`, `event-mutex`, `gitrepo`, optional `ots`), **both sequencing engines** (`completion` = workflow events, `crypto` = sign-off), the document notary (`notary`), and **the assembly** (`create` + `ingest`): `create()` composes the pillars over one `dataDir`; `ingest()` runs the prefilter→decode→classify→route→commit-always→advance→persist→trigger pipeline. On top of that: the **verification surface** — durable DKIM-key archive, the offline `verify()`/`reverify()` primitives, OTS-proof anchoring, AND the public `verify+`/`reverify+` email endpoints wired through `ingest()` (m7c-6); and the **trigger pillar** — every kernel-derivable occasion (state/time/bounce/verify) emitted as one of **12 neutral-templated `kind`s** (defaults centralised in `templates.js`, brand-free) over a single `composeNotification` hook. ~307 `node --test` tests pass with **2 runtime deps** (`mailauth`, `mailparser`); the public surface ships generated `.d.ts` (JSDoc-sourced, checkJs-gated in CI). The next phase is **P2** — validate the surface by rebuilding `gitdone` on mailproof on a non-merging branch (PRD §7.1; Step 1 boundary audit done).
- `docs/` — the doc tier (start at `docs/README.md`): `01-product/PRD.md` (what mailproof is, who adopts it, the NO-GO table + GDPR posture), `02-design/DESIGN.md` (extraction boundary, locked decisions, planned API, phasing), `02-design/SPEC.md` (wire formats — the mechanism authority), `03-logs/decisions-log.md`. **Read the PRD, DESIGN, and SPEC before any lift/extraction work; the CHANGELOG tracks exactly what has landed.**
- `poc/pipeline.js` — the original P0 stdlib-only proof the four pillars compose; **superseded** by the real modules, kept only as the P0 artifact (never shipped).

Describe mailproof by what's actually lifted (the PRD status line + CHANGELOG are authoritative) — neither a finished library nor a bare POC.

## Commands

```bash
npm test           # node --test over tests/unit/**/*.test.js + tests/integration/**/*.test.js (~307 tests)
npm run typecheck  # tsc -p tsconfig.json — checkJs over src/*.js JSDoc, full strict (0 errors; CI gate)
npm run build:types # rm -f src/*.d.ts && tsc -p tsconfig.types.json — regenerate the shipped src/*.d.ts (cleans first so the committed copy can't collide with the emit)
npm run poc        # node poc/pipeline.js — the original P0 proof (superseded; never shipped)
```
Runtime deps: `mailauth` + `mailparser` (2; the git ledger uses the `git` binary via `child_process`, **not** `simple-git`). No build step **for consumers** — vanilla JS + JSDoc; the shipped `src/*.d.ts` are generated from that JSDoc by a dev-only `npm run build:types` (devDeps: `typescript`, `@types/node`). The JSDoc is the single source of truth; CI runs `typecheck` (full `strict`) and fails if the committed `.d.ts` are stale. `strictNullChecks` is the floor, `strict:true` the default — no `any` casts / `@ts-ignore`. Node ≥ 22.5 required.

## Architecture (the big picture)

The whole design hinges on a clean **boundary** and three **invariants** — understanding these requires `DESIGN.md` + reading how `gitdone/app/bin/receive.js` orchestrates today:

- **Four pillars, decoupled.** verify → sequence → git ledger → email triggers. Each maps to specific `gitdone` modules (see DESIGN.md). The orchestrator (`receive.js`) is **app glue and is NOT lifted** — mailproof exposes the primitives (+ an optional `createReceiver()` with policy hooks); each consumer writes its own thin glue.
- **Accept-with-flag.** *Every* inbound reply is committed to the git ledger as an audit record — even rejected ones (wrong participant, unverified DKIM, out-of-order). A separate `counted` flag records whether it advanced state. Routing/trust never gate the commit; they gate the state transition. The POC demonstrates this (8 commits, 2 counted).
- **Git-native storage.** Event state = JSON + a per-event git repo whose commit chain *is* the tamper-evidence and the portable, offline-verifiable proof. SQL consumers project a read-model; they don't replace the ledger.

### Locked design decisions (do not silently revert — see DESIGN.md)
- **Two generic coordination modes** — events (`completion.js`, workflow subset) + lean crypto sign-off (`crypto.js`, the parameterized `signers`/`threshold`/`requiredDocHash` engine). *Supersedes the original "generic workflow only" scope* (decisions-log 2026-05-24). The heavy attestation tail stays `gitdone` policy: `revoke`, `latest`/`accumulating` dedup (core is distinct-only), multi-doc strict manifests + `reference_docs`, attestor-PII redaction — do **not** drag these into the core.
- **Durability-first privacy** — per-record erasure / participant self-revoke is a NO-GO (PRD §8.16); privacy = minimization (salted hashes, no plaintext at rest, SPEC §6) + lawful retention. The only erasure lever is whole-event deletion (destroys the salt). Crypto trust is hardcoded `verified`; the initiator's own reply never counts as a sign-off (anti-self-dealing).
- **Bundled Postfix/sendmail** transport (self-hosted, opendkim signs outbound at the MTA). Not a pluggable third-party mail provider.

## Dev rules

This project follows the standards in **`.claude/memory/AGENT_RULES.md`** (POC-first, strict dependency hierarchy vanilla→stdlib→external, lightweight over complex, open-source only, Testing-Trophy). They are mandatory, not suggestions. Notably for mailproof: keep the dependency surface tiny (target ≤3 runtime deps, matching gitdone/knowless), and graduate the POC by rewriting — never shipping it.

## Relationship to gitdone
**`gitdone`** (`~/PycharmProjects/gitdone`) is the source of the extraction and mailproof's eventual first consumer — P2 refactors it to depend on mailproof, reimplementing its crypto modes as policy on mailproof's hooks.
