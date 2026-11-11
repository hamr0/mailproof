# mailproof - Setup Guide (command line)

From zero to a sealed, exportable proof trail using only the `mailproof` command. Every command below is real; every address and path is a placeholder (`ana@example.com`, `~/mailproof/...`). For what a proof means and the library side, see the [Usage guide](usage-guide.md); the contract is [SPEC Part B](SPEC.md) (B11 CLI, B12 MCP, B13 stamp/export/verify-bundle).

Only Gmail with an app password has been proven against a real server ([findings F17](findings.md)). The Hotmail/Outlook.com section is marked **not yet tested with mailproof**.

## 1. What you get, what stays here, what leaves

You get a git repository you own (the **trail**) holding, for every email in the mailbox you point mailproof at, a re-checkable proof: the signed headers, the signature, the sender's public key archived at capture, and the verdicts. Anyone can re-check it offline later, even after the sender's key leaves DNS. Optionally the raw emails are kept in a local content store beside the trail (on by default, 730 days). Then `mailproof export` hands another person the proof of what you exchanged.

**Stays on your machine:** the trail, the content store, the config, the password source. mailproof never stores a password and never sends email. The proof never contains the body.

**Leaves your machine**, three paths, each listed in the README table:

| Path | What goes out | Off switch |
|---|---|---|
| IMAP (`sync`, `watch`) | Your login and read-only requests, to your mail provider, over TLS (certificates always checked). Nothing is marked read, moved or deleted. | do not run `sync` |
| DNS (at capture) | Lookups of the sender's DKIM key, DMARC and SPF records, to your resolver. | none while capturing; every later check is offline |
| OpenTimestamps (`sync`, `watch`, `stamp`) | One 32-byte hash of a manifest per run (a list of file hashes), at most every 6 hours. Never content, subjects or addresses. The public calendars see your IP address and the timing. | `"ots": false` |

## 2. Install

Requirements: Node >= 22.19 and `git` on your PATH. Optional, for the seal: the `ots` binary.

```bash
npm install -g mailproof
mailproof help                          # lists every command
pip install opentimestamps-client       # optional: the `ots` command; without it records are kept but not sealed
```

To try an unreleased branch instead, from a clone:

```bash
cd ~/src/mailproof && npm install && npm link      # `mailproof` now runs your clone
npm unlink -g mailproof                              # undo
```

Upgrade later with `mailproof update` (prints the command) or `mailproof update --run`.

## 3. A Gmail account (proven path)

**3.1 App password.** Gmail needs 2-step verification on, then an app password (a 16-character code that works for IMAP only):

1. Turn on 2-Step Verification in your Google account.
2. Open https://myaccount.google.com/apppasswords, create one named `mailproof`, copy the code (Google shows it in groups of four; spaces are fine).
3. IMAP must be enabled for the mailbox (Gmail settings, Forwarding and POP/IMAP).

**3.2 Put it in a private file.** mailproof never takes the password at a prompt: it reads it from a command or a file you name.

```bash
mkdir -p ~/.config/mailproof
install -m 600 /dev/null ~/.config/mailproof/gmail.pass     # create an empty file only you can read
$EDITOR ~/.config/mailproof/gmail.pass                       # paste the code on the first line, save
```

The file must be owned by you and mode 0600, or it is refused.

**3.3 Describe the account.** Run `mailproof config add-account`. It asks the questions below in this order. `?` at any prompt shows the hint; nothing is written until you confirm at the end.

| # | Prompt | Answer for Gmail |
|---|---|---|
| 1 | Account name | `gmail` (letters, digits, `-`, `_`) |
| 2 | IMAP user | `ana@example.com` (your full address) |
| 3 | IMAP host | Enter (default `imap.gmail.com`) |
| 4 | Port | Enter (`993`) |
| 5 | Folders to read | Enter (`INBOX`), or comma separated |
| 6 | Also read Sent mail | Enter (`on`; or `off`, or a folder path) |
| 7 | Trail directory | Enter (default `~/mailproof/gmail`) |
| 8 | Trail name | Enter (`default`) |
| 9 | Where does the password come from | `2` (1 = a command, 2 = a file, 3 = an OAuth2 token command) |
| 10 | Path of the password file | `~/.config/mailproof/gmail.pass` (an absolute path or `~/...`) |
| 11 | Keep the raw emails in the local content store | Enter (`y`) |
| 12 | Keep attachments too | Enter (`y`; only asked if 11 is `y`) |
| 13 | Days to keep stored content | Enter (`730`; only asked if 11 is `y`) |
| 14 | Seal records with OpenTimestamps | Enter (`y`) if `ots` is installed; `n` otherwise |
| 15 | Backup remote for `backup --push` | Enter (empty = none) |

