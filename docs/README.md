# mailproof documentation

Email-native multi-party coordination **kernel**, extracted from `gitdone`.
mailproof turns a promise made over email into proof: it verifies a reply
(DKIM/DMARC), commits it to a tamper-evident git ledger, sequences it through
one of two generic modes — an **events** workflow or a **crypto sign-off** — and
triggers the next email. The web UI, branding, and the heavy attestation policy
tail stay in `gitdone` on top.

> **Status:** P1 (the lift) is COMPLETE, and so are the two surfaces on top of
> it — m7c (verification) and m7d (triggers). `src/` holds verify, the inbound
> decoder (DKIM/DMARC auth + MIME parse — mailproof's 2 runtime deps, `mailauth`
> + `mailparser`), sequence routing, inbound preprocessing, outbound, the full
> git-ledger storage, both sequencing engines (workflow events + crypto sign-off),
> the document notary, and the `create()` / `ingest()` assembly that makes it a
> usable library. On top: the offline `verify()`/`reverify()` primitives + OTS
> anchoring + the public `verify+`/`reverify+` email endpoints, and the trigger
> pillar emitting 12 neutral-templated occasion `kind`s. ~307 tests pass; the
> public surface ships JSDoc-generated, checkJs-gated `.d.ts`. Next is
> **P2** — validate by rebuilding gitdone on mailproof (non-merging branch; see
> the PRD §7.1 + DESIGN).

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Product** | [`01-product/`](01-product/) | The **PRD** — what we're building, why, who adopts it, and the NO-GO table |
| **Design** | [`02-design/`](02-design/) | **DESIGN.md** — extraction boundary, locked decisions, planned API, phasing; **SPEC.md** — exact wire formats (trust levels, address grammar, commit / event schemas) |
| **Logs** | [`03-logs/`](03-logs/) | The **decisions log** — design forks, dated, with rationale |

Future tiers (process, ops) and docs (SPEC, `mailproof.context.md`, GUIDE)
appear as they earn their place — most when real code lands in P1, since they
describe a surface that doesn't exist yet.

## Start here

1. **What is mailproof, who is it for, and what does it refuse to do?** →
   [`01-product/PRD.md`](01-product/PRD.md) — see §1 (identity), §3 (audience),
   and §8 (the NO-GO table).
2. **How will it actually be built — the extraction boundary, planned API, and
   phasing?** → [`02-design/DESIGN.md`](02-design/DESIGN.md).
3. **Why was X decided?** → [`03-logs/decisions-log.md`](03-logs/decisions-log.md).

## Document precedence

If two documents disagree:
- **Intent / philosophy / scope** → the **PRD** wins; the other doc must be
  brought into alignment.
- **Mechanism / wire format / byte layout** → the **SPEC**
  ([`02-design/SPEC.md`](02-design/SPEC.md)) wins; **DESIGN.md** remains the
  authority on the extraction boundary and phasing.

## Top-level docs (sibling to this directory)

- [`/README.md`](../README.md) — project pitch and POC entry point
- [`/CLAUDE.md`](../CLAUDE.md) — guidance for Claude Code working in this repo
- [`/CHANGELOG.md`](../CHANGELOG.md) — version history (Keep a Changelog + SemVer)
- [`/OPS.md`](../OPS.md) — Postfix/opendkim/PTR/port-25 operator checklist
- *(planned, P1+)* `/mailproof.context.md` (dense AI-agent integration guide),
  `/GUIDE.md` (adopter walkthrough)
