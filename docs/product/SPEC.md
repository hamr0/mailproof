# mailproof — SPEC (wire formats)

> The authority on **mechanism**: byte layouts, schemas, and grammars. If
> this disagrees with DESIGN.md on a wire format, **SPEC wins** (per
> `docs/README.md` precedence). If it disagrees with the PRD on *intent or
> scope*, the PRD wins and this doc must be corrected.

**Status:** P1 is not yet lifted. This SPEC is **prescriptive** — it pins the
formats the lift must produce, derived from the `gitdone` source being
extracted (`event-store.js`, `gitrepo.js`, `classifier.js`, `router.js`,
`outbound.js`) minus the policy that stays in `gitdone`. Where mailproof
deliberately diverges from gitdone, it is called out.

## 0. Scope

mailproof is the **two-mode coordination kernel** (PRD §4.2): an
ordered/parallel multi-step confirmation (**events**, `type: "workflow"`, §3)
*and* a verified-signer sign-off (**crypto**, `type: "crypto"`, §3.1). Both
formats are covered here. The heavy *policy* tail of gitdone's crypto — strict
multi-doc signing, `revoke`, `latest`/`accumulating` dedup, reference-doc
registration, attestor-PII redaction — stays gitdone policy; its wire artifacts
(`attach`/`revoke` commit kinds, `reference_docs`, `revoked_senders`, per-event
`dedup`/`mode`) are **out of scope here** and are noted only to mark the
boundary.

---

## 1. Trust levels