It then prints the account JSON and asks `Write it to <file>?`. Answer `y`. The file is `~/.config/mailproof/config.json`, mode 0600. For the answers above it contains only:

```json
{
  "v": 1,
  "accounts": {
    "gmail": {
      "user": "ana@example.com",
      "host": "imap.gmail.com",
      "trailDir": "~/mailproof/gmail",
      "passFile": "~/.config/mailproof/gmail.pass"
    }
  }
}
```

The wizard writes only fields that differ from the defaults (port 993, folders `INBOX`, Sent on, trail `default`, content store on, 730 days, OpenTimestamps on). That is expected, not a lost answer. `~/` is expanded for every path in the config; versions up to 3.3.0 expanded it only for the trail directory, so there use the full path (run `echo $HOME` to see yours) for the password file. The password-file example the wizard shows (`/home/ana/...`) is only an example.

**3.4 Check it.**

```bash
mailproof config validate          # exit 0: permissions and every field are fine (no secret is read)
mailproof status --account gmail   # "trail does not exist yet" is normal before the first sync
```

`validate` exits 64 for a missing file or a bad field (the message names the JSON path) and 77 when the file is not owned by you or is readable by group or others (`chmod 600` it). `status` never connects to the mailbox.

## 4. Hotmail / Outlook.com / msn.com / live.com (NOT YET TESTED WITH MAILPROOF)

> **Not yet tested with mailproof.** Only Gmail app passwords are proven (F17). This section is research plus what the config allows; expect to troubleshoot, and please report what you find.

**What the research found** (web search, 2026-11-11; sources below):

- Microsoft's support page on Outlook.com and Basic authentication (last updated 2024-02-27) says Microsoft will remove Basic authentication from Outlook.com and rely on OAuth only, without giving a date there. Third-party and community reports put the switch-off for personal accounts in autumn 2024 (BlueMail: 16 September 2024; a Microsoft Q&A thread: IMAP app-password logins failing since about 1 October 2024). I did not find an official Microsoft page stating the date, so treat the date as unconfirmed.
- Practical result: **passwords and app passwords no longer work for IMAP on consumer Outlook.com accounts**; Thunderbird's 2026 guidance lists host `outlook.office365.com`, port 993, authentication OAuth2. So password sources 1 and 2 are not an option here. Use **password source 3**, an `accessTokenCommand`.
- The OAuth2 route needs an app registration of your own (Microsoft Entra / Azure portal, a "personal Microsoft accounts" supported account type) with delegated permissions `IMAP.AccessAsUser.All` and `offline_access`. Reports disagree on the resource form of the scope: `https://outlook.office.com/IMAP.AccessAsUser.All` is reported to work for personal accounts, while `outlook.office365.com` produced `AADSTS500200` ("personal Microsoft account not supported") in a Thunderbird bug report. Verify against your own registration.

**What mailproof needs from you.** `accessTokenCommand` is a command that prints a **fresh access token on stdout** and nothing else. mailproof runs it at every `sync` (and at every `watch` tick), so the command, not mailproof, handles refresh tokens. mailproof logs in with XOAUTH2 using your address and that token.

Realistic token-command options (all unverified with mailproof):

- A command-line token helper that does the OAuth2 flow with your app registration, stores the refresh token, and prints an access token: for example `oama`, `pizauth` or `mutt_oauth2.py` (from the mutt contrib scripts). Follow that tool's own setup for Microsoft, then set `accessTokenCommand` to its "print access token" command. Run the command by hand first and check it prints one line.
- `email-oauth2-proxy` (a local proxy that logs in with OAuth2 on behalf of a plain client): **not supported.** mailproof always uses TLS with the certificate checked (SPEC B4), and the CLI config has no CA or TLS option (`tls: { ca }` exists in the library only, not in the config file), so it cannot connect to a plaintext or self-signed local proxy.

