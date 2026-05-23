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

mailproof is the **generic-workflow kernel only**. These formats describe an
ordered/parallel multi-step confirmation over email. Crypto declaration,
attestation, strict signing, thresholds, revoke, and reference-doc
registration are **gitdone policy** layered on top — their wire artifacts
(`attach`/`revoke` commit kinds, `declaration`/`attestation` event fields,
`reference_docs`, `revoked_senders`) are **out of scope here** and are noted
only to mark the boundary.

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

### Policy tags (gitdone, NOT lifted)

`manage+`, `attest+`, `attach+`, `revoke+`, `close+`, `bundle+`. The mailproof
router must **not** parse these — a consumer that needs them adds its own
parser. (gitdone's `router.js` parses all of them; the lift drops these.)

---

## 3. `event.json` — workflow state

One file per event at `{dataDir}/events/{eventId}.json`, written atomically
(temp + rename), serialized as `JSON.stringify(event, null, 2) + '\n'` — this
exact serialization is an **invariant** (see §5).

```jsonc
{
  "id": "a1b2c3",                    // alphanumeric; 12-char base36 if generated
  "title": "Contract sign-off",
  "type": "workflow",               // v1: only "workflow"
  "flow": "sequential",             // "sequential" | "parallel"
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
    completion.json           # written once when the event completes
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
  "raw_sha256": "…",                // sha256 of the raw RFC-822 bytes
  "raw_size": 4096,

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

**A reply is `counted` iff all hold:** `participant_match` is true; `trust_level`
≥ step `minTrust`; the step's `dependsOn` are all complete; and (for
`sequential` flow) the step is the earliest pending step. Otherwise `counted`
is false with a `count_reason` (`wrong_participant`, `unverified_trust`,
`deps_unmet`, `out_of_order`, `already_complete`, `event_not_activated`).

**Other kernel commit kinds:** `event_edit` (participant/deadline/title change
as a before/after audit record; participant changes stored as salted
`from_hash`/`to_hash`), `completion` (written once at threshold; records
`completed_at` + `triggering_commit_sequence`), `reverify` (durable
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
   without OTS.
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