A pure classification of one inbound reply's authentication result
(`classifier.js`). Input is a [`mailauth`](https://github.com/postalsys/mailauth)
`authenticate()` result; output is exactly one level. Ranked ascending:

| Level | Rule | Meaning |
|---|---|---|
| `unverified` | none of the below | No usable authentication. |
| `authorized` | SPF pass **and** DMARC pass | Sending MTA is authorized for the domain, but no aligned DKIM signature. |
| `forwarded` | ARC pass via a trusted intermediary | DKIM broke in transit (e.g. a mailing list), but the ARC chain vouches for the original. |
| `verified` | DKIM pass **and** aligned **and** DMARC pass | Strongest: the message is cryptographically bound to the sending domain. |

```
TRUST_LEVELS = ['verified', 'forwarded', 'authorized', 'unverified']   // rank: index 0 strongest
```

Evaluation order is `verified → forwarded → authorized → unverified`; the
first matching rule wins. A step's `minTrust` gate is satisfied when the
reply's level is **at least as strong** as the step's requirement.

---

## 2. Address grammar

Inbound routing keys off the envelope recipient (Postfix preserves
`${original_recipient}` through the pipe transport). All tags share one shape:

```
{kind}+{extension}@{domain}
ADDR_RE      = /^([a-z][a-z0-9]*)\+([^@\s]+)@([^\s@]+)$/i
EVENT_ID_RE  = /^[a-zA-Z0-9]+$/        // eventId is alphanumeric, validated at creation
```

### Kernel tags (in scope)

| Tag | Meaning |
|---|---|
| `event+{eventId}-{stepId}@` | Workflow reply for a specific step. Everything after the **first** dash is the `stepId` (step ids may contain dashes; eventId may not). |
| `event+{eventId}@` | Workflow reply, step unspecified (kernel resolves the step from sender/state). |
| `remind+{eventId}@` | Initiator asks to re-nudge pending participants. |
| `stats+{eventId}@` | Initiator requests a status summary. |
| `verify+{eventId}@` | Public, durable verification endpoint (no step component). |
| `reverify+{eventId}-{commitSeq}@` | Contested-commit re-evaluation: submitter supplies a raw `.eml` that must validate against the DKIM key archived for `commit-{commitSeq}`. `commitSeq` is `1..99999`. |
| `attest+{eventId}@` | Crypto sign-off reply (§3.1). No step component — sign-off events have no steps; the engine resolves the signer from the verified sender. **Promoted from a policy tag to a kernel tag with the two-mode pivot.** |

### Policy tags (gitdone, NOT lifted)

`manage+`, `attach+`, `revoke+`, `close+`, `bundle+`. The mailproof router must
**not** parse these — a consumer that needs them adds its own parser. (gitdone's
`router.js` parses all of them; the lift drops these. `attest+` was in this set
until crypto sign-off became a core mode — it is now a kernel tag above.)

---

## 3. `event.json` — workflow state

One file per event at `{dataDir}/events/{eventId}.json`, written atomically
(temp + rename), serialized as `JSON.stringify(event, null, 2) + '\n'` — this
exact serialization is an **invariant** (see §5).

```jsonc
{
  "id": "a1b2c3",                    // alphanumeric; 12-char base36 if generated
  "title": "Contract sign-off",
  "type": "workflow",               // "workflow" (this section) | "crypto" (§3.1)
  "flow": "sequential",             // "sequential" (default) | "parallel" | "custom"; expanded to per-step dependsOn at createEvent
  "initiator": "organiser@acme.com",
  "status": "open",                 // "open" | "complete"
  "salt": "9f3a…",                  // 32-byte hex, PUBLIC; salts the commit hashes (§6)
  "created_at": "2026-05-22T20:27:04.210Z",
  "activated_at": null,             // ISO string once activated; null = pending, replies don't count
  "completed_at": null,             // ISO string when status flips to complete
  "archived_at": null,              // ISO string if archived (reversible; never auto-completed)
  "steps": [
    {
      "id": "legal",                // unique within the event
      "name": "Legal review",
      "participant": "legal@acme.com",
      "dependsOn": [],              // step ids that must be complete first
      "minTrust": "verified",       // gate: reply level must be >= this (§1)
      "status": "pending",          // "pending" | "complete"
      "commit_sequence": null,      // the commit-NNN that completed it (§4); null until done
      "deadline": "2026-06-01",     // optional, YYYY-MM-DD
      "requires_attachment": false, // optional
      "details": "…"                // optional, free text shown to participant
    }
  ]
}
```

**gitdone-only event fields (policy, not core):** `activation_ack_token`,
`activation_link_clicked_at` (web magic-link flow), `declaration`,
`attestation`, `mode`, `reference_docs`, `revoked_senders`,
`proof_email_message_id`. The kernel ignores them if present.

**Activation gate.** `activated_at == null` ⇒ the event is pending and replies
are committed for audit but never `counted`. *How* an event gets activated is
the consumer's policy (gitdone uses a magic link); the kernel only reads the
timestamp.

---

## 3.1 `event.json` — crypto sign-off state

The second mode (`type: "crypto"`, PRD §4.2). Same file location, atomic write,
and serialization invariant as §3, and the same lifecycle fields
(`activated_at`/`archived_at`/`status`/`completed_at`/`salt`). It has **no
`steps`**; instead a flat signer/threshold shape. Engine: `src/crypto.js`.

```jsonc
{
  "id": "c1d2e3",
  "title": "Series A board consent",
  "type": "crypto",
  "initiator": "counsel@example.com", // orchestrates; a self-reply NEVER counts
  "status": "open",                   // "open" | "complete"
  "salt": "9f3a…",                    // 32-byte hex, PUBLIC (§6)
  "created_at": "2026-05-22T20:27:04.210Z",
  "activated_at": null,
  "completed_at": null,
  "archived_at": null,

  "signers": ["a@example.com", "b@example.com"], // allow-list, lowercased
  "open": false,                      // true ⇒ ANY verified sender may sign (a shared address)
  "threshold": 2,                     // distinct signatures to complete; 1 = single-signer declaration
  "requiredDocHash": "sha256:…",      // optional; a counting reply must attach a file whose sha256 matches (notary format) | null
  "manualCompletion": false,          // optional; true ⇒ engine never auto-locks — replies still count, but only completeEvent finalises (consumer owns completion)

  "signatures": [                     // the distinct count-to-threshold record (non-PII, §6)
    {
      "sender_hash": "sha256:…",      // salted; the dedup key
      "sender_domain": "example.com",
      "commit_sequence": 4,           // the commit-NNN (§4) that counted this signer
      "received_at": "2026-05-22T20:27:04.235Z",
      "trust_level": "verified"
    }
  ]
}
```

**A reply COUNTS as a signature iff** (machine-code `count_reason`s, §4): the
event is activated, not archived, not complete; `trust_level === "verified"`
(**hardcoded** — crypto is all-or-nothing, no per-event `minTrust`); the sender
is **not** the initiator (`initiator_self_reply` — anti-self-dealing); the
sender is a signer (or `open`); the sender is **distinct** from those already in
`signatures` (`already_signed`); and, if `requiredDocHash` is set, some
attachment's sha256 matches (`doc_hash_mismatch`). The event locks
(`status:"complete"` + `completed_at`) when `signatures.length ≥ threshold`,
**unless `manualCompletion` is set** — then the count still accrues but the
engine never auto-locks, and the consumer finalises via `completeEvent` (the
same flag suppresses the workflow engine's all-steps-done auto-complete).

**Signer-identity resolution is the orchestrator's**, mirroring workflow's
`participant_match`: it compares the plaintext sender against
`signers`/`open`/`initiator` at ingest and passes the engine precomputed
`signer_match` / `is_initiator` booleans (plaintext never reaches the engine or
ledger). The engine dedups on the commit's salted `sender_hash`.

**crypto count_reasons:** `event_not_activated`, `event_archived`,
`already_complete`, `unverified_trust`, `initiator_self_reply`, `not_a_signer`,
`already_signed`, `doc_hash_mismatch`.

**gitdone-only crypto fields (policy, NOT core):** `mode`, `dedup`,
`reference_docs`, `revoked_senders`, `attestor_progress` (strict multi-doc
signing, dedup variants, revoke, per-attestor buckets). The kernel **ignores
them if present** — distinct-count-to-threshold is the only rule.

---

## 4. Per-event git repo — the ledger

One **non-bare** git repo per event at `{dataDir}/repos/{eventId}/`. The
working tree *is* the inspectable, `git clone`-able proof. Layout:

```
{dataDir}/repos/{eventId}/
  .git/                       # the commit chain IS the tamper-evidence (§5)
  event.json                  # mirror of the master state, synced on every transition
  commits/
    commit-001.json           # one per accepted reply, zero-padded, monotonic
    commit-002.json
    reverify-001.json         # durable re-verification records (separate namespace)
    completion.json           # the current completion; rewritten + re-committed if reopened then re-completed (prior records stay in the chain)
  dkim_keys/                  # archived signer PEMs for durable verify (optional)
    commit-001.pem
  ots_proofs/                 # optional OpenTimestamps anchors (one per commit)
    commit-001.ots
```

### `commit-NNN.json` — reply audit record

The core invariant is **accept-with-flag**: *every* inbound reply that routes
to an event is committed — even rejected ones (wrong participant, unverified,
out of order). Routing and trust never gate the commit; they gate `counted`.

```jsonc
{
  "schema_version": 2,
  "kind": "reply",                  // "reply" | "event_edit" | "completion" | "reverify"
  "sequence": 3,                    // matches NNN in the filename
  "event_id": "a1b2c3",
  "step_id": "legal",               // null if the tag carried no step

  "received_at": "2026-05-22T20:27:04.235Z",
  "trust_level": "verified",        // §1
  "participant_match": true,        // sender == the step's participant
  "counted": false,                 // ← did this reply ADVANCE state? (the flag)
  "count_reason": "unverified_trust", // why not counted (null when counted)

  "sender_hash": "sha256:…",        // salted (§6); NO plaintext sender
  "sender_domain": "acme.com",      // domain is non-PII, kept plaintext
  "message_id_hash": "sha256:…",    // salted hash of the RFC-5322 Message-ID
  "raw_sha256": "sha256:…",         // notary hashDocument of the raw RFC-822 bytes
  "raw_size": 4096,
  "attachments": [                  // one entry per inbound attachment (may be [])
    { "filename": "doc.pdf", "size": 8192, "sha256": "sha256:…" }
  ],

  "dkim": { },                      // auth result fragments, structured
  "spf": { },
  "dmarc": { },
  "arc": { },
  "envelope": { "client_ip": null, "client_helo": null },

  "dkim_key_file": null,            // "dkim_keys/commit-003.pem" if archived (durable verify)
  "ots_proof_file": null            // "ots_proofs/commit-003.ots" if OTS anchoring enabled
}
```

**`counted` is mailproof's addition.** gitdone's `buildCommitMetadata` records
`trust_level` + `participant_match` and lets the orchestrator decide counting
out-of-band; the kernel makes the decision explicit and durable in the commit,
because "did this reply count, and why not" is exactly what an auditor reads.

**`attachments` is the notary capture half.** `parseMessage` (m7a) hashes every
inbound attachment's bytes through `hashDocument`, so each `sha256` is
`sha256:`-prefixed and byte-identical to what `verifyDocument` (§4.1) recomputes
and to a crypto event's `requiredDocHash` (§3.1). Hashing is unconditional; the
bytes themselves are never persisted (only the fingerprint, filename, and size).

**A reply is `counted` iff all hold:** the event is activated, not archived, and
not already complete; `participant_match` is true; the reply names a known,
not-yet-complete step; `trust_level` ≥ that step's `minTrust`; the step's
`dependsOn` are all complete; and, if the step sets `requires_attachment`, the
reply carried an attachment. (`createEvent` expands `flow:'sequential'` into a
linear `dependsOn` chain, so "earliest pending step" *is* the deps rule — the
engine has one eligibility model, no second sequential code path.) Otherwise
`counted` is false with a machine-code `count_reason`: `event_not_activated`,
`event_archived`, `already_complete`, `wrong_participant`, `no_step`,
`unknown_step`, `unverified_trust`, `deps_unmet`, `out_of_order` (deps unmet
under `sequential` flow), or `missing_attachment`. Matching a *specific*
document hash is the notary's `verifyDocument` (§4.1), never a completion gate.

**Other kernel commit kinds:** `event_edit` (participant/deadline/title change
as a before/after audit record; participant changes stored as salted
`from_hash`/`to_hash`), `completion` (records `completed_at` +
`triggering_commit_sequence`; written when the event reaches `complete`, and
*rewritten + re-committed* if the event is reopened then re-completes — via
either `completeEvent` or a fresh inbound reply through `ingest` — so the record
tracks the current completion while every prior record stays in the git chain;
a byte-identical re-completion writes no commit), `reverify` (durable
re-verification against an archived PEM; never mutates the target commit).

**gitdone-only commit kinds (policy, NOT core):** `attach`, `revoke`.

---

## 5. Tamper-evidence model

1. **Primary: the git commit chain.** Each accepted reply is a git commit.
   Git's content-addressing means every commit SHA covers its tree *and* its
   parent SHA — a Merkle DAG. Altering any historical `commit-NNN.json` changes
   that commit's tree hash and breaks every descendant SHA, which is detectable
   by anyone with a clone. This is the portable, offline-verifiable proof.
2. **Optional: OpenTimestamps.** When an `otsBin` is configured, each commit
   file is OTS-stamped (`commit-NNN.ots`), anchoring its existence to Bitcoin.
   This is **accept-with-flag**: stamp failure is recorded in the commit
   (`ots_archive.error`) and never blocks delivery. The kernel works fully
   without OTS. The initial stamp is a *calendar-pending* commitment; the
   Bitcoin attestation is folded in later by `createOts().upgradeProof(abs)`
   (runs `ots upgrade` in place — the proof file's sha256 *changing* is the
   authoritative "now anchored" signal, never `ots verify`). The anchored block
   is read offline with `readBlockHeight(abs)` (`ots info`, no network). Driving
   `create().upgradeProofs({ now? })` (m7d-4, present when `otsBin` is set)
   drives the upgrade across every event's proofs, patches each sibling commit
   JSON with `ots_anchored`/`ots_anchored_at`/`ots_block` via
   `gitrepo.commitProofUpgrade`, and emits the `proof_anchored` occasion on a
   fresh full-anchor transition. The schedule is the consumer's; the
   orchestration is the kernel's.
3. **Serialization invariant.** Every writer of `event.json` MUST emit
   `JSON.stringify(event, null, 2) + '\n'`. The repo's no-op-sync check is
   **byte-strict**: identical bytes ⇒ no commit. Any drift (indent, key order,
   trailing newline) produces spurious ledger commits. Enforced by convention +
   a regression test.

**Concurrency:** v1 relies on Postfix pipe-transport serialization
(`maxproc=1`, see OPS.md) so only one delivery touches a repo at a time. The
kernel adds a per-event in-process mutex for non-pipe writers (edits,
activation).

---

## 6. Plaintext discipline (salted hashes)

mailproof never persists plaintext sender addresses, subjects, bodies, or raw
Message-IDs to the ledger — those live only in any email forwarded to the
organiser by a consumer. The ledger stores **salted hashes**:

```
salt              = event.salt              // 32-byte hex, public, per-event
sender_hash       = "sha256:" + sha256(`${salt}|${sender.toLowerCase()}`)
message_id_hash   = "sha256:" + sha256(`${salt}|${normalizedMessageId}`)
normalizedMessageId = messageId without surrounding <>, lowercased
```

A verifier re-hashes a *claimed* address with the event's public salt and
matches; a random observer cannot bulk rainbow-table across events because the
salt differs per event. `sender_domain` is kept plaintext (non-PII, useful for
at-a-glance audit).

**Pseudonymous, not anonymous — and durable by design.** Because the salt is
public and lives in the committed `event.json`, a `sender_hash` is *re-linkable*
to a guessed address; it is pseudonymized personal data, not anonymized. This is
deliberate: it is what makes the proof publicly, offline-verifiable. The records
are therefore **durable by design** — there is no per-record erasure (it would
rewrite the Merkle chain and the non-repudiation it carries; PRD §8.16). The
**only** erasure lever is coarse and opt-in: deleting an *entire* event removes
its repo and `event.json`, destroying that event's salt, after which any
residual exported hashes are unlinkable (whole-event crypto-shred). Privacy
rests on minimization (no plaintext at rest) + lawful retention, not deletion
(PRD §8.17 for the GDPR posture).

---

## 7. Outbound RFC-822 message

mailproof composes plaintext (`text/plain; charset=utf-8`, `8bit`) RFC-822
messages with **CRLF** line endings and submits them to the local MTA via
`sendmail(8)` (opendkim signs at the MTA — no Node-side crypto). Required
headers: `From`, `To`, `Subject` (CR/LF stripped to prevent header injection),
`Message-Id` (`<{ts}.{16-hex}@{domain}>`), `Date` (RFC-5322), `MIME-Version`,
`Content-Type`, `Content-Transfer-Encoding`. Threading replies set
`In-Reply-To`/`References`. Notifications set `Auto-Submitted` (RFC 3834:
`auto-generated` for pure notifications, `auto-replied` for responses).
Non-ASCII subjects are RFC-2047 encoded.
