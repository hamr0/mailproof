# mailproof

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/hamr0/mailproof?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Email-native multi-party coordination kernel.** Verify a reply, sequence it through a workflow, commit it to a tamper-evident git ledger, trigger the next email.

> ⚠️ **Early WIP — P1 lift in progress.** Being extracted from [gitdone](https://github.com/hamr0/gitdone). Real `src/` modules are landing pillar by pillar (verify + the inbound decoder — DKIM/DMARC auth and MIME parse — sequence routing, inbound preprocessing, outbound, the full git-ledger storage, both sequencing engines — the **events** workflow and the **crypto sign-off** engine — and the document notary, now with its inbound auto-hash capture, are done); only the `create()` / `ingest()` assembly (m7b) remains before there is a usable published API. See [`docs/`](docs/) ([PRD](docs/01-product/PRD.md), [DESIGN](docs/02-design/DESIGN.md), [SPEC](docs/02-design/SPEC.md)).

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
| P1 — lift real modules + tests | 🔄 in progress — verify + inbound decoder (DKIM/DMARC auth + MIME parse, m7a), sequence routing, inbound preprocessing, outbound, git-ledger storage, workflow + crypto sign-off engines, document notary (incl. auto-hash capture) done; `create()`/`ingest()` assembly pending (m7b) |
| P2 — gitdone depends on mailproof | ⬜ |

## Try the POC

```bash
npm run poc   # stdlib + git only: runs a 2-step workflow, prints the ledger + outbox, self-asserts
```

Requires Node ≥ 22.5. The POC has no dependencies; the lifted library now has **2 runtime deps** — `mailauth` (DKIM/DMARC/ARC) and `mailparser` (MIME), both landed with the inbound decoder (m7a) and required because verifying/parsing untrusted mail is security-critical (a vetted library, never hand-rolled). The git ledger still shells out to the `git` binary directly (no `simple-git`), so storage stays dependency-free. Budget: ≤3.

## Docs

Start at [`docs/README.md`](docs/README.md). The [PRD](docs/01-product/PRD.md) covers what mailproof is, who adopts it, and the NO-GO table; [DESIGN](docs/02-design/DESIGN.md) covers the extraction boundary (what's in mailproof vs. what stays gitdone policy), the planned public API, and the phasing; the [decisions log](docs/03-logs/decisions-log.md) records the design forks with rationale.

## License

[Apache-2.0](LICENSE) © hamr0
