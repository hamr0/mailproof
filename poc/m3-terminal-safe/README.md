# POC: terminal-safe printing for CLI text output (branch-review blocker H1)

**Question.** `mailproof list/show/replies` print untrusted mail fields raw. Which code points must a single `printable(s)` make
visible, where must it be applied, and does it mangle real mail? Shape (owner-preferred): sanitise at print, CLI text mode only;
proofs, index and `--json` unchanged; `show --raw` stays raw; dangerous characters are escaped, never dropped.

**Privacy.** The attack corpus is synthetic (`example.*`). Real mail (`~/mailproof-m0-samples*`, `~/mail-samples/m2-replies`,
`~/mail-samples/m3-replyfacts`) is only run through a scratch trail (worker size 0, no OTS; `M3_SCRATCH` or `os.tmpdir()`, removed
in `finally`). Only counts and code-point classes are printed. Nothing real is written here.

**Files.** `printable.mjs` (candidate helper: pure, stdlib, also exports `dangerousIn`, `FORBIDDEN_AFTER`), `run.mjs` (attack
corpus assertions, `--json` check, real-mail counts, bench).

**Re-run.** `node poc/m3-terminal-safe/run.mjs` (exits non-zero if an assertion fails).

## Escape set (escaped = shown as an escape; everything else is kept)

| Class | Why |
|---|---|
| C0 0x00-0x1F incl. TAB, LF, CR | ESC/BEL/BS/NUL drive the terminal; LF/CR forge a second line. Single-line fields escape all (`\n \r \t`). `keepNewline` keeps LF for multi-line blocks. |
| DEL 0x7F | some terminals act on it; JSON leaves it raw |
| C1 0x80-0x9F | 0x9B is CSI, 0x9D OSC, 0x9C ST on terminals in 8-bit mode; includes U+0085 NEL |
| bidi U+061C, 200E/200F, 202A-202E, 2066-2069 | reorder a domain or address visually (Trojan Source style) |
| U+2028, 2029 | Unicode line/paragraph separators |
| U+200B, 2060-206F, FEFF, 00AD, 034F, 180E, 17B4/17B5, 115F/1160/3164/FFA0 | zero-width or blank-rendering: two addresses that look identical |
| U+FE00-FE0D, E0100-E01EF, tags E0000-E007F | variation selectors and tag characters used to smuggle invisible text (FE0E/FE0F kept: emoji presentation) |
| noncharacters FDD0-FDEF, FFF9-FFFF, lone surrogates | never valid text |
| backslash | the escape marker, so output is unambiguous (`\\`) |
| **kept**: ZWJ U+200D / ZWNJ U+200C between two non-ASCII characters | emoji sequences, Persian/Arabic/Indic text. Next to ASCII or at an end they are escaped. |
| **kept**: NBSP, U+2000-200A spaces, private use, all letters, emoji, CJK, RTL letters | normal text; homoglyphs (Cyrillic `a`) are out of scope |

Format: `\n \r \t`, `\xNN` (<0x100), `\uNNNN`, `\u{NNNNN}`, `\\`. Round trip is exact (the corpus test decodes the escapes back to
the input). Option `max` cuts to N code points then appends `...(+N)` (for 100,000-char lines).

## Results

1. **Attack corpus: 18/18 pass** (cursor-up+erase overwrite, OSC title with BEL and ST, OSC 8 link, CSI 0x9B, C1 OSC/ST, bidi
   override on a domain, RLO/isolate address spoof, ZW chars, ZWJ/ZWNJ beside ASCII, soft hyphen/BOM/filler, tag characters, NUL/BEL/
   BS/FF/DEL, CRLF-forged second line, U+2028/2029/0085, lone surrogates, a literal `\x1b` text, 100k-char line). Each asserts no
   forbidden code point remains and that undoing the escapes returns the input exactly. 10/10 legit non-ASCII samples are unchanged.
2. **Real mail (40 distinct files, 12 replies):** 400 fields checked, **0 of the 361 fields the CLI prints (or would print) changed**
   (address, from/to/cc, display names, subject, message_id, parent/child ids, attachment filenames, replyFacts from/subject/to/cc/
   firstLine); 29 fields held non-ASCII. An extra stress run over the 39 decoded text bodies changed 10 (not CLI fields): U+0009 x48,
   U+2066 x4, U+2069 x4 (Gmail wraps names in LRI...PDI in quoted attributions; `firstLine` strips quotes, so it was clean).
3. **`--json`:** JSON.stringify escapes C0 and lone surrogates only. It leaves raw: DEL, all 32 C1 (incl. 0x9B), bidi (202A-202E,
   2066-2069, 200E/200F, 061C), ZW (200B-200D, 2060-2064), FEFF, U+2028/2029, tag characters. So the claim "--json is safe" holds for
   ESC (C0) but not for C1 CSI/OSC on 8-bit terminals or bidi when a person `cat`s it. Consumers must treat the strings as untrusted.
4. **Cost:** 2.1 us/op (clean, mean 63 chars, 10,000 fields), 2.6 us/op with 10% dirty, 13.5 ms for a 1 MiB field; 10,000 fields
   cost about 21 ms.

## Sinks (src/cli) that can carry mail- or server-derived text

Mail fields (apply `printable` per field): `ops.js:46` (message_id), `:71` (from; `:70` message-id, `:72` copy.kind/verdicts are closed
sets), `:77` (attachment filename), `:79` parent message_id, `:80` child message_id, `:97` (signature `d`, `s`, `why`: signature
header values), `:98` (`v.error`), `:111` (r.from, plus r.captured/r.link/r.live: use the helper on all string fields), `:112`
(firstLine, after `cut`), `:128` (`JSON.stringify(f.got)`: attacker value, and JSON leaves C1/bidi, so wrap in printable).

Server-derived (IMAP server and git/tar errors): `sync-op.js:57` (folder name from LIST, `f.error`), `misc.js:29` (folder, code,
message), `watch.js:60-72` (`line` built from `message`) printed at `watch.js:80` and written by `appendWatchLog` (`watch.js:78`, a
file people `tail`), `watch.js:81`, `run.js:101-102` (`report`: any error message, UsageError echoing argv), `backup.js:94,99,121,140-
141,153-157` (git/tar stderr, paths), `status.js:88` plus `statusText` (user, trail path, lastSync.error, backup path), `ops.js:186-187,206`
(prune: cutoff, backup path, `short(...)`), `menu.js:55` (library error text), `prompt.js` `askValue` echoes validator messages that
quote typed input, `wizard.js:104` (JSON of typed values).

Not sinks: `show --raw` (`ops.js:59`) stays raw by design; generated help (`help.generated.js`) is static text from `commands.js`.

**Recommended shape:** per-field `printable()` at the mail-field sinks above, plus defence in depth in `session.js`: `print` and
`warn` (the single exit for almost every line) run the text through `printable(s, { keepNewline: true })`, so a sink missed today
cannot reach the terminal. `ctx.stdout.write` direct calls (`run.js` help, `misc.js:71` template, `ops.js:59` raw) stay as they are.
Direct writes in `prompt.js`/`menu.js` (`out.write`, `err`) need the same treatment or to be routed through `print`/`warn`.

## Owner decisions
- Escape backslash as `\\` (unambiguous but doubles Windows paths in text) or leave it alone (ambiguous when a mail carries a literal `\x1b`)?
- Keep ZWJ/ZWNJ only between non-ASCII (proposed), or escape always (never mangles, but shows `‌` inside Persian words)?
- Does `--json` get a documented note only (owner's current choice), given C1/bidi pass through it?