**Example second account** (add by hand-editing, or run `mailproof config add-account` and choose password source `3`; host `outlook.office365.com`):

```json
{
  "v": 1,
  "accounts": {
    "gmail": {
      "user": "ana@example.com",
      "host": "imap.gmail.com",
      "trailDir": "~/mailproof/gmail",
      "passFile": "~/.config/mailproof/gmail.pass"
    },
    "hotmail": {
      "user": "ana@hotmail.example",
      "host": "outlook.office365.com",
      "trailDir": "~/mailproof/hotmail",
      "accessTokenCommand": "pizauth show hotmail"
    }
  }
}
```

(`pizauth show hotmail` is a placeholder for whichever helper you use.) Keep the file mode 0600. **With two accounts every command needs `--account <name>`** (`mailproof sync --account hotmail`); only `status` without it lists them all. Each account needs its own `trailDir` (or `trail` name).

**What an Outlook/msn mailbox gives you as proof**, so you set expectations:

- Your own **Sent copies are unsigned** (F3: 4 msn.com Sent copies, 0 DKIM signatures). They are recorded `unverified`; the proof that you sent something is the counterparty's signed copy when they reply.
- **Microsoft does not sign `In-Reply-To` or `References` or `To`** (F11: msn.com signs only From, Date, Subject, Message-ID, Content-Type, MIME-Version and one X-MS header). A reply from a Microsoft-hosted sender is matched to your request by quoting, not by a signed link; the record's link grade says `unsigned`. Gmail does sign them.
- Mail received at Outlook/Exchange from outside often has an altered body (`bh=` fails): the sender and signed headers still verify, but the words are unproven (`body_status: mismatch`).

