# M3 replyFacts POC (throwaway, never shipped)

Question: can the flat, string-only fact bundle of PRD section 7 M3 ("Approvals and the fact bundle") be built from
the existing primitives, the record and the content store with no new parsing? How is the reply to a request found, what
happens with 0, 1 and several replies and with several copies of one reply, what do the fields come out as on real
replies, what does a call cost, and which PRD fields are wrong or ambiguous? Findings: the newest F-entry in
[findings.md](../../docs/product/findings.md) ("M3 step 4 replyFacts POC").

**Privacy.** The samples are real mail and this is a public repo. Nothing from a sample is in this directory, the
findings or any console output (ids, counts, flags and provider class only). Per-reply bundles (with the reply text) and
the id -> file map are written to `~/mailproof-m3-replyfacts-review/` (mode 700, outside the repo) for the owner's review.
The synthetic scenarios use the test helpers and `example.*` domains only.

## Files

- `facts.mjs`: candidate `replyFacts(mp, { messageId })`. Public primitives only (`list`, `linked`, `get`, `rawEmail`,
  `replyText`, `checkProfile`, `verifyRecord`) plus the record JSON. Every place that needed something that is not public
  is marked `NEW:`. Also the lookup (`candidates`, two strategies) and the proposed choice rule (`choose`).
- `run.mjs`: the harness. Records every sample into a scratch trail (real `Mailproof`, worker size 0, no OTS, dir from
  `tests/helpers/tmp.js`, removed at exit), builds a bundle for every reply, tallies by provider class, runs synthetic
  scenarios (0 / 1 / several replies, copies), pads the trail with unsigned records and times `replyFacts`.

## Re-run

```bash
node poc/m3-reply-facts/run.mjs                  # default dirs as in poc/m2-quotes; M3_PAD=2000 (padding, x5 for the second size), M3_FAST=1 stops after the first padding
M3_REVIEW=<dir> node poc/m3-reply-facts/run.mjs  # change the review folder
```

Direction is assumed from the directory name (`*sent*` = out, everything else in). Provider class is by From domain or
Message-ID domain (Gmail / Microsoft / other), never printed beyond the class. The request Message-ID is the reply's
In-Reply-To (or last References id). Real requests were present for only 2 of the 10 real replies, so the harness
records an unsigned stand-in request (fixed text, `example.invalid`) for the others (arm B) and also measures the lookup
with the request absent (arm A).

## Limits of the evidence

Only 10 of the 42 distinct sample files are replies with an In-Reply-To/References (8 Microsoft-hosted, 1 Gmail, 1
other), and none has a DKIM-signed In-Reply-To; so `link` = `signed` and the "green" recipe are exercised only by the
synthetic signed thread (`tests/helpers/thread-trail.js`). Real counts are therefore "what the data shows", not rates.
