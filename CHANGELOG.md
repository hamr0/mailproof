# Changelog

All notable changes to **mailproof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Publish status.** `0.0.0` and `0.0.1` were published to npm in May 2026 to
> reserve the `mailproof` name during the scaffold phase. Versions `0.1.0`
> through `0.6.1` are **backdated** to match the P1 lift as it landed on `main` —
> the public API (`create()` / `ingest()` and the verify + trigger surfaces) was
> implemented across those milestones but was never published to npm.
> **`0.7.0` is the first published library release** (the `create()` / `ingest()`
> API + verify/trigger surfaces + shipped TypeScript declarations), cut from the
> `v0.7.0` GitHub release via the trusted-publishing workflow.
> The `0.x` line was the pre-1.0 phase (minor bumps could change API shape);
> **`1.3.0` is the first stable release** — the public API now follows SemVer,
> with breaking changes only in a future major. (`1.0.0`–`1.2.0` were skipped:
> those versions were published and unpublished under this name in 2025 and npm
> permanently reserves a once-published version, so the stable 1.x line starts at
> the first free clean minor, `1.3.0`.) See
> [`archive/v1/docs/DESIGN.md`](archive/v1/docs/DESIGN.md) for the phasing.

## [Unreleased]

### Fixed
- **`export --tar` with an `--out` that does not end in `.tar`** wrote a tar file with no extension that `verify-bundle` then refused (exit 64). The export now writes `<out>.tar` (one name rule in the library, so the MCP `export` too; the result `out`, the printed path and the `they run:` hint name the real file; `.tar` is never doubled), and `verify-bundle` (library, CLI, MCP) recognises a tar file by its `ustar` header, not only its `.tar` name; a regular file that is not a tar is still refused.