Sources: [Microsoft Support: Outlook and other apps are unable to connect to Outlook.com when using Basic authentication](https://support.microsoft.com/en-us/office/f4202ebf-89c6-4a8a-bec3-3d60cf7deaef) (updated 2024-02-27); [BlueMail: Outlook.com app passwords](https://bluemail.me/app-password/outlook/); [n8n: IMAP Outlook credentials](https://docs.n8n.io/integrations/builtin/credentials/imap/outlook); [Mozilla Support: Microsoft OAuth and Thunderbird in 2026](https://support.mozilla.org/en-US/kb/microsoft-oauth-authentication-and-thunderbird-202/revision/275523); [Mozilla Bugzilla 1799259](https://bugzilla.mozilla.org/show_bug.cgi?id=1799259); [EmailEngine: setting up OAuth2 with Outlook](https://docs.emailengine.app/setting-up-oauth2-with-outlook). Several are third-party; none is an official Microsoft statement of a cut-off date.

## 5. First sync

```bash
mailproof sync --account gmail
```

It reads the folders (INBOX and Sent by default) **read-only** (EXAMINE and BODY.PEEK: nothing is marked read, moved or deleted), records a proof for every message, and at the end runs the seal job when it is due. The first run reads at most 1,000 messages and 512 MiB per folder and runs at most 30 minutes, so for a large mailbox **repeat the command** until it prints `complete`. Each run continues from a saved cursor; mail already recorded is skipped.

Output, one line per folder, then a verdict line:

```
INBOX                    in    seen 1000  recorded 998  duplicate 2  partial (run again)
Sent                     sent  seen 41  recorded 41  duplicate 0
not complete: the next run continues from the saved cursor
```

- `seen`: messages the server listed past the cursor. `recorded`: new records written. `duplicate`: byte-identical copies already in the trail (not an error).
- `over-limit N` appears when mail was over a size or shape limit: it is still recorded, as `unverified`, with the reason `over limit: <name>`. Mail over 128 MiB is listed as skipped, not recorded.
- `partial (run again)` means that folder hit a cap; `error <CODE>` means that folder failed and the run went on to the next; `not attempted` follows an earlier trail error.
- `complete` on the last line: everything is read. A partial run still exits 0.

Exit codes for `sync`: **0** done (even partial), **75** try again later (another sync holds the lock, server unreachable, throttled, or the secret command failed), **77** login refused or config not private, **64** bad usage or config, **1** anything else. `--json` prints one JSON document instead.

## 6. Look around

Start from the person, not from an id. `show` and `verify` take a **target**: an address (`b@example.com`), a Message-ID in angle brackets (`<abc@mail.example>`), or a record id (32 hex characters, or a unique prefix of at least 8; kept for scripts).

| Command | Use when |
|---|---|
| `mailproof status` | at a glance: records (in/out), oldest/newest, last sync, content size, pending seals, last backup, whether a watch runs |
| `mailproof people [--limit n]` | who is in the trail: one line per exact address with emails, received emails that verified, first and last date. Your own address is marked `(you)` |
| `mailproof show b@example.com [--after 2026-01-01] [--before 2026-07-01] [--limit n] [--full]` | every email naming that exact address (From, To, Cc or Reply-To), newest first. Each block has the same labelled lines, always in the same order, `N/A` where something does not exist: account, direction, date, captured, from/to/cc/reply-to/bcc (each marked signed or not signed), subject, trust, why it is not verified, body proof, the body text (first 10 lines; `--full` for all), attachments, seal, message-id, id |
| `mailproof verify b@example.com [--all] [--at <date>]` | re-check each of those emails offline. One line per email, then `received: N verified, M not`. Exit **0** when every RECEIVED email verifies, **2** when one does not (or none was received). Your own Sent copies are normally unsigned by the provider, so they are listed and counted apart and do not decide the exit code unless you add `--all` |
| `mailproof show <abc@mail.example>` / `verify <abc@mail.example>` | the same for every copy of one Message-ID |
| `mailproof show 3f2a9c1d` (`--raw`) | one record in full: every recorded fact (DKIM per signature, DMARC, SPF, ARC, thread links, content store) and the whole body; `--raw` prints the stored raw email (exit 1 if the content store no longer has it) |
| `mailproof list [--with ana@example.com] [--role from\|to\|cc\|reply-to] [--direction in\|out] [--after 2026-01-01] [--before 2026-07-01] [--limit n]` | a table, newest first: date, in/out, trust, the other party, subject, short id last. `--with` is one exact address. Dates are `YYYY-MM-DD` UTC or a full ISO time. Default 50 rows, `--limit 0` for all |
| `mailproof replies <messageId>` | what people answered to an email you sent (by its Message-ID), as facts, not interpreted |
| `mailproof check <id> --profile <file\|name> [--parent <messageId>]` | gate an email against a trust profile (allowed senders, required checks, body level, link strength). A name is looked up as `~/.config/mailproof/profiles/<name>.json`. Exit 0 pass, 2 fail with the failed rules |

An address with no recorded email is exit 1 (`no email with b@example.com in this trail`). A bare word or an id shorter than 8 characters is exit 64 with the three accepted forms. In the menu, **People** (item 16) lists them and lets you pick one, then Show, Verify or Export.

Trust levels (both a live verdict at capture and a portable one recomputed offline):

| Level | Meaning |
|---|---|
| `verified` | a DKIM signature passes and is aligned with From, and DMARC passes if the domain publishes it |
| `forwarded` | DKIM fails or is missing but an ARC chain from a trusted sealer passes |
| `authorized` | DKIM fails or is missing but SPF and DMARC pass; live only, never portable |
| `unverified` | none of the above; still recorded, with the reason |

`body_status` is a separate field and never changes the level: `matched` (the body hashes to the signed `bh=`, full proof), `partial` (the signature has `l=`), `mismatch` (the body was altered after signing), `not-checked` (unsigned, over limit, or your own Sent copy). A `verified` email means the signed headers are authentic, not that the body is intact.

## 7. Seal

```bash
mailproof stamp --account gmail
```

Sealing proves "captured no later than T" with OpenTimestamps, independent of your own clock. `stamp` writes a manifest of the file hashes recorded since the last run, sends its single 32-byte hash to the public calendars (needs the `ots` binary), and upgrades older pending seals. `sync` and `watch` already run it every 6 hours; run it by hand before an export.

- **pending**: the calendars accepted the hash but it is not in a Bitcoin block yet. This usually takes around an hour or more.
- **anchored**: a later run (`stamp`, `sync` or `watch`) upgraded the seal and it carries a Bitcoin block attestation.
- Nothing new and nothing pending: it commits nothing (idempotent).

If `ots` is not installed the result says `ots not installed: records are not sealed; install opentimestamps-client or set ots: false`. Nothing breaks: records are kept and listed in manifests. To turn the seal off, add `"ots": false` to the account. `mailproof stamp` rejects with `ERR_STAMP_LOCKED` (another stamp is running) or `ERR_TRAIL_LOCKED` (retry later).

## 8. Keep it running

There is no daemon. Either a foreground loop:

```bash
mailproof watch --account gmail --interval 5m     # 30s, 5m, 1h; default 5m, minimum 30s; Ctrl-C to stop
```

(it backs off on transient errors, stops with exit 77 if the login is refused, and finishes the sync in progress on Ctrl-C), run under `systemd --user` or tmux, or a cron line:

```cron
*/15 * * * * mailproof sync --account gmail --json >> $HOME/.local/state/mailproof/gmail/cron.log 2>&1
```

Exit 75 from an overlapping or unreachable run is normal; the next run continues from the cursor. A systemd unit example is in the [Usage guide](usage-guide.md#the-mailproof-command).

## 9. Export a proof and verify it

Start with the person: `mailproof people`, then `mailproof verify bob@example.com` to see for yourself what verifies, then export.

```bash
mailproof people --account gmail
mailproof verify bob@example.com --account gmail
mailproof stamp --account gmail
mailproof export --account gmail --with bob@example.com,bob@work.example \
    --after 2026-01-01 --before 2027-01-01 --out ~/proof-for-bob --tar
```

`--with` is **comma separated** (not repeatable); an email is included when it names any of those exact addresses on From, To, Cc or Reply-To. `--after` (inclusive) and `--before` (exclusive) are optional. `--out` is the new directory (it must not exist or be empty; the parent must exist); without it the default is `./mailproof-bundle-<account>-<UTC time>`. With `--tar` the `--out` path is the `.tar` file to mail. `export` never stamps and never uses the network: it warns when seals are pending. It prints the number of records and a **`bundle_sha256`**: send that to the recipient **by another channel** than the bundle (a call, a different mail).

The recipient needs no account and no trail:

```bash
npx mailproof verify-bundle ./proof-for-bob --expect <the sha256> --strict
```

Exit 0: it checks out; **2**: something does not (the failed checks are named). Without `--strict` an unsigned email or a pending seal is reported, not a failure; `--strict` fails unless every email is DKIM-verified and every seal is anchored (also when `ots` is missing). `--expect` fails when `bundle.json` is not the one you were told about. For the seals to be checked the recipient needs `ots` installed (`pip install opentimestamps-client`).

**What it proves:** each signed header set was signed by the sender's domain, and each record existed no later than its seal. **Anchored** means the seal is for exactly those bytes and carries a Bitcoin block attestation; the block header is *not* checked against Bitcoin (run `ots verify` for that). **What it does not prove:** completeness (you chose what to include), the content of any email, or when mail was received. A bundle names everyone in it, with subjects, and shows that other records exist (a count and sealing times, never their content). Sharing it is your act.

Export errors: `ERR_EXPORT_EMPTY` (nothing matches), `ERR_EXPORT_TOO_BIG` (over 10,000 records or 256 MiB: narrow with `--after/--before`), `ERR_EXPORT_EXISTS` (it never overwrites), `ERR_EXPORT_TAR` (no `tar`).

## 10. Housekeeping

- **backup**: `mailproof backup --account gmail` writes a git bundle of the whole trail (records, keys, replies, stamps; never bodies) to `~/.local/state/mailproof/backups/<account>/` and prints the path. Restore with `git clone <file>.bundle <dir>`. `--out <path>` chooses the file. `--with-content` adds an unencrypted `<file>.content.tar` of the stored raw emails (other people's mail: encrypt it or the disk). `--push --yes` pushes to the account's `backupRemote`, never with force.
- **forget**: deletes stored mail content, never the proof. `mailproof forget <id>...` or `mailproof forget --with bob@example.com [--before d] [--after d]`. Without `--yes` it prints a summary and exits 64; `--dry-run` prints the summary only.
- **prune**: `mailproof prune --before 2026-01-01 --dry-run`, then again with `--yes`. It rewrites the trail without everything older and keeps the old one as `<trail>.pre-prune-<date>` until you delete it (`--delete-backup`). Rare, explicit, never scheduled.
- **update**: `mailproof update` prints the upgrade command; `--run` executes it.

## 11. Use it from Claude Code (MCP)

```bash
claude mcp add mailproof -- mailproof mcp
# for an unreleased branch clone:
claude mcp add mailproof-dev -- node ~/src/mailproof/bin/mailproof.js mcp
```

Then start a **new** Claude Code session (servers are loaded at start). Try: "List my last 10 emails with bob@example.com", "Verify record 3f2a9c1d", "Sync my gmail account and tell me how many were recorded", "What did Bob reply to message <abc@example.com>?".

The 22 tools, named like the library methods:

- **read** (16): `accounts`, `list`, `get`, `copies`, `counterparties`, `linked`, `verify`, `verifyRecord`, `proofParts`, `checkProfile`, `replyFacts`, `matchBody`, `matchFile`, `rawEmail`, `attachment`, `check`
- **write** (4): `record`, `replyText`, `sync`, `upgradeStamps`
- **destructive** (2): `forget`, `prune`. They only preview until called again with `confirm: true`.

Notes: with two accounts every tool call takes `account`. `stamp`, `export` and `verify-bundle` are **not** MCP tools; use the CLI. Claude Code does not act on the read-only/destructive hints (F30), so scope by tool name (for example allow only `mcp__mailproof__list`, `get`, `verify`), or use `mailproof mcp --account <name>` for one server per account. `rawEmail` and `attachment` are read-only but hand over other people's mail. Paths for files go in only from `mcp.inputDirs` and out only into `mcp.outputDir`, both off until set in the config. Remove with `claude mcp remove mailproof`. Details: [Usage guide, MCP](usage-guide.md#ai-agents-the-mcp-server-mailproof-mcp).

## 12. Troubleshooting

| Exit | Meaning | Do |
|---|---|---|
| 0 | done | |
| 2 | a check ran and the answer is no (`verify`, `check`, `verify-bundle`) | read the failed rules/checks |
| 64 | bad usage, bad config field, or a destructive command without `--yes` | read the message; it names the JSON path |
| 75 | try again later: lock held, server unreachable, throttled, secret command failed | rerun; for `ERR_TRAIL_LOCKED` wait for the other writer |
| 77 | config not owned by you or readable by group/others, or login refused | `chmod 600 ~/.config/mailproof/config.json`; see below |
| 1 | anything else | `--json` and the error code help |

- **Login refused (`ERR_IMAP_AUTH`, exit 77), Gmail:** regenerate the app password, confirm 2-step verification and IMAP are on, paste it without spaces or keep them (both work), file mode 0600. `watch` stops on this on purpose, because retrying can lock the account.
- **Login refused, Outlook:** the token command printed an expired or wrong token, or Basic authentication was used. Run the command by hand: it must print only a fresh access token.
- **`cannot read passFile: ENOENT`:** the password file path is wrong or does not exist. Versions up to 3.3.0 expanded `~/` only for the trail directory, so there use the full path (`echo $HOME` shows your home) for `passFile`.
- **Config or password file refused (77):** `chmod 600` both; both must be owned by you. A key named `pass`, `password` or `secret` in the config is refused (exit 64): use `passCommand`, `passFile` or `accessTokenCommand`.
- **`ERR_TRAIL_LOCKED` / `ERR_SYNC_LOCKED` (75):** another run holds the trail lock. If none is running, see "Recovery" in the [Usage guide](usage-guide.md#concurrency-locks-and-recovery).
- **`ERR_INDEX_UNAVAILABLE`:** the `better-sqlite3` native addon could not load; `list` and `replies` need it, `show` and `verify` do not.
- **`ERR_TRAIL_LAYOUT`:** a pre-3.0 flat trail; it is not converted, create a new one.
- **The menu:** `mailproof` with no arguments on a terminal shows a menu with every command above (sync, list, show, verify, backup, update and more). Menu and subcommands run the same code, so use whichever you prefer.
