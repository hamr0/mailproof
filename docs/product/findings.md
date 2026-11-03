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
- **Decision:** confirms PRD §5. Own sent records are `unverified`; the strong proof is the counterparty's signed reply. A Gmail-address Sent copy is not tested yet (M1). **Closed (owner, 2026-11-01): moot.** Own sent records are `unverified` regardless (F3); the proof of sending is the counterparty's signed copy, and Gmail does sign outbound from the owner's gmail.com address (the batch-3 gmail.com-signed message, F11).
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
- **Decision:** none for mailproof. addypin should fix its sending domain/signing. *Update: mail sent `From:` the app's own domain is signed and verifies, see [F12](#f12--addypin-and-ownsub-mail-is-now-signed-by-its-own-domain).*
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

## F7 — M0 design decisions

- **Date:** 2026-11-01
- **Question:** what shape does the M0 implementation take where the PRD left forks open?
- **Decisions:**
  - **D1 Portable verdict is DKIM only.** `trustedSealers` (constructor option, default `[]`) gates only the live `forwarded` level. Offline re-check of ARC seals needs archived ARC headers and sealer keys, an unproven mechanism, so it is a separate follow-up POC. **Open follow-up (owner, 2026-11-01): portable ARC (the trusted-sealer offline re-check) is missing and needs its own spec and POC before it is built; tracked in PRD §12 Q10 (design notes for it in [F13](#f13--gitdone-phase-0-samples-corroborate-f10)).** **Sample gathering closed (owner, 2026-11-01).** The samples so far carry Gmail/Microsoft ARC seals, but none has DKIM broken while ARC passes. Portable ARC stays deferred to its own spec + POC (PRD §12 Q10, still open), which will create its own test cases (e.g. a synthetic ARC-sealed relay via mailauth's `arc` sealing).
  - **D2 Stored fields.** `raw_sha256` and attachment `filename` are kept in the record (dedupe/match value; the trail owner's own data, like `Subject`).
  - **D3 Key stored twice.** Embedded in the record (`{k,p}`, so it verifies standalone) and in the trail key archive (provenance: TXT as fetched, lookup name, time).
  - **D4 Second capture of the same email** returns `duplicate:true` and writes nothing; its ctx is not kept. *Reversed by owner 2026-11-01: one record per distinct copy (raw-bytes id) + `message_key` grouping + `copy.kind`. A captures-log idea was rejected because relayed copies collided with direct ones (same `b=`, so the first to arrive hid the other's body status and verdicts). The same bytes captured again are still a no-op.*
  - **D5 OTS** stamps per record in M0; per-sync batching is an M1 decision.
  - **D6 SPEC** gets a new Part B for v2 on top of the v1 text; v1 sections are archived at M3.
- **Record id (changed 2026-11-01; F7 first said `b=`-based):** `id` = first 32 hex of the raw bytes' sha256 (`message.raw_sha256`), so every distinct copy is its own record. The old `b=`-based rule survives as `message_key` (`sha256("mp2\n" + identity)[0:32]`, `identity` = the first DKIM-Signature's raw `b=`; unsigned mail: its Message-ID hashed, else null), which groups the copies of a signed message. `copy.kind` (`direct`/`relayed`/`forward`/`unknown`) marks the route; "original" is derived across copies (the earliest `direct` copy with body `matched`), never stored.
- **Observation:** DMARC passes whenever aligned DKIM passes, by definition. So "DMARC must pass if the domain publishes it" (PRD §3) differs from "aligned DKIM pass" only on DMARC errors (temperror/permerror), where mailproof fails closed. This is why the portable verdict needs no DMARC input.
- **Affects:** PRD §3, §4, M0; SPEC Part B.

## F8 — M0 library on the real sample sets

- **Date:** 2026-11-01
- **Question:** does the rewritten M0 library (not the POC) agree with live mailauth on real mail, and does every F6 negative still fail?
- **Run:** `tests/manual/real-mail.mjs` (public API: `record` into a trail outside the repo, then `verify`/`matchBody` and the F6 tampers on each signature) over the same two sample sets as F1/F4. Captured = the run time (2026-11-01), so `x=` is judged as of that day.
- **Gmail set** (9 emails, 14 signatures: ietf.org x10, corp.mail.ru x2, google.com, lists.camaraproject.org): offline agrees with live on 14/14 (10 pass/pass; the 4 signatures carrying `x=` are expired by the capture date, so live and offline both fail them). `matchBody` own-raw passes 14/14, other-raw fails 14/14. Negatives a, b, c, e, f, x, d, h, i: all fail (0 pass). Live/portable trust per email: 5 verified/verified, 4 unverified/unverified (the 4 expired).
- **Outlook-sourced set** (8 emails, 11 signatures: dhlecommerce.nl, uzsc.onmicrosoft.com, venmo.com, amazonses.com x3, email.meta.com, tello.com, infotip.eu, email.apple.com): live DKIM 0/11 (body altered, same as F4), so live agreement is n/a(body) on 11/11; `matchBody` own-raw fails 11/11 (F4). Header side: offline passes 10/11 at capture (dhlecommerce.nl is `x=`-expired); all negatives fail (0 pass).
- **Observation:** on the Outlook-sourced set the portable verdict is `verified` for 6 of 8 emails while the live verdict is `unverified` (body altered). That is by design: the portable verdict covers the signed headers only, and the body claim is separate (`matchBody` / `full`). A consumer that wants a body guarantee must call `matchBody`.
- **Decision:** none; the library reproduces F1/F4/F6. M0 go/no-go stays GO.
- **Affects:** PRD §6, M0.

## F9 — Body status on the real sample sets

- **Date:** 2026-11-01
- **Question:** with the body result as its own field (`body_status`, `signatures[].body`), what do the detectors say about the Outlook-sourced body alteration (F4), and do they stay quiet on clean mail?
- **Run:** `tests/manual/real-mail.mjs` (extended to print body status and explain kinds, domains and counts only) on the Outlook-sourced set (8 emails, 11 signatures) and on `mailproof-m0-samples-gmail2` (9 emails, 14 signatures).
- **Gmail set (second):** `matched` on 14/14 signatures, `explain` empty, record `body_status` `matched` 9/9. No detector fired on clean mail (ietf.org lists, corp.mail.ru, google.com, lists.camaraproject.org). Synthetic tests cover the cases that MUST fire (appended, prepended, `l=` partial, canonicalisation, line endings, ARC + List-Id hints) and must NOT fire (clean, sealed-but-clean, edit in the middle).
- **Outlook-sourced set:** `mismatch` on 11/11, record `body_status` `mismatch` 8/8, trust verdicts unchanged (6 `unverified/verified`, 2 `unverified/unverified`). Explanation: `unknown` on all 11. No appended or prepended content at a line boundary (the 2 emails that hit the work cap, infotip.eu and amazonses.com, are the large ones). One email (uzsc.onmicrosoft.com) carries ARC seals from microsoft.com with chain result `fail`, reported as a `forwarded` hint only.
- **What the alteration is: unknown.** Extra probes (a throwaway script, not kept) on the same files, each tested against `bh=`: mbox `>From` unquoting, LF/CRLF both ways, trailing whitespace, tabs to spaces, the other canonicalisation, trailing/leading blank lines, base64 re-wrap at 60/64/72/76, quoted-printable re-encode, dropping up to 40 lines at either end, Microsoft SafeLinks rewriting (0 occurrences). None matches. The mail is multipart with encoded parts (so a banner or footer would sit inside a part, not at the body edge) and the one single-part email (tello.com, `7bit` HTML, signed `Content-Transfer-Encoding`) fails too, so the change is inside the content. Hypothesis not yet testable without the original bytes: a content rewrite between Exchange and the export. *Update: narrowed to the Microsoft side, see [F10](#f10--the-outlook-body-alteration-happens-on-the-microsoft-side-not-in-thunderbird).*
- **Decision:** ship the field and the detectors; the Outlook cause stays an open item. M1 stays Gmail-first (F4).
- **Affects:** PRD §4, SPEC Part B1.
- **Copy kinds on the real sets (added with the per-copy ids; revised for `digest`):** Outlook-sourced set: 8 emails, 8 distinct `message_key`s, `direct` 7 / `relayed` 1 (the microsoft.com ARC-sealed one). Gmail set (second): 9 emails, 9 distinct keys, `relayed` 4 (corp.mail.ru x2, google.com, lists.camaraproject.org: List-Id or ARC) and `digest` 5 (all the ietf.org list messages). The first version labelled those five `forward` because they carry 2-3 `message/rfc822` parts each; they are Mailman digests (top-level multipart/mixed, List-Id, inner messages, no `Fwd:` prefix), so the owner added `copy.kind: digest` (precedence: Subject-prefix forward, digest, attachment forward, relayed, direct, unknown). The `attached_original` links stay on digests, and `copies()` lists them under `contained_in` (renamed from `forwards`, since a digest is not a forward). The inner originals (gmail.com, ietf.org, pingidentity.com, chinamobile.com and others) came back `dkim: fail` at capture with body `matched` (`partial` for chinamobile.com): the headers as embedded in a digest do not verify.

## F10 — The Outlook body alteration happens on the Microsoft side, not in Thunderbird

- **Date:** 2026-11-01
- **Question:** F4/F9 found Outlook-sourced mail with altered bodies after a Thunderbird export. Is Thunderbird the cause?
- **Run:** `tests/manual/real-mail.mjs` on batch 3 (7 emails, 8 signatures, domains only). None are Thunderbird exports (0 `X-Mozilla` headers): they were downloaded directly from Gmail web and Outlook web. `RESULT: OK`, 0 negatives passed, 0 live/offline disagreements.
- **Result:**
  - Received at Outlook/Exchange (`*.PROD.OUTLOOK.COM`), downloaded from Outlook web: 3 forwards (comcast.net x2, one gmail.com-signed). All 3 body `mismatch`, explain `unknown` (one hit the search cap). Live is neutral (body hash); the offline header recheck passes.
  - The gmail.com-signed one is the telling case: that signature matches 14/14 when received at Gmail, but fails the body when received at Outlook.
  - Received at Gmail (`mx.google.com`): 4 emails (msn.com-signed forward sent from the owner's Outlook, ietf.org digest x2 signatures, addypin.com, ownsub.com). 4/4 `matched`, live pass. Mail sent *from* Outlook and received at Gmail matches.
- **Decision:** this narrows F9: the alteration is not Thunderbird. Updated cause: Exchange at or after receipt, or Outlook web's export. We still cannot tell receipt-time rewriting from export-time re-serialisation without raw bytes over IMAP; an Outlook IMAP POC in M1 would settle it.
- **Implication:** Outlook-hosted mailboxes give header proof only. Body proof needs mail received at Gmail or at our own MTA (M5).
- **Affects:** PRD M1, §4 (body-match / "full proof").
- **See also:** [F13](#f13--gitdone-phase-0-samples-corroborate-f10) (two more Outlook-received downloads fail the same way).

## F11 — Threading and recipient signing differ by provider

- **Date:** 2026-11-01
- **Question:** are `In-Reply-To`/`References` (and `To`) in the signed `h=` list? (PRD §12 Q2)
- **Run:** header inspection of the batch 3 signatures.
- **Result:**
  - **gmail.com** (selector 20260707) signs `in-reply-to` and `references`, along with from, to, cc, subject, date, message-id, reply-to and content-type.
  - **msn.com** (selector1, Outlook) signs only `From:Date:Subject:Message-ID:Content-Type:MIME-Version:X-MS-Exchange-SenderADCheck`: not `To`, not `In-Reply-To`, not `References`.
- **Decision:** Q2 is answered: yes for Gmail, no for Microsoft.
- **Implication (design note for M3, not implemented):** replies are matched to requests by threading (PRD §5). A reply from a Microsoft-hosted sender has an unsigned threading link and an unsigned recipient. The match is then evidence by Message-ID quoting, not by signature, and the record/verdict should be able to say whether the threading link is signed.
- **Affects:** PRD §5, §12 Q2, M3.

## F12 — addypin and ownsub mail is now signed by its own domain

- **Date:** 2026-11-01
- **Observation:** weekly stats from addypin.com (selector addypin2026) and ownsub.com (selector default) verify: `matched`, live pass. The F5 failing mail claimed `From:` a gmail.com address; mail sent `From:` the app's own domain is fine.
- **Decision:** none for mailproof; updates F5.
- **Affects:** nothing in the PRD.

## F13 — gitdone Phase-0 samples corroborate F10

- **Date:** 2026-11-01
- **Question:** do the gitdone Phase-0 samples (gitdone-owned) agree with F10?
- **Run:** `node tests/manual/real-mail.mjs ~/PycharmProjects/gitdone/poc/phase0` on 4 files, read in place and never copied. `RESULT: OK`, 0 negatives passed, 0 disagreements.
- **Result:**
  - **from-msn:** msn.com-signed, received at Gmail. Live pass, body `matched`, kind `relayed` (ARC i=2, sealers google.com + microsoft.com; DKIM also passes).
  - **sample** (algorithmwatch.org, mailing_list) and **sample1** (ab.mtasv.net + boardy.ai): both received at Outlook (`*.eurprd02.prod.outlook.com`), no Thunderbird markers. Body `mismatch`/`unknown` on 3/3 signatures. Their `x=` has since passed, so offline at today's capture time gives `fail(expired)`, consistent with F2.
  - **from-gm:** 0 DKIM signatures and no provider `Received` header. Origin unknown, so a hint only, consistent with F3.
- **Decision:** Outlook-received mail now fails `bh=` in 5/5 independent downloads (F10's 3 plus these 2); Gmail-received mail matches every time. F10 stands.
- **Notes for the future ARC spec (PRD §12 Q10), from gitdone:**
  - mailauth's `auth.arc.authResults` is a rendered header string, not an array. gitdone shipped a "chain length 476" bug by calling `.length` on it; use `auth.arc.i` for chain depth.
  - Offline ARC re-check needs the sealers' keys archived at receipt, the same as DKIM.
- **Affects:** PRD M1, §4; PRD §12 Q10.

## F14 — One admission gate bounds input cost; our own search needs a per-message budget

- **Date:** 2026-11-01
- **Question:** can one linear pre-scan (`poc/admit-gate/`) replace the scattered input caps and close the mailauth long-line hole?
- **Run:** admit() over the complexity generators plus long-line bodies; the real check() just under each limit; 37 real samples read in place, never copied.
- **Result:** admit() is linear (1.85-2.16x per doubling over 6 and 12 MiB, on six shapes that make it read every byte; 1.2 ms on an ordinary 1 MiB message, 29 ms on 25 MiB, 237 ms on the worst shape, 25 MiB of CRLF-only lines). It closes the mailauth hole (a 1/2/4/8 MiB one-line body with a matching `bh=`: 109/244/708/2473 ms of CPU; refused as body_line in 3/6/13/25 ms). 37/37 real samples admitted with at least 5x headroom (signatures 5.0x, h= names 6.9x, header fields 11.9x, MIME delimiter lines 11.8x, header block 15.1x, header lines 18.9x, signature field 18.6x, total size 23.9x, body line 261x). Super-linear classes below the old caps forced tighter limits (256 KiB header block, 4000 header lines, 200 MIME delimiter lines, 16 KiB per signature field, 256 KiB body line). Not bounded by the gate: the body-status mismatch search ran per signature, so 10 valid signatures on a tampered body cost 2.8-7.9 s of CPU on admitted input (the six shapes of `tests/helpers/worst-cases.js`: 2765, 3490, 5060, 7884 and 6281 ms, and 109 ms for the 190-name `h=` shape); mailauth alone costs 8-160 ms. With one per-message budget, and a prepended search that hashes views of one buffer instead of rebuilding each suffix, the same shapes cost 215, 450, 368, 301 and 1212 ms (65 ms). Also measured, not fixed: our own first body-hash pass runs once per signature (mailauth shares one pass), so a 24 MiB message with 10 valid signatures costs 3.5 s against 1.9 s with one (4.2 s tampered); and the total-size case is linear in BYTES only at a fixed line width: about 75 ms a MiB of 76-column lines, so a 25 MiB base64 message costs 1.3-1.8 s through the real check(). **Correction (2026-11-02):** that per-MiB figure was measured on one line width. The cost has two parts, per byte (about 75 ms a MiB) and per LINE (mailparser's text conversion, our line canonicalisation and the GC, about 3 µs a line): 4 MiB of 76-column lines (55,000 lines) 0.73 s; 1/2/4 MiB of one-byte `a\r\n` lines (0.35M/0.7M/1.4M lines) 0.85/2.1/4.0 s; 23 MiB of them with 10 signatures 43 s and 1.3 GiB RSS. The gate bounded bytes and line length but not line count, so `MAX_BODY_LINES` = 500,000 now does (a 25 MiB base64 message is about 345,000 lines and is admitted; the largest real message has 14,200), and the worst admitted shapes are in `tests/helpers/worst-cases.js`. The line count also exposed a driver that the earlier "our own first body-hash pass is linear" note missed, because it was measured on CRLF bodies only: on a body of bare LFs mailauth's relaxed hasher builds a subarray per line (about 1.4 µs a line), and we run it once per signature, so 10 signatures on 500,000 one-byte bare-LF lines cost 14-21 s (15.7 s for `a\n`, 21.0 s for empty lines; the CRLF equivalent 0.8 s and 0.35 s). The body is now converted to CRLF once per message before the `relaxed` hashers (relaxed only: `simple` hashes a bare LF as is, so the copy changes its digest), proven identical to hashing the original on 480,000 fuzz cases and every real sample, and the same shapes cost 3-4 s on a machine at load 12-15 (the rest is the mismatch searches under the shared `MAX_WORK` budget, which no longer grows with the signature count). A cache keyed on (`c=`, `a=`, `l=`) was rejected: ten signatures with ten distinct `l=` values would bring ten passes back.
- **Decision:** all bounds live in src/proof/limits.js; the gate is the single admission point; over-limit mail is recorded unverified with the limit named, never parsed. >10 signatures rejects the whole message. Total size capped at 25 MiB. body-status gets one per-message work budget, kept at the old per-signature 64 MiB because a smaller one changes what real mail is explained as: 13 of the 37 real messages run the mismatch search, and the largest needs 54, 36, 23, 23 and 14 MiB to finish (two more need 100 and 679 MiB and were already capped); a 16 MiB budget turned one real `unknown` into `search_capped` and changed the stored `max_work_bytes` of every capped record. The 256 KiB body-line limit is accepted on a small (37-message, QP-wrapped consumer) corpus; revisit if legitimate unwrapped HTML mail is rejected. The v1 64 KB ingest window is not an admission limit.
- **Affects:** src/proof/limits.js, admit.js, signed-headers.js, body-status.js, mailproof.js, record.js, recheck.js, copy.js.

## F15 — A worker-thread deadline bounds what the gate has not measured

- **Date:** 2026-11-02
- **Question:** the gate bounds only measured dimensions, and six review rounds each found another unmeasured cost driver on untrusted mail. Can a backstop bound the rest, without changing a single result and without leaving partial state? (`poc/worker-deadline/`)
- **Run:** the build half in a warm worker, killed from the main thread; real samples read in place (37 messages); the 26 worst-case shapes of `tests/helpers/worst-cases.js`; synthetic runaways (CPU loop, catastrophic regex, external-memory loop, JS-heap loop) on the real pool; queueing; the installed package.
- **Result:**
  - *Kill works.* POC, on the tree before the body-line gate: a 25 MiB body of 1-byte lines (47.7 s in-process, event loop blocked throughout) was killed at 3.2 s with a 3 s budget; loop, regex, spin, heap and alloc all killed, one commit each, `git fsck` ok, no lock left, the pool recovered for the next message, longest event-loop gap 288 ms. Final: CPU loop and regex killed at 15.1 and 15.2 s of default budget, RSS 59 to 67 MB, loop gap under 10 ms.
  - *Identical results.* 37/37 real messages give byte-identical `check()` (with and without envelope), `record()` and stored-record JSON, and the same 30 archived key files, as HEAD 5919a5c, in a worker and with `size: 0` (DNS replayed from one capture; `trail` and commit ids ignored).
  - *CPU time, not wall time.* Wall time of one message stretches with machine load, CPU does not (as much): at load 20-30 the three body-line ceilings measured 6.6 s vs 6, 10.2 s vs 8 and 8.3 s vs 8 for work that costs 0.4 to 1.9 s of CPU on a quiet machine. A wall deadline sized to the idle cost would kill legitimate mail exactly when the machine is busy. So the deadline is the worker thread's own CPU (`Worker#cpuUsage`, 15 s); wall time survives only as a 120 s cap on busy time (DNS waits subtracted), for a job that hangs without burning CPU.
  - *Headroom.* Worker-thread CPU, idle-ish machine: the 37 real messages 707 ms at most (largest 1 MB); the worst-case shapes 1977 ms at most (24 MiB with 76-column lines), then 1865 ms (10 tampered signatures on 500,000 bare-LF lines) and 1682 ms (10 keyless signatures, same lines); a 24 MiB signed base64 message 1.7 to 2.3 s. So 15 s is 7.6x the worst measured, and no real sample or worst-case shape comes within 3x (5 s).
  - *Memory.* Peak worker heap + external: real samples 64 MB, worst-case shapes 347 MB (24 MiB messages 234 to 249). Threshold 1,536 MB (4.4x). Measured per worker thread (`Worker#getHeapStatistics`, which also answers while the worker spins) rather than process RSS, which counts the host program and every other worker: an RSS threshold would either kill everything in a big host or never fire in a small one. External-memory runaway (1 MiB Buffers in a loop, invisible to V8's heap limit): killed at 703 ms, process RSS 59 MB before, 1,620 MB peak, 61 MB 3 s after, longest event-loop gap 6 ms (the POC left 4.8 GB held; it had only V8's heap limit). JS-heap runaway: V8's own limit (set to the same value) and the CPU deadline end it; GC thrash near the limit makes it slow (killed at 16.9 s, RSS peak 1,677 MB, 144 MB 3 s later, one 2.5 s event-loop stall while the worker's GC threads competed on a loaded machine). That is a bounded, not a prompt, stop.
  - *Queueing.* The clock starts when a worker starts the job. 8 concurrent signed 24.6 MiB base64 messages through one worker: all 8 verified, no timeout, 15.5 s to drain (1.9 s each); 10 messages 19.5 s. The same holds for the wall cap (a test queues five jobs behind a 2.5 s DNS wait with a 1 s busy budget).
  - *Cost.* Warm: about the same as in-process (median 5.3 vs 4.5 ms for a small signed message at load 9; 10.5 to 11.6 vs 7.7 to 14.3 ms at load 5 to 8). The first call starts a thread that loads mailauth and mailparser a second time: first check 0.83 s vs 0.26 s in-process; a whole one-mail process 1.41 s wall and 2.1 s CPU with the worker vs 1.04 s and 1.4 s in-process (load 9). Before the main thread stopped loading the parsers itself it was 2.3 s in-process vs 3.7 s with the worker (load 7). A caller that handles one mail per process pays that every time and should use `size: 0`.
  - *Found on the way.* A worker inherits the process's `execArgv` (`--input-type` made it fail to start), so the pool passes `execArgv: []`. The Node floor: `Worker#cpuUsage` exists from 22.19 (24.6), `Worker#getHeapStatistics` from 22.16, so `engines` is 22.19.
- **Decision:** on by default, one warm worker, deadline = 15 s worker CPU plus a 120 s busy-wall cap, memory 1,536 MB; opt out with `worker: { size: 0 }`. The killed message goes through the over-limit path (`over limit: time` / `over limit: memory`), accept-with-flag intact. A worker that dies for a reason the pool cannot name (not a limit, not an error of the build) is recorded as `over limit: crash`, unverified: accept-with-flag holds even for a message that deterministically crashes its worker (it first rejected the call, which would have lost the message). An Error of the build still rejects, as in-process. The gate remains the deterministic first line; limits are not loosened because the backstop exists.
- **Affects:** src/proof/build.js, over-limit.js, worker.js, pool.js, limits.js, mailproof.js, package.json (engines), SPEC Part B Limits, README, tests/integration/{worker,worker-pool,complexity}.test.js.

## F16 — M1's IMAP library: adopt imapflow (checklist run); a stdlib client is rejected

- **Date:** 2026-11-03
- **Question:** does `imapflow` pass the AGENT_RULES External Dependency Checklist as mailproof's third (last allowed) runtime dependency, and is a minimal `node:tls` client the better choice? (PRD §7 M1, §12 Q9.) Desk evaluation plus one local run; no Gmail session yet.
- **Run:** `npm view imapflow` (metadata, release times, maintainers); throwaway install in the session scratchpad (not in the repo), `npm ls --all`, `npm audit`, `du`; the install's lockfile diffed against this repo's `package-lock.json`; source of the installed 2.10.0 read for XOAUTH2, `BODY.PEEK[]`, partial fetch and `uidValidity`; a throwaway fake IMAP server (plain TCP, one message mixing bare LF and CRLF with bytes `FF FE 00`) driven by a real `ImapFlow`.
- **Result (checklist, one line each):**
  - *Necessity:* passes. A client for exactly M1 is not under 100 lines (see the stdlib estimate below).
  - *Maintained:* passes, with a caveat. imapflow 2.10.0, last push and release 2026-10-29; 12 releases in 2026-09 and 33 in 2026-10 (296 versions since 2019-12), 2 open GitHub issues. The caveat is churn: a `^2` range will move under adopters weekly, so the lockfile and our tests must be the pin.
  - *Established:* passes. MIT, ~580 GitHub stars, SLSA provenance on the npm tarball. The maintainer is `andris` (Postal Systems / Kreata), the same npm maintainer as `mailauth` and `mailparser`; so it is one maintainer, but already the one on the two deps we trust. This is concentration risk, not new risk.
  - *Security-aware:* passes in favour of a library. The server's literals and responses are untrusted input; the checklist says a vetted library is required for that. The installed parser has explicit bounds (nesting, inline-literal size, token limit) and a `SECURITY.md`. `npm audit`: 0 vulnerabilities.
  - *Lightweight:* **the weak item.** 8 direct dependencies, 24 packages in the throwaway tree (7.7 MB of `node_modules`), 30.7k lines in the package (ESM and CJS copies, plus `.d.ts`). Against our lockfile (61 packages): 7 are already present (`@zone-eu/mailsplit`, `libmime`, `libqp`, `libbase64`, `iconv-lite`, `encoding-japanese`, `safer-buffer`; `libmime` is 5.6.2 here vs 5.6.3 there, which npm would dedupe on install), so **17 are new**, taking the lockfile to about 78 (+28%). Most of the new weight is `pino` (10 packages) for logging we turn off with `logger: false`, and `socks` + `ip-address` + `smart-buffer` for a proxy M1 never uses. These cannot be dropped.
- **Result (can it do what M1 needs):**
  - *Exact raw bytes:* yes. `fetch(range, { uid: true, source: true })` issues `UID FETCH 42:* (UID BODY.PEEK[])` (PEEK: no `\Seen` change). In the local run the returned `source` Buffer was byte-identical (`Buffer.compare === 0`) to a message with bare LF, CRLF and 8-bit bytes; no re-encoding or line-ending change. `source` also takes `{ start, maxLength }`, which maps to `BODY.PEEK[]<start.maxLength>`.
  - *XOAUTH2:* yes. `auth: { user, accessToken }` made the client send `AUTHENTICATE XOAUTH2` (server side confirmed) when the server advertises `AUTH=XOAUTH2`; OAUTHBEARER also exists. Password `LOGIN` is the default with `auth: { user, pass }`. Refresh of the access token is the caller's job (a fresh token per run suits a cron `sync`).
  - *UID resume:* yes. `getMailboxLock(path, { readOnly: true })` selects with `EXAMINE`; `mailbox.uidValidity` (a **BigInt**, `777n` in the run) and `uidNext` come back; `fetch('<lastUid+1>:*', { uid: true })` with the `uid` option in the third argument is a UID FETCH. Note the `N:*` quirk (RFC 3501: `*` always matches the highest message, so `lastUid+1:*` returns the last message when there is nothing new); the caller must drop `uid <= lastUid`. Not exercised here against a real server: `UID SEARCH`, `\All Mail` / label folders, Sent folder discovery via `SPECIAL-USE` (imapflow ships a `special-use` module).
  - *ESM:* the package is CJS with an ESM build; `import { ImapFlow } from 'imapflow'` works and ships `.d.ts` (`types` in its `package.json`), so it fits `checkJs` + `strictNullChecks`. Engines `>=20`, fine for our `>=22.19`.
- **Stdlib alternative (estimate, not built):** `node:tls` connect with verified certificates; tag generator; response reader; `LOGIN` and `AUTHENTICATE XOAUTH2` (base64 `user=..^Aauth=Bearer ..^A^A`, with the `+` continuation carrying an error JSON that must be answered with an empty line); `EXAMINE` + `[UIDVALIDITY]` / `[UIDNEXT]` response codes; `UID SEARCH`/`UID FETCH` with literal parsing (`{n}\r\n` + exactly n octets, which may contain anything, including CRLF and text that looks like a tagged response). Honest size: about 300 to 500 lines plus its own tests, against the "<100 lines" bar of the Necessity item, so it does not qualify as "vanilla". Risk: the literal reader is the untrusted-input surface. It is small and well-defined (count n octets, cap n), and we would own the bound in `limits.js` as for the rest. But it is the exact class of code the checklist forbids rolling by hand, and the long tail is what costs: Gmail quirks (`[THROTTLED]`, `BYE` mid-fetch, folder names in modified UTF-7, `\All Mail` handling, literal8/`LITERAL+` differences, `NO [UNAVAILABLE]`), literal-in-the-middle responses, timeouts and reconnects, and a later IDLE (M6) which is a state machine of its own. The repo's own history (six review rounds on untrusted-input parsing, F14/F15) argues against taking on a new parser. Not a dependency, but not simple either.
  - *Does the dependency still let us bound cost?* The admission gate (F14) is applied after bytes exist in memory. imapflow's `source` buffers the whole literal, so a hostile or huge message costs memory before `admit()` runs. Mitigation (to build and measure in the M1 POC, not proven here): fetch `RFC822.SIZE` first and skip-and-record anything over `MAX_TOTAL_BYTES` as over limit, or fetch with `source: { maxLength: MAX_TOTAL_BYTES + 1 }` so a longer message arrives truncated by one byte and the gate refuses it.
- **Decision:** adopt `imapflow` as the third runtime dependency for M1, behind a thin `src/proof/` (or `src/capture/`) wrapper that is the only importer, with `logger: false`, a TLS-only connection and a read-only select. Reasons: it passes necessity, maintained, established and security-aware; it fails "lightweight" only on count (17 new, transitive, packages), not on any package we cannot trust (0 audit findings, same maintainer as mailauth and mailparser, 7 of its 24 packages already in our tree). A hand-written client trades that for a new untrusted-input parser we would own. The user's tie-breaker (simple, one source of truth) points the same way: one library for IMAP, no second implementation. **If the owner objects to +17 packages**, the fallback is PRD §12 Q9's option: ship IMAP as a separate package (`mailproof-imap`) that depends on `mailproof` and imapflow, keeping the core tree at 61 packages; the core would then have no capture dependency and `sync` would live outside it. We did not pick that now because it splits the CLI/cron entry point from the library. Raise it with the owner as the one product fork.
- **Not verified (do in the M1 POC):** a real Gmail login (app password and XOAUTH2 against Google), TLS to `imap.gmail.com`, the label and `[Gmail]/Sent Mail` folder behaviour, `UID SEARCH`, behaviour on `UIDVALIDITY` change, memory with a large literal, that fetched bytes still verify (the POC question in PRD §7 M1), the dedupe of `libmime` on an actual install, and imapflow's reconnect and timeout behaviour on a dropped connection. The release churn (45 releases in 2 months) was read from the npm `time` map only; whether those are mostly dependency bumps was not checked beyond the last few changelog entries.
- **Affects:** package.json (when M1 starts), docs/product/PRD.md §7 M1 and §12 Q9 (unchanged now), AGENT_RULES dependency ceiling (reaches 3 of 3).

## F17 — M1 Gmail POC: GO (app password, fetched bytes verify, Gmail ARC present); corpus is small

- **Date:** 2026-11-03
- **Question:** PRD §7 M1 and §12 Q3/Q5: does an app-password login to Gmail work, do fetched bytes still verify, and what does Gmail add on inbound? (`poc/m1-imap/`)
- **Run:** `poc/m1-imap/m1-imap-poc.mjs`, imapflow 2.10.0, `secure: true`, `imap.gmail.com:993`, against the owner's real Gmail account, read-only (EXAMINE, `BODY.PEEK[]`; the redacted wire log shows no STORE, APPEND, MOVE, COPY, DELETE or EXPUNGE). Password from `pass` at runtime. The first attempt, from the wrong `pass` entry, failed `NO [AUTHENTICATIONFAILED]` (a wrong credential, not a finding about Gmail); the run below used the right entry and logged in first time. The script ran twice with the same results; the second run added `disableCompression: true` (see Q6). Cap was 30 messages a folder, but **the mailbox is small: INBOX 8 messages, Sent 1** (9 in all). Every number is over those 9, so treat them as existence evidence, not rates.
- **Result:**
  1. *Login (Q3):* `AUTHENTICATE PLAIN` with an app password works over TLS (1.1 to 2.8 s to connect). Gmail also advertises XOAUTH2 and OAUTHBEARER; OAuth was not tested. Google shows an app password in groups of four with spaces; the script strips whitespace. The server enables COMPRESS=DEFLATE and imapflow turned it on by default.
  2. *Fetched bytes verify:* INBOX 8/8 `verified` on both the portable and live verdicts, `body_status` `matched` 8/8; 9 DKIM signatures on 8 messages (every signing domain was outside the well-known list; none printed). `mailauth` called directly on the same bytes agrees with `check()` on 8/8 (DKIM pass, and aligned DKIM with no DMARC fail). That comparison could have disagreed and did not. `RFC822.SIZE` equals the fetched Buffer length on 9/9. One message fetched twice (and read back from the saved file): sha256 identical in all three.
  3. *Sent (Q4 of the plan):* the 1 Sent copy has 0 DKIM signatures, 0 ARC and 0 Authentication-Results headers: `unverified`, body not checked. Consistent with F3 for a Gmail-address Sent folder (n = 1).
  4. *Gmail inbound headers (PRD Q5):* all 8 INBOX copies carry an ARC set (`ARC-Seal`, `ARC-Message-Signature`, `ARC-Authentication-Results`) sealed by **google.com**, each a single hop (`i=1`), chain `pass` per `mailauth` on 8/8; all 8 carry `Authentication-Results` and `Received-SPF` too. The `ARC-Authentication-Results` of 8/8 contains an `spf=` result, and the `Authentication-Results` of 8/8 contains `spf=`, `dkim=` and `dmarc=`. So Gmail's SPF verdict is present inside a validly-signed ARC set, which is the shape a portable SPF claim would need. Observed only, not designed: it is Google's word about what Google saw, trusted only if the sealer is trusted (`trustedSealers` exists for `forwarded`), and it was not checked here that the `i=1` AAR is covered by the ARC-Message-Signature `h=` the way the spec says.
  5. *Resume:* `uidValidity` is a BigInt (`typeof` `bigint`) and `uidNext` is above the highest fetched UID. `UID FETCH <last+1>:*` with nothing new returned 1 message, the last one, and dropping `uid <= lastUid` leaves 0. With one genuinely new UID after `prev` it returned 1 and the filter kept 1. `last+100000:*` returned 1 and the filter left 0. The `N:*` quirk is real on Gmail. `UIDVALIDITY` change was not exercised.
  6. *Size bound:* `RFC822.SIZE` alone costs about 100 bytes on the wire (`UID FETCH n (RFC822.SIZE ...)`: 103 bytes against 28,622 for the full 28,520-byte message, measured with compression off; with COMPRESS on, the figures were 62 and 279, which is why the second run turned it off). `source: { start: 0, maxLength: n }` maps to `BODY.PEEK[]<0.n>` and works: 4096 asked, 4096 returned (prefix identical, 4,200 wire bytes); `size - 1` asked, one byte short returned. So a size-first check and the maxLength+1 trick both work as F16 hoped. **Not proven:** the largest message here is 28 KB, so nothing shows imapflow buffering a multi-megabyte literal, and the early-abort `download()` test is inconclusive (the whole 28 KB arrived before the abort). Memory with a 25 MiB literal is untested.
- **Decision:** **GO** for M1 on Gmail via imapflow with an app password: login, byte-exact fetch, verification agreement with mailauth, resume and the size knobs all worked on a real server and each could have failed. M1's design must account for: (a) filter `uid <= lastUid` after every `N:*` fetch; (b) store `UIDVALIDITY` (BigInt, stringify it) with the cursor and treat a change as a full re-scan; (c) fetch `RFC822.SIZE` first and record over `MAX_TOTAL_BYTES` as over limit without downloading, or use `maxLength: MAX_TOTAL_BYTES + 1`; (d) disable compression or measure with it off, and note that wire bytes are not literal bytes; (e) Sent folder by the `\Sent` special-use flag (found here); (f) Sent copies are unsigned, so they record `unverified` and the proof is the counterparty's copy (F3); (g) Google's ARC set exists on inbound and is worth a follow-up for a portable SPF verdict, a product decision, not made here. Gaps to close before relying on rates: a larger mailbox, a huge literal, a dropped connection, XOAUTH2.
- **Affects:** PRD §7 M1, §12 Q3 and Q5; package.json when M1 starts.
- **Built and run (2026-11-03):** M1 is built (`src/proof/sync.js`, `src/proof/imap.js`, SPEC B4). The public `sync()` was run read-only against the owner's real Gmail account. Run 1: INBOX 5 seen, 5 recorded, all `verified`; Sent 1 seen, 1 recorded, `unverified`; 8.2 s. Run 2: 0 seen, 0 recorded, 1.2 s, so resume works and nothing was recorded twice. The INBOX shrank from 8 to 5 between the POC and the build (the owner moved mail out); a `STATUS` call confirmed 5 messages.
