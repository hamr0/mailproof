```
    ╭─────────────────────────────────╮
    │  ╔╦╗╔═╗╦╦  ╔═╗╦═╗╔═╗╔═╗╔═╗      │
    │  ║║║╠═╣║║  ╠═╝╠╦╝║ ║║ ║╠╣       │
    │  ╩ ╩╩ ╩╩╩═╝╩  ╩╚═╚═╝╚═╝╩        │
    │   reply ──→ verify ──→ commit   │
    │      ↑                  │       │
    │      └──────────────────┘       │
    ╰──╮──────────────────────────────╯
       ╰── proof, from the inbox
```

<p align="center">
  <a href="https://github.com/hamr0/mailproof/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/mailproof/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <img src="https://img.shields.io/npm/v/mailproof?label=npm&color=2a4f8c" alt="npm version">
  <img src="https://img.shields.io/github/package-json/v/hamr0/mailproof?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Turn an email reply into proof. Multi-party sign-offs and document notarization over plain email — verifiable by anyone, offline, forever.**

You get a record that a *specific person* agreed to a *specific thing* — and it holds up **without you**. No app to install, no account to create: people reply from their normal inbox. Each reply is cryptographically tied to its sender by the email they already trust (DKIM), and the whole history is a git repository anyone can verify with stock tooling — even if your service is long gone. It's the opposite of a signing SaaS: nothing to log into, no vendor to trust, no proof that evaporates when a company pivots or shuts down.

## What you can do with it

