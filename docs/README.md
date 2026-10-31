# mailproof documentation

**mailproof v2** is a two-party (A<->B) email proof library: it records a
re-checkable proof of each email (signed headers, never the body) in a local git
trail, so anyone can verify it offline later. Multi-party workflows stay in
`gitdone` / signedreply.com. See the [v2 PRD](product/PRD.md).

> **Status:** v2 planning. 1.x (a multi-party coordination kernel lifted from
> gitdone) is frozen at tag `v1.4.0`; branch `v1` takes security fixes only. The
> v1 PRD is archived at [`archive/v1/PRD.md`](archive/v1/PRD.md). `DESIGN.md` and
> `SPEC.md` still describe v1 and are superseded module by module as v2 lands.

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Product** | [`01-product/`](01-product/) | The **v2 PRD** — problem, trust rule, record format, go/no-go, modules, out of scope |
| **Design** | [`02-design/`](02-design/) | **DESIGN.md** and **SPEC.md** — describe **v1** (extraction boundary, wire formats); superseded module by module for v2 |
| **Logs** | [`03-logs/`](03-logs/) | The **decisions log** — design forks, dated, with rationale |
| **Archive** | [`archive/v1/`](archive/v1/) | The v1 PRD (multi-party kernel), kept for background |

Future tiers (process, ops) and docs (SPEC, `mailproof.context.md`, GUIDE)
appear as they earn their place — most when real code lands in P1, since they
describe a surface that doesn't exist yet.

## Start here

1. **What is mailproof v2, and what does it refuse to do?** →
   [`01-product/PRD.md`](product/PRD.md) — see §1 (problem), §3 (trust rule),
   §7 (modules), and §10 (out of scope).
2. **How was v1 built (extraction boundary, wire formats)?** →
   [`02-design/DESIGN.md`](archive/DESIGN.md) and
   [`02-design/SPEC.md`](product/SPEC.md) (v1; being superseded).
3. **Why was X decided?** → [`03-logs/decisions-log.md`](product/decisions-log.md).

## Document precedence

If two documents disagree:
- **Intent / philosophy / scope** → the **PRD** wins; the other doc must be
  brought into alignment.
- **Mechanism / wire format / byte layout** → the **SPEC**
  ([`02-design/SPEC.md`](product/SPEC.md)) wins; **DESIGN.md** remains the
  authority on the extraction boundary and phasing.

## Top-level docs (sibling to this directory)

- [`/README.md`](../README.md) — project pitch and POC entry point
- [`/CLAUDE.md`](../CLAUDE.md) — guidance for Claude Code working in this repo
- [`/CHANGELOG.md`](../CHANGELOG.md) — version history (Keep a Changelog + SemVer)
- [`/OPS.md`](../OPS.md) — Postfix/opendkim/PTR/port-25 operator checklist
- *(planned, P1+)* `/mailproof.context.md` (dense AI-agent integration guide),
  `/GUIDE.md` (adopter walkthrough)