### Changed
- **`verifyBundle` records name who and what.** Each `records[]` entry also carries `from`, `to`, `subject` and `subject_signed` (read from the bundle's own record, third-party data; additive, also the MCP `verifyBundle` result). `verify-bundle` text rows now read like `list` (the sender or `to <address>`, the subject, `· subject not signed`) instead of the record id, and an unsealed record in a received bundle reads `not sealed` (`waiting to be sealed` stays for your own trail).
- **Final tidy of the menu text.** `verify-bundle` prints `1 record` (not `1 records`), each record as the two-line browse row with the short capture time and the seal phrase once, and the three notes dim, wrapped and set off by blank lines before the verdict. The mcp screen says `registered for all your projects (user scope)` and offers `reinstall` / `uninstall` only when registered (`install` only when not). A record not yet sealed shows `waiting to be sealed (next 14:03Z)` instead of `unsealed`; the `spf` line of a mailbox copy says `N/A (not checkable from a mailbox copy)`; the pager breaks before a `#N of M` block instead of right after its header. `--json` is unchanged.
- **Menu content, in plain words (walkthrough 2026-11-12, SPEC B11.4c).** `sync` (menu item 1) asks nothing: it syncs the account's folders (`mailproof sync --folders/--sent` keep the overrides) and the seal line reads `seal: next due 19:01Z (in 5 h); 1 waiting for its Bitcoin anchor` (it was `ots: skipped (not due), 0 upgraded, 1 pending`). Each `watch` tick prints its per-folder seen/recorded lines under the tick line (`watch.log` keeps the one line). `replies` and `verify <address>` print the browse rows (when, age, verdict, from; subject or reply text; link and short reason; a long reason wrapped under its row), with blank lines before the totals and the final verdict. `check` in the menu asks Who, lists that person's latest five and takes a number (a record id still works), lists the profiles with a one-line meaning and prints one line per rule, passed or failed, with a plain reason; `check <id> --profile default` is a built-in baseline (DKIM signature verifies and covers the From) unless you create your own `default.json`. `check .eml` prints a result block (verdict, From, Subject, signatures, trust, body) and says `checked only, not recorded` when an account exists. `export` previews first (`export --dry-run`: the emails as rows, what the bundle reveals) and the menu then asks `Write it?`; the result reads `saved to ~/mailproof/exports/...` with the sha256 note as two short lines. `seal` and `backup` results use plain words (`sealed 3 new records; the Bitcoin anchor is pending ...`; `saved to ~/mailproof/backups/..., 12.3 KiB, 14 commits`, the restore command on its own line). `forget` asks Who first (ids are the advanced answer `ids`), `prune` shows its preview (count, span, rows) once, stops when there is nothing to remove, and asks for the account name only after the backup question; counts are plain (`1 email`, no `(s)`). `status` has an account line `personal · user@...`, bold labels, `~/` paths, short relative times and KiB sizes.
- **Upgrading from 3.3.x: text output.** The text of `verify <address>`, `replies`, `check`, `export`, `backup`, `forget`, `prune`, `stamp`/`seal` and `sync` changed (the exit codes and every `--json` output did not); scripts that parsed the text should use `--json`. `mailproof status` now brings the trail index up to date itself (an incremental catch-up under a 0.5 s lock wait) so it can show in/out and verified counts; the library's `status()` and the MCP `status` tool stay read-only. The menu header no longer shows `(verified count after the next list)`: it shows the total until the index is current.
- The `config add-account` wizard prompts back out on an empty answer or `q`, like the menu's; error messages show `~/` for paths under your home.

- **Upgrading from 3.3.x: where mailproof writes files for you.** Everything made for the owner now goes under `~/mailproof/<kind>/`, created 0700 on first use, never the current directory and never the state directory: `export` writes `~/mailproof/exports/mailproof-bundle-<account>-<time>` (it was `./mailproof-bundle-...`), `backup` writes `~/mailproof/backups/<account>-<time>.bundle` (it was `<state>/backups/<account>/`; older backups stay where they are and `status` still shows the last one), and the menu's save-attachment defaults to `~/mailproof/saved/<name>` (it was `~/Downloads/`). `--out` and the prompts choose another place; there is no new config key. Scripts that relied on the old defaults must pass `--out`. `export --json` and `backup --json` carry the absolute path.
- Every path the CLI prints uses `~/` (export, backup, status, check .eml); `mailproof config path` and `--json` stay absolute.
- `~` and `~/x` now expand in every path argument and prompt (`--out`, `--profile`, `--log`, `--config`, the `verify-bundle` directory, every menu path), not only in the config.
- The name a menu prompt offers for an export or a backup is the name written (the timestamp is computed once; it used to be read again after the prompt, so the file could be a few seconds later than the name shown).
- The menu: every screen opens with a crumb and a one-sentence job line the moment its item is chosen (before its questions), and a blank line and a dim rule separate every result from the options below it (the short line, the list footer, the opened-email actions); sub-screens (an opened email, raw, attachment, verify, thread, person, `m`, `f`, `s`) have their own. The status block shown after a state-changing action has a rule above and below and a bold first line. The crumb never cuts the command name (`10 verify-bundle`): a long value is shortened first (a path to its file name, a long address to a middle ellipsis).
- Every menu prompt backs out: an empty answer (where it has no other meaning) or `q` goes back one level instead of "a value is needed"; the label says `empty = back` or `q = back`.
- **Upgrading from 3.3.x: the MCP server uses the CLI's folders by default (owner decision 2026-11-12, reverses the 3.3.0 off-by-default rule).** With no `mcp.inputDirs` the server reads a `path` from under `~/mailproof`; with no `mcp.outputDir` it writes `export` to `~/mailproof/exports`, `backup` to `~/mailproof/backups` and `rawEmail`/`attachment` `saveTo` to `~/mailproof/saved` (created 0700 on first use, a preview included). Same safety as before: preview plus `confirm: true`, plain output names, resolved paths must stay inside the folder (symlink-safe), every write audit-logged. An explicit `mcp.outputDir` / `mcp.inputDirs` replaces the defaults; to keep the old behaviour set `"outputDir": null` and `"inputDirs": []` (`null` is now accepted for `outputDir`). `mailproof mcp` and the menu's `mcp` screen show the folders in effect. A minor bump: an agent that was refused a path or a write before is now served.
- MCP `status` returns the same counts as `mailproof status` (in/out, verified/unverified, first and last date): both call the library's `status({ refresh: true })`, which holds the catch-up the CLI used to do itself (500 ms lock wait, read-only fallback unchanged). It also returns `install: { kind: 'dev-link' | 'npm', path }`, from the one detection `update` uses (`src/cli/install.js`); the npm version lookup stays CLI-only.
- MCP `checkProfile`: `profile` is now optional and accepts a profile name (`default`, or a file in the profiles folder) as well as an inline object. The CLI and MCP resolve profiles through one module (`src/cli/profiles.js`).

### Added
- `Mailproof#status({ refresh: true })`: catch the trail index up first (short lock wait; a failure falls back to the read-only answer), so the in/out and verified counts are filled in. `status()` with no option is unchanged.
- MCP tool `profiles` (30 tools): the trust profiles `checkProfile` accepts by name, each with a one-line meaning (the CLI menu's list).
- **Menu walkthrough, part C (SPEC B11.4d).** Ctrl-C at a question goes back one level (at the main prompt it quits; during a running command it cuts the command); lines typed ahead in a terminal are no longer dropped; a blank line separates `watch` ticks; one separator (blank line and dim rule) comes before every choice or confirmation that follows a result; the `people` table has a `#` header cell. New **config** screen (summary with the password source and its mode, edit in `$EDITOR` with validation and an offer to reopen, add an account, an annotated example), **mcp** screen (status, install/uninstall in Claude Code through `claude mcp`, other clients: the JSON printed and written to `~/mailproof/mcp/mcp.json`), and **update** that detects a development link, looks up the latest version (`update --check`, `update --run` upgrades only a newer one, says to restart, hides npm's output unless it fails; offline `--run` is exit 1). A seal reads `sealed 11-11 21:03Z · anchored (Bitcoin block N)` or `· anchor pending` (new `sealed_at` on `describe().seal` and on `verifyBundle` records; the time is the stamping manifest's own, no network). `show` tags headers `signed`, `signed, failing`, `not signed`, `show <address>` blocks carry the dkim/dmarc/spf/arc lines, a tab in a shown body becomes spaces and a leading run of blank lines collapses. When the raw email is gone `show` and the browser's `r` say why: `forgotten 11-12 (mailproof forget)`, `expired 11-12 (retention)`, `never stored (content store off)`; `forget` and the retention sweep now leave a small note `<trail>.content/gone/<id[0:2]>/<id>.json` beside the content store (outside git; `describe().records[].content.gone`).
- **`verify-bundle` takes the `.tar`** that `export --tar` writes (library, CLI, menu, MCP), unpacked by a bounded reader of our own into a private temp folder (SPEC B13.3.10).
- `list({ subject })` (library), `mailproof list --subject <text>`, the MCP `list` tool's `subject` argument and the menu's `s`: keep the emails whose subject (signed, or the sender's claim read from the stored email) contains the text, ignoring case; a plain substring, the limit counts matches.
- The menu's **list** is a browser (SPEC B11.4a): it asks only `Who`, shows the latest 5 emails as numbered rows (when, age, verdict, who; the subject; a short reason, with the attachment count) and `N of TOTAL`; `m` more, `f` filter, `s` subject search. A number opens the email (the `show` text) with `r` raw email, `a` save attachment (never over an existing file, 0600), `v` verify again, `t` thread (parent and direct replies, signed or unsigned link) and `p` this person.
- `replyFacts({ address })` (and `mailproof replies <address>`, the menu's item 6, the MCP `replyFacts` tool's `address` argument): the direct replies one person sent to any email in the trail, with the same bundles, earliest first. Give exactly one of `messageId` or `address`.

### Changed
- The menu's list rows are shorter (SPEC B11.4a): no `dir` column (a sent copy already reads `to <address>`), the subject alone with a dim `· subject not signed` suffix instead of the `~` marker, and a short plain reason (`verifies`, `no DKIM signature`, `no DKIM key in DNS`, `signature fails`, `body changed after signing`, `DMARC fails`, `key expired (x=)`, `over limit: size`, ..., at most 40 characters) instead of the long cut sentence. The reason is the new `reason` field of `describe()` (and of the MCP `describe` tool), `shortReason()` in `src/proof/explain.js`, next to `explain`; the full sentence stays in `show`. `t` with no parent or replies says `no thread: no parent or replies recorded for this email`.
- The menu prints a blank line and a dim breadcrumb (`── mailproof › 4 list › bob@example.org › #3 › v verify ──`) before every menu and browser output block, and still never clears the screen. The non-menu subcommands are unchanged.
- The menu's list item no longer asks Role, Direction, Before, After and Limit up front, and prints no one-line table: those became `f` (filter) inside the browser. The non-menu `mailproof list` is unchanged apart from `--subject`.
- `mailproof replies` tells an address from a Message-ID by shape, like `show` and `verify`. **A bare `id@host` is now an address**: write the angle brackets for a Message-ID (`<id@host>`); the library's `replyFacts({ messageId })` still accepts it bare.
- The menu's `?` shows what the menu showed at the start: the header lines, then the full grouped menu.
- `mailproof stamp` (menu item 12, seal) prints one line, `nothing new to seal`, when nothing was sealed, upgraded or pending; any other result keeps the full report (`--json` is unchanged).
- The `mailproof` menu shows every command at once, grouped (Mail, Look, Check, Share and keep, Clean up, Setup), one per line with its help, numbered 1 to 19; after an action only a short line of the common ones follows. The numbers changed (`3` is now `people`, `5` `show`, `7` `verify`, `11` `export`, `16` `status`); names still work. New items: `9` check a saved `.eml` and `10` `verify-bundle`.

## [3.3.0] - 2026-11-11

### Added
- **`mailproof mcp`: an MCP server** (stdio, no new dependency; SPEC B12). One process serves every configured account to an MCP client (Claude Code, Claude Desktop, ...): 22 tools named after the library methods (`list`, `get`, `verify`, `replyFacts`, `record`, `sync`, `forget`, `prune`, ...), all always listed, each with the four MCP annotations. Every account-bound tool takes `account` (required when two or more are configured; `--account <name>` restricts a server to one). Results are JSON text; `rawEmail` and `attachment` return a blob or save a file (`saveTo`). Failures are `isError` results with the library's error code and a `retryable` flag. `forget` and `prune` only preview until called with `confirm: true`. Write and destructive calls add one line to `<state>/mcp.log`. Everything an email says is marked as untrusted data in every tool description.
- Config block `mcp` (`inputDirs`, `outputDir`, `maxResponseBytes`, `maxBinaryBytes`): paths are read only from `inputDirs` and files are saved only into `outputDir`; both are off until you set them.
- `Mailproof#forget(target, { dryRun: true })` previews what a `forget` would remove (`{ removed, attachments, dryRun: true, ids }`); the CLI's `forget` summary now uses it.
- The MCP audit log rotates at server start: a `mcp.log` over 1 MiB is renamed to `mcp.log.1` (replacing any older one) instead of being cut to its last 1 MiB, so the rare `forget`/`prune` lines are not the first lost. `watch.log` is unchanged.
- `npm run build:mcp-tools` / `check:mcp-tools` (generated tool list, checked in CI).
- The MCP `sync` tool takes `maxMessages`, the most messages to read per folder in one call (default 100, at most 1,000); call again while `complete` is false. The library's own `sync` caps are unchanged.

### Changed
- `mailproof-sync --help` now says that exit 77 also covers a `--pass-file` / `MAILPROOF_PASS_FILE` with group or other permission bits or a foreign owner (refused unread; the behaviour itself shipped in 3.2.0).

### Notes
- Claude Code 2.1.322 does not act on the tool annotations: it refuses any MCP tool not in its allow list and runs `forget` without a gate once allowed. Scope by tool name in the client (usage guide).
- Known limits: the MCP tool annotations are advisory and no current client enforces them; scope by tool name or one server per account; `confirm: true` is the only server-side guard for `forget`/`prune`.
- `mailproof mcp` with no stdin stream or on a terminal exits 64 (it is a stdio server, not interactive).

## [3.2.0] - 2026-11-11

> **Upgrading from 3.1.0.** Configs that worked before are now refused: a `backupRemote` with credentials in the URL fails config validation, and a loose-mode `passFile` or `--pass-file` (group or other bits, or a foreign owner) is refused unread (exit 77). Fix with a git credential helper or ssh key, and `chmod 600` the password file. `backup --with-content` also refuses an existing `<out>.content.tar`.

### Security
- `backupRemote` with credentials in the URL (`https://user:token@host/...`) now fails config validation: a pasted token sat in the config and in git's argv. Use a git credential helper or an ssh key; `git@host:path` and `ssh://git@host/path` are unchanged.
- A `passFile` (config) or `--pass-file` (`mailproof-sync`) with group or other permission bits, or owned by someone else, is now refused unread (exit 77), like the config file. Existing loose-mode password files need `chmod 600`.
- `backup --with-content` creates `<out>.content.tar` with mode 0600 before `tar` writes to it (it was readable by others until the archive finished) and refuses an existing `<out>.content.tar` instead of overwriting or deleting it.
- `backup` writes and verifies the git bundle in a private 0700 temp directory next to `--out` and links it into place 0600 (never overwriting), so it is never readable by others while it is written either.

### Changed
- `backup --push` masks credentials in git's stderr for every URL scheme, not only `https`.
- The `forget` help text now says From, To, Cc or Reply-To (what SPEC B7.7 always said).
- `list()` and `copies()` read the trail HEAD once per caught-up call instead of twice (one less `git rev-parse`).

### Fixed
- `backup --out` on a filesystem without hard links (FAT/exFAT, some network mounts) falls back to an exclusive copy (still never overwriting, 0600) instead of failing; `backupRemote` is passed to `git push` after `--`, so a value starting with `-` can never be read as an option.
- `expireContent()` now also removes stray temp files in `att/` that a crashed attachment write left (SPEC B7 already promised this).
- `mailproof status` with an unloadable SQLite add-on (`index unknown`) says to reinstall or rebuild better-sqlite3 instead of the stale "run `mailproof list`" hint.

## [3.1.0] - 2026-11-10

### Added
- `Mailproof#replyFacts({ messageId })` (M3 step 4, SPEC B10, findings F26-F27): one flat bundle of strings (closed sets for every flag) per recorded inbound DIRECT reply to a Message-ID (In-Reply-To names it, or it is the last References entry; deeper thread members are not included), earliest capture first; `[]` when there is none. Read-only: the text comes from the stored raw email through the pure stripper (nothing is committed); with no stored email `text`/`firstLine` are `""` and `textSource` says so. Fields include `fromDomain` (the domain of `from`, lower-case; a claim, pair it with `fromDkimAligned`), `fromDkimAligned`, `link`, `bodyProven`, `quote`, `trailing`, `firstLine`, `dkim`/`dmarc`/`spf`/`arc`, `live`/`portable` (trust levels), `commit`, `messageKey` (groups copies), and `date`/`subject` with `dateSource`/`subjectSource` (signed or claimed, RFC 2047-decoded). More than 200 direct replies rejects with `ERR_TOO_MANY_REPLIES`.

- **`mailproof` CLI** (M3 step 5, SPEC B11; `bin/mailproof.js`, shipped in `files` with `src/cli/`): one binary over the library, with no new runtime dependency. With no arguments on a terminal it shows a menu (stdlib `readline`) that asks each action's parameters and runs the same code as the subcommand; every action is also a subcommand for scripts: `sync`, `watch` (foreground loop, 30 s minimum, doubling backoff to 1 h, stops on a refused login, no daemon), `list`, `show` (`--raw` prints the stored email), `verify`, `replies`, `check --profile`, `forget`, `prune`, `backup`, `status`, `update`, `config`, `export` (not available until M6), `mcp` (reserved). Accounts live in one strict config file (`~/.config/mailproof/config.json`, mode 0600 enforced, secrets by reference only: `passCommand`, `passFile` or `accessTokenCommand`; a plaintext password key is refused); several accounts need `--account`. `forget` and `prune` print a dry-run summary and need `--yes` (menu: type the account name). `backup` writes a git bundle (and with `--with-content` a `tar` of the content store); `backup --push` never forces. `--json` prints one document; exit codes are those of `mailproof-sync` plus `2` for "ran, the answer is no" (`verify`, `check`). `config add-account` is an interactive wizard that writes the config atomically after a confirmation. Help comes from the same JSDoc as `primitives.json` (`npm run check:cli-help`, in CI). `mailproof-sync` is unchanged; the secret-source and exit-code helpers it shares with the CLI moved to `src/cli/`.
- `mailproof status` is read-only (SPEC B11.14): it never builds, creates or catches up the trail index and never takes the trail lock. `records.total` comes from the index when it is current (with in/out counts and oldest/newest dates), otherwise from a streamed count of record files at HEAD (dates and in/out null); `records.totalSource` (`index` or `git`) says which, and an index that exists but cannot be opened or queried is reported as `unreadable` (distinct from `stale`).
- `Mailproof#upgradeStamps()` (SPEC B3): folds the Bitcoin attestation into OpenTimestamps stamps that are still calendar-pending, one trail-lock window per stamp, each upgraded proof committed on its own; `{ enabled, upgraded, pending, error? }`; a no-op result when OTS is off, a reported (not thrown) error when the `ots` binary is missing.
- `Mailproof#prune({ dryRun: true })` (SPEC B9.7): the same plan and re-check of the kept records, the same result shape (`dryRun: true`, `head: null`, `backup` the path a real prune would use), nothing built, swapped or written. The result gains `dryRun` (false for a real prune).

### Security
- **CLI text output is terminal-safe** (branch-review H1, SPEC B11.7, F28). A sender could put cursor moves, an OSC title or a C1 CSI in a header and have `list`, `show`, `replies`, `check` and the error lines print them raw. Every mail- or server-derived string in text mode now goes through `printable()` (`src/cli/printable.js`: control, C1, bidi, zero-width, line-separator, tag and lone-surrogate code points, and the backslash, are shown as escapes; linear, no copy when clean), per field and again in the `print`/`warn` backstop, and the `watch.log` lines are escaped too. `mailproof-sync`'s stderr lines (folder, usage and thrown errors) are escaped the same way (stdout JSON unchanged). The escape set also covers U+180B-180D, U+2800 and U+1D173-1D17A; variation selectors U+FE0E/FE0F are kept only after a non-ASCII character or before U+20E3 (keycaps) and escaped otherwise, so `bob`+FE0F+`@` no longer displays as `bob@`. `--json` is unchanged (data as received; treat strings as untrusted) and `show --raw` stays raw bytes.

### Changed
- The trail index rebuild and catch-up stream git's listings (`ls-tree`, `diff`, `log`) instead of buffering them, so there is no 16 MB output limit: `ERR_INDEX_REBUILD` (about 350,000 records) no longer exists, and the `log` listing added by `commit_id` would have lowered that ceiling to about 170,000 (findings F27).
- The trail index schema is 4: `rec.commit_id` (the commit that added each record, from one `git log` at rebuild or catch-up) and `links.direct`. An older index file is rebuilt on first use; nothing to migrate.

### Documentation
- Post-3.0.0 status sweep: CLAUDE.md, README.md, docs/README.md, the PRD, the usage guide and mailproof.context.md now give 3.0.0 as current, mark M3 steps 1-3 shipped and step 4 onward not built, and say the git proof never holds the body while the raw email lives in the local content store outside git.
- M3 step 4 documented: SPEC B10, PRD recipe (consumer rule: allow only when at least one distinct reply is green and none is red), decisions-log, F27.
- M3 step 5 documented: SPEC B11 (built, owner resolutions B11.12, B11.14, terminal-safe output B11.7), the usage guide's `mailproof` command section, README, `mailproof.context.md`, PRD section 7, decisions-log and F28; a docs sweep after the terminal-safe and `status` fixes.
- M3 build order: `replyFacts` moves ahead of the CLI and MCP (now steps 4, 5, 6).

## [3.0.0] - 2026-11-09

M3 is partially delivered: steps 1-3 (content store, participants/links/profiles, prune). The CLI, the MCP server and `replyFacts` are still to come. POC evidence is under `poc/` (`poc/m3-prune/`) and the measurements are findings F22-F25.1 in `docs/product/findings.md`.

### Breaking
- **The trail layout changed and 2.2 trails are not readable.** `records/` and `replies/` are now sharded by id prefix (`records/<id[0:2]>/<id>.json`, `.ots` beside it; `replies/<id[0:2]>/<id>.<slug>.json`), so a commit writes a small shard tree instead of one entry per record. A trail in the old flat layout fails with `ERR_TRAIL_LAYOUT` on `record()` and every other call that opens it. There is no reader and no converter. **Upgrade path: create a new trail with 3.0.0 and re-record the mail** (for example with `sync()` or `record()` from the raw emails). Every path is built and parsed in `src/proof/layout.js`.
- **The content store is on by default.** `record()` now keeps the raw email (and its attachment files, once per distinct sha256) beside the trail in `<trailDir>/<trail>.content/`, outside git, write-once, hash-named and re-hashed on every read. The proof in the trail is unchanged (signed headers, never the body), but the raw email now sits on local disk, kept 730 days after capture. To keep the old "proof only" behaviour, construct with `content: { store: false }`: nothing is written and callers supply raw bytes as before. A content write failure never loses the proof; a failed commit removes the content files the call created. The raw email of a message over 25 MiB is not stored.
- **Records gain an `addresses` field** (signed and unsigned From, To, Cc and Reply-To addresses). Records written by 2.2 do not have it; they are not readable in the new layout anyway.
- **The trail index schema is 3** (participants and links, built from `addresses` when present). The SQLite index is a disposable cache rebuilt from the records, so there is nothing to migrate.

### Added
- Constructor option `content: { store, attachments, days, sweepDays }`. `store` and `attachments` default to true, `days` to 730 (retention counted from the record's `captured` time), `sweepDays` to 7 (the automatic sweep at the end of `sync()` runs only when the last one is at least `sweepDays` days old; an explicit `expireContent()` always runs). Bad values throw at construction.
- `Mailproof#rawEmail(id)` and `Mailproof#attachment(sha256)`: read back the stored raw email and attachment bytes, re-hashed on every read.
- `Mailproof#expireContent({ now })`: deletes content older than `days`. The record scan runs without the trail lock; the lock is taken only for the deletions, after revalidating against commits since the scan's HEAD (rewritten history aborts that round). Records are never deleted.
- `Mailproof#forget(target)`: removes stored raw email and attachment files on demand, for one id, a list of ids, or everything with one correspondent (`{ with, before?, after? }`). The proof stays and still re-verifies offline. Idempotent; the address definition is shared with the record's `addresses` field.
- `Mailproof#replyText({ id })`: extract the reply text of a recorded message from the content store, without passing the raw bytes. `matchBody(id)` likewise works without `raw` when the message is stored.
- Trail index (SPEC B5): participants and graded thread links, built from the record alone. `list()` gains `with`, `role`, `before` and `after` filters.
- `Mailproof#counterparties()`: who the trail's mail is exchanged with.
- `Mailproof#linked(id, { limit })`: the messages linked to one by threading ids, graded by link strength; children are bounded.
- `Mailproof#checkProfile(recordOrId, profile, opts)` and the exported pure `checkProfile` function: gate a recorded email by allowed senders, required checks, body level and link strength; returns `{ ok, failed, record, rules }`. The method reads the record from the trail first; an invalid profile rejects with `ERR_BAD_PROFILE`.
- `Mailproof#proofParts(recordOrId)`: separate results for the email (offline DKIM re-check, `body_status`) and for each attachment (re-hashed from the content store).
- `Mailproof#prune({ before, deleteBackup?, now? })` (SPEC B9): rebuild the trail without everything captured before a cutoff, using `git fast-export`, a stdlib filter and `git fast-import` into `<trail>.prune-build` (no new dependency). The pruned trail is built from a snapshot HEAD without the trail lock; the trail and sync locks are held only to append the commits made since and swap. A journal and two renames make the swap crash-recoverable (recovery runs inside the trail lock before any writer can create a trail); the sync cursor is repointed and the content of removed ids is swept. Stragglers are kept and reported, reply-only commits dropped, late keys follow the late-key rule, and re-verification is reported. Bounded memory: git's delta-base cache is capped at 16 MB and the file-set check is streamed (80,000 records peak about 194 MB, F25.1).
- The `addresses` record field and the sharded layout described above; the sync() retention sweep.

### Changed
- `sync()` runs the content retention sweep at the end of a run (at most once per `sweepDays`).
- Timing tests are load-robust (wall-clock bounds widened; the signature-cap test proves the cap by the empty lookups list). The index no longer issues a redundant explicit ROLLBACK.
- README, usage guide, PRD (section 4 and M3 status), SPEC (B1, B3, B5-B9), the agent context guide and the docs map describe the content store, the new methods and the layout.

## [2.2.0] - 2026-11-08

### Added
- `Mailproof#replyText(raw)` (M2, SPEC B6): returns the text the sender newly wrote in a recorded reply, with quoted history removed, plus whether that text is proven to come from the signed email. `proven` is true only when the stored record's `body_status` is `matched` and the message has a `text/plain` part; `partial`, `mismatch`, `not-checked` and html-only messages are unproven (`proven: false` is normal for mail received at Outlook/Exchange, whose copies have altered bodies). The result carries `text`, `text_sha256`, `text_bytes`, `quote` (`found` / `not-found` / `inline`), `trailing`, `source`, `boundary`, `stripper`, `body_status`, `proven`, `commit` and `duplicate`. Each extraction commits a text-free reply-text record at `replies/<id>.mailproof-quote-1.json` (hash and flags only: no text, subject or address); the same id and stripper version is a no-op. It rejects `ERR_NOT_RECORDED` when the message is not recorded in the trail, and `ERR_OVER_LIMIT` (with `limit`) when the message is over a gate limit or the worker backstop stopped it. Interpreting the text (keywords, dates, intent) is the consumer's job.
- The stripper `mailproof-quote/1`, stdlib code with no new dependency: decodes `text/plain` itself, cuts at the first quote boundary (attribution line, forward marker, Outlook original or header block, or a run of `>` lines), and recognises attribution lines with the name after the verb and in any language (for example Dutch `Op ... schreef Name <addr>:`, German `Am ... schrieb ...`). A sender's own "Op maandag schreef ik:" is kept. It is linear in the input (the attribution check no longer backtracks on long runs of spaces). Checked on 23 owner-reviewed real replies (F20). windows-1252 and GBK (and their aliases, including `us-ascii`, the default, and `iso-8859-1`) are decoded in-house (GBK as gb18030), so the result does not depend on the Node version.
- A trail index for `list()` and `copies()` (SPEC B5, F19): a rebuildable SQLite cache beside the trail, outside git, keyed by the trail's HEAD. The records stay the single source of truth; the index is caught up from new commits or rebuilt from the records, and can be deleted at any time. Queries no longer read every record (they were linear, about 65 microseconds per record). It is opened and closed inside each call, so nothing outlives a query and `close()` only releases the workers. Same signatures and result shapes as before.
- `better-sqlite3` as the fourth runtime dependency (a native addon), imported only by `src/proof/index-db.js`; `record`, `get`, `verify` and `replyText` never load it. Owner decision, F19.
- New errors from `list()` and `copies()`: `ERR_INDEX_UNAVAILABLE` (the addon cannot load; there is no fallback), `ERR_INDEX_REBUILD` (a rebuild over git's 16 MB output, about 350,000 records) and `ERR_TRAIL_LOCKED`.
- `docs/product/usage-guide.md`: operational guide, including "Reading a reply: what each outcome means" (`proven`, `body_status`, `quote`, `trailing`, html-only, the Gmail receiving rule, the threading caveat, a consumer decision rule). The agent context guide gains "Which entry point do I need?" and the same reply section.

### Changed
- `list()` and `copies()`: records captured at the same time are now ordered by id.
- The index rebuild and catch-up use bounded memory: records are read 500 at a time and written in one transaction, rolled back to the previous rows and head on any failure (peak RSS at 80,000 records 391 MB down to 175 MB).
- Index catch-up ignores git renames (`git diff --no-renames`), so a renamed record file removes the old id from the index.
- README rewritten around the two goals (verify now, verify offline later), the four ways to use it and what you can rely on.
- `primitives.json` is covered by `check:primitives`; `.gitattributes` pins LF on the hash-pinned primitives files.
- The publish workflow loads `mailproof/primitives.json` from the installed tarball, and its smoke step records an unsigned message and calls `list()` from the installed package, proving `better-sqlite3` loads there.
- Docs: a short reply's `text_sha256` can be confirmed by guessing the text, so treat it as not secret (SPEC B6.2, usage guide, context guide). The `SYNC_MAX_MS` comment says the cap is also checked between UID windows.
- Tests: two load-flaky tests (`cli-sync` timeout bound, `trail-lock` live break lock) made robust without weakening them.

## [2.1.0] - 2026-11-03

### Added
- `Mailproof#sync` (M1, IMAP capture): reads one mailbox read-only over implicit TLS (`EXAMINE`, `BODY.PEEK[]`; no `STORE`, `APPEND`, `COPY`, `MOVE`, `EXPUNGE` or `IDLE`) and records each message through the normal `record()` path. Folders (default `INBOX`, direction `in`) and the `\Sent` folder (direction `out`, found by special-use flag); app password or OAuth2 access token; a resume cursor sidecar `<trailDir>/.<trail>.sync.json` (not in git; stamped with the trail's git HEAD, so a trail restored from an older backup or replaced is detected and rescanned, `reset: 'trail'`); UID windows, never `*`; `UIDVALIDITY` compared as a string with a rescan on change; caps per folder per run (1,000 messages, 512 MiB, 30 minutes per call; the 30-minute cap is also checked before each UID window, so a server announcing a huge `UIDNEXT` with no mail cannot hold the sync lock for hours, and empty windows persist the cursor every 100 windows); reconnect with backoff; messages over 25 MiB are stream-hashed and recorded `over limit: total_bytes` with the id the pipe would give (above 128 MiB: `skipped`); errors `ERR_IMAP_AUTH`, `ERR_IMAP_CONNECT`, `ERR_SYNC_LOCKED` and per-folder `ERR_IMAP_*`. A Sent lookup failure is kept on the Sent entry (a throttle or protocol error) while the other folders still sync, and is ignored when Sent was not requested. SPEC B4.
- `mailproof-sync` CLI (`bin/mailproof-sync.js`, `bin` in package.json, `bin/` in `files`): one `sync` run for cron and systemd timers. Flags with `MAILPROOF_*` env fallbacks; the password comes from `--pass-command` (no shell), `--pass-file` or stdin, or an OAuth2 token from `--access-token-command`, never from a flag or plain env value. One JSON line on stdout, errors on stderr. Exit codes: 0 done (a capped partial run too), 75 retry later (lock, connect, timeout, throttled), 77 login refused, 64 bad usage, 1 other. Spaces are stripped only from Google's grouped app-password shape; any other password keeps its inner spaces. The pass/token command's stdin is closed, so a command that reads stdin to EOF no longer hangs to the 30 s timeout. systemd timer and cron setups are documented (verified against real Gmail under `ProtectSystem=strict`, `ProtectHome=read-only`).
- `imapflow` as the third (last) runtime dependency, used only by `src/proof/imap.js`.
- A second lock file `<trailDir>/.<trail>.sync.lock`, same mechanism as the trail lock, fail-fast.

### Changed
- `withTrailLock` takes the lock-file name and a lock kind as arguments (one implementation for the trail lock and the sync lock). `record()` is split into build and commit; behaviour is unchanged.
- Tests: the complexity and wall-time budgets derive from one per-machine CPU measurement (`tests/helpers/cpu-budget.js`) instead of fixed numbers; `makeTmpDir` directories are swept on SIGINT, SIGTERM and SIGHUP, not only on exit; the 18b memory test measures live memory (forced gc) instead of uncollected garbage.

## [2.0.1] - 2026-11-03

### Fixed
- A job that went over its CPU budget between two checks is now recorded `over limit: time` instead of being accepted. The budget was only read on a 50 ms poll, which stalls on a loaded machine; it is now also checked when the job finishes.
- An envelope reads the same with a worker and with `worker.size: 0`. `clientIp`, `clientHelo` and `sender` values that are not strings are read as `null`, and an envelope that is not a non-null object is read as no envelope. Before, a non-string or function value was rejected with "message input cannot be sent to the worker" when a worker was in use, but passed in-process.

### Changed
- Docs: `close()` says a call still running at `close()` may reject, and if it does it is not recorded, so await first (JSDoc, SPEC, context). `matchFile` documents that junk bytes give `{ match: false, attachment: null }`.
- CI runs on Node 22.19, the `engines` floor.
- Tests pin `message_key` distinctness, the body-status empty-prefix and budget-charge branches, the worker-pool spawn failure paths, and one resolver guard per message. POC scratch paths use `os.tmpdir()`. The CPU-budget worker tests no longer depend on the machine's speed.
- CLAUDE.md rewritten for v2.
- v1 code, tests and docs moved to `archive/v1/` (kept for borrowing; not shipped, not run, not type-checked). 1.x stays frozen at tag `v1.4.0`; there is no `v1` branch.

## [2.0.0] - 2026-11-02

mailproof v2.0.0: a new, smaller product. 1.x is frozen at tag `v1.4.0`. See `docs/product/PRD.md`.

### Added
- **Worker-thread deadline backstop** (SPEC Part B, "Limits"; on by default). `check()` and `record()` now build the record in a warm worker thread (`src/proof/build.js`, `worker.js`, `pool.js`); the main thread kills the worker over 15 s of the thread's CPU (`Worker#cpuUsage`), 120 s of busy wall time with DNS waits excluded, or 1,536 MB of worker heap + external memory, and records the message through the over-limit path: `unverified`, `reason: 'over limit: time'` / `'over limit: memory'`. It bounds what the admission gate has not measured; the gate stays the first line. Commit, lock, git and the clock stay on the main thread, so a killed worker leaves no partial state; the deadline starts when a worker starts the job, never at enqueue. New constructor option `worker: { size, cpuMs, wallMs, maxMemoryMb }` (`size: 0` = in-process, no backstop), new `Mailproof#close()`. A worker that dies for no nameable reason (the thread exits, or throws outside the build) is recorded as `over limit: crash` (unverified) rather than rejecting, so a message that crashes its worker is still recorded; `check()` returns the same reason, and an `Error` of the build itself still rejects as in-process. Idle workers are unref'd, so a program that never calls `close()` still exits. Results are identical to in-process (37 real messages). Cost: the first call starts the thread (roughly 0.4 to 1 s of wall time extra for a one-process-per-mail caller; use `size: 0` there).
- `Mailproof` class (bound methods): `check`, `record`, `verify`, `matchBody`, `matchFile`, `list`, `get`, plus root exports `verifyRecord`, `hashDocument`, `TRUST_LEVELS`, `RULES_VERSION`.
- The signed-header record (SPEC Part B): the exact headers each DKIM signature covers, the signature, the archived key, both verdicts, attachment hashes, threading ids. Never the body or the raw email.
- Two verdicts per email, each stamped with the engine/rules version: **live** (DKIM + DMARC + SPF + ARC) and **portable** (recomputable offline from the record alone, DKIM only).
- Offline re-check from the record alone; `x=`/`t=` judged at capture time; a bad capture time fails closed.
- One git repo per trail, one commit per record, a key archive deduped per domain+selector+key; optional OpenTimestamps stamp (off by default).
- Body status as its own field: per signature `body: { status, explain[] }` and a record-level `body_status` (`matched` / `partial` / `mismatch` / `not-checked`), computed at `record()` and `check()`. `explain` carries machine-readable hints (`l_tag`, `appended`, `prepended`, `canonicalisation`, `line_endings`, `forwarded`, `mailing_list`, `search_capped`, `unknown`), counts and domains only, never body text. It never changes a trust verdict.
- One record per distinct copy: the record `id` is now the first 32 hex of the raw bytes' sha256 (was the `b=`-based hash), so a mailing-list or forwarded copy no longer collides with the direct one. New `message_key` groups the copies of a signed message, and `copy: { kind, evidence }` (`direct` / `relayed` / `forward` / `digest` / `unknown`) marks the route; a forward-as-attachment links its signed original by key + verdict (`attached_original`, max 10, one level). New `copies(idOrKey)` returns `{ message_key, original, copies, contained_in }`. The same bytes captured twice are still a no-op.
- `npm run check:types`: fails when an exported function or method in the generated `.d.ts` returns a bare `object`.

### Changed
- **Node floor raised to 22.19** (`engines`): the CPU deadline needs `Worker#cpuUsage`.
- The three raw CPU ceilings on the body-line-count cases (and every other absolute CPU ceiling in the worst-case layer of `complexity.test.js`) failed at machine load 20-30. They are replaced by two load-independent checks: no admitted worst case is stopped by the default budget, and the heavy ones are stopped (`over limit: time`) by a 100 ms budget. The growth-ratio (linearity) checks are unchanged.

### Fixed
- A worker that dies while idle (nothing was listening to its exit) stayed in the pool, and the next, innocent message was handed the dead thread and recorded `over limit: crash`. The pool now forgets any worker as soon as it exits, so that message gets a fresh worker; a crash during a job is still `over limit: crash`.
- Input the worker cannot receive (for example `envelope: { extra: () => 1 }`) no longer crashes the process (unhandled rejection) or leaves `check()`/`record()` pending until the wall timer. Only the three envelope fields the build reads (`clientIp`, `clientHelo`, `sender`) are passed to it, in a worker and with `worker.size: 0` alike, so extra caller fields cannot reach `postMessage`; a value inside those that still cannot be cloned rejects that call with a clear error (in a worker only; the worker is reused), and a failed thread spawn settles its job instead of hanging.
- A worker that cannot start (its file throws at load, the thread cannot be created, it exits or errors before its hello) now rejects `check()`/`record()` and records nothing, as SPEC Part B says. It was recorded as a permanent `over limit: crash`, and re-recording the same bytes then returned `duplicate: true`. A worker that crashes while running a job is still recorded `over limit: crash`.
- A resolver answer that is not plain data (for example `[{ fn() {} }]`) no longer kills the process: with a worker, `postMessage` threw a DataCloneError out of an async handler. It is now answered as a DNS error (`resolver returned a non-plain value`, `code: 'EBADRESP'`), in a worker and with `worker.size: 0` alike, so both modes give the same result and the message is recorded `unverified`.
- DNS is bounded per lookup and per message: one lookup the caller's `resolver` (or the system one) has not answered within `DNS_TIMEOUT_MS` (5 s, in `limits.js`, shared with `fetchDkimKey`) is answered as the error `dns timeout` (`code: 'ETIMEOUT'`), and all the lookups of one message together (mailauth's and the DKIM key fetches, outer and inner signatures) may wait at most `DNS_BUDGET_MS` (30 s, `limits.js`), counted as wall time with at least one lookup in flight; once it is spent, further lookups fail at once with the same error. Both hold in a worker and with `worker.size: 0` alike. A resolver that never settled used to hang `check()`/`record()` forever; with only the per-lookup bound, a message with 10 outer and 10 x 10 inner signatures still cost about 555 s (DNS waits are excluded from `wallMs`) and, with the shared worker, blocked every message queued behind it. Now such a message costs about 30 s of DNS plus its CPU, and the lookups that were cut off are the usual temporary `dns timeout` key errors (`unverified`). A slow resolver that does answer within the budget is unaffected.
- The OTS stamp now runs with a timeout of `clamp(floor(lockTimeoutMs / 3), 5000, 30000)` ms inside the writer lock, so a hanging calendar can no longer make every concurrent writer hit `ERR_TRAIL_LOCKED` (on timeout the record is still committed, `ots: {error}`).
- The lock wait always honours its deadline: only `ENOENT` counts as a vanished lock file, so an unreadable lock or break lock (a directory, `EACCES`) no longer makes `record()` spin forever instead of throwing `ERR_TRAIL_LOCKED`.
- Crash cleanup removes only files mailproof itself writes (`records/<32 hex>.json`, `records/<32 hex>.json.ots`, `keys/<domain>/<selector>/<16 hex>.json`) instead of every untracked file under `records/` and `keys/`; your own files there are left alone (README Concurrency, SPEC Part B).
- The OTS timeout has a 5 s floor (a short or zero `lockTimeoutMs` no longer cuts the stamp to ~0 ms; concurrent writers can wait up to that long behind a slow stamp) and one default: `DEFAULT_OTS_TIMEOUT_MS` in `ots.js`.
- `fetchDkimKey` clears its DNS-timeout timer, so a one-shot process that called `record()` exits at once instead of lingering about 5 s.
- `matchBody` / `matchFile` (and `matchBodyRecord` / `matchFileRecord`) fail closed on a malformed record (non-array `signatures` / `attachments`, junk entries) with `match: false` instead of throwing; `matchFile` with bytes that are not bytes or a string also returns `match: false`.
- Docs: a Recovery note for a stuck `ERR_TRAIL_LOCKED` (SPEC Concurrency, README).
- Stale-lock takeover is now atomic: it goes through a break lock (`<trailDir>/.<trail>.lock.break`, `O_EXCL`), so two waiters judging the same dead-pid lock stale can no longer both unlink it, nor can one remove a live lock the other just created. A stale break lock (dead pid, or older than `max(lockTimeoutMs, 10 s)`) is removed by a plain unlink.
- Crash-safe `record()`: a writer killed mid-commit (SIGKILL, OOM) left a staged record and key, and the retry of the same mail returned `duplicate: true` with nothing committed. Under the trail lock, `record()` now clears staged changes and untracked files under `records/` and `keys/`, counts a record as a duplicate only if it is committed in HEAD, and re-writes an uncommitted key file. First-trail creation is also finished on the next call if it was interrupted before its first commit.
- Single writer per trail across processes: `record()` now holds a lock file (`<trailDir>/.<trail>.lock`, `O_EXCL`, `{pid, host, started}`) across the whole write, so concurrent processes (one per mail under Postfix) no longer hit git's `index.lock` or race the first `git init`. New `lockTimeoutMs` option (default 30000); on timeout `record()` throws `ERR_TRAIL_LOCKED` (map to exit 75 in a pipe consumer). Dead-pid locks on the same host are taken over. A failed write now removes only the files it newly created and git does not track, so it can no longer delete records another process committed.

- `verifyRecord` (and `mp.verify`) no longer throw on malformed input: a non-object signature entry (for example `null`) is reported as `ok: false, why: 'malformed signature entry'` in its own slot, and junk options are ignored.
- **Hardened against CPU-exhaustion input.** One admission gate now bounds what the parsers ever see, and the body search has one budget per message (SPEC Part B, "Limits"):
  - `admit()` (`src/proof/admit.js`) makes one linear pass over the raw bytes (no regex) and refuses a message over any limit in the new `src/proof/limits.js`, which defines every bound in one place: total size 25 MiB, header block 256 KiB, 4,000 header lines, 1,000 header fields, 10 DKIM-Signature headers, 200 names in one `h=`, 16 KiB per DKIM-Signature field, 200 MIME delimiter lines, 256 KiB per body line, 500,000 body lines. It reads the header block and the signature fields the way mailsplit and mailauth do (tested against both, including a leading empty line, bare CR and a signature whose colon is on the next line). It runs in `record()`, `check()`, `matchBody()` and on each attached original.
  - A refused message is still recorded (accept-with-flag) but never parsed: `unverified`, `reason: 'over limit: <name>'` on both verdicts, `signatures: []`, `message_id` null, `copy.kind` `unknown`; only `id`, `raw_sha256` and `size` come from the bytes. mailauth and mailparser never run on it and no DNS is asked. `check().unsigned` is false for it (it was not looked at). It closes mailauth's relaxed body canonicaliser being super-linear in a long line (a 1/2/4/8 MiB single-line body with a matching `bh=` cost 0.11/0.24/0.71/2.5 s of CPU; it is now refused in 3/6/13/25 ms).
  - More than 10 signatures refuses the whole message instead of evaluating the first 10, so `dropExtraSignatures`, `signatures_skipped` and the per-signature `h= too long` entry are gone, and mailauth is handed the message exactly as received (no signature headers removed).
  - A header block over the old 1 MiB decoder limit no longer rejects with `EMAXLEN` and records nothing: any header block over 256 KiB is recorded as `over limit: header_bytes`. `reason: 'too many header fields'` is now `over limit: header_fields`.
  - The body-status mismatch search has ONE work budget per message (`MAX_WORK`, 64 MiB) shared by all signatures and attached originals, instead of 64 MiB per signature: 10 valid signatures on a tampered body cost 2.8-7.9 s of CPU on input that is well under every limit (mailauth alone: 8-160 ms); they now cost 0.1-0.5 s. A search the budget cannot cover is skipped and reported as `search_capped`; no status or verdict changes. Only the super-linear appended/prepended searches draw on it: the linear canonicalisation and line-ending detectors always run, so a large body is still explained as `canonicalisation` / `line_endings`. The prepended search also hashes views of one buffer instead of rebuilding every suffix, so the same budget is several times cheaper in CPU.
  - A body of more than 500,000 lines (`MAX_BODY_LINES`) is refused as `over limit: body_lines`. The byte and line-length limits left the number of lines free, and what sits behind the gate pays per line (about 3 µs: 4 MiB of 76-column lines 0.7 s, 1 MiB of one-byte lines 0.85 s, 4 MiB of them 4 s, and 23 MiB of `a\r\n` lines with 10 signatures 43 s and 1.3 GiB), so the "about 75 ms a MiB" in findings F14 and the SPEC held only for 76-column lines. 500,000 admits a 25 MiB base64 message (about 345,000 lines); the largest real message has 14,200.
  - A body with bare-LF line endings is converted to CRLF once per message (one linear pass, one shared copy) before the per-signature `relaxed` hashing, instead of by mailauth's hasher once per signature (a subarray per line, about 1.4 µs a line each time): 10 signatures on 500,000 bare-LF lines cost 14-21 s, now 3-4 s. The digest and canonical length are identical (checked against mailauth on mixed-ending fuzz, 480,000 cases, and on every real sample); `simple` is not equivalent and is left alone. The copy is keyed on the body buffer, not on `c=`/`a=`/`l=`, so distinct tag values cannot bring the passes back.
  - A message that starts with an empty line is read as having no headers (as mailsplit and mailauth read it), and a header field name is trimmed of spaces and tabs only, as mailauth does.
  - Trailing-whitespace trimming in the relaxed body canonicalisation, address extraction from the signed `From`, the `List-Id` angle-bracket match and the OpenTimestamps attestation scan no longer use regexes that backtrack quadratically (a long run of spaces, a `From` with no `@`, a run of `<`, many attestation nodes). Results are unchanged. `selectSigned` indexes the header rows by name once instead of once per `h=` name.
  - A message is decoded before it is authenticated (the two ran side by side), so nothing the decoder rejects starts DNS lookups.
  - `tests/integration/complexity.test.js` guards every public path: adversarial inputs at size N and 2N must not grow more than linearly, `admit()` is timed on the shapes that make it read every byte, and for every limit the most expensive message still admitted (`tests/helpers/worst-cases.js`, 10 tampered signatures included) must stay under a CPU ceiling.

### Removed
- `OPS.md` and `config.example.env` (v1 operator checklist and `MAILPROOF_*` env template for the bundled Postfix stack) moved to `docs/archive/v1/`; they were not in the package `files` and describe the v1 `create()` API.

### Changed
- `build:types` emits declarations for the shipped surface only (`tsconfig.build.json`: `src/index.js` + `src/proof/`) after cleaning `types/`; the tarball no longer carries v1 `.d.ts` (18 `types/` files, was 42). `typecheck` still checks all of `src/`.
- Types are built on `prepack` (pack and publish) instead of `prepublishOnly`; the publish workflow's adopter gate now compiles a v2 quickstart; `mailproof.context.md` follows the context template sections.

### Changed (breaking)
- Root export is now the proof core. `create()`/`ingest()` and the v1 barrel are no longer exported; there is no compatibility layer.
- Trust rule: `verified` = aligned DKIM pass AND DMARC pass **if the domain publishes DMARC**. A domain with no DMARC record is now `verified` on an aligned DKIM pass (v1 said `unverified`). DMARC temperror/permerror fails closed.
- `forwarded` can be restricted to ARC chains sealed by `trustedSealers`.

## [1.4.0] - 2026-10-31

Minor, not patch: the DKIM/DMARC engine moves three majors (mailauth 4 → 8), and its stricter DMARC evaluation can change the **trust level** `ingest()`/`verify()` assign to some senders. The public API, types, and Node floor (≥ 22.5) are unchanged.

### Security

- **Inbound address parsing moved off vulnerable `nodemailer` — this one IS reachable, correcting the earlier "sending-only" triage.** Both the DKIM verifier (`mailauth` → `dkim-verifier` parses the `From:` and `Return-Path:` headers) and `mailparser` (every address header) run `nodemailer/lib/addressparser` over *untrusted inbound* mail. nodemailer ≤ 10.1.3 carries 15 advisories; the ones that matter here are the addressparser parsing bugs (RFC 5322 comment mis-parsing, a `>` inside a quoted local part ending the angle-addr early, `;` ending a group early, nested comments, quadratic backtracking): the parsed `From:` domain is what DMARC alignment is computed against, so a parser that disagrees with what the header names is a trust-spoofing path, not just a DoS. The previous `overrides` pin of `nodemailer@^9.0.1` was holding the vulnerable parser *in place*. Fixed at the source so adopters get it too (npm `overrides` are **not** inherited by consumers): `mailauth` ^4.13.3 → **^8.0.4** (pins nodemailer 10.2.0) and `mailparser` ^3.9.17 → **^3.14.1** (pins nodemailer 10.3.1). The repo override is lifted to `nodemailer ^10.3.1`.
- **`undici` override ^7.29.0 → ^7.30.1** (Dependabot #6, #8). Exposure remains nil — undici is reachable only through mailauth's BIMI VMC fetch, which `parse.js` disables (`disableBimi: true`).
- **`joi` override ^18.3.1** (Dependabot #7 brought joi in via mailauth). The advisory (quadratic `string().email({ multiple: true })`) is **unreachable**: mailauth never calls `.email()` — joi only validates mailauth's own options. mailauth pins `joi@18.3.0` exactly, so a fresh adopter install still reports it until mailauth ships a bump; there is nothing to fix on mailproof's side.

Verified: `npm audit` 0 vulnerabilities in-repo; a clean adopter install of the packed tarball (no overrides) resolves nodemailer 10.2.0 / 10.3.1 on both paths, with only the unreachable joi finding left.

### Changed

- **`mailauth` ^4.13.3 → ^8.0.4 (Dependabot #7, extended from 7.1.0).** Every 7.x still pins a vulnerable nodemailer, so #7's 7.1.0 was taken on to 8.0.4. Breaking changes upstream and what they mean here:
  - *DMARC strict alignment is now enforced (5.0).* `adkim=s` / `aspf=s` used to fall through to relaxed comparison, so a sender publishing strict alignment but signing from a sibling host under the same org domain passed. It now fails, and `dkim.results[].status.aligned` is `false` for org-level-only matches. **Such a reply now classifies below `verified`** — the previous result was over-trusting.
  - *RFC 9989 DNS Tree Walk for org domains (6.0) and `np` / `t=y` / invalid-policy rules (7.0).* DMARC verdicts can change for subdomains, in the direction RFC 9989 defines.
  - *`pct` removed from the DMARC result (7.0); TypeScript build, deep imports go through an exports map (8.0).* No effect: mailproof reads only `dkim.results[].status.{result,aligned}` and `dmarc.status.result`, and imports only root named exports (`authenticate`, `dkimSign`).
  - *Node floor.* mailauth 5–7 required Node ≥ 22.19; 8.0.4 is back to ≥ 20.18.1, and every package in the tree is at or below 20.19, so mailproof's `engines` stays at **≥ 22.5**.
- **`mailparser` ^3.9.17 → ^3.14.1** — same major; carries the fixed nodemailer.

### Fixed
- **The publish workflow now fails when `package-lock.json`'s version drifts from `package.json`.** npm writes that field on install, so a release that bumps `package.json` without running one leaves it behind — and nothing caught it: `npm ci` fails when the lockfile's *dependency* entries disagree, but never checks the lockfile's copy of the project's own version. `scripts/check-lockfile.mjs` (`npm run check:lockfile`) compares both places npm writes it and runs in the publish workflow. No lockfile is not a failure.

- **Adopter type-check gate no longer runs dependency install scripts next to the publish credential.** The gate installs the packed tarball into a throwaway consumer project, and that install ran inside the job holding `id-token: write` — the OIDC credential that can publish this package — with install scripts enabled, so any install script in the tarball's transitive dependency tree executed beside a live publish capability. Now `--ignore-scripts`. The gate only ever runs `tsc`, which reads `.d.ts` and nothing else, so nothing needs building: verified on a native-addon package that the addon is *not* compiled and the type check still passes green, while a broken dereference still fails it. `typescript` is also pinned to `@5` for the same reason `@types/node` is pinned — an unpinned compiler silently becomes a new major and fails the gate on its own schedule rather than on the commit's merits. CI only — no runtime or published-artifact change.

## [1.3.3] - 2026-08-30

### Security

- **Bumped `mailparser` 3.9.14 → 3.9.17 and the `undici` override 7.28.0 → 7.29.0 (Dependabot #2, #3).** mailparser 3.9.16 *bounds `linkify-it`'s scan of untrusted text bodies* — a reachable hardening, since `simpleParser` runs over inbound mail mailproof does not control; it also pulls `html-to-text` 10.0.1 → `deepmerge-ts` 8.0.2, which resolves the ancestor half of #2 (`deepmerge-ts` sits two levels under mailparser and mailproof never calls it directly — the kernel reads only `from`/`messageId`/`attachments` off `ParsedMail`, never the html-to-text-derived `text`). undici 7.29.0 carries one high and four medium advisories (Cache-Control parsing, blob `content-type` CRLF injection, retry `Content-Length` desync, cookie attribute injection); mailproof's exposure stays *nil* — undici is reachable only through mailauth's BIMI VMC fetch, which `parse.js` disables with `disableBimi: true` — so this is defence in depth for the override, not a live fix. `nodemailer` stays pinned at 9.0.1 (sending-only surface, unreachable behind the Postfix/sendmail transport). `npm audit` clean; 317 tests + typecheck green.

### Added

- **Publish workflow gates on the types being usable BY AN ADOPTER, not just internally.** `npm run typecheck` (`tsc --noEmit`) checks the *source*; it cannot see the generated `.d.ts` as an adopter resolves it from inside `node_modules`, which is the one thing consumers actually get. The publish workflow now packs the tarball, installs it into a clean consumer project, and compiles a quickstart against it, so a release whose published types are broken cannot reach the registry.  The consumer pins `@types/node` to the major this package builds against instead of floating to the newest, so a stricter DefinitelyTyped release cannot turn the publish gate red for reasons unrelated to the commit being published. Verified locally: the quickstart compiles green against a packed tarball, and a deliberately broken dereference fails it. CI only — no runtime or published-artifact change.

## [1.3.2] - 2026-07-24

### Security

- **Bumped `mailparser` 3.9.11 → 3.9.14, pulling in `linkify-it` 5.0.2 (transitive).** `linkify-it` 5.0.2 fixes a ReDoS in `mailto:` link parsing (user/pass parts now length-capped). This path is reachable: mailparser runs `linkify-it` over inbound message bodies, and mailproof parses *untrusted* inbound mail — so this is a real hardening of the decode surface, not a sending-only path. `nodemailer` stays pinned at 9.0.1 via the existing `overrides` (its CVE surface is message-sending, unreachable behind the Postfix/sendmail transport). `npm audit` clean; 317 tests + typecheck green. (Also refreshed the committed `package-lock.json`, which had drifted to `0.9.2` while `package.json` advanced through the 1.x line.)

### Fixed

- **Publish workflow pinned to `npm@11` — npm 12.0.0's `npm publish --provenance` is broken.** The job ran `npm install -g npm@latest`, which started resolving to npm 12.0.0 (released 2026-07-09) on the Node 22 runner. npm 12's `libnpmpublish` provenance code does `require('sigstore')`, but the tarball bundles only the `@sigstore/*` scoped packages — so `--provenance` dies with `MODULE_NOT_FOUND` and the publish fails outright. npm@11 bundles `sigstore` and publishes fine. Pinned to the major rather than floating on `@latest`. Revisit once npm ships a provenance fix. CI only — no runtime or published-artifact change.

### Changed

- **Agent/IDE scratch is gitignored and de-tracked (`.claude/`, `.litectx/`, `.idea/`).** Per-machine agent and IDE state is no part of the package — it regenerates locally and only added noise and churn. Now ignored, and any already-committed copies removed from tracking (local files kept on disk). Functional dot-paths (`.github/`, `.gitignore`, `.npmignore`, `.mcp.json`) stay tracked. Repo hygiene only.

## [1.3.1] - 2026-06-25

### Documentation
- **README polish (the README ships in the npm tarball).** Value-first framing:
  leads with what you get (sign a contract, run a petition, drive an approval
  chain, notarize *when* something existed), with OpenTimestamps surfaced as a
  value line. Removed the internal build-phase "Status" table (P0/P1/m7c/P2
  codenames) that read as work-in-progress under a stable release; trimmed the
  recipes to two outcome-framed flagships (kept the code); de-jargoned the
  validation section; added a point-of-view line. No code change.

## [1.3.0] - 2026-06-25

**First stable release** (`1.0.0`–`1.2.0` were permanently reserved by prior unpublishes on npm, so the stable 1.x line starts at the first free clean minor, `1.3.0`). mailproof graduates out of pre-1.0. The four pillars
(verify → sequence → git ledger → triggers), both coordination modes (an
**events** workflow + a **crypto sign-off** — declaration / attestation), and the
document notary are complete and validated. P1 (lift), m7c (verification
surface), m7d (trigger pillar), and P2 (surface validation against a real
consumer's full capability set — **Bucket A 19/19 + Bucket C 7/7**, only the
neutral `reopenEvent`/`completeEvent` lifecycle pair forced) are all done. The
verify pillar is grounded against real-world DKIM — `verified` end to end on a
genuine production opendkim message over **live DNS**, with a committed offline
regression and deprecated rsa-sha1 refused (RFC 8301). 317 `node --test` tests,
**2 runtime deps**, JSDoc-sourced TypeScript declarations. **The public API is
now stable under SemVer** — breaking changes only in a future major.

### Tests
- **DKIM-verify interop pinned against a real production opendkim key.** Added
  `tests/integration/dkim-interop.test.js` — a deterministic, offline regression
  that verifies a message signed by a real production opendkim key to `verified`
  against the committed public-key record (injected resolver, no network).
  Confirmed end to end against a genuine production message over **live DNS** via
  the new manual harness `tests/manual/verify-live.mjs`; the verification path
  also correctly **refuses deprecated rsa-sha1** signatures (RFC 8301, inherited
  from the `mailauth`/OpenSSL digest policy). Captured live mail is gitignored so
  sign-in tokens never enter git.

## [0.9.3] - 2026-06-25

### Security
- **Disabled BIMI verification in the inbound auth path** (`disableBimi: true` on
  the `mailauth.authenticate` call). mailproof surfaces only DKIM/DMARC/ARC trust
  (`summariseAuth` never reads BIMI), and BIMI's VMC fetch is mailauth's **only
  outbound-HTTP path** — the sole route to the transitive `undici` CVEs. Disabling
  it removes that network call and its CVE surface for every consumer (DKIM /
  DMARC / ARC stay DNS-only via the injected resolver). This is the consumer-facing
  fix: it ships in source, independent of the lockfile.
- **Pinned patched transitive deps** via `overrides` + a `mailparser` bump, so
  this repo's lockfile carries no known advisories (`npm audit` → 0):
  `undici` → `^7.28.0` (patches the 7.x TLS-bypass / header-injection / cache /
  keep-alive advisories; same major as mailauth's pin), `nodemailer` → `^9.0.1`
  (patches the CRLF-header-injection / jsonTransport / OAuth2-TLS / raw-SSRF
  advisories), and `mailparser` `^3.9.8` → `^3.9.11`. **Reachability:** the
  nodemailer advisories are all message-*sending* paths — mailproof sends via
  bundled Postfix/sendmail (`child_process`), never nodemailer — so they were
  never reachable; the bump is hygiene. (Note: npm `overrides` clear *this repo's*
  audit/Dependabot; they are not inherited by downstream consumers — for them the
  `disableBimi` source change is what reduces surface.)

## [0.9.2] - 2026-06-25

### Fixed
- **Engine-driven re-completion after `reopenEvent` no longer leaves the ledger
  stale.** Completes the 0.9.1 fix on the remaining path: when a reopened event
  re-reaches its threshold via a *new inbound reply* (the `ingest` engine path,
  not consumer-driven `completeEvent`), `commits/completion.json` was kept at the
  *first* completion's `triggering_commit_sequence`/`completed_at`/`summary` while
  the master event recorded the second — the same ledger-vs-master divergence 0.9.1
  fixed for `completeEvent`. `ingest` now passes `supersede: true` to
  `commitCompletion` when the event carries `reopened_at`, so the ledger record
  tracks the current completion; the prior record stays in the git chain (the
  tamper-evidence), and a byte-identical re-completion still writes no commit.
  First-completion behaviour (never-reopened events) is unchanged — `reopened_at`
  is absent, so `supersede` stays off. Regression test in
  `tests/integration/reopen.test.js`.

### Added (consumer ergonomics — surfaced by the P2 mailproof-probe validation)
- **`manualCompletion: true` event flag** — suppresses the engine's auto-complete
  in both modes: replies still count and commit (accept-with-flag is unchanged),
  but the event only finalises when the consumer calls `completeEvent`. The honest
  replacement for the `threshold: 999` workaround a consumer that owns its own
  completion semantics (e.g. strict-signing) previously needed. (Probe gap G3a.)
- **`saltedSenderHash` is now a top-level export** — the pure salted-sender hasher
  (SPEC §0.1) consumers need to map an attestor email → its stored ledger hash,
  available without constructing a `createGitrepo` instance. Same function the
  ledger uses (no divergence). (Probe gap G2.)
- **`loadCompletion(eventId)`** on `create()` (and the `gitrepo` factory) — reads
  the canonical `commits/completion.json` record (or `null` if not complete). The
  one non-numbered ledger record, now a first-class reader instead of inferring
  completion from `event.status`. (Probe gap G4.)
- **`exports` map now exposes `./package.json`** — consumers can
  `import pkg from 'mailproof/package.json'` (e.g. to read the version). (Probe gap G0.)

## [0.9.1] - 2026-06-25

### Fixed
- **`completeEvent` after `reopenEvent` no longer leaves the ledger stale.**
  `reopenEvent` (0.9.0) made completion repeatable, but `gitrepo.commitCompletion`
  was idempotent on the singleton `commits/completion.json` — so a re-completion
  (the revoke / strict-signing flow m7e exists for) silently kept the *first*
  completion's `completed_at`/`summary` on the tamper-evident ledger while the
  master event recorded the second, a ledger-vs-master divergence. `completeEvent`
  now passes `supersede: true`: `completion.json` is rewritten + re-committed to
  reflect the current completion, and the prior record stays in the git commit
  chain (the actual tamper-evidence — nothing is erased). A byte-identical
  re-completion still writes no commit. `commitCompletion` gains an opt-in
  `supersede` flag (default off — the `ingest` one-shot path is unchanged) and a
  `superseded` field on its result. Regression test in `tests/integration/reopen.test.js`;
  SPEC §4 wording updated. (Found by `/diff-review` of the 0.9.0 delivery.)

## [0.9.0] - 2026-06-25

### Validated
- **P2 surface validation complete (`mailproof-probe`).** A throwaway consumer on
  the public package surface (gitdone untouched) exercised gitdone's full
  capability set: **Bucket A (19 core) passed on stock `0.8.0`**; **Bucket C (7
  candidate-gaps) all resolved** — C1/C2 forced exactly the two neutral primitives
  below (`reopenEvent`/`completeEvent`), and **C3 reference-doc manifest/attach+,
  C4 close+ two-step close, C5 bundle+ proof export, C6 forward-to-initiator, and
  C7 attestor redaction needed no kernel change.** Structural finding:
  accept-with-flag + `listCommits` already give consumers a durable, tamper-evident
  per-event store (the committed inbound email is the record), so the heavy
  attestation tail stays consumer policy over the existing surface; C7 is moot
  because the privacy invariant means no plaintext is ever at rest. The surface
  grew by exactly the two lifecycle primitives. (See the decisions log + the
  probe's verdict table.)

### Added
- **`completeEvent(eventId, opts)` — the mirror of `reopenEvent`** (forced by the
  `mailproof-probe` C2/strict-signing validation: a consumer that owns its own
  completion semantics — e.g. strict-signing attestation, where an attestor only
  counts after signing a whole reference-doc set — had no way to mark an event
  complete). Flips `status`→`complete`, stamps `completed_at`, and writes the
  canonical one-shot completion record (`gitrepo.commitCompletion`). Policy-free:
  `reason` is opaque, and the consumer owns any completion notification (the
  primitive sends no mail, matching `reopenEvent`). No-op (`completed:false`) when
  already complete; refuses archived. Together with `reopenEvent`, this lets a
  consumer drive the full completion lifecycle (create with an unreachable
  `threshold` so the engine never auto-completes, then complete/reopen by policy)
  while mailproof's verify + append-only ledger do the load-bearing work.
- **`reopenEvent(eventId, opts)` — a neutral event-lifecycle primitive** (forced
  by the `mailproof-probe` C1/revoke validation: a consumer had no way to reopen
  a completed event, so policies like revoke / close-reversal were impossible to
  build on the public surface). Flips a completed event `complete`→`open`, clears
  `completed_at`, optionally **retracts** named counted signatures by salted
  `sender_hash` (so the crypto engine's count drops), and appends a
  tamper-evident `event_reopen` commit to the ledger (`gitrepo.appendReopenCommit`;
  retracted senders recorded as salted hashes only — never plaintext). The kernel
  holds **no policy opinion** on *why* — `reason` is opaque, supplied by the
  consumer; this keeps revoke *logic* in consumer policy (per the locked design)
  while exposing the lifecycle *primitive* it needs. No-op (`reopened:false`) on a
  non-complete event; refuses archived events. Exposed on the `create()` instance
  and from `createEventStore`. New event fields `reopened_at` / `reopened_reason`.
  Workflow step state is not auto-rewound (consumer's call via `editEvent`).

## [0.8.0] - 2026-05-29

### Changed
- **Migrated the package from CommonJS to pure ESM** (`"type": "module"`), to
  the suite-wide `LIBRARY_CONVENTIONS.md` §1 — mailproof was the last library on
  CJS. Every `src/*.js` module and test now uses `import`/`export` instead of
  `require`/`module.exports`; all relative specifiers carry the `.js` extension
  Node ESM requires (in code **and** in JSDoc `import('./x.js')` type
  references). Consumers now `import { create } from 'mailproof'` rather than
  `const { create } = require('mailproof')`. The `package.json` `exports` map
  gains an `"import"` condition. **No API surface change** — the 59 named
  exports, `create()`/`ingest()`, and the 12 occasion kinds are identical;
  this is a packaging/module-system change, hence the minor bump.
- Three module-system seams were reworked by hand (the rest was mechanical):
  `parse.js`'s `mailparser` type-cast (was a variable-specifier `require` to
  dodge the untyped module; now a default import + the same JSDoc cast),
  `verifier.js` / `dkim-archive.js` inline `require('node:dns')` (hoisted to
  top-level `import`), and `event-store.js`'s lazy `require('./gitrepo')`
  (now a static import; construction stays lazy). `create.js`'s whole-module
  captures of `completion`/`crypto` became `import * as`.
- `poc/pipeline.js` → `poc/pipeline.cjs` so the superseded P0 proof still runs
  under the now-ESM package (`npm run poc`).

### Unchanged
- Runtime deps still **2** (`mailauth`, `mailparser`). **307** `node --test`
  tests pass, `npm run typecheck` → 0 errors (`checkJs` + `strictNullChecks`),
  `build:types` emits 24 `.d.ts` to git-ignored `./types/`. Node ≥ 22.5.

## [0.7.0] - 2026-05-29

### Added
- **Shipped TypeScript declarations, generated from JSDoc — to the suite-wide
  library types contract (`LIBRARY_CONVENTIONS.md`).** Every `src/*.js` module
  carries JSDoc type annotations referencing a shared vocabulary in
  `src/types.js` (`TrustLevel`, `MailproofEvent`, `Step`, `Commit`,
  `ParsedMessage`, …). `tsc` with `checkJs` + **`strictNullChecks`** (not full
  `strict` — full strict is ~95% `noImplicitAny` noise, ~5% real null-safety;
  `strictNullChecks` keeps the 5%) type-checks the source against that JSDoc
  (0 errors; `npm run typecheck` → `tsc --noEmit`). `npm run build:types`
  (`tsc`) emits the `.d.ts` to **`./types/` (git-ignored)**; they are built
  fresh on publish via `prepublishOnly` and **never committed**, so no stored
  artifact can drift from the JSDoc — drift is structurally impossible, not just
  guarded. Null-safety findings were fixed with minimal behaviour-preserving
  guards (no `!` / `as any` / `@ts-ignore`). `package.json` gains a
  `types`/`exports` (→ `./types/index.d.ts`) entry + `prepublishOnly`;
  `typescript` + `@types/node` are dev-only devDeps (**runtime stays 2 deps, no
  consumer build step**). `.github/workflows/ci.yml` runs typecheck +
  `build:types` + tests on push/PR; `publish.yml` gates on typecheck and
  `prepublishOnly` builds the types into the tarball. New
  `tests/unit/index.test.js` pins the exact public-barrel surface (59 exports).
  Matches the family contract (`bareagent` reference, `knowless`); repo-only
  docs (`docs/`) are no longer shipped in the tarball (PRD §8.13).
- **Adopter integration guide (`mailproof.context.md`) now ships.** The
  self-contained "wire mailproof correctly without reading the source" reference
  (every `create()` option, the full public API + `ingest()` result shape, the
  plus-tag address space, the `composeNotification` contract + 12 occasion
  `kind`s, the threat model, gotchas, constraints) is added to `files` so it
  reaches adopters via npm. Refreshed to current reality (published 0.7.0; the
  m7c-6 public `verify+`/`reverify+` email endpoints + their report kinds; types
  generated-on-publish). Per `LIBRARY_CONVENTIONS.md` §3–4, the adopter's
  complete picture is README + `mailproof.context.md`; `docs/` + `CLAUDE.md`
  stay repo-only.
- **m7c-6: public verification email endpoints wired through `ingest()`.** The
  verify primitives (`verify()`/`reverify()`) are now reachable from inbound
  mail, not just as library calls. `ingest()` routes `verify+<id>@` (read-only:
  match a forwarded original to a committed reply + DKIM re-verify against the
  archived key — **never commits**) and `reverify+<id>-<seq>@` (contested-commit
  re-evaluation — persists its own immutable reverify record), each emitting a
  neutral `verify_report` / `reverify_report` occasion through the shared
  `deliver()`/`composeNotification` seam (report prose is policy, §8.6). The
  forwarded original is recovered transiently via a new
  `parse.extractVerifyCandidates(raw)` (attachment content + message-id; hashed
  and discarded, never persisted — SPEC §6 governs the ledger, not a read-time
  match). New `tests/integration/verify-endpoint.test.js` (4 tests, incl. an
  end-to-end trust upgrade through the email path) + 2 template unit tests.
  Brings the occasion taxonomy to **12 kinds**. With m7c-6 the verification
  surface is reachable from email, matching gitdone's #19/#20. See
  decisions-log 2026-05-28.
- **Centralised default email surface (`src/templates.js`).** One pure
  `renderDefault(kind, ctx) → { subject, defaultBody }` (+ `statsBody`) owns the
  neutral default subject/body for all 10 emitted occasions (`activation`,
  `advance`, `reassigned`, `stats`, `bounce`, `ack`, `completion`, `archived`,
  `overdue`, `proof_anchored`). Producers (`ingest`/`create`/`sweep`/
  `proof-anchor`) spread it into `deliver()` instead of inlining copy at each
  call site — mirrors the organisation gitdone reached with `email-bodies.js`,
  but the copy stays **generic and brand-free** (no product tag / host names /
  verify-CLI). The `composeNotification(ctx)` override seam is unchanged, so
  branded prose remains policy (§8.6 intact). New unit suite
  `tests/unit/templates.test.js` (8 tests) pins the per-kind shape + the
  brand-free invariant. See decisions-log 2026-05-28.
- **P2 Step 1: gitdone→mailproof boundary audit.** Read-only API audit
  (`docs/03-logs/audit-p2-step1-gitdone-boundary.md`) classifying every
  `gitdone/app/src/` module + `bin/receive.js` into Bucket A
  (depend-on-mailproof) / B (reimplement-as-policy) / C (gap-mailproof-needs),
  with the behavioural deltas the lift introduced enumerated. 11 gaps
  catalogued, 3 Tier-1 load-bearing (revoke, strict-signing attestation,
  `reference_docs` + manifest freezing). Reconverge verdict: MEDIUM-LARGE
  (3-5 weeks).

### Changed
- **Neutral default email copy upgraded** (richer, still generic) as part of
  the `templates.js` lift. Notably the two `remind+` reuse-paths now read
  `Reminder — action needed: <title>` / `Reminder — signature requested:
  <title>` (was `Reminder: <title>`); `defaultStatsBody` moved out of
  `ingest.js` and the inline bounce recipient/diagnostic rendering moved into
  the template (producers pass `ctx.failed`). No public-API change; any
  consumer overriding bodies via `composeNotification` is unaffected.
- **P2 validation runs as a non-merging gitdone branch (PRD §7.1, decisions-log
  2026-05-28).** Revises the canonical "P2 = refactor gitdone onto mailproof"
  reading of DESIGN.md's phasing. Two steps: (1) read-only API audit producing
  one boundary table across `gitdone/app/src/` (every capability classified
  `depend-on-mailproof` | `reimplement-as-policy-on-hooks` |
  `gap-mailproof-needs`, plus the behavioural deltas the lift introduced); (2)
  gitdone-on-mailproof on a dedicated branch that is **never intended to
  merge** — a validation harness whose purpose is surfacing every gap mailproof
  has against gitdone's full corner-case surface and feeding kernel-side fixes
  back to mailproof's `main` (possibly an `m7e`). gitdone's `main` stays
  untouched. Boundary proof = the branch reaching gitdone-test parity; the
  PRD's primary success metric (a non-gitdone consumer) is unchanged.
  Rationale: protects gitdone's production stability while validating
  mailproof's kernel against a real, corner-case-rich consumer. DESIGN.md §
  Phasing updated to point at PRD §7.1.

## [0.6.1] - 2026-05-28

### Changed
- **Canonical `isComplete(event)` + `signatures(event)` — drift-prevention DRY
  pass.** Lifted in spirit from gitdone's 2026-05-28 fix where three sites read
  `event.completion` differently and disagreed for crypto-closed-early (their
  fix: one canonical `isClosedByInitiator(event)` helper). Same pattern was
  present in mailproof for "is this event complete?": `event.status ===
  'complete'` was re-derived inline at 5 sites (`ingest.js`, `sweep.js`,
  `event-store.js editEvent`, `proof-anchor.js`) plus byte-identical
  duplicates in `completion.js` / `crypto.js`. **Now one definition** —
  `isComplete(event)` exported from `event-store.js` (schema-level: every
  engine writes `event.status` there); both engines re-export it (public API
  preserved: `completion.isComplete`, `crypto.isComplete` still work); every
  consumer imports the canonical helper. Same pass unified the 4 inline
  `Array.isArray(event.signatures) ? event.signatures : []` accesses in
  `ingest.js` to `cryptoEngine.signatures(event)` (the engine's existing
  canonical helper — also previously duplicated). Behaviour-preserving; per
  [[prefers-simple-one-source-of-truth]]. **Tests stay 290 / 0 fail.**
  Future-tense rules captured in the Step-1 audit doc: when `close+` ships
  (audit Gap #2), define `isClosedByInitiator(event)` from day one; when
  revoke ships (Gap #3), define `revokedHashSet(event)` from day one. Same
  drift-pattern, same one-definition rule.

## [0.6.0] - 2026-05-28

### Added
- **Triggers pillar widens — m7d-1: time-driven occasions (`sweep()`).** The
  trigger pillar grows from "fire the next email on an inbound reply" to also
  emitting the occasions that fall out of the passage of TIME, executing the
  locked occasions-are-kernel / bodies-are-policy boundary (decisions-log
  2026-05-27). `create()` returns a new `sweep({ now? })` — a consumer-scheduled
  scan (the schedule is the consumer's) that derives and emits two occasions:
  - **`overdue`** — an active event idle past `overdueDays` (default 14) past its
    reference clock: ONE neutral nudge to the initiator, idempotent via
    `event.nudged_overdue_at` (bookkeeping only — not mirrored to the repo).
  - **`archived`** — idle past `archiveDays` (default 45): a STATE TRANSITION
    (`archived_at` + `archive_reason: 'auto_stale'`) persisted to the master JSON
    **and mirrored into the per-event ledger**, plus a neutral notice to the
    initiator. `sweep()` returns `{ overdue, archived, notified }`.
  - **Shared notifier (`src/notify.js`, `createNotifier` → `deliver`).** The
    notification seam was extracted out of `ingest.js` so **every** occasion —
    workflow `advance` / crypto `ack` / `completion` *and* `overdue` / `archived`
    (and the m7d occasions to come) — fires through ONE `deliver`, with
    `composeNotification(ctx)` (keyed by `kind`) the single body hook. One source
    of truth for occasion→email; ingest's behaviour is unchanged.
  - **Ported from gitdone's `app/src/sweep.js`**, trimmed to the kernel boundary:
    the `config` singleton becomes injected `overdueDays`/`archiveDays`; the send
    goes through `deliver` instead of a bespoke binary; predicates re-anchored to
    mailproof's shape (`type==='workflow'`, `status==='complete'`). **Deferred to
    m7d-2** (activation lifecycle): the pending-activation TTL-delete + about-to-
    expire reminder passes. **Divergence** (simpler, justified in the module
    header): archive takes precedence over a same-tick overdue — no point nudging
    an event being archived — one fewer wasted email than gitdone's two
    independent passes.
  - New `eventStore.listEventIds()` (enumerate events for the scan). The pure
    `referenceClockMs`/`isActive` are re-exported.
  - Tests: `tests/unit/sweep.test.js` (7 — the pure clock + active-cohort
    predicates) and `tests/integration/sweep.test.js` (8 — overdue-once +
    idempotency, archive transition persisted + ledger-mirrored, archive-over-
    overdue precedence, deadline-driven reference clock, not-yet-due no-op,
    `composeNotification` body override, custom thresholds) against the real
    store + ledger + a fake capture transport. **237 → 252, 0 fail.**
- **Triggers pillar — m7d-2: organiser-action occasions (activation + edit).**
  `create()`'s `activateEvent`/`editEvent` are now bound wrappers that run the
  (pure) store transition, then emit the resulting occasion through the shared
  `deliver`, appending `notified` to the return:
  - **`activation`** — on the FIRST `activateEvent`, ping every initially-eligible
    participant (workflow: `eligibleSteps`) / listed signer (crypto). Idempotent
    (a re-activate notifies no one). Open crypto events have no roster, so they
    notify no one — the initiator distributes the `attest+` link themselves.
  - **`reassigned`** — on `editEvent`, ping a participant moved ONTO a currently-
    eligible step of an ACTIVATED event. A blocked step's new owner is pinged
    later via `advance`; a pending event's edits and non-participant edits ping
    no one.
  - **Boundary refinement (supersedes m7d-1's "deferred to m7d-2" line):** the
    pending-activation TTL-delete and about-to-expire reminder are NOT lifted —
    they presuppose the magic-link self-activation UX mailproof dropped, so they
    are consumer policy (whole-event deletion is the consumer's lever per the
    privacy decision; a draft-idle reminder is composable on `listEventIds` +
    the shared notifier). Recorded in the decisions log.
  - Tests: `tests/integration/activation-edit.test.js` (7 — sequential/parallel/
    crypto/open activation, idempotency, eligible/blocked/pending/non-participant
    edit re-notify). **252 → 259, 0 fail.**
- **Triggers pillar — m7d-3: inbound bounce (DSN) → the `bounce` occasion.**
  `src/dsn.js` — an RFC 3464 delivery-status-notification parser (PURE,
  stdlib-only): `isDeliveryStatusReport` / `extractDsn` / `permanentFailures`
  (+ `parseDeliveryStatusBody` / `stripAddressType` / `contentTypeOf`). `ingest()`
  now recognises a DSN from the header block **before** the humans-only prefilter
  (which would otherwise reject the machine-generated report), routes it to the
  event/step, records a per-step send error (`recordStepSendErrors`), and emits
  the `bounce` occasion to the initiator. A bounce is **operational, not a
  participant reply** — it is *never* committed to the ledger.
  - **Ported from gitdone's `app/src/dsn.js`**, re-anchored to operate on RAW
    bytes (gitdone keyed off mailparser's `parsed.headers`, which mailproof's
    `parseMessage` intentionally doesn't expose; mailparser also folds
    message/delivery-status into `.text`) — so the parser is self-contained and
    adds no dependency. **Routing divergence:** mailproof signs outbound mail
    *from the plus-tag* (`event+{id}-{step}@` / `attest+{id}@`), so a bounce's
    return path — its inbound envelope recipient — *is* that tag; ingest routes
    by the address it already parses (VERP-style), rather than gitdone's
    fixed-sender + body inspection. Only **permanent** failures (Action: failed,
    or a 5.x status when Action is absent) alert; transient `delayed` (4.x)
    reports are ignored.
  - Tests: `tests/unit/dsn.test.js` (10 — the pure parser: detection incl. folded
    headers, recipient/status/diagnostic extraction, permanent-vs-transient,
    address-type stripping, multi-recipient blocks) and
    `tests/integration/ingest-bounce.test.js` (4 — route + step-error + notify +
    not-committed; transient no-op; untagged/unknown-event reported-not-routed;
    crypto event notifies without a step error). **259 → 273, 0 fail.**
- **Triggers pillar — m7d-4: OTS proof anchoring + the `proof_anchored` occasion.**
  `create()` exposes `upgradeProofs({ now? })` — a consumer-scheduled pass that
  walks every event's repo, drives **m7c-4's `ots.upgradeProof`** across each
  pending `.ots` proof, records the anchored state into the ledger, and emits
  `proof_anchored` to the initiator when an event newly crosses fully-Bitcoin-
  anchored. Only stood up when `otsBin` is configured (otherwise `undefined`).
  - **Ledger recording (`gitrepo.commitProofUpgrade`)** — patches the sibling
    commit JSON with `ots_anchored: true` + `ots_anchored_at` + (when known)
    `ots_block`, git-adds the upgraded proofs AND the patched JSONs, writes ONE
    summary commit per event. Idempotent backfill: a re-run on already-anchored
    proofs writes nothing if nothing actually changed. Plus
    `gitrepo.listProofFiles(eventId)` (basename map `commit-NNN.ots ↔
    commit-NNN.json`, `reverify-NNN.ots ↔ reverify-NNN.json`, `completion.ots ↔
    completion.json`).
  - **`proof_anchored` once-only** — gitdone's `.anchored-notified` SENTINEL
    FILE becomes a top-level `event.ots_proof_anchored_notified_at` flag (same
    store as the sweep flags — one source of truth). Gated on `status==='complete'`
    (collapses gitdone's `completion.status || threshold_reached_at`), at least
    one proof NEWLY anchored this run (a pure backfill never re-sends), and no
    proofs still pending.
  - **Concurrency:** the slow per-file `ots upgrade` runs OUTSIDE the per-event
    mutex (talks to calendar servers); the ledger commit + the flag flip happen
    INSIDE one mutex section per event, so they can't race with a concurrent
    ingest writing into the same `.git`. The send fires outside the lock.
  - **Ported** from gitdone's `app/bin/ots-upgrade.js` `processRepo`/`run` +
    `notifyProofAnchored` gate, trimmed to the kernel boundary: no `bin/` cron
    glue, no notify-bodies (the `composeNotification` seam owns the body).
  - Tests: `tests/integration/proof-anchor.test.js` (6 — pending no-op, fresh
    anchor → patch + emit + idempotent re-run, mixed proofs hold the notify
    until all anchored, incomplete event records but doesn't emit, no-repo
    skipped, composition guards). Stub-`ots` injection exercises the
    orchestration without subprocesses (the real `upgradeProof` is m7c-4's
    integration test). **SPEC §4 corrected** (the OTS section no longer says
    "the consumer's scheduler" — `upgradeProofs` is the kernel mechanism).
    **273 → 279, 0 fail.**
- **Triggers pillar — m7d-5a: richer `completion` ctx (ledger-sourced receipts).**
  The completion-edge `composeNotification(ctx)` now sees `countedCommits`
  (number) + `receipts` (one entry per counted reply commit, ordered by
  sequence). Each receipt carries `{sequence, received_at, step_id,
  sender_domain, sender_hash, trust_level}` — enough to render the proof block
  the durable completion email is meant to embed (PRD §0.1.4 "the proof comes
  to the user"). **One source of truth:** receipts are read straight from the
  per-event git ledger we just finalised (`gitrepo.listCommits` → filter to
  `kind:'reply' && counted`), so the kernel never builds a parallel index of
  counted replies. **Privacy posture preserved (SPEC §6):** senders stay
  salted-hashed in flight — receipts expose `sender_hash` + `sender_domain`,
  never plaintext. Best-effort: a ledger read failure yields empty receipts so
  the completion notification is never undone by a read. Lifted from gitdone's
  `filterCountingCommits` (`app/bin/receive.js`) in spirit; trimmed to the
  kernel boundary (workflow-vs-crypto filtering collapses because the commit
  metadata already carries `counted`/`kind:'reply'` — gitdone's per-mode
  step/threshold/attestor walking is policy). Tests:
  `tests/integration/ingest-triggers.test.js` +2 (workflow 2-step completion
  carries 2 receipts ordered s1/s2; crypto sign-off carries 1 receipt with
  `step_id:null`). **279 → 281, 0 fail.**
- **Triggers pillar — m7d-5b: initiator commands (`remind+`, `stats+`).**
  `ingest()` now dispatches the initiator-command plus-tags before the
  participant-reply tags. `parseInitiatorCommand` (lifted in module 2) is
  wired through `create()`; auth matches gitdone's
  `authenticateInitiatorCommand` — DKIM-verified + envelope sender ==
  `event.initiator` (PRD §6.4). A non-initiator returns
  `{ authenticated:false, reason:'sender_not_initiator' }`, an unverified reply
  returns `reason:'unverified'`. Never committed to the ledger (operational,
  like `bounce`).
  - **`remind+{id}@` reuses existing kinds + `ctx.reminder=true`** (the user-
    confirmed shape — one body hook keyed by kind; policy distinguishes via
    flag; fewer kinds = simpler). Workflow remind re-fires every currently-
    eligible step through `kind:'advance'` — same recipients as a cascade-
    advance, matching gitdone's `notifyWorkflowParticipants({reminder:true})`.
    Crypto remind re-fires every listed signer that hasn't yet signed through
    `kind:'activation'` — same recipients as the activation kickoff (the
    semantically right reuse: "still need your signature" IS the kickoff
    message; `ack` is post-reply receipt and inverts here). Open crypto has no
    roster, so remind ends up a no-op (the initiator owns distribution). An
    already-complete or archived event short-circuits with
    `reason:'already_complete'`, no sends.
  - **`stats+{id}@` returns a kernel snapshot AND sends a neutral default reply**
    (`kind:'stats'`). The snapshot — `{eventId, type, title, status,
    activated_at, archived_at, completed_at, flow?, steps?, threshold?, open?,
    signers?, signatureCount?}` — is `loadEvent(id)` reshaped into a stable
    surface; the default body is a plain ASCII dump of that snapshot
    (gitdone-parity shape: checkbox step list / sig-progress, mirroring
    gitdone's `statsBody`). The snapshot also rides on `ctx`, so a consumer's
    `composeNotification` keyed on `kind:'stats'` overrides the prose — same
    body-hook seam as every other kind, branding stays policy (§8.6). Adds the
    10th occasion kind to the m7d taxonomy.
  - Tests: `tests/integration/ingest-initiator-command.test.js` (8) — workflow
    remind hits both eligible steps with `ctx.reminder=true`; crypto remind
    skips the already-signed signer; stats returns the snapshot AND auto-sends
    the neutral default reply (with body assertions); the composeNotification
    override for `kind:'stats'` wins over the default; auth rejects
    non-initiator + unverified; already-complete + unknown-event
    short-circuit. **281 → 289, 0 fail.**
- **Triggers pillar — m7d-5c: m7d end-to-end test (every kernel occasion in one
  composition).** `tests/integration/m7d-e2e.test.js` drives the full trigger
  surface through ONE `create()` instance against real I/O (real outbound to a
  fake `sendmail`, real per-event git repos, a small fake `ots` binary that
  simulates `stamp`+`upgrade`+`info`). Not a re-proof of each occasion's
  contract — every kind has its own dedicated test — but a proof of the
  COMPOSITION: every kernel-derivable occasion fires through the same
  `deliver()` seam, keyed by `kind`, over a single bound notifier. Asserts
  every one of `activation`, `advance`, `ack`, `stats`, `completion`,
  `overdue`, `archived`, `bounce`, `proof_anchored` is seen by
  `composeNotification`, and that `remind` reuses `kind:'advance'` (workflow)
  with `ctx.reminder=true`. Crypto event uses `threshold:2` so the first
  counted reply produces `ack` without completion; a separate event exercises
  `archived` (archive precedence prevents `overdue`+`archived` racing on the
  same id in one sweep tick). m7d is now COMPLETE — the trigger pillar emits
  every kernel-derivable occasion (10 kinds; `remind` is a flag on
  `advance`/`activation`). **289 → 290, 0 fail.**

### Fixed
- **`editEvent` completeness guard reads top-level `status`.** It refused edits
  on a complete event via `event.completion.status` — gitdone's nested shape,
  which mailproof never writes (the completion/crypto engines and `sweep`'s
  `isActive` use top-level `status === 'complete'`). The guard never fired on a
  real completed event; the test passed only because it built the event with the
  legacy shape. Now reads `event.status` (the engines' field) — one source of
  truth, and a prerequisite for m7d-2's edit-renotify not firing on a done event.

## [0.5.0] - 2026-05-27

### Added
- **Verify pillar, m7c-1: durable DKIM-key archive + auth summaries on commit
  (gitdone parity).** `src/dkim-archive.js` (lifted, generic, config-free):
  `fetchDkimKey` (resolves `{selector}._domainkey.{domain}` via the INJECTED
  resolver, extracts `p=`, wraps SPKI in PEM), `pickSignatureToArchive`,
  `extractPublicKey`, `toPem`. `parse.js` gains pure **`summariseAuth(auth)`** →
  `{ dkim, spf, dmarc, arc }` (DKIM per-signature result/domain/selector/aligned;
  SPF/DMARC verdicts; ARC chain depth). `ingest()` now, right after authenticate
  (still outside the event lock), computes the summaries and best-effort archives
  the signer's public key, then records both on the commit via the existing
  `commitReply` ctx (`dkim`/`spf`/`dmarc`/`arc` + `dkimArchive` → `dkim_key_file`
  + `dkim_archive`). This is what lets a commit re-verify OFFLINE after the signer
  rotates DNS — the substrate for the `verify+`/`reverify` endpoints (m7c-2/3).
  Re-exported from `src/index.js`. Tests: `tests/unit/dkim-archive.test.js`
  (parse/PEM/pick + `fetchDkimKey` via offline resolver, error paths) +
  `tests/integration/ingest.test.js` (a verified reply records the DKIM summary +
  archives the key on its commit). 203 → 209, 0 fail.
- **Verify pillar, m7c-2: offline durable verification.** `src/verifier.js` —
  `createVerifier({ gitrepo, eventStore, resolver })` → `verify(eventId, bytes,
  { messageId?, resolver? })`, exposed as **`core.verify()`**. Two lifted kernel
  primitives (gitdone's verify.js/reverify.js, trimmed — report *formatting* stays
  policy §8.6): **`findMatch`** (re-hash a candidate against committed
  `raw_sha256` → salted `message_id_hash` → attachment hashes, one
  `sha256:`-tagged format end to end) and **`reverifyDkim`** (re-run mailauth DKIM
  against the ARCHIVED PEM via a resolver that serves the archived key and
  delegates everything else to an injected base resolver — so the signature
  re-verifies OFFLINE, even with live DNS down, after the signer rotates keys).
  `gitrepo` gains **`loadDkimPem`** (allowlisted to `dkim_keys/commit-*.pem`).
  Re-exported from `src/index.js` (`createVerifier`, `findMatch`, `reverifyDkim`).
  Tests: `tests/unit/verifier.test.js` (the `findMatch` cascade + precedence) +
  `tests/integration/verifier.test.js` (ingest a signed reply → re-verify the
  exact bytes against the archived key with **live DNS disabled**; tampered ⇒
  no match; attachment-hash match; unknown event). 209 → 218, 0 fail.
- **Verify pillar, m7c-3: contested-commit `reverify` + trust upgrade.**
  `verifier.js` gains pure **`resolveUpgrade`** (below-`verified` → `verified` on a
  DKIM pass; already-verified records the attempt, no upgrade) and **`pickSigner`**
  (the commit's signing domain/selector), plus **`reverify(eventId, targetSeq,
  rawEml, { resolver? })`** (exposed as **`core.reverify()`**): re-runs DKIM against
  the target commit's archived key and, on a pass, upgrades the recorded trust —
  persisting an **immutable** `reverify-NNN.json` via new **`gitrepo.commitReverify`**
  (separate sequence namespace; the original `commit-NNN.json` is never rewritten;
  OTS-stamped like a reply). Re-exported from `src/index.js`. Tests:
  `tests/unit/verifier.test.js` (`resolveUpgrade`/`pickSigner`) +
  `tests/integration/reverify.test.js` (a non-aligned commit recorded `unverified`
  upgrades to `verified` against the archived key with live DNS disabled; an
  already-`verified` commit records the attempt without upgrading; missing target
  ⇒ `found:false`). 218 → 223, 0 fail.
- **m7c-5: kitchen-sink end-to-end proof.** `tests/integration/e2e.test.js` drives
  a FULL lifecycle of each mode through the public `create()` API against the real
  ledger + mailauth + a fake capture transport — the "all the pillars compose"
  proof before the gitdone reconverge. Workflow: two sequential steps advance
  themselves (advance→completion triggers) to completion, salted-at-rest is
  asserted (no plaintext sender on the ledger), and step 1's email re-verifies
  offline. Crypto: an open threshold-2 sign-off counts two distinct verified
  signers, rejects the initiator's self-reply (`initiator_self_reply`) and a
  duplicate (`already_signed`), and locks — acking the signer + notifying the
  initiator, with the ledger showing `counted` `[true,false,false,true]`. The
  m7c verification surface is now complete bar **m7c-4** (OTS-proof verification,
  skip-gated on the `ots` binary). 223 → 225, 0 fail.
- **Verify pillar, m7c-4: OTS-proof verification (Bitcoin-anchor upgrade/read).**
  `createOts` gains `upgradeProof(abs)` and `readBlockHeight(abs)`, plus the pure
  `parseOtsBlockHeight` (re-exported from `src/index.js`) — **ported from
  gitdone's `bin/ots-upgrade.js` worker**, trimmed to the kernel primitive.
  `upgradeProof` runs `ots upgrade` in place and treats the proof file's sha256
  *changing* as the authoritative "now anchored in Bitcoin" signal
  (`{ ok, changed, anchored, pending, exit, block_height? }`); `readBlockHeight`
  reads which block via `ots info` (local parse, **no network**).
  - **Follows gitdone's proven design:** we do NOT shell out to `ots verify`
    (which masks pending state by querying calendars live) — the upgraded `.ots`
    carries the Bitcoin attestation offline, so the upgrade-changed-the-file
    signal is the trust anchor. `ots upgrade`'s non-zero exit on a still-pending
    proof is modelled as `{ pending: true }`, **not** an error (accept-with-flag).
  - **Left in the worker (policy/glue → m7d):** the `$dataDir/repos/*` walk, the
    per-repo git-commit batching, `patchCommitJsonAnchored` (writing `ots_anchored`
    into the ledger), the `.anchored-notified` sentinel, and `notifyProofAnchored`.
    The event-level "upgrade an event's proofs + record anchored + emit the
    `proof_anchored` occasion" is m7d, riding the `composeNotification` seam.
  - Tests: `tests/unit/ots.test.js` (8 — the pure parser across every
    opentimestamps-client output shape + null/degenerate cases) and 4 added to
    `tests/integration/ots.test.js` (binary-missing → `{error}`/`null`, never
    throws; + real-`ots` smoke tests, skip-gated on the client, asserting a
    non-proof input reports `pending`/`null` and leaves the file untouched). The
    fully-confirmed-proof path stays deployment-verified (needs ~1h of Bitcoin
    confirmations). **225 → 237, 0 fail. The 9-point gitdone-rebuild checklist is
    now fully covered — OTS-proof verification was the last gap.**

## [0.4.0] - 2026-05-27

### Added
- **Assembly prep, module 7b-1: accept-with-flag commit fields + `commitCompletion`.**
  The storage slice the `ingest()` pipeline (m7b) needs, landed first because it
  is independent of the pipeline wiring.
  - `buildCommitMetadata` now emits `kind: "reply"` and the **accept-with-flag**
    pair `counted` / `count_reason` (SPEC §4) — previously omitted. Invariant
    enforced in one place: `counted ⇒ count_reason: null`; an absent flag
    defaults to `counted: false` (never `undefined`). The orchestrator computes
    these from the engine's decision before the commit is written.
  - `commitCompletion(eventId, event, { completedAt, triggeringSequence, summary? })`
    **lifted from gitdone** (deferred since m5b): writes the one-shot
    `commits/completion.json`, idempotent (a second call is a no-op), OTS-stamped
    via the same `maybeStamp` path as replies. gitdone's per-mode `event_mode`
    is **dropped** (the two-mode model has no `mode`; `event_type` suffices).
  - Tests: `tests/unit/gitrepo.test.js` (kind/counted/count_reason incl. the
    invariant + defensive default) and `tests/integration/gitrepo.test.js`
    (real repo: completion.json written once, idempotent, `event_mode` absent).
- **Assembly prep, module 7b-2: two-mode `createEvent` + the `attest+` route.**
  - `event-store.js` gains two pure, exported helpers: **`expandFlow(steps, flow)`**
    turns the `flow` sugar into the canonical per-step `dependsOn` graph the
    engine reads (sequential → linear chain, parallel → no deps, custom →
    verbatim — the engine has ONE eligibility model, so `flow` exists only at
    creation, SPEC §3); **`buildEventRecord(partialEvent)`** normalizes a
    caller's partial event into the canonical two-mode record (workflow §3 /
    crypto §3.1) with structural-only validation — rejects an unknown `type`, a
    workflow step without a unique id, a crypto event with `threshold < 1` or
    with neither `signers` nor `open` (nothing could ever count). `createEvent`
    is now a thin writer over `buildEventRecord` (collision check + atomic
    write); crypto events init `signatures: []`, signers are lowercased.
  - **`router.parseAttestTag`** (`attest+{eventId}@`, no step component) — the
    crypto sign-off route, **promoted from a policy tag to a kernel tag** (SPEC
    §2; deferred here from m6.7, now that it's exercised). `attach+`/`revoke+`/
    `manage+`/`close+`/`bundle+` stay dropped.
  - **Fixed a stale value**: the event-store integration tests used the gitdone
    `type: 'event'` literal; the canonical mailproof value (SPEC §3, PRD §4.2,
    every other test) is `'workflow'`. `buildEventRecord`'s type validation
    surfaced it; the 14 occurrences are corrected.
  - Tests: `tests/unit/event-store.test.js` (`expandFlow` 3 flows; `buildEventRecord`
    workflow/crypto normalization + every validation throw), `tests/unit/router.test.js`
    (`parseAttestTag` accept/reject), `tests/integration/event-store.test.js`
    (both modes normalize + persist to disk). 174 → 185, 0 fail.
- **Assembly, module 7b-3 (Commit A): the `create()` composition root.**
  `src/create.js` — `create({ dataDir, domain, sendmailBin?, otsBin? })` wires
  the four pillars into ONE bound instance: it composes `createOts` (only when
  `otsBin` is set) → `createGitrepo` → `createEventStore` → `createNotary` over a
  single `dataDir`, so config is injected here and nowhere else (decisions log,
  "Config injection by bound per-pillar factories"). Returns the create/read/verify
  surface — `createEvent`, `activateEvent`, `editEvent`, `loadEvent`, `listCommits`,
  `loadCommit`, `verifyDocument`, `hashDocument`. `dataDir`/`domain` are required
  (validated at composition); `sendmailBin`/`otsBin` are optional. **`ingest()` is
  deferred to Commit B** (the inbound verify→route→commit→advance→trigger pipeline,
  added to this same returned object). Re-exported from `src/index.js`. Tests:
  `tests/integration/create.test.js` drives the real store + ledger + notary on a
  tmp dir (validation, surface shape, both-mode `createEvent`↔`loadEvent` round
  trip, notary/gitrepo sharing the bound dataDir, otsBin-optional). 185 → 191, 0 fail.
- **Assembly, module 7b-3 (Commit B): the `ingest()` core.** `src/ingest.js` —
  `createIngest(deps)` returns `ingest(raw, envelope)`, the one path every inbound
  reply takes (mailproof's answer to gitdone's NOT-lifted `receive.js main()`):
  **prefilter** (humans-only gate; non-human mail returns `routed:false`, never
  committed) → **decode** (`parseMessage` + `authenticateMessage`) → **classify**
  trust → **route** by plus-tag (`event+`→workflow, `attest+`→crypto) → **load** →
  **match** (workflow `participant_match`; crypto `signer_match` + `is_initiator`,
  resolved from the lowercased plaintext sender, never persisted) → **commit ALWAYS**
  (accept-with-flag: the engine's `shouldCount` verdict drives both the commit's
  `counted`/`count_reason` and the transition) → **advance** (`applyReply`, routed
  by mode) → **persist** master JSON + repo mirror → **`commitCompletion`** on the
  newly-complete edge → return a summary `{ routed, mode, eventId, trustLevel,
  committedSeq, counted, count_reason, completedStep|signatureCount, eventComplete,
  notified }`. The whole load→commit→advance→persist section runs inside ONE
  `withEventMutex(eventId)` (the in-process mutex is non-reentrant and `commitReply`
  allocates its sequence by reading the dir, so concurrent replies must serialise);
  DNS-bound auth stays outside the lock. **The trigger/send layer is deferred to
  Commit C** — `notified` is always `[]` here.
  - `event-store.js` now exposes **`writeEventAtomic(eventId, event)`** — the raw
    (mutex-less) atomic master writer `ingest` needs from inside the lock it
    already holds (the mutex-taking `activateEvent`/`editEvent` would deadlock).
  - `create()` gains optional **`mtaHostname`** + **`resolver`** (threaded into
    mailauth) and composes + returns `ingest`. `resolver` lets tests authenticate
    offline; production uses the system resolver.
  - Tests: `tests/integration/ingest.test.js` drives the real store + ledger +
    both engines + the real mailauth/mailparser decode path offline (workflow
    count→complete, crypto verified sign-off→lock, accept-with-flag for
    wrong-participant + unverified-trust + initiator self-reply, prefilter drop,
    unknown-event + tagless). New TEST-ONLY `tests/helpers/dkim.js` (per-call
    keypair + `signDkim` + matching in-process resolver → `verified` offline).
    191 → 198, 0 fail.
- **Assembly, module 7b-3 (Commit C): the trigger/send layer + `composeNotification`
  hook — m7b-3 (and the m7b assembly) COMPLETE.** `ingest()` now closes the
  email loop: on a COUNTED reply it sends the next neutral notification(s) via the
  injected `sendmailBin` (real `buildRawMessage` + `sendmail`), OUTSIDE the event
  lock, and reports them in the result's `notified` array.
  - **What fires:** workflow → ping the participant(s) of every step that just
    became eligible (`eligibleSteps` whose `dependsOn` includes the completed
    step); crypto → ack the verified signer; both → notify the `initiator` on the
    completing edge. Non-counting replies send nothing. Each message's `From` is
    the plus-tagged reply address (`event+{id}-{step}@`, `attest+{id}@`) so the
    recipient's reply routes straight back; `Auto-Submitted: auto-generated` marks
    it machine-sent. No `proof_email_sent_at` idempotency state is needed — the
    distinct-only kernel completes an event exactly once (a later reply hits
    `already_complete`), so the completion notice can't double-fire (gitdone's
    revoke/reopen re-fire guard stays policy).
  - **`composeNotification(ctx) → body`** — the ONE optional hook (branding is a
    NO-GO §8.6, so the body needs a consumer seam). `ctx` carries
    `{ kind: 'advance'|'ack'|'completion', mode, eventId, event, to, replyAddress,
    step?|signatureCount? }`; a falsy return (or absent hook, or a throw) falls
    back to a neutral default body. Subjects are kernel-defaulted. No
    `onCounted`/`onRejected`/`onCompleted` hooks — redundant with the `ingest()`
    return value.
  - `create()` gains the optional `composeNotification` param and threads the
    outbound builders + `sendmailBin` into `ingest`.
  - Tests: `tests/integration/ingest-triggers.test.js` drives the real outbound
    path to a fake capture binary in tmp (workflow advance→completion, crypto
    ack+completion, no-send on non-counting, `composeNotification` override vs
    neutral default, graceful `ok:false` when `sendmailBin` is absent). New
    `verifiedSigner` helper (one keypair/resolver signing many senders @one
    domain). 198 → 203, 0 fail.
- **`mailproof.context.md`** — the dense AI-assistant/developer integration guide
  (modeled on knowless's): both modes, `create()` options, the `create()` return
  surface + `ingest()` result shape, the accept-with-flag invariant, trust levels,
  the `composeNotification` hook, the four-pillar architecture, the
  what's-NOT-in-mailproof policy boundary, gotchas, and constraints.

## [0.3.0] - 2026-05-26

### Added
- **Verify + inbound pillar, module 7a: inbound decoder + the first external
  deps.** `src/parse.js` (`authenticateMessage`, `parseMessage`) — the two
  primitives gitdone composed inline in `bin/receive.js` (the orchestrator,
  **not lifted**), extracted as standalone functions.
  - **First 2 runtime deps: `mailauth` (DKIM/DMARC/ARC) + `mailparser` (MIME).**
    Both passed the AGENT_RULES External Dependency Checklist: DKIM/MIME of
    untrusted input is security-critical (a vetted lib is *required*, never
    hand-rolled), both are actively maintained by the Nodemailer author, and
    they are the same packages gitdone already ships — **no new supply-chain
    surface**. Budget 2 of ≤3 (the git ledger still uses the `git` binary, not
    `simple-git`). MIT-licensed.
  - `authenticateMessage(raw, envelope, { mtaHostname, resolver })` is a thin
    wrapper that **pins `trustReceived: false`** (mailproof never trusts
    pre-existing `Received`/`Authentication-Results` headers — forged headers
    are the attack) and injects `mtaHostname`/`resolver` as config (no env
    singleton). Its result feeds `classifyTrust` (m1).
  - `parseMessage(raw)` → `{ from:{address,name}, messageId, attachments, rawSha256 }`.
    **This is the notary's CAPTURE half** (deferred from m6.5): every inbound
    attachment is auto-hashed through `notary.hashDocument`, so committed
    `attachments[].sha256` is byte-identical to what `verifyDocument` recomputes
    — one fingerprint format across the kernel.
  - **Boundary correction:** the stash labelled this a `verify.js` lift, but
    `verify.js` is gitdone's `verify+{id}@` *endpoint* (forwarded-email report +
    reverify-against-archived-PEM); that endpoint, DSN bounce handling, and
    durable `dkim-archive` reverify are **deferred** to later modules.
  - Tests: `tests/unit/parse.test.js` — `parseMessage` over a fixture with a
    base64 attachment (asserts the notary-hashed sha256, size, `from`,
    `messageId`) and `authenticateMessage` run **offline** via an injected
    no-DNS resolver (asserts the result shape and that nothing authenticates →
    `classifyTrust` returns `unverified`). No network, no mocks of the deps.

## [0.2.0] - 2026-05-24

### Added
- **Sequence pillar, module 6: workflow completion engine.** `src/completion.js`
  (`shouldCount`, `applyReply`, `isComplete`, `firstPendingStep`, `stepDepsMet`,
  `eligibleSteps`, `meetsTrust`, `COUNT_REASONS`), lifted from gitdone's
  `completion.js` as **pure** state transitions (no I/O; `applyReply` returns a
  new event, never mutates).
  - **Trimmed to the workflow subset** per the §8 NO-GO table: dropped crypto
    declaration/attestation (§8.2), strict signing + `reference_docs` (§8.3),
    and revoke/threshold/dedup (§8.4) — `shouldCountDeclaration`,
    `shouldCountAttestation`, `applyDedup`, `applyRevoke`, the strict-signing
    matchers, and the attestor-progress/redaction machinery all stay in gitdone
    as policy on the hooks. The engine is **one `dependsOn` eligibility model** —
    no sequential/parallel code-path split.
  - **Re-anchored to SPEC** (not a verbatim lift): machine-code `count_reason`s
    via the exported `COUNT_REASONS` taxonomy (SPEC §4) instead of gitdone's
    English prose; **per-step `minTrust`** (gitdone used a per-event
    `min_trust_level`); top-level `status`/`completed_at` (not gitdone's nested
    `completion` object); camelCase `dependsOn`/`minTrust`; `type: "workflow"`.
    Trust ordering is **imported from `classifier.js`** (`TRUST_LEVELS`), not
    redefined — one source of truth.
  - `flow` (`sequential` default / `parallel` / `custom`) is stored for audit
    and affects only the reason label (`out_of_order` under sequential vs.
    `deps_unmet`); `createEvent` expands `sequential` into a linear `dependsOn`
    chain (wired in m7), so the engine never branches on flow for eligibility.
  - Document-hash *verification* is the notary (PRD §4.1, m6.5), explicitly **not**
    in this engine; `requires_attachment` here is only the generic "carried an
    attachment" gate. The completion ledger commit (`commitCompletion`) and
    cascade notifications are orchestration, wired in m7.
  - `tests/unit/completion.test.js` — 18 pure tests covering the full decision
    tree (every `count_reason`, the sequential/parallel/custom flow split,
    `requires_attachment`, the two-step→complete transition, input immutability,
    and the `eligibleSteps`/`stepDepsMet` predicates), re-anchored from gitdone's
    characterization suite (domains neutralized to `example.com`).
- **Verify pillar, module 6.5: document notary (verify half).** `src/notary.js`
  — `hashDocument(bytes)` (the canonical `sha256:`-prefixed fingerprint) and
  `createNotary({ gitrepo, eventStore })` → `verifyDocument(eventId, bytes,
  { email })`. **Net-new** primitive (NOT a gitdone lift — gitdone has only
  manifest-matching strict signing, which stays policy per §8.3), designed from
  PRD §4.1.
  - `verifyDocument` is **read-only over the ledger**: re-hashes a document,
    scans every committed reply (counted or not — accept-with-flag), and returns
    `{ found, matches: [{ sequence, received_at, trust_level, counted,
    sender_domain, sender_match, filename }] }`. With `email`, `sender_match`
    flags whether the verified sender (salted via `gitrepo.saltedSenderHash`)
    submitted it — the second layer; without it, `sender_match` is null.
  - Framed as a **proof-of-participation receipt, not a secret** (PRD §4.1): the
    DKIM-verified sender is the trust factor; a matching document only adds
    tamper-evident binding.
  - **`hashDocument` is the one source of truth for the fingerprint format** — m7's
    parser will hash inbound attachments through it, so committed
    `attachments[].sha256` matches what `verifyDocument` recomputes
    (`verifyDocument` also normalises a bare-hex vs `sha256:`-prefixed value
    defensively).
  - **Capture half deferred to m7:** mandatory auto-hashing of inbound
    attachments needs the parsed bytes, which only exist at the mailparser layer
    (m7); at commit time the ledger holds attachment metadata, not bytes. Building
    a capture enforcer now (no byte source) would be the speculative-code red
    flag — so the parser populates the hashes in m7 and this module reads them.
  - Tests: `tests/unit/notary.test.js` (pure `hashDocument` format/determinism +
    factory guards) and `tests/integration/notary.test.js` (real store + per-event
    repo: exact-match, the email layer's match/reject, tampered-doc and
    unknown-event non-matches — no mocks).
- **Sequence pillar, module 6.7: crypto sign-off engine.** `src/crypto.js`
  (`shouldCount`, `applyReply`, `isComplete`, `signatures`, `CRYPTO_REASONS`) —
  mailproof's **second coordination mode** (`type: "crypto"`, PRD §4.2),
  re-exported as `shouldCountSignoff` / `applySignoff`. Pure (no I/O, no crypto),
  parallel to `completion.js`.
  - **One parameterized engine, lifted from gitdone's `shouldCountDeclaration` +
    `shouldCountAttestation` + the `applyReply` crypto branches and collapsed**
    per the two-mode pivot: `signers` (allow-list or `open`), `threshold`
    (1 = single-signer *declaration*, N = count-to-goal), optional single
    `requiredDocHash` (the "email + doc" two-layer, in the notary's `sha256:`
    format). A reply counts iff activated/not-archived/not-complete, DKIM-`verified`,
    **not the initiator**, a matched signer, a *distinct* sender, and (if set) an
    attachment hash matches; the event locks at distinct count ≥ `threshold`.
  - **Trust hardcoded to `verified`, NOT per-event configurable** — crypto is the
    high-assurance mode; a forwarded/authorized reply must never stand as a
    signature.
  - **Initiator self-reply is committed for audit but never counts**
    (`initiator_self_reply`) — anti-self-dealing: the initiator orchestrates and
    cannot also be a verifier. (Events differ: there the initiator *may* be a
    counted participant.)
  - **Sender-identity resolution stays in the orchestrator** (like workflow's
    `participant_match`): the engine reads precomputed `signer_match` /
    `is_initiator` booleans and dedups on the salted `sender_hash`, so plaintext
    never reaches the engine or ledger (SPEC §6).
  - **Trimmed to the lean mechanism** per §8.2–8.4: dropped `revoke`,
    `latest`/`accumulating` dedup (distinct-only), multi-doc strict manifests +
    `reference_docs`, per-attestor progress buckets, and attestor-PII redaction —
    all stay gitdone policy. Re-anchored to SPEC: machine-code `count_reason`s,
    camelCase, top-level `status`/`completed_at` (not gitdone's nested
    `completion`). ~150 lines vs. completion.js's ~500.
  - Tests: `tests/unit/crypto.test.js` (declaration / distinct-count / initiator
    exclusion / trust gate / open mode / `requiredDocHash` / lifecycle / purity)
    including a **provable-trim** test that gitdone's dropped policy fields
    (`dedup`, `revoked_senders`, `reference_docs`, `mode`) are inert, not honored.
  - **Router `attest+{id}@` tag + SPEC §2 promotion deferred to m7b assembly**,
    where the route is exercised end-to-end — m6.7 mirrors how m6 landed
    (the engine, pure; the router untouched).

### Changed
- **Identity pivot: two generic coordination modes (PRD §1, §4.2).** A design
  conversation widened mailproof from "generic workflow only" to **events** +
  **crypto sign-off**, both on the DKIM-verified-email + notary substrate —
  "gitdone's engine, public." Crypto is **one parameterized engine**: `signers`
  (explicit email list *or* open via a shared `attest+{id}@`-style address — the
  "link" is an email address, **not** a web link/app/webhook), `threshold`
  (1 = single-signer declaration; N = count-to-goal), optional single
  `requiredDocHash`. **Lean by exclusion** — `revoke`, `latest`/`accumulating`
  dedup, multi-doc manifests, attestor-PII redaction, and the magic-link/web flow
  stay `gitdone` policy. This **supersedes** the "generic workflow only" decision
  and narrows NO-GO §8.2–8.4/§8.12; the m6 events engine is unchanged, crypto is
  an additive engine (m6.7) and `ingest()` routes by `type`. See the decisions log.
- **Scope locked: document-notary primitive (PRD §4.1).** A design conversation
  on using attachments for verification resolved to a minimal kernel notary —
  mandatory SHA-256 auto-hashing of inbound attachments + a read-only
  `verifyDocument(doc)` lookup — framed as a *proof-of-participation receipt, not
  a secret*. Distinct from gitdone's strict-signing (§8.3, still policy): the
  notary records and verifies, it never gates workflow completion. Outbound-doc
  hashing, `listDocuments`, and retrieval-gating are **deferred** (built only on
  a concrete need); **document-as-login / second factor is NO-GO** (§8.8). See
  the decisions log.

## [0.1.0] - 2026-05-23

### Added
- **P1 lift begins — verify pillar, module 1: trust classifier.**
  `src/classifier.js` (`classifyTrust` + `TRUST_LEVELS`), lifted from gitdone as
  a pure function and re-anchored to SPEC §1. First real `src/` module; resolves
  the previously-dangling `main`.
- **Sequence pillar, module 2: address router.** `src/router.js`
  (`parseAddress`, `parseEventTag`, `parseVerifyTag`, `parseReverifyTag`,
  `parseInitiatorCommand`), lifted pure from gitdone and **trimmed to the kernel
  boundary** (SPEC §2): initiator commands cut to `{stats, remind}`; the policy
  parsers `parseAttachTag`/`parseRevokeTag` and the `close+`/`bundle+` tags
  dropped (they stay in gitdone). `tests/unit/router.test.js` proves the trim
  (dropped tags parse to null / are unexported) and adds `verify+` coverage the
  origin suite lacked.
- **Inbound preprocessing, module 3: pre-filter + envelope.** `src/prefilter.js`
  (`preFilter`, `extractHeaderBlock`, `rawHeader` — the humans-only gate that
  rejects auto-responders / mailing lists / bulk / system senders before
  verification) and `src/envelope.js` (`parseEnvelope` — the Postfix pipe-argv
  helper, aligned to OPS.md §5). Both lifted verbatim (generic, no policy
  branches, no config deps) with their gitdone characterization tests.
- **Email-triggers pillar, module 4: outbound send path.** `src/outbound.js`
  (`sendmail`, `buildRawMessage`, `newMessageId`, `rfc5322Date`,
  `sanitizeSubject`, `withSignature`), lifted from gitdone with **config
  injection** (no `GITDONE_SENDMAIL_BIN` / `git-done.com` env defaults — the
  caller passes `binary` and `domain`) and an **injectable, no-default footer**
  (gitdone's branded `SIGNATURE_FOOTER`/`SIGNATURE` dropped per PRD §8.6;
  `noSignature` removed as redundant). First **integration-tier** tests:
  `tests/integration/outbound.test.js` drives the real `sendmail(8)`
  child-process path against fake binaries in tmp (no mocks); pure builders
  stay in `tests/unit/outbound.test.js`.
- **Git-ledger pillar, module 5a: event store + per-event write mutex.**
  `src/event-store.js` and `src/event-mutex.js`, lifted from gitdone as the
  stdlib-only half of the storage pillar (gitrepo + simple-git follow in 5b).
  - **Config injected by a bound factory, not a singleton:**
    `createEventStore({ dataDir })` names `dataDir` once and returns the bound
    primitives (`loadEvent`, `createEvent`, `activateEvent`, `editEvent`,
    `recordStepSendErrors`, `recordProofEmailMessageId`, plus the pure
    `findStep` / `senderMatchesStep` / `generateEventId` / `generateEventSalt`).
    This replaces gitdone's `config` singleton. **Why:** banning the singleton
    moved the single source of truth from *implicit* (ambient `GITDONE_*` env
    read at import) to *explicit* (the create call); a bound factory preserves
    that one explicit binding point, where per-call injection of a fixed value
    would re-fragment `dataDir` across every call site. See the decisions log,
    "Config injection by bound per-pillar factories."
  - **Trimmed of gitdone-web magic-link policy:** dropped `confirmActivationLink`
    and the `activation_ack_token` / `activation_link_clicked_at` fields from
    `createEvent` (dashboard activation-link mechanics, not kernel). The
    pending→active gate (`activated_at` / `activateEvent`) is workflow-core and
    stays. `tests/unit/event-store.test.js` proves the trim (the dropped fields
    are absent; `confirmActivationLink` is unexported).
  - `src/event-mutex.js` (`withEventMutex`) lifted with its in-process
    serialization intact; gitdone-deployment-specific commentary generalized to
    library terms (cross-process locking is the consumer's concern).
  - Tests split by type per the Testing Trophy (matching outbound): pure
    helpers in `tests/unit/event-store.test.js`, the filesystem-backed
    primitives (incl. `activateEvent`'s pending→active gate + idempotency) in
    `tests/integration/event-store.test.js`. The activated-edit audit commit is
    skipped pending 5b.
- **Git-ledger pillar, module 5b: per-event git ledger.** `src/gitrepo.js`,
  `createGitrepo({ dataDir, ots? })` — `initRepoIfNeeded`, `commitReply`,
  `appendEditCommit`, `loadCommit`, `listCommits`, `syncEventJson`,
  `nextSequence`, and the pure salted-hash / metadata helpers.
  - **Zero new dependencies: talks to the `git` binary via stdlib
    `child_process`, not `simple-git`.** The dependency checklist failed
    `simple-git` on necessity — gitrepo uses only 5 git ops (a <100-line
    `execFile` wrapper), `listCommits` reads the filesystem rather than
    `git log`, and the only consumed behaviors (commit SHA, staged detection)
    are `rev-parse HEAD` + `diff --cached`. Keeps the ≤3-dep budget for
    `mailauth` + `mailparser`; consistent with `outbound`→`sendmail`. See the
    decisions log, "git ledger uses the `git` binary via child_process."
  - **OTS anchoring is optional and injected:** with no `ots` stamper wired
    (the default until module 5c), commits are written unanchored
    (`ots_proof_file: null`) per SPEC §0.2 — no hard `ots` coupling.
  - **Trimmed to the kernel:** dropped `commitAttach` / `commitRevoke` (policy;
    their `attach+`/`revoke+` tags were already dropped from the router).
    Deferred `commitReverify` + `nextReverifySequence` (kernel per PRD §4 but
    no caller until the verify-side archive-key re-check lands — shipping a
    writer with no caller is the speculative-code red flag) and
    `commitCompletion` (the `completion.js` boundary walk, module 6).
  - Unit/integration split as above; un-skipped the m5a activated-edit audit
    test (now green against the real ledger).
- **Git-ledger pillar, module 5c: optional OpenTimestamps anchor.**
  `src/ots.js`, `createOts({ otsBin })` → `{ stampFile }` — factory-injected
  (otsBin bound once, matching the storage factories), accept-with-flag
  (`stampFile` never throws; returns `{ proof_path }` or `{ error }`). Wire it
  into `createGitrepo({ ots })` to anchor commits; omit it for unanchored.
  - **Dropped `moveProofIntoTree`** — no caller: `gitrepo` files the proof into
    its own tree (`fs.rename` in `maybeStamp`), which is the cleaner boundary
    (ots *stamps*; the ledger owns its layout).
  - Covered `gitrepo`'s previously-untested `if (ots)` branch via an **injected
    fake stamper** (dependency injection, not a mock): success anchors the
    commit and files the proof; a failing stamp records `ots_archive.error`
    with a null path. The real `ots` happy path needs the client + network and
    is deployment-verified; the binary-missing error path is tested via a real
    spawn.
- `src/index.js` — public entry point, re-exporting each pillar as it lands.
- `tests/unit/classifier.test.js` — 14 behavior tests (every trust level,
  precedence ordering, alignment edges, defensive input), reconciled with
  gitdone's characterization fixtures (real mailauth shape).
- `docs/02-design/SPEC.md` — wire-format authority: trust taxonomy, address
  grammar, `event.json` / `commit-NNN.json` schemas, tamper-evidence model, and
  the salted-hash plaintext discipline. Kernel-vs-policy boundary marked throughout.
- `OPS.md` — operator checklist for the bundled Postfix/opendkim stack
  (DNS, PTR/FCrDNS, the `master.cf` pipe transport, port-25 ingress/egress).
- `config.example.env` — `MAILPROOF_*` reference template (env → injected
  `create()` config).

### Changed
- `package.json`: added the `test` script (`node --test`), an `exports` map, and
  shipped `OPS.md` + `config.example.env` in the `files` allowlist.

## [0.0.1] - 2026-05-22

First release published to npm — **reserves the `mailproof` name**. Pre-library:
there is still no working API (`main` resolves to `src/index.js`, which lands in
P1), so this publish is a documentation + POC scaffold, not a functional module.

### Changed
- **Renamed `gitcore` → `mailproof`.** The name reflects the identity: verification
  is grounded in DKIM/DMARC — i.e. email — by construction, so the channel is the
  trust anchor, not an implementation detail.

### Added
- `docs/` tier: `01-product/PRD.md` (with the §8 NO-GO table), `02-design/DESIGN.md`
  (moved into the design tier), `03-logs/decisions-log.md`, and `docs/README.md`
  (index + document precedence).
- npm publish workflow via OIDC trusted publishing (`.github/workflows/publish.yml`).
- Full publish metadata in `package.json` (repository, bugs, homepage, author,
  keywords, `files` allowlist, `publishConfig`); removed the `private` flag and the
  non-standard `_intendedDependencies` placeholder.
- This changelog.

## [0.0.0] - 2026-05-22

### Added
- Initial public scaffold (published as `gitcore`): a stdlib-only POC
  (`poc/pipeline.js`) proving the four pillars compose — verify → sequence →
  git ledger → email triggers — plus the original DESIGN doc and an Apache-2.0
  license. The POC is throwaway: it gets rewritten in P1 and is never shipped.
