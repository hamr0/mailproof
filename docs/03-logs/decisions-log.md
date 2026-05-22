# Decisions Log

Architectural and design decisions with rationale. Do not silently revert these
— if a decision needs to change, supersede it here with a dated entry and update
the [PRD](../01-product/PRD.md) / [DESIGN](../02-design/DESIGN.md).

## Format

```
### Decision: [Title]
**Date**: YYYY-MM-DD
**Status**: Accepted | Superseded | Deprecated
**Context**: Why was this decision needed?
**Decision**: What was decided?
**Consequences**: What are the trade-offs?
```

---

### Decision: Git-native storage (events as JSON + per-event git repo)
**Date**: 2026-05-22
**Status**: Accepted
**Context**: mailproof needs a store for event state and an audit record. Options were a database as the source of truth vs. the git ledger as the source of truth.
**Decision**: Git-native. Event state = JSON + a per-event git repo whose hash-chained commits *are* the tamper-evidence. SQL/other consumers project a read-model; they do not replace the ledger.
**Consequences**: Limited ad-hoc query power and per-event repo overhead, but the proof is portable and offline-verifiable, and "the git ledger is the point" stays literally true. (Mirrors gitdone's original JSON+git decision.)

### Decision: Generic workflow only in v1 (sequencing scope)
**Date**: 2026-05-22
**Status**: Accepted
**Context**: `completion.js` in gitdone mixes a generic ordered/parallel workflow engine with crypto declaration/attestation, strict signing, revoke, and threshold logic. The lift had to choose how much to bring.
**Decision**: Extract only the **workflow subset** — ordered/parallel/mixed steps. Crypto/attestation, strict signing, revoke, and thresholds stay in gitdone as policy on mailproof's hooks.
**Consequences**: Keeps the kernel lean and generic; consumers needing those modes implement them on the hooks. Risk: the workflow/policy seam must be clean enough that gitdone can rebuild its modes on top (proven in P2).

### Decision: Bundled Postfix/sendmail transport
**Date**: 2026-05-22
**Status**: Accepted
**Context**: Outbound email needs a transport. Options were a pluggable third-party provider (SendGrid/SES) vs. a self-hosted MTA lifted from gitdone's `outbound.js`.
**Decision**: Bundle Postfix/sendmail; opendkim signs outbound at the MTA. Not a pluggable third-party mail provider.
**Consequences**: More operator config (Postfix, opendkim, PTR, port 25 — to be documented in OPS.md) but full control, no vendor lock-in, and DKIM signing under the operator's own domain. Third-party providers are NO-GO (PRD §8.10).

### Decision: Email-only core verify/trigger path (with consumer side-effect carve-out)
**Date**: 2026-05-22
**Status**: Accepted
**Context**: Considered keeping a door open for non-email channels (webhooks/SMS) on the trigger or verify side.
**Decision**: Lock the core verify and trigger paths to email. DKIM/DMARC is what provides cold, third-party, offline verification with no pre-shared secret; webhooks (HMAC/mTLS) require a prior relationship and SMS has no real origin verification — neither preserves the "any two parties, no setup" property. Carve-out: consumers may fire their own side-effect notifications (webhook/Slack/SMS) from mailproof's `ingest()` result, carrying **no** mailproof verification guarantee.
**Consequences**: Email is the trust anchor by construction, not a swappable channel — this is the library's identity. Adopters needing a different channel need a different trust anchor (a different library). Integration reach is preserved via the side-effect carve-out. (PRD §8.1.)

### Decision: `receive.js` is not lifted — primitives + `createReceiver()` hooks
**Date**: 2026-05-22
**Status**: Accepted
**Context**: gitdone's `receive.js` orchestrates the four pillars, but it's tangled with gitdone's config singleton and crypto branches.
**Decision**: Do not lift the orchestrator. mailproof exposes the four pillars as primitives plus an optional `createReceiver()` with policy hooks; each consumer writes its own thin glue.
**Consequences**: Consumers write a little wiring, but the kernel stays decoupled from any one app's policy and config. "Mechanism, not policy" holds at the orchestration layer too.

### Decision: Accept-with-flag (commit every reply, gate the transition)
**Date**: 2026-05-22
**Status**: Accepted
**Context**: How to treat replies that fail routing/trust (wrong participant, unverified DKIM, out-of-order).
**Decision**: Commit *every* inbound reply to the ledger as an audit record; a separate `counted` flag records whether it advanced state. Routing and trust gate the state transition, never the commit.
**Consequences**: Complete, tamper-evident audit trail including rejected attempts (POC: 8 commits, 2 counted). The ledger answers "what was received" independently of "what counted."
