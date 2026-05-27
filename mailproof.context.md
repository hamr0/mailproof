# mailproof — Integration Guide

> For AI assistants and developers wiring mailproof into a project.
> Pre-library (P1 — m7b assembly + m7c verify surface + m7d-1 sweep) | Node.js >= 22.5 | 2 deps (`mailauth`, `mailparser`) | Apache-2.0

## What this is

mailproof is an **email-native multi-party coordination kernel** for Node.js.
It does four decoupled things to an inbound email reply: **verify** it
(DKIM/DMARC trust level), **sequence** it through a workflow or a crypto
sign-off, **commit** it to a tamper-evident per-event **git** ledger, and
**trigger** the next email. No web UI, no branding, no policy — those belong to
the consumer on top.

```js
const { create } = require('mailproof'); // CommonJS, vanilla JS

const core = create({
  dataDir: '/var/lib/mailproof',   // required — events + per-event git repos live here
  domain:  'app.example',          // required — your address space (Message-Id + plus-tags)
  sendmailBin: '/usr/sbin/sendmail', // optional — the trigger transport
  otsBin:  '/usr/bin/ots',         // optional — OpenTimestamps anchoring
});

// Define a coordination event…
await core.createEvent({
  id: 'onboard1', type: 'workflow', flow: 'sequential', initiator: 'boss@app.example',
  steps: [
    { id: 'sign',  participant: 'alice@corp.example' },
    { id: 'countersign', participant: 'bob@corp.example' },
  ],
});
await core.activateEvent('onboard1'); // replies don't count until activated

// …then feed it every inbound reply. mailproof verifies, routes, commits,
// advances, and fires the next notification.
const result = await core.ingest(rawRfc822Buffer, envelope);
// → { routed, mode, eventId, trustLevel, committedSeq, counted, count_reason,
//     completedStep, signatureCount, eventComplete, notified }
```

This is the dense reference. For the *why*, see `docs/01-product/PRD.md`; for
the wire formats, `docs/02-design/SPEC.md`; for the extraction boundary,
`docs/02-design/DESIGN.md`.

## What mailproof is and is NOT

mailproof is the **mechanism**: verify → sequence → ledger → trigger. It is
deliberately NOT a product. It does not brand emails, render a dashboard, send
magic links, manage accounts, or decide policy. Anything that is *opinion*
(who may sign, what an email says, how long to retain, whether to revoke) is the
consumer's job — mailproof gives you the primitives and one body hook.

The design tie-breaker: **a consumer must be able to rebuild gitdone (the source
project) from mailproof's primitives + thin policy glue.** Keep mechanism in the
kernel; push policy out. See § "What's NOT in mailproof".

## Which mode do I need?

mailproof has **two generic coordination modes**, both on the same
DKIM-verified-email + git-ledger substrate, routed by the event's `type`:

| Mode | `type` | Tag | What it coordinates | Completes when |
|---|---|---|---|---|
| **Workflow events** | `'workflow'` | `event+{id}-{step}@` | Ordered/parallel/mixed steps, each owned by a participant | every step is `complete` |
| **Crypto sign-off** | `'crypto'` | `attest+{id}@` | Signatures from named or open signers against an optional document hash | distinct signature count ≥ `threshold` |

Crypto is "one email or many through a link": `threshold: 1` = a single-signer
**declaration**; `threshold: N` (or `open: true`) = count-to-goal where the
"link" is the `attest+{id}@` **email address** (not a web link/app/webhook).

## All `create()` options

```js
const core = create({
  // --- Required ---
  dataDir: '/var/lib/mailproof',  // root for {dataDir}/events/*.json + per-event git repos
  domain:  'app.example',         // the operator's domain; outbound Message-Ids + plus-tags

  // --- Optional ---
  sendmailBin: '/usr/sbin/sendmail', // sendmail(8) the trigger pillar submits to.
                                     //   Absent ⇒ sends report {ok:false}; ingest still advances.
  otsBin: '/usr/bin/ots',            // `ots` binary for OpenTimestamps. Absent ⇒ no .ots proofs.
  mtaHostname: 'mx.app.example',     // this MTA's hostname, passed to mailauth as `mta`.
  resolver: customDnsResolver,       // custom mailauth DNS resolver. Absent ⇒ system resolver.
                                     //   (tests inject an offline stub; verify+ will re-check archived keys)
  composeNotification: (ctx) => '…', // body of the neutral notifications ingest()/sweep() trigger.
                                     //   Absent/falsy ⇒ a neutral default body. See § Triggers.
  overdueDays: 14,                   // sweep(): idle days before the `overdue` nudge (default 14).
  archiveDays: 45,                   // sweep(): idle days before auto-archive + `archived` (default 45).
});
```

