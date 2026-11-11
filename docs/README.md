# mailproof documentation

**mailproof v2** is a two-party (A<->B) email proof library: it records a
re-checkable proof of each email (signed headers in git, never the body; the raw email is kept in a local content store outside git) in a local git
trail, so anyone can verify it offline later. Multi-party workflows stay in
`gitdone` / signedreply.com. See the [v2 PRD](product/PRD.md).

> **Status:** v2 is released through 3.2.0 (M0-M2 and M3 steps 1-5 shipped; the MCP server, M3 step 6, is built on `feat/m3-mcp` and not yet released). 1.x (a multi-party coordination kernel lifted from
> gitdone) is frozen at tag `v1.4.0`; the v1 code and docs are archived in
> [`../archive/v1/`](../archive/v1/) (no `v1` branch). The v1 PRD is at [`../archive/v1/docs/PRD.md`](../archive/v1/docs/PRD.md). `DESIGN.md` and
> `SPEC.md` still describe v1 and are superseded module by module as v2 lands.

[`index.md`](index.md) is the complete, generated map of every doc, with line
counts and section ranges.

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Product** | [`product/`](product/) | The **v2 PRD** (problem, trust rule, record format, go/no-go, modules, out of scope), **SPEC.md** (wire formats; still describes **v1**, superseded once the v2 M0 record format is specified), the **decisions log** (design forks, dated, with rationale), and **findings.md** (POC/test results with evidence) |
| **Archive** | [`../archive/v1/`](../archive/v1/) | v1 code, tests and docs (outside `docs/`): the v1 PRD in [`docs/`](../archive/v1/docs/) (multi-party kernel), [`DESIGN.md`](../archive/v1/docs/DESIGN.md) (extraction boundary), and the [P2 gitdone boundary audit](../archive/v1/docs/audit-p2-step1-gitdone-boundary.md) |

Further tiers (process, ops) and docs (GUIDE) appear as they earn their place.
`mailproof.context.md` lives at the repo root because it ships in the npm package.
(The v1 `OPS.md` and `config.example.env` are archived in [`../archive/v1/docs/`](../archive/v1/docs/).)

## Start here

1. **How do I set up the `mailproof` command, step by step, from install to an exported proof?** →
   [`product/setup-guide.md`](product/setup-guide.md).
2. **How do I use mailproof (surfaces, reading a reply, capture, running on a timer, operations)?** →
   [`product/usage-guide.md`](product/usage-guide.md).
3. **How do I run my own mail server so my outbound mail is signed (M5)?** →
   [`product/self-hosting.md`](product/self-hosting.md).
4. **What is mailproof v2, and what does it refuse to do?** →
   [`product/PRD.md`](product/PRD.md) — see §1 (problem), §3 (trust rule),
   §7 (modules), and §10 (out of scope).
5. **How was v1 built (extraction boundary, wire formats)?** →
   [`../archive/v1/docs/DESIGN.md`](../archive/v1/docs/DESIGN.md) and
   [`product/SPEC.md`](product/SPEC.md) (v1; being superseded).
6. **Why was X decided?** → [`product/decisions-log.md`](product/decisions-log.md).
7. **What did the POCs prove, with what evidence?** →
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
- [`../archive/v1/docs/OPS.md`](../archive/v1/docs/OPS.md) — v1 Postfix/opendkim operator checklist (archived)
- [`/mailproof.context.md`](../mailproof.context.md) — dense AI-agent integration guide
