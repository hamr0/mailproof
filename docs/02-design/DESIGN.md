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
| **Sequencing scope (v1)** | **Two generic modes** — events (ordered/parallel/mixed steps) + lean crypto sign-off (1/N/open signers + threshold + single-doc gate) | Only the heavy attestation tail (`revoke`, `latest`/`accumulating` dedup, multi-doc manifests, PII redaction) + web/branding stay gitdone policy. *Supersedes "generic workflow only" — see decisions log (2026-05-24).* |
| **Email transport** | **Bundled Postfix/sendmail** (lifted from `outbound.js`) | Self-hosted stack = full control, no 3rd-party mail dep. More config, more freedom. opendkim signs outbound at the MTA. |

## Extraction boundary
**Into mailproof** (the four pillars):
- **Verify** — `classifier.js` (trust levels), `dkim-archive.js` (archive signer key for durable verify), `verify.js`/`reverify.js`. Dep: `mailauth`, `mailparser`.
- **Sequence** — `event-store.js`, `event-mutex.js`, `router.js` (workflow + `attest+{id}@` tags; not the policy tags), the **workflow subset** of `completion.js` (events, m6), **and a new lean crypto sign-off engine** (the parameterized 1/N/open-signer + threshold + single-doc-gate mechanism — completion.js's crypto modes minus the heavy tail).
- **Git ledger** — `gitrepo.js` (per-event repo, hash-chained `commit-NNN.json`), `ots.js` (optional anchoring, spawns `ots`). Dep: `simple-git`.
- **Email triggers** — `outbound.js` (build + sendmail), `sweep.js` (reminders/nudges/archive), `prefilter.js`, `envelope.js`, `dsn.js` (bounce handling).

**Stays in gitdone** (policy/product): the heavy attestation tail (`revoke`, `latest`/`accumulating` dedup, multi-doc strict manifests + `reference_docs`/`attach`, attestor-PII redaction), `bundle`, `[gitdone]` email bodies, web dashboard + magic-link flow, knowless-based manage auth. (The lean crypto sign-off *mechanism* itself is now lifted — see the Sequence bullet above.) **`receive.js` is NOT lifted** — it's app glue; mailproof exposes primitives + an optional `createReceiver()` with policy hooks, and each app writes thin glue.

## Planned public API (pure ESM)
```js
import { create } from 'mailproof';
const core = create({ dataDir, domain, sendmailBin, otsBin /* optional */ });

await core.createEvent({ title, flow: 'sequential', initiator,
  steps: [{ id, name, participant, dependsOn: [], minTrust: 'verified' }] });

// inbound: app pipes raw RFC-822 + envelope; mailproof verifies, routes,
// commits (accept-with-flag), advances, and fires the next notification.
const result = await core.ingest(rawEmailBuffer, envelope);
//   → { routed, trustLevel, committedSeq, counted, completedStep, eventComplete, notified }

// crypto sign-off mode (PRD §4.2): same substrate, routed by `type`.
await core.createEvent({ title, type: 'crypto', initiator,
  signers: ['a@x.com', 'b@x.com'], open: false, threshold: 2,
  requiredDocHash: 'sha256:…' /* optional */ });

core.loadEvent(id);  core.listCommits(id);  core.stats();
await core.sweep();  // call from a cron / systemd timer
```
Lower-level pieces (`classifyTrust`, `buildRawMessage`, `commitReply`,
`applySignoff`, …) are exported too, so a consumer can compose its own pipeline.

Deps: `mailauth`, `mailparser` (+ optional `ots` binary). The git ledger uses
the `git` binary via `child_process`, **not** `simple-git` (decisions log,
2026-05-23), so the runtime-dep budget is ≤2. Node ≥22.5. Apache-2.0.

## Phasing
- **P0 — POC (this commit):** stdlib + `git` binary only. Prove verify→sequence→git→email composes as vanilla code, decoupled from gitdone's config singleton and crypto branches. `poc/pipeline.js`. *Never shipped — rewritten in P1.*
- **P1 — Lift:** port the modules above; extract the workflow-only completion engine; replace the `config` singleton with injected config; bundle the sendmail transport; Testing-Trophy tests (mostly integration with `:memory:`/`tmp` repos).
- **P2 — Validate (revised; see PRD §7.1):** ~~refactor `gitdone` to depend on `mailproof`~~ → **two steps that protect gitdone's production stability**: (Step 1) read-only API audit producing one boundary table across `gitdone/app/src/`; (Step 2) gitdone-on-mailproof on a **dedicated branch that is never intended to merge** — a validation harness whose purpose is surfacing gaps/awkwardness mailproof has against gitdone's full corner-case surface and feeding fixes back to mailproof's `main` (possibly an `m7e`). gitdone's `main` stays untouched. Other downstream services adopt mailproof where a multi-party, email-grounded confirmation chain is needed. The PRD success metrics (primary = a non-gitdone consumer; boundary proof = the validation branch reaches gitdone-test parity) are unchanged.
