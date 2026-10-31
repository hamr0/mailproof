# mailproof documentation

**mailproof v2** is a two-party (A<->B) email proof library: it records a
re-checkable proof of each email (signed headers, never the body) in a local git
trail, so anyone can verify it offline later. Multi-party workflows stay in
`gitdone` / signedreply.com. See the [v2 PRD](product/PRD.md).

> **Status:** v2 planning. 1.x (a multi-party coordination kernel lifted from
> gitdone) is frozen at tag `v1.4.0`; branch `v1` takes security fixes only. The
> v1 PRD is archived at [`archive/v1/PRD.md`](archive/v1/PRD.md). `DESIGN.md` and
> `SPEC.md` still describe v1 and are superseded module by module as v2 lands.

[`index.md`](index.md) is the complete, generated map of every doc, with line
counts and section ranges.

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Product** | [`product/`](product/) | The **v2 PRD** (problem, trust rule, record format, go/no-go, modules, out of scope), **SPEC.md** (wire formats; still describes **v1**, superseded once the v2 M0 record format is specified), the **decisions log** (design forks, dated, with rationale), and **findings.md** (POC/test results with evidence) |
| **Archive** | [`archive/`](archive/) | v1 history: the v1 PRD in [`archive/v1/`](archive/v1/) (multi-party kernel), [`DESIGN.md`](archive/DESIGN.md) (extraction boundary), and the [P2 gitdone boundary audit](archive/audit-p2-step1-gitdone-boundary.md) |

Further tiers (process, ops) and docs (GUIDE) appear as they earn their place.
`OPS.md` and `mailproof.context.md` live at the repo root because they ship in
the npm package.

## Start here

1. **What is mailproof v2, and what does it refuse to do?** →
   [`product/PRD.md`](product/PRD.md) — see §1 (problem), §3 (trust rule),
   §7 (modules), and §10 (out of scope).
2. **How was v1 built (extraction boundary, wire formats)?** →
   [`archive/DESIGN.md`](archive/DESIGN.md) and
   [`product/SPEC.md`](product/SPEC.md) (v1; being superseded).
3. **Why was X decided?** → [`product/decisions-log.md`](product/decisions-log.md).
4. **What did the POCs prove, with what evidence?** →
   [`product/findings.md`](product/findings.md).

## Document precedence

If two documents disagree:
- **Intent / philosophy / scope** → the **PRD** wins; the other doc must be
  brought into alignment.
- **Mechanism / wire format / byte layout** → the **SPEC**
  ([`product/SPEC.md`](product/SPEC.md)) wins for the current (v1-derived) code,
  until the v2 M0 spec replaces it. **DESIGN.md** is archived v1 history, not an
  authority.

## Top-level docs (sibling to this directory)

- [`/README.md`](../README.md) — project pitch and POC entry point
- [`/CLAUDE.md`](../CLAUDE.md) — guidance for Claude Code working in this repo
- [`/CHANGELOG.md`](../CHANGELOG.md) — version history (Keep a Changelog + SemVer)
- [`/OPS.md`](../OPS.md) — Postfix/opendkim/PTR/port-25 operator checklist
- [`/mailproof.context.md`](../mailproof.context.md) — dense AI-agent integration guide
