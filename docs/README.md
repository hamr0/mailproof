# mailproof documentation

Email-native multi-party coordination **kernel**, extracted from `gitdone`.
mailproof turns a promise made over email into proof: it verifies a reply
(DKIM/DMARC), commits it to a tamper-evident git ledger, sequences it through a
workflow, and triggers the next email. No web UI, no branding, no
crypto-attestation policy — those stay in `gitdone` on top.

> **Status:** pre-library. P0 (POC) is done; P1 (the real lift) is pending.
> There is no `src/` or published API yet — see the DESIGN doc.

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Product** | [`01-product/`](01-product/) | The **PRD** — what we're building, why, who adopts it, and the NO-GO table |
| **Design** | [`02-design/`](02-design/) | **DESIGN.md** — extraction boundary, locked decisions, planned API, phasing. The SPEC (exact wire formats) lands here in P1 |
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
- **Mechanism / wire format / byte layout** → the **SPEC** wins once it exists
  (P1). Until then, **DESIGN.md** is the authority on mechanism.

## Top-level docs (sibling to this directory)

- [`/README.md`](../README.md) — project pitch and POC entry point
- [`/CLAUDE.md`](../CLAUDE.md) — guidance for Claude Code working in this repo
- [`/CHANGELOG.md`](../CHANGELOG.md) — version history (Keep a Changelog + SemVer)
- *(planned, P1+)* `/mailproof.context.md` (dense AI-agent integration guide),
  `/GUIDE.md` (adopter walkthrough), `/OPS.md` (Postfix/opendkim/PTR/port-25
  operator checklist)