Config is injected here and **nowhere else** — each pillar factory closes over
the same `dataDir`. There are no env-var defaults (that's the consumer's glue).

## Public API (`create()` return surface)

| Method | Purpose |
|---|---|
| `ingest(raw, envelope)` | The inbound pipeline. `raw` = RFC-822 Buffer; `envelope` = `{ sender, recipient, clientIp, clientHelo }`. Returns the result summary (below). |
| `sweep({ now? })` | The time-driven pass (run it on your own schedule). Scans every event and emits the `overdue` (idle nudge) + `archived` (auto-archive transition) occasions through the same notifier. Returns `{ overdue, archived, notified }`. Thresholds via `create()`'s `overdueDays`/`archiveDays` (14/45). |
| `createEvent(partial)` | Create + persist an event (both modes). Created **pending** (`activated_at: null`). |
| `activateEvent(id)` | Mark activated + fire the `activation` kickoff to initially-eligible participants/signers (once). `{ event, alreadyActive, notified }`. **Replies don't count until activated.** |
| `editEvent(id, patch)` | Patch a non-finalised event; writes an audit commit if activated; re-notifies (`reassigned`) a participant moved onto a currently-eligible step. Returns `{ event, prev, changes, commitSequence, notified }`. |
| `loadEvent(id)` | Read the event JSON (the master record). |
| `listCommits(id)` | The per-event commit ledger (every reply, counted or not). |
| `loadCommit(id, seq)` | One `commit-NNN.json`. |
| `verifyDocument(id, bytes, {email?})` | Notary lookup: does this document match a committed attachment? |
| `hashDocument(bytes)` | The canonical `sha256:…` fingerprint (one source of truth). |
| `verify(id, bytes, {messageId?, resolver?})` | Offline durable verify: match a forwarded email/doc to a commit (`raw_sha256`→`message_id_hash`→attachment) and re-verify its DKIM against the **archived** key — holds with live DNS down. |
| `reverify(id, seq, rawEml, {resolver?})` | Re-evaluate a contested commit against its archived key; on a DKIM pass, **upgrade** its recorded trust and persist an immutable `reverify-NNN.json` (the original commit is never rewritten). |

Lower-level pieces are also exported from the package root for consumers that
compose their own pipeline: `classifyTrust`, `TRUST_LEVELS`, the `router`
parsers, `preFilter`, `parseEnvelope`, `authenticateMessage`, `parseMessage`,
`buildRawMessage`/`sendmail`/…, `createEventStore`, `withEventMutex`,
`createGitrepo`, `createOts`, the `completion` + `crypto` engine functions,
`createNotary`, `hashDocument`.

### `ingest()` result shape

```js
// matched + processed:
{ routed: true, mode: 'workflow'|'crypto', eventId, trustLevel,
  committedSeq,            // the reply's ledger sequence (always committed)
  counted, count_reason,   // did it advance state? if not, the machine-code reason
  completedStep,           // workflow: the step just completed (or null)
  signatureCount,          // crypto: distinct signatures so far (or null)
  eventComplete,           // did THIS reply complete the event?
  notified }               // [{ kind:'advance'|'ack'|'completion', to, ok, reason }]

// not attached to any event (NOT committed):
{ routed: false, reason: 'no_event_tag'|'unknown_event'|<prefilter reason>, rejected? }
```

## The core invariant: accept-with-flag

**Every reply that resolves to a known event is committed to the ledger — even
when it doesn't count.** Routing, trust, and participant checks gate the *state
transition*, never the *commit*. The commit records `counted` (did it advance?)
and `count_reason` (why not, when false). This is what makes the ledger a
complete audit trail rather than a record of only the "good" replies.

