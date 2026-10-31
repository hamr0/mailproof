# mailproof v2 — Findings

Decisions and the tests/POCs behind them, with evidence. The [PRD](PRD.md) stays the lightweight product contract and points here.

POC script: [`poc/m0-header-recheck.js`](../../poc/m0-header-recheck.js) (throwaway, never shipped). Sample sets are real mail kept outside the repo; only counts and domains are recorded here.

## F1 — M0 header-only re-check: GO

- **Date:** 2026-10-31
- **Question:** can a DKIM signature be re-checked offline from a stored record alone (no raw email, no DNS, no live mailauth)?
- **Run:** `poc/m0-header-recheck.js` on 9 Gmail "Download original" files with 14 signatures (ietf.org x10, corp.mail.ru x2, google.com, lists.camaraproject.org). Each record is written to JSON, re-loaded, and re-checked from the JSON only.
- **Result:**
  - Offline re-check agrees with mailauth on 14/14.
  - The canonical header bytes are byte-identical to mailauth's own (built with `mailauth/lib/dkim/header`; body hash with `mailauth/lib/dkim/body`).
  - Body hash (`bh=`) matches on 14/14.
  - Every tamper fails (a: edit a signed header, b: swap the key, c: drop a signed header, x: edit `x=`), plus the F6 set.
  - Oversigning is common: `cc` in most signatures, and many absent names in mail.ru's signature.
  - Ed25519 is coded but untested (no samples).
- **Record fields stored:**
  - `v`, `captured`
  - `dkim_signature` (base64, raw)
  - `tags`: d, s, a, c, h, bh, l, t, x
  - `signed_headers`: base64 raw lines in hashing order (RFC 6376 §5.4.2, bottom-up; names in `h=` with no matching header are oversigned and add nothing)
  - `key`: {k, p}
- **Decision:** GO. The record format of PRD §4 is viable as specified.
- **Affects:** PRD §4, §6, M0.

## F2 — Decision: `x=` / `t=` are judged as of capture time

- **Date:** 2026-10-31
- **Question:** against which clock is signature expiry (`x=`) and timestamp (`t=`) judged?
- **Run:** the F1 set. 4 of the 14 signatures (google.com, corp.mail.ru x2, lists.camaraproject.org) carry `x=`, and it is only days ahead. Judged against "now", all 4 already fail on the day of analysis.
- **Result:** judging against "now" would turn every Google/mail.ru record into a fail within about a week, however valid it was when received.
- **Decision:**
  - `recheck(rec, { at })` defaults `at` to `rec.captured`.
  - It also returns `expires` and `expired_now` for information.
  - A signature expired at `at` fails; a `t=` more than 300 s after `at` fails; an unparseable or missing `captured` fails closed (see F6).
  - mailproof must stamp `captured` itself at capture. The `Received:` date is set by the receiving server, so it is not a trusted source.
  - OTS is what makes "captured no later than T" provable.
  - Limit: a caller can pass any `at`. `recheck` proves "valid at time T", not "captured at T".
- **Affects:** PRD §4, §6, M0.

## F3 — Sent copies are unsigned

- **Date:** 2026-10-31
- **Question:** does a mailbox's Sent copy carry the provider's DKIM signature?
- **Run:** 4 msn.com Sent copies, header inspection.
- **Result:** 0 `DKIM-Signature` headers and a single client-submission `Received:` on all 4.
- **Decision:** confirms PRD §5. Own sent records are `unverified`; the strong proof is the counterparty's signed reply. A Gmail-address Sent copy is not tested yet (M1).
- **Affects:** PRD §5, M1 POC, §12 Q4.

## F4 — Outlook/Exchange mail exported via Thunderbird has altered bodies

- **Date:** 2026-10-31
- **Question:** does the same pipeline work on Outlook/Exchange-sourced mail?
- **Run:** `poc/m0-header-recheck.js` on 8 files with 11 signatures (dhlecommerce.nl, uzsc.onmicrosoft.com, venmo.com, amazonses.com x3, email.meta.com, tello.com, infotip.eu, email.apple.com).
- **Result:**
  - Microsoft's `Authentication-Results` says `dkim=pass`, yet mailauth reports "body hash did not verify" on 11/11, and `matchBody` fails 11/11.
  - Headers are intact: the offline re-check passes 11/11 at capture time (the one `x=` signature, dhlecommerce.nl, fails "now" as expired), and all tampers fail.
  - Ruled out: LF-only line endings, QP soft breaks, trailing CRLF, whitespace.
  - The cause is not found. The mail was altered somewhere between Exchange and the export.
- **Decision:** `matchBody` is unreliable for mail synced that way. M1 stays Gmail-first. An Outlook source needs its own POC.
- **Affects:** PRD M1, §4 (body-match / "full proof").

## F5 — Side note: addypin mail has no proof value

- **Date:** 2026-10-31
- **Observation:** mail from the owner's addypin server claims `From:` a gmail.com address but has no DKIM, and SPF softfails.
- **Decision:** none for mailproof. addypin should fix its sending domain/signing.
- **Affects:** nothing in the PRD.

## F6 — Negative scenarios

- **Date:** 2026-10-31
- **Question:** does every way of breaking a record make the re-check fail (and fail closed)?
- **Run:** same script and sample sets as F1/F4, run on every signature (14 Gmail, 11 Outlook-sourced). Each case must fail; nothing passes that should fail.

| ID | Case | Expected | Gmail set (14) | Outlook-sourced set (11) |
|---|---|---|---|---|
| a | edit a signed header value | fail | 14/14 fail | 11/11 fail |
| b | swap in a generated key | fail | 14/14 fail | 11/11 fail |
| c | drop a signed header | fail | 14/14 fail | 11/11 fail |
| x | edit `x=` in the signature | fail | 4/4 fail | 1/1 fail |
| d | key replay: real archived key of a different d= from another sample | fail | 14/14 fail | 11/11 fail |
| e | flip one base64 char of `b=` | fail | 14/14 fail | 11/11 fail |
| f | swap two entries of `signed_headers` | fail | 14/14 fail | 11/11 fail |
| g | `matchBody` with another email's raw: fail; with its own raw: pass | fail / pass | 14/14 fail; 14/14 pass | 11/11 fail; own fails 11/11 (F4) |
| h | `at` after `x=` (expired) / `at` before `t=` minus 300 s | fail | 4/4 expired; 14/14 future-`t=` fail | 1/1 expired; 10/10 future-`t=` fail |
| i | `captured` missing, null, empty or garbled | fail closed | 14/14 fail | 11/11 fail |

- **Result:** 0 negatives pass. Both sets stay consistent with F1 and F4. The Outlook-sourced set is INCONCLUSIVE on live agreement (0 live passes, from the body alteration), so only its negatives count; the header-side cases behave the same as on the Gmail set.
- **Decision:** the M0 GO rule now includes d-i. Fail-closed on a bad `captured` is part of the contract.
- **Affects:** PRD §6.
