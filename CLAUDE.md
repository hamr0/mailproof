# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What mailproof is

A small **two-party (A<->B) email-proof library**. It records a re-checkable proof of each email (the signed headers, never the body; the raw email is kept separately in a local content store outside git) in a local **git trail**, so anyone can verify it offline later, even after the sender's DKIM key leaves DNS (the key is archived at capture). Public surface: a `Mailproof` class (`check`, `record`, `verify`, `matchBody`, `matchFile`, `list`, `get`, `copies`, `counterparties`, `linked`, `checkProfile`, `proofParts`, `replyText`, `replyFacts`, `sync`, `rawEmail`, `attachment`, `expireContent`, `forget`, `prune`, `upgradeStamps`, `close`) plus `verifyRecord`, `checkProfile`, `hashDocument`, `TRUST_LEVELS`, `RULES_VERSION` (`src/index.js`).

Multi-party workflows, thresholds and N-signer sign-off are **not** here: they live in `gitdone` / signedreply.com. The old "rebuild gitdone on mailproof" north star is retired. v2 is a new, smaller product, not an edit of v1.

## Status

**3.0.0 (2026-11-09, PR #17)** shipped M3 steps 1-3 on top of M0-M2. **2.2.0 shipped M2** (reply text: `Mailproof#replyText`, the new text of a signed reply, with proof; interpreting it is the consumer's job; SPEC B6, F20) **and the trail index**; M1 (IMAP capture via `sync()` and the `mailproof-sync` CLI; `imapflow` is the third runtime dependency) shipped in 2.1.0. The trail index (`list`/`copies` from a rebuildable SQLite cache, SPEC B5, F19) adds `better-sqlite3` as the 4th, by owner decision of 2026-11-07, lifting the ceiling of 3; M0 (record and re-check) shipped in 2.0.0. **M3 (two-party coordination) steps 1-3 shipped in 3.0.0** (the local content store with retention and `forget`, SPEC B7, F22; trust profiles, the counterparty view and graded thread links, SPEC B5/B8, F23; prune before date, SPEC B9, F25), plus the `addresses` record field (B1) and the sharded trail layout `records/<id[0:2]>/` (B3, F24; a flat 2.2.x trail is refused with `ERR_TRAIL_LAYOUT`, never converted). **M3 step 4, `replyFacts`, and step 5, the `mailproof` CLI (SPEC B11; `bin/mailproof.js` over `src/cli/`, with `upgradeStamps()` and `prune({ dryRun })` added to the class), shipped in 3.1.0** (SPEC B10, F27); **3.2.0 (2026-11-11) is the latest**. The remaining step (MCP; not built) is in PRD §7 "Build order". M4-M6 are later. 1.x (the multi-party kernel) is frozen at tag `v1.4.0`; the v1 code is archived in `archive/v1/` (there is no `v1` branch); there is no compatibility layer between 1.x and 2.x. The PRD status line and `CHANGELOG.md` are authoritative; verify against them before trusting any other doc.

`src/proof/` plus `src/index.js` is the library; `src/cli/` plus `bin/` is the CLI (M3 step 5: `mailproof`, and `mailproof-sync` from M1); together they are the only code that ships (`files` in `package.json`). The v1 code (`create.js`, `ingest.js`, `completion.js`, `legacy-index.js`, ...), its tests and its docs live in `archive/v1/`: kept for borrowing in M3/M4 (PRD §9), not run, not type-checked, not shipped. To reuse a part, `git mv` it and its tests back into `src/` and `tests/` and make them pass.

`poc/` holds POC evidence, never shipped: the v2 POCs (`poc/m0-header-recheck.js` = M0 go/no-go, F1; `poc/admit-gate/` = F14; `poc/worker-deadline/` = F15); the superseded v1 P0 pipeline is `archive/v1/poc/pipeline.cjs`.

## Docs map

Start at `docs/README.md`; `docs/index.md` is the generated map of every doc.
- `docs/product/PRD.md`: authoritative on intent and scope (§3 trust rule, §4 record, §7 modules M0-M6, §10 out of scope, §11 process).
- `docs/product/SPEC.md`: wire formats. **Part B (B1-B3, Limits, Concurrency) is v2 and the mechanism authority; Part A (sections 0-7) and `archive/v1/docs/DESIGN.md` still describe v1.**
- `docs/product/findings.md`: POC/test results as F-entries with evidence (decisions and results go here; the PRD stays a thin contract).
- `docs/product/decisions-log.md`: dated design forks with rationale.
- `archive/v1/`: v1 code, tests and docs (v1 PRD, DESIGN, P2 audit, OPS under `archive/v1/docs/`).
- `mailproof.context.md` (repo root, ships in the package): dense integration guide for agents.

## Commands

```bash
npm test                 # node --test over tests/unit, tests/integration, and the primitives tests
npm run typecheck        # tsc --noEmit: checkJs + strictNullChecks over src/ (CI gate)
npm run build:types      # clean ./types/, then tsc -p tsconfig.build.json (shipped surface only: src/index.js + src/proof/)
npm run build:primitives # regenerate primitives.json (scripts/gen-primitives.mjs)
npm run check:primitives # fail if primitives.json is stale vs the generator
npm run build:cli-help   # regenerate src/cli/help.generated.js (scripts/gen-cli-help.mjs: primitives.json + src/cli/commands.js)
npm run check:cli-help   # fail if help.generated.js is stale (CI, next to check:primitives)
npm run check:types      # fail if an exported function/method in the generated .d.ts returns a bare `object`
npm run check:lockfile   # lockfile check (scripts/check-lockfile.mjs)
```
`prepack` runs `build:primitives`, `build:cli-help`, then `build:types`, so pack and publish build all fresh.

## Architecture essentials

All in `src/proof/`; wire formats in SPEC Part B.
- **Record, trail, key archive.** A record (`records/<id[0:2]>/<id>.json`, sharded by id prefix, `"v": 2`; every trail path is built and parsed in `layout.js`) holds the exact headers each DKIM signature covers, the signature, the archived key, both verdicts, attachment hashes and threading ids; never the body or the raw email (those live in the content store outside git). One git repo per trail (`trail.js`, `git.js`), one commit per record, keys archived per domain+selector+key. Optional OpenTimestamps stamp (`ots.js`, off by default, needs the `ots` binary).
- **Record identity.** `id` is the first 32 hex of the raw bytes' sha256, so one record per distinct copy; `message_key` groups copies of a signed message; `copy.kind` marks direct/relayed/forward/digest/unknown (`copy.js`).
- **Two verdicts** (`verdict.js`, `recheck.js`): **live** (DKIM + DMARC + SPF + ARC, decided at capture) and **portable** (DKIM only, recomputable offline from the record alone). Each carries the engine `RULES_VERSION`. `x=`/`t=` expiry is judged at capture time; a bad capture time fails closed. `body_status` (`body-status.js`) is its own field and never changes a verdict.
- **Accept-with-flag.** Every inbound mail is recorded, even unverified or over limit; limits and trust gate the verdict, never the record. A refused message is recorded `unverified` with reason `over limit: <name>` (`over-limit.js`) and never parsed.
- **Admission gate.** `admit()` (`admit.js`) makes one linear pass over the raw bytes before any parser runs; every bound lives in `src/proof/limits.js` and nowhere else. Bound untrusted-input cost with the gate plus the deadline backstop; never patch slow paths one by one (findings F14, F15).
- **Worker deadline backstop** (`build.js`, `worker.js`, `pool.js`, on by default). `check()`/`record()` build in a warm worker thread; the main thread kills it over its CPU budget (`Worker#cpuUsage`, default 15 s), busy wall time (120 s, DNS waits excluded) or memory (1,536 MB), recording `over limit: time` / `memory` / `crash`. Commit, lock, git and the clock stay on the main thread. `worker: { size: 0 }` runs in-process with no backstop (use for one-mail-per-process callers). A worker that cannot start rejects and records nothing.
- **DNS budget** (`resolver-guard.js`, `limits.js`): `DNS_TIMEOUT_MS` 5 s per lookup, `DNS_BUDGET_MS` 30 s per message, same in worker and in-process; a non-plain resolver answer is a DNS error (`EBADRESP`).
- **Trail lock** (`trail.js`, `mutex.js`): in-process mutex plus a cross-process lock file `<trailDir>/.<trail>.lock` (`O_EXCL`) with `lockTimeoutMs`; on timeout `ERR_TRAIL_LOCKED` (map to Postfix exit 75). Local filesystems only. A failed or killed write is rolled back, removing only files mailproof itself created.

- **CLI** (`src/cli/`, SPEC B11): `run.js` is the dispatcher (`run(argv, ctx)` returns the exit code, never touches `process`; menu and tests call it with injected streams and `deps`), `commands.js` the one command table, `config.js` the strict config (0600 enforced), `secrets.js`/`errors.js` shared with `mailproof-sync`, `menu.js`/`wizard.js`/`prompt.js` the interactive side. Menu and subcommands share one code path; the help text is generated from the library JSDoc. Tests set `XDG_CONFIG_HOME`/`XDG_STATE_HOME` through `tests/helpers/cli.js`; IMAP is never contacted (inject `deps.sync`).

## Locked rules

- **Runtime deps stay tiny:** `mailauth`, `mailparser`, `imapflow` (M1, imported only by `src/proof/imap.js`, F16) and `better-sqlite3` (the trail index, imported only by `src/proof/index-db.js`, F19) only. Git is used through the `git` binary via `child_process`. Hierarchy vanilla -> stdlib -> external; a further external dep still needs the AGENT_RULES checklist and an owner decision.
- **Pure ESM** (`"type": "module"`): `import`/`export`, and `.js` on every relative specifier, including JSDoc `import()` type refs.
- **Types:** JSDoc is the single source of truth; `checkJs` + `strictNullChecks` only (not full `strict`; follow `LIBRARY_CONVENTIONS.md`). `.d.ts` are generated into git-ignored `./types/` and built on `prepack`, never committed. No `!`, `as any` or `@ts-ignore` to silence findings.
- **Node >= 22.19** (`engines`; the CPU deadline needs `Worker#cpuUsage`).
- **Never commit directly to `main`:** work on a branch; merging and releasing are the owner's call (PRD §11). Never publish locally (release goes through the publish workflow).
- **Out of scope** is PRD §10; read it before adding anything multi-party, revoke/threshold, or per-record erasure.
- Public repo: real mail samples stay outside the repo (`*.eml` is git-ignored except `tests/integration/fixtures/`); tests must not leak `/tmp` (use the helper in `tests/helpers`).

## Relationship to gitdone

`gitdone` (`~/PycharmProjects/gitdone`, live as signedreply.com) is the multi-party product mailproof was originally extracted from. v2 borrows only engineering ideas (git trail, key archive, accept-and-flag, OTS) and does not depend on it; signedreply.com is gitdone itself, not an independent consumer. First planned consumer: a human-approval channel for the sibling library `bareguard` (PRD §2).

@.claude/remember/MEMORY.md
Consult when building something new or adding a feature — a standards guide, not hot
context like MEMORY.md above:
.claude/remember/AGENT_RULES.md
Docs map: `docs/index.md` — every doc in this project, with line counts.
Search this corpus instead of reading it whole: `/docs-builder search <query words>`