Mail that fails the **humans-only prefilter** (auto-responders, mailing lists,
bulk, system senders), carries **no event tag**, or names an **unknown event**
is *not* committed (there's no event to attach it to) and returns `routed:false`.

`count_reason` values — workflow: `event_not_activated`, `event_archived`,
`already_complete`, `wrong_participant`, `no_step`, `unknown_step`,
`unverified_trust`, `deps_unmet`, `out_of_order`, `missing_attachment`. Crypto:
`event_not_activated`, `event_archived`, `already_complete`, `unverified_trust`,
`initiator_self_reply`, `not_a_signer`, `already_signed`, `doc_hash_mismatch`.

## Verify — trust levels

`classifyTrust(auth)` maps a `mailauth` result to one of four levels, ranked
strongest→weakest:

| Level | Meaning |
|---|---|
| `verified` | DKIM pass + aligned + DMARC pass |
| `forwarded` | DKIM fail/none, but ARC pass via a trusted intermediary |
| `authorized` | DKIM fail/none, but SPF pass + DMARC pass |
| `unverified` | none of the above |

mailproof pins `trustReceived: false` — it never trusts pre-existing
`Received`/`Authentication-Results` headers, only its own check against the
envelope.

## Workflow events

```js
await core.createEvent({
  type: 'workflow',
  flow: 'sequential', // 'sequential' (linear chain) | 'parallel' (no deps) | 'custom' (your dependsOn)
  initiator: 'boss@app.example',
  steps: [{
    id: 'sign',                    // required, unique per event
    participant: 'alice@corp.example',
    dependsOn: [],                 // custom flow only; sequential/parallel are derived
    minTrust: 'verified',          // ⚠️ DEFAULT is 'verified' — see gotchas
    requires_attachment: false,    // if true, the counting reply must carry SOME attachment
  }],
});
```

One eligibility model: a step counts iff its `dependsOn` are all complete, the
sender matches `participant`, and trust meets `minTrust`. `flow` is sugar that
only shapes `dependsOn` at creation (sequential → linear chain). On a step
completing, ingest pings the participant(s) of every newly-eligible step.

## Crypto sign-off

```js
await core.createEvent({
  type: 'crypto',
  initiator: 'boss@app.example',
  signers: ['alice@corp.example', 'bob@corp.example'], // explicit allow-list…
  open: false,                  // …or open:true = any verified sender counts ("the link")
  threshold: 2,                 // distinct signatures to complete (1 = declaration)
  requiredDocHash: 'sha256:…',  // optional: a counting reply must attach a matching document
});
```

A reply counts as a signature iff: the event is active/not-complete, the reply
is **`verified`** (hardcoded — crypto is the high-assurance mode, not per-event
configurable), the sender is **not the initiator** (anti-self-dealing: the
initiator may reply, but it's committed-for-audit and never counts), the sender
is a signer (or the event is open), the sender's salted hash is distinct from
those already counted, and `requiredDocHash` (if set) matches. The event locks
at distinct count ≥ `threshold`.

## The git ledger + verifiability

State = event JSON + a per-event git repo whose commit chain **is** the
tamper-evidence and the portable, offline-verifiable proof. Each reply →
`commits/commit-NNN.json`. Identity at rest is **minimized**: the salted
`sender_hash` + `message_id_hash` (per-event public salt), `sender_domain` in
plaintext, never the raw address. With `otsBin` set, each commit also gets an
`.ots` OpenTimestamps proof. Each accepted reply also **archives the signer's
DKIM public key** (PEM) on its commit, so `core.verify()` re-checks the signature
offline — even after the signer rotates DNS — and `core.reverify()` can upgrade a
contested commit's trust against it. With `otsBin` set, `createOts()` also
exposes `upgradeProof(abs)` (folds the Bitcoin attestation into a pending `.ots`
once the calendars have it; the file's sha256 changing = "now anchored") and
`readBlockHeight(abs)` (reads the anchored block via `ots info`, offline) — so
the `.ots` proofs are verifiable, not just stored. *(Driving these across an
event + emitting a `proof_anchored` notification is m7d.)*

## The notary (documents, both ways)

Inbound attachments are **auto-hashed** on every `ingest` (the capture half) and
recorded in the commit. `verifyDocument(id, bytes)` re-hashes a document and
matches it back (the verify half) — a proof-of-participation receipt, not a
secret. The notary records and verifies; it never gates completion (that's
`requires_attachment` for workflow / `requiredDocHash` for crypto).

## Triggers + the `composeNotification` hook

Every occasion mailproof derives fires through ONE notifier (`deliver`), with
`composeNotification` the single body hook. On a **counted** reply, `ingest`
sends the next neutral email(s) via `sendmailBin`, *after* releasing the event
lock, and reports them in `notified`:

- workflow → ping the participant(s) of every newly-eligible step (`kind:'advance'`)
- crypto → ack the verified signer (`kind:'ack'`)
- both → notify the `initiator` on the completing edge (`kind:'completion'`)

`sweep()` adds the **time-driven** occasions, to the initiator: `kind:'overdue'`
(idle past `overdueDays`) and `kind:'archived'` (auto-archived past `archiveDays`).
`activateEvent`/`editEvent` add the **organiser-action** occasions: `kind:'activation'`
(first activation → ping initially-eligible participants / listed signers) and
`kind:'reassigned'` (a participant moved onto a currently-eligible step). Both
append a `notified` array to their return. And an inbound **DSN bounce** (a
notification that failed permanently downstream) is recognised by `ingest()`,
routed to the event by its plus-tag return path, recorded as a per-step send
error, and surfaced to the initiator as `kind:'bounce'` (operational — never
committed to the ledger; `ingest` returns `{ routed:false, bounce:true, eventId,
stepId, failedRecipients, notified }`). Non-counting replies send nothing. Each
message's `From` is the plus-tagged reply address so the recipient's reply
routes straight back.

```js
composeNotification({ kind, mode?, eventId, event, to, replyAddress, step?, signatureCount?, daysOver?, daysIdle? }) {
  return `Your custom body for ${kind}`; // return falsy → neutral default; a throw → default
}
```

Branding is a NO-GO (the body is the only consumer seam). The hook returns a
**body** only; subjects are kernel-defaulted. There are intentionally no
`onCounted`/`onRejected`/`onCompleted` hooks — the `ingest()` return value
already carries that.

## Architecture (four pillars, decoupled)

```
ingest(raw, envelope)
  │
  ├─ prefilter   (prefilter.js)      humans-only gate
  ├─ decode      (parse.js)          mailparser + mailauth   ── deps
  ├─ verify      (classifier.js)     trust level
  ├─ route       (router.js)         event+ / attest+ tag
  ├─ sequence    (completion.js | crypto.js)   pure engines
  ├─ ledger      (gitrepo.js + event-store.js + event-mutex.js + ots.js)
  └─ trigger     (outbound.js)       next email
```

Each pillar is factory-bound to config and independently testable. `create.js`
composes them; `ingest.js` orchestrates one inbound reply through them.

## What's NOT in mailproof, and why

These stay in the **consumer** (gitdone is the reference) as policy on the
primitives + the `composeNotification` hook:

- **Branded / prose email bodies, web dashboard, magic-link auth** — product, not mechanism (use `composeNotification` + your own app).
- **`revoke`, `latest`/`accumulating` dedup** — the core is **distinct-only**; revoke/reopen cycles are policy.
- **Multi-doc strict manifests, `reference_docs`, attestor-PII redaction** — the heavy attestation tail.
- **Per-record erasure / participant self-revoke (RTBF by deletion)** — a **NO-GO**: it breaks tamper-evidence + non-repudiation + offline verify. Privacy = minimization (salted hashes, no plaintext at rest) + lawful retention. The *only* erasure lever is **whole-event deletion** (destroys the salt → residual hashes unlinkable). The operator is the GDPR controller; mailproof *enables* compliance, it does not discharge it.
- **Document-as-login / second factor** — NO-GO; the notary is a receipt, not a secret.
- **The orchestrator glue** (`receive.js`-style main) — mailproof exposes `ingest()` + primitives; you write thin glue.

## Gotchas

1. **Events are created pending.** A reply doesn't count until `activateEvent(id)` (or you pass `activated_at` at creation). Otherwise `count_reason: 'event_not_activated'`.
2. **`minTrust` defaults to `'verified'`.** A workflow step with no explicit `minTrust` requires a DKIM-verified reply — an unverified reply is committed but not counted (`unverified_trust`). Set `minTrust: 'unverified'` to accept anything.
3. **Crypto trust is hardcoded `verified`** and not per-event configurable.
4. **The initiator's own reply never counts in crypto** (anti-self-dealing). In *workflow*, the initiator MAY be a counted participant.
5. **Plaintext sender is never persisted** — only the salted hash. Don't expect to recover addresses from the ledger; that's by design.
6. **`sendmailBin` absent ⇒ sends report `{ok:false}`** but `ingest` still commits + advances. Triggers are best-effort; a send failure never undoes a transition.
7. **The event mutex is in-process only.** A multi-worker / multi-process consumer must add its own cross-process lock (the bundled per-message Postfix pipe model relies on MTA delivery serialisation).
8. **`composeNotification` returns a body string** (subject is kernel-defaulted); a throw or falsy return falls back to the neutral default.
9. **`ingest` commits even non-counting replies** for matched events. Prefilter-dropped / tagless / unknown-event mail is `routed:false` and *not* committed.

## Constraints

- Node ≥ 22.5. Vanilla JS (CommonJS), JSDoc + shipped `.d.ts`. No build step.
- 2 runtime deps (`mailauth`, `mailparser`); the git ledger uses the `git` binary via `child_process` (not `simple-git`). `ots` is an optional external binary.
- Transport is **bundled self-hosted Postfix/sendmail** with opendkim signing outbound at the MTA — not a pluggable third-party mail provider.
- Durability-first: the ledger is the single source of truth and is meant to be offline-verifiable; SQL consumers project a read-model, they don't replace it.
