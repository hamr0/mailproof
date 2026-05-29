# mailproof

<p align="center">
  <img src="https://img.shields.io/npm/v/mailproof?label=npm&color=2a4f8c" alt="npm version">
  <img src="https://img.shields.io/github/package-json/v/hamr0/mailproof?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
  <img src="https://img.shields.io/github/actions/workflow/status/hamr0/mailproof/ci.yml?branch=main&label=CI" alt="CI status">
</p>

**Email-native multi-party coordination kernel.** Verify a reply, sequence it through a workflow, commit it to a tamper-evident git ledger, trigger the next email.

> **Status — P1 (lift) + m7c (verification) + m7d (triggers) are COMPLETE.** Being extracted from [gitdone](https://github.com/hamr0/gitdone). A consumer can `create()` a bound instance and `ingest()` inbound replies end to end: verify + the inbound decoder (DKIM/DMARC auth + MIME parse), sequence routing, inbound preprocessing, outbound, the full git-ledger storage, both sequencing engines (**events** workflow + **crypto sign-off**), the document notary with inbound auto-hash capture, the offline `verify()`/`reverify()` primitives + their public email endpoints, and the trigger pillar (12 neutral-templated occasion `kind`s). 307 `node --test` tests pass with 2 runtime deps; the public surface ships JSDoc-generated, checkJs-gated TypeScript declarations. Next is **P2** — validate by rebuilding gitdone on mailproof. See [`docs/`](docs/) ([PRD](docs/01-product/PRD.md), [DESIGN](docs/02-design/DESIGN.md), [SPEC](docs/02-design/SPEC.md)).

## The idea

A lot of coordination is just: ask some named people to confirm something, in an order, and prove they did. mailproof does that **entirely over email** — **no app, no login** for participants. They reply from their normal inbox; that's it.

- **Verify** — each inbound reply is graded by DKIM/DMARC trust level (via [`mailauth`](https://github.com/postalsys/mailauth)); the signer's public key is archived so the reply still verifies after key rotation.
- **Sequence** — replies advance one of two generic modes: an **events** workflow (ordered / parallel steps among named participants) or a **crypto sign-off** (verified signers — one, several named, or open via a shared address — counted toward a threshold, optionally bound to a hashed document).
- **Git ledger** — every reply is committed to a per-event git repo. The commit chain *is* the tamper-evident, offline-verifiable proof: clone it and check it with stock `git`, forever, even if the service disappears.
- **Email triggers** — composes and sends the next notification / reminder through your own MTA (Postfix + opendkim). Self-hosted: more config, full control, no third-party mail dependency.

### Accept-with-flag

Every inbound reply is committed — *even rejected ones* (wrong sender, failed DKIM, out of order). A `counted` flag records whether it advanced state. The audit trail stays complete; trust gates the *transition*, never the *record*.

## Status

| Phase | State |
|---|---|
| P0 — composition proof (POC) | ✅ `npm run poc` |
| P1 — lift real modules + tests | ✅ COMPLETE — verify + inbound decoder (DKIM/DMARC auth + MIME parse), sequence routing, inbound preprocessing, outbound, git-ledger storage, workflow + crypto sign-off engines, document notary (incl. auto-hash capture), and the `create()`/`ingest()` assembly |
| m7c — verification surface | ✅ COMPLETE — durable DKIM-key archive, offline `verify()`/`reverify()`, OTS-proof anchoring, public `verify+`/`reverify+` email endpoints |
| m7d — trigger pillar | ✅ COMPLETE — every kernel-derivable occasion (state/time/bounce/verify) as one of 12 neutral-templated `kind`s over one `composeNotification` hook |
| P2 — gitdone depends on mailproof | ⬜ next — validate by rebuilding gitdone on mailproof (non-merging branch) |

## Install

```bash
npm i mailproof   # 2 runtime deps (mailauth, mailparser); Node ≥ 22.5
```

Vanilla JS + JSDoc, no consumer build step. The public surface ships JSDoc-generated, `strictNullChecks` checkJs-gated TypeScript declarations, so `require('mailproof')` gives TS consumers a checked surface. The git ledger shells out to the `git` binary directly (no `simple-git`), so storage stays dependency-free.

> **Pre-1.0:** the API can still change shape between `0.x` minors (SemVer 0.x). P2 (rebuilding gitdone on it) is the surface-validation phase.

## Try the POC

```bash
npm run poc   # stdlib + git only: runs a 2-step workflow, prints the ledger + outbox, self-asserts
```

Requires Node ≥ 22.5. The POC has no dependencies; the lifted library has **2 runtime deps** — `mailauth` (DKIM/DMARC/ARC) and `mailparser` (MIME), both required because verifying/parsing untrusted mail is security-critical (a vetted library, never hand-rolled). Budget: ≤3.

## Docs

Start at [`docs/README.md`](docs/README.md). The [PRD](docs/01-product/PRD.md) covers what mailproof is, who adopts it, and the NO-GO table; [DESIGN](docs/02-design/DESIGN.md) covers the extraction boundary (what's in mailproof vs. what stays gitdone policy), the planned public API, and the phasing; the [decisions log](docs/03-logs/decisions-log.md) records the design forks with rationale.

## License

[Apache-2.0](LICENSE) © hamr0