- **Get a contract signed** — one counterparty, one verified reply, bound to the exact document. A **declaration** (a contract, a pink slip): the signed file never leaves your server, only its fingerprint + the proof.
- **Run a petition or collect attestations** — N distinct, provably-real people sign one thing, counted to a threshold. Open to anyone via a single address, or an explicit allow-list.
- **Drive an approval chain** — release gates, vendor sign-offs, onboarding — in order, where every step is proven by the person who actually did it, and clearing one step emails the next automatically.
- **Notarize that something existed when you say it did** — optionally **stamp every record against Bitcoin via [OpenTimestamps](https://opentimestamps.org)**, so the proof of *when* needs no trust in you or any server.

Under all four: every reply — even a rejected one — is committed to a tamper-evident ledger, graded for trust (DKIM/DMARC/SPF/ARC), with a `counted` flag for whether it advanced. The audit trail is complete; trust gates the *decision*, never the *record*.

## Quick start

```bash
npm i mailproof   # 2 runtime deps (mailauth, mailparser); Node ≥ 22.5
```

**1. Give your AI assistant the integration guide**

```
Read mailproof.context.md from node_modules/mailproof/mailproof.context.md
```

This single file is the complete wiring contract — every `create()` option, the API + `ingest()` result shape, the plus-tag address space, the `composeNotification` hook + 12 occasion kinds, the trust model, and the gotchas. It's structured for LLM consumption: your agent reads it once and knows how to wire the library correctly.

**2. Describe what you want**

```
I need to collect three sign-offs by email, in order, and end up with an
offline-verifiable proof each person really replied. Use mailproof. The
integration guide is in mailproof.context.md.
```

**Not sure what you need?** Paste this into any AI assistant:

```
I want to build an email-coordination or digital-notary flow with mailproof.
Read the integration guide at node_modules/mailproof/mailproof.context.md,
then ask me up to 5 questions about what I need. Based on my answers, tell me
which mode to use (workflow vs crypto sign-off) and show me the wiring code.
```

---

## What's inside

One `create()` binds four decoupled pillars over a single data dir; take the bound methods, or the lower-level named exports to compose your own pipeline.

| Piece | What it does |
|---|---|
| **`create({ dataDir, domain, … })`** | Composition root — binds verify + sequence + git ledger + triggers over one dir |
| **`ingest(raw, envelope)`** | The inbound pipeline: prefilter → DKIM/DMARC verify → route → **commit (accept-with-flag)** → advance state → trigger the next email |
| **Trust classify** | `classifyTrust` grades each reply `verified` / `forwarded` / `authorized` / `unverified` from DKIM + DMARC + SPF + ARC |
| **Events (workflow)** | Ordered / parallel / custom steps among named participants; completion = all steps done |
| **Crypto sign-off** | **Declaration** (1 signer) or **attestation** (threshold of distinct signers), open or allow-listed, with an optional `requiredDocHash` |
| **Notary** | `hashDocument` / `verifyDocument` — bind a hashed document to a verified signature; plaintext addresses + bytes are never stored |
| **Git ledger** | A per-event git repo; `listCommits` is the tamper-evident chain — every reply committed, `counted` records whether it advanced state |
| **Offline verify** | `verify()` / `reverify()` re-check a commit against the **archived** DKIM key — holds even with live DNS down |
| **OTS anchoring** | Optional `otsBin` → `upgradeProofs()` folds a Bitcoin OpenTimestamps anchor into each commit's proof |
| **Triggers** | 12 neutral occasion `kind`s (activation, advance, completion, overdue, bounce, verify_report, …) over one `composeNotification` hook |
| **Lifecycle** | `activateEvent` · `editEvent` · `completeEvent` · `reopenEvent` · `sweep()` (overdue nudge + auto-archive) |

**Modes:** two generic ones — an **events** workflow and a **crypto sign-off** (declaration / attestation). Branding, web UI, auth, and the heavy attestation tail (revoke, multi-doc manifests, alternate dedup) are *consumer policy*, not kernel.

**Transport:** bundled self-hosted **Postfix/sendmail**, with opendkim signing outbound at the MTA — not a pluggable third-party mail provider.

**Deps:** 2 runtime — [`mailauth`](https://github.com/postalsys/mailauth) (DKIM/DMARC/ARC) + [`mailparser`](https://github.com/nodemailer/mailparser) (MIME), both required because verifying/parsing untrusted mail is security-critical. The git ledger shells out to the `git` binary (no `simple-git`); `ots` is an optional external binary. Pure ESM + JSDoc, no consumer build step; ships generated `strictNullChecks`-checked `.d.ts`.

This table is the map, not the manual — per-option wiring and API detail live in the **[Integration Guide](mailproof.context.md)** and [`docs/`](docs/).

---

## Recipes

The 80% path is short; full wiring — every option, the `ingest()` result, the trust model — is in the [Integration Guide](mailproof.context.md).

**An ordered approval chain, proven** — each step confirmed by the person who did it, the chain emailing the next automatically:

```js
import { create } from 'mailproof';

const core = create({ dataDir: './data', domain: 'app.example', sendmailBin: '/usr/sbin/sendmail' });

await core.createEvent({
  id: 'onboarding42', type: 'workflow', flow: 'sequential', initiator: 'boss@app.example',
  steps: [
    { id: 'legal',   participant: 'alice@corp.example' },
    { id: 'finance', participant: 'bob@corp.example' },
  ],
});
await core.activateEvent('onboarding42');        // emails the first step

// Postfix pipes each reply in; mailproof verifies, commits, advances, emails the next:
const res = await core.ingest(rawEmail, { sender, recipient, clientIp, clientHelo });
// res.counted → did it advance?   res.eventComplete → all done?
```

**A two-party contract, signed and provable offline** — bound to the exact document, nothing sensitive stored:

```js
import fs from 'node:fs/promises';

const doc = await fs.readFile('./contract.pdf');
await core.createEvent({
  id: 'contract42', type: 'crypto', initiator: 'you@app.example',
  signers: ['counterparty@firm.example'],
  threshold: 1,                              // one verified signer = a declaration
  requiredDocHash: core.hashDocument(doc),   // the reply must attach exactly this file
});
await core.activateEvent('contract42');
// They reply with the file → DKIM-verified + hash-matched → committed + complete.
// Only the sha256 + DKIM proof are stored; the document never leaves your server.
```

Same `crypto` shape scales to a **petition** (`open: true, threshold: 100` — anyone verified counts), and anyone can re-check a proof later, offline, with `core.verify(id, bytes)` against the archived DKIM key.

---

## Grounded, not just claimed

- **Verification is tested against real-world mail**, not just fixtures — it reaches `verified` end to end on a genuine production DKIM-signed message over **live DNS**, a committed regression keeps it that way, and deprecated **rsa-sha1** is refused (RFC 8301).
- **Validated against a real consumer's entire feature set** — every capability of a mature, corner-case-heavy email-coordination app was rebuilt on the public surface. All of it fits; the heavy parts (document manifests, two-step close, proof export, forwarding) ride the existing hooks as thin policy, not kernel changes.
- **317 tests, 2 runtime deps**, a JSDoc-sourced TypeScript surface. **Stable under SemVer** — breaking changes only in a future major.

## Docs

Start at [`docs/README.md`](docs/README.md): the [PRD](docs/01-product/PRD.md) (what mailproof is, who adopts it, the NO-GO table), [DESIGN](docs/02-design/DESIGN.md) (the extraction boundary + planned API), [SPEC](docs/02-design/SPEC.md) (wire formats), and the [decisions log](docs/03-logs/decisions-log.md). For wiring an adopter, the **[Integration Guide](mailproof.context.md)** is the single source.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE). © hamr0
