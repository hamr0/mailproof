# mailproof — Design

> Email-native multi-party coordination **kernel**, extracted from `gitdone`.
> Verify a reply, sequence it through a workflow, commit it to a tamper-evident
> git ledger, and trigger the next email. No web UI, no branding, no crypto
> attestation policy — those stay in `gitdone` on top.

## Why this exists
`gitdone` proved the pattern (DKIM-verified replies → git-committed proof →
multi-party progress). The generic engine underneath is reusable: any system
that needs "did named party X confirm step Y, provably, over email, no app"
wants it. `mailproof` is that engine as a standalone vanilla library; `gitdone`
becomes its first consumer (web + crypto modes as policy on top).

## Confirmed decisions (2026-05-22)
| Decision | Choice | Rationale |
|---|---|---|
| **Storage** | **Git-native** (events as JSON + per-event git repo) | Simplest; the git ledger *is* the point. SQL consumers project a read-model. |
| **Sequencing scope (v1)** | **Generic workflow only** (ordered/parallel/mixed steps) | Crypto declaration/attestation, strict signing, revoke, thresholds stay in gitdone as policy. Keeps the core lean. |
| **Email transport** | **Bundled Postfix/sendmail** (lifted from `outbound.js`) | Self-hosted stack = full control, no 3rd-party mail dep. More config, more freedom. opendkim signs outbound at the MTA. |

## Extraction boundary
**Into mailproof** (the four pillars):
- **Verify** — `classifier.js` (trust levels), `dkim-archive.js` (archive signer key for durable verify), `verify.js`/`reverify.js`. Dep: `mailauth`, `mailparser`.
- **Sequence** — `event-store.js`, `event-mutex.js`, `router.js` (workflow tags only: `event+{id}-{step}@`, `remind+{id}@`, `stats+{id}@`), and the **workflow subset** of `completion.js` (drop crypto/attestation branches).
- **Git ledger** — `gitrepo.js` (per-event repo, hash-chained `commit-NNN.json`), `ots.js` (optional anchoring, spawns `ots`). Dep: `simple-git`.
- **Email triggers** — `outbound.js` (build + sendmail), `sweep.js` (reminders/nudges/archive), `prefilter.js`, `envelope.js`, `dsn.js` (bounce handling).

**Stays in gitdone** (policy/product): crypto declaration/attestation, strict signing + `reference_docs`/`attach`, `revoke`/threshold, `bundle`, `[gitdone]` email bodies, web dashboard, knowless-based manage auth. **`receive.js` is NOT lifted** — it's app glue; mailproof exposes primitives + an optional `createReceiver()` with policy hooks, and each app writes thin glue.

## Planned public API (CommonJS, mirrors gitdone style)
```js
const mailproof = require('mailproof');
const core = mailproof.create({ dataDir, domain, sendmailBin, otsBin /* optional */ });

await core.createEvent({ title, flow: 'sequential', initiator,
  steps: [{ id, name, participant, dependsOn: [], minTrust: 'verified' }] });

// inbound: app pipes raw RFC-822 + envelope; mailproof verifies, routes,
// commits (accept-with-flag), advances, and fires the next notification.
const result = await core.ingest(rawEmailBuffer, envelope);
//   → { routed, trustLevel, committedSeq, counted, completedStep, eventComplete, notified }

core.loadEvent(id);  core.listCommits(id);  core.stats();
await core.sweep();  // call from a cron / systemd timer
```
Lower-level pieces (`classifyTrust`, `buildRawMessage`, `commitReply`, …) are
exported too, so a consumer can compose its own pipeline.

Deps: `mailauth`, `mailparser`, `simple-git` (+ optional `ots` binary). Node ≥22.5. Apache-2.0.

## Phasing
- **P0 — POC (this commit):** stdlib + `git` binary only. Prove verify→sequence→git→email composes as vanilla code, decoupled from gitdone's config singleton and crypto branches. `poc/pipeline.js`. *Never shipped — rewritten in P1.*
- **P1 — Lift:** port the modules above; extract the workflow-only completion engine; replace the `config` singleton with injected config; bundle the sendmail transport; Testing-Trophy tests (mostly integration with `:memory:`/`tmp` repos).
- **P2 — Reconverge:** refactor `gitdone` to depend on `mailproof`, reimplementing crypto modes as policy on mailproof hooks. Other downstream services adopt mailproof where a multi-party, email-grounded confirmation chain is needed.
