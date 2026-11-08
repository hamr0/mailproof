# M2 reply-text POC (throwaway, never shipped)

Question: can a deterministic, stdlib-only stripper (`mailproof-quote/1`, candidate rules) return only the text a
sender newly wrote in a reply, without quoted history, on real replies from real clients, and decide
`quote: found | not-found | inline`? How often does a real reply have no text/plain part? Findings: [F20](../../docs/product/findings.md).

**Privacy.** The samples are real mail and this is a public repo. Nothing from a sample is in this directory,
the findings or any console output (ids, counts, sizes and flags only). The id -> file map and all extracted text
are written to `~/mailproof-m2-review/` (mode 700, outside the repo) for the owner's manual review.

## Files

- `strip.mjs`: the stripper. Hand-written header/MIME parsing, Content-Transfer-Encoding (7bit/8bit/binary,
  quoted-printable, base64) and charset via `TextDecoder` (fatal off); no mailparser, so the result depends on the
  bytes and the stripper version only (on a Node whose `TextDecoder` is right for windows-1252 and GBK: the shipped
  `src/proof/reply-text.js` decodes those two in-house, F21, and this frozen POC does not, so the unit parity test
  skips its windows-1252 fixtures on Node 22.19.0). format=flowed is unfolded. Output: `text`, `text_sha256`, `text_bytes`
  (UTF-8), `quote`, `source` (`text/plain` or `html-only`), the boundary kind. Signatures are not stripped.
- `run.mjs`: the harness. Collects replies/forwards, runs the stripper twice (determinism), runs it again with the
  detectors off (control), runs the real `Mailproof#check()` for `body_status` (worker size 0, no trail written,
  scratch dir from `tests/helpers/tmp.js`, removed at exit), writes the review folder and prints aggregates.

## Re-run

```bash
node poc/m2-quotes/run.mjs                       # default dirs: ~/mailproof-m0-samples*, gitdone poc/phase0, ~/mail-samples/m2-replies
node poc/m2-quotes/run.mjs ~/mail-samples/m2-replies   # only the targeted replies; M2_REVIEW=<dir> to change the review folder
```

Sample selection: a message with an `In-Reply-To` or `References` header, or a subject starting Re:/Fwd:/Fw:/AW:/WG:/TR:/RV:
(encoded words decoded). A digest (multipart/digest, or "digest" in the subject) with `message/rfc822` parts is
expanded and each part is its own sample if it passes the same filter; a digest that is one plain-text
concatenation is counted and skipped, never split heuristically.

## Rules (candidate, version `mailproof-quote/1`)

Boundary = the first of: an attribution line (On/Op/Am/Le/El ... wrote/schreef/schrieb/a ecrit/escribio, also
wrapped over up to 4 lines); an Outlook header block (`-----Original Message-----`, or From/Van/Von/De followed
within 4 lines by Sent/Verzonden/Gesendet/Envoye/Enviado/Date/Datum, taking a rule line of `_`/`-`/`=` directly
above it along); a forward marker (`---- Forwarded message ----`, `Begin forwarded message:`, localized variants);
a line starting with `>`. New text = everything before it, trailing whitespace trimmed. `inline` = a non-empty
unquoted line after the boundary region followed later by a `>` line. `trailing` (added after the owner's review, F20) = quote `found` and a non-empty unquoted line after the last `>` line: text that follows the quote and is not returned.

## Can it fail?

- Control: detectors off must give `not-found` and the whole body on every sample, and the number of samples that
  change is reported against the number that visibly quote.
- Idempotence: stripping the extracted text again must give the same bytes and `not-found`.
- Non-reply population (newsletters, receipts, reports) run through the same stripper: it should rarely find a boundary.
- Degenerate checks: empty text, text equal to the whole body despite a boundary, very short text, and text written
  after the last quoted line (bottom-posting or a signature below the quote, which the rules would drop).
- What it cannot do: judge correctness. That is the owner's manual review of the review folder.

## Rule changes made while iterating

Only general ones, none driven by a single sample. (1) Reply selection also accepts a `References` header: replies
from one client carry `References` but no `In-Reply-To` (three digest parts were first missed). (2) The forward
marker list was first drafted with an overlapping "original message" pattern; split so `-----Original Message-----`
reports its own kind. The detectors themselves were not changed after seeing results.
