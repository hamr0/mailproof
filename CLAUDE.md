# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What mailproof is

An **email-native multi-party coordination kernel**, being extracted from the sibling `gitdone` project (`~/PycharmProjects/gitdone`) into a standalone vanilla JS library. It does four things: **verify** an inbound reply (DKIM/DMARC trust level), **sequence** it through a workflow of ordered/parallel steps, **commit** it to a tamper-evident per-event **git** ledger, and **trigger** the next email. No web UI, no branding, no crypto-attestation policy — those stay in `gitdone` as a consumer on top.

## Project status — read this first

This repo is at the **POC stage**, not a working library. There is **no `src/`, no real modules, and no published API yet.** What exists:
- `poc/pipeline.js` — a stdlib-only proof that the four pillars compose cleanly (re-implemented stand-ins, **not** the real `gitdone` modules). It is throwaway: per the dev rules, it gets **rewritten in P1, never shipped**.
- `docs/` — the doc tier (start at `docs/README.md`): `01-product/PRD.md` (what mailproof is, who adopts it, the NO-GO table), `02-design/DESIGN.md` (the authoritative design — extraction boundary mapping each pillar to the `gitdone` source files in `~/PycharmProjects/gitdone/app/src` that will be lifted, locked decisions, planned API, phasing), and `03-logs/decisions-log.md`. **Read the PRD and DESIGN before doing P1 work.**

Do not describe mailproof as if the library exists. The real lift (P1) is pending.

## Commands

```bash
npm run poc        # node poc/pipeline.js — runs the POC, prints the ledger + outbox, self-asserts
```
There is no build, lint, or test setup yet. P1 will add deps (`mailauth`, `mailparser`, `simple-git`) and a `node --test` suite (mirroring gitdone's `node --test 'tests/unit/**/*.test.js' 'tests/integration/**/*.test.js'`). Node ≥ 22.5 required.

## Architecture (the big picture)

The whole design hinges on a clean **boundary** and three **invariants** — understanding these requires `DESIGN.md` + reading how `gitdone/app/bin/receive.js` orchestrates today:

- **Four pillars, decoupled.** verify → sequence → git ledger → email triggers. Each maps to specific `gitdone` modules (see DESIGN.md). The orchestrator (`receive.js`) is **app glue and is NOT lifted** — mailproof exposes the primitives (+ an optional `createReceiver()` with policy hooks); each consumer writes its own thin glue.
- **Accept-with-flag.** *Every* inbound reply is committed to the git ledger as an audit record — even rejected ones (wrong participant, unverified DKIM, out-of-order). A separate `counted` flag records whether it advanced state. Routing/trust never gate the commit; they gate the state transition. The POC demonstrates this (8 commits, 2 counted).
- **Git-native storage.** Event state = JSON + a per-event git repo whose commit chain *is* the tamper-evidence and the portable, offline-verifiable proof. SQL consumers project a read-model; they don't replace the ledger.

### Locked design decisions (do not silently revert — see DESIGN.md)
- **Generic workflow only** in v1. Crypto declaration/attestation, strict signing, revoke, thresholds stay in `gitdone` as policy on mailproof hooks — do **not** drag them into the core when lifting `completion.js` (extract only its workflow subset).
- **Bundled Postfix/sendmail** transport (self-hosted, opendkim signs outbound at the MTA). Not a pluggable third-party mail provider.

## Dev rules

This project follows the standards in **`.claude/memory/AGENT_RULES.md`** (POC-first, strict dependency hierarchy vanilla→stdlib→external, lightweight over complex, open-source only, Testing-Trophy). They are mandatory, not suggestions. Notably for mailproof: keep the dependency surface tiny (target ≤3 runtime deps, matching gitdone/knowless), and graduate the POC by rewriting — never shipping it.

## Relationship to gitdone
**`gitdone`** (`~/PycharmProjects/gitdone`) is the source of the extraction and mailproof's eventual first consumer — P2 refactors it to depend on mailproof, reimplementing its crypto modes as policy on mailproof's hooks.
