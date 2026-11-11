```
  ┌──────────────────────┐
  │  ✉  ───────┐         │
  │            ▼         │
  │  ╭──────────────╮    │
  │  │ ▓ DKIM ✓ ▓   │    │
  │  ╰──────────────╯    │
  │     │         │      │
  │   now       later    │
  │  verify    offline   │
  └──────────────────────┘

  mailproof
```

> Prove an email really came from the address it says, and keep that proof checkable offline, years later.
> Signed headers only in the git proof, never the body (raw email kept locally, outside git, expiring). A git repo you own. OpenTimestamps sealing on by default, one hash per run.

<p align="center">
  <a href="https://github.com/hamr0/mailproof/actions/workflows/ci.yml"><img src="https://github.com/hamr0/mailproof/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/mailproof?label=version&color=2a4f8c" alt="version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

## What it is

**One proof, two goals.** The email-proof engine behind signedreply.com, packaged for anyone who needs a verifiable email.

**1. Verify it now.** Did this email really come from the sending address? mailproof always checks DKIM, and adds DMARC, SPF and ARC when the sender publishes them. You get one verdict: `verified`, `forwarded`, `authorized` or `unverified`.

**2. Verify it later, offline.** It keeps the signed headers, the signature and the sender's public key in a git trail you own, so anyone can re-check the email from that record alone. No network needed, even after the sender rotates the key out of DNS. OpenTimestamps (on by default, batched: one hash per run, see [What leaves your machine](#what-leaves-your-machine)) proves the email was captured no later than a given time.

**Replies, too.** `replyText` returns only what the sender newly wrote (the quoted history is removed), and tells you whether those words are proven. A reply that merely quotes "Approve payment of $5,000?" is not read as an approval.

**What it isn't.** Not a mail client, not a sender, not spam filtering, and not proof of delivery. It never decides what a reply *means*: it gives you the verified text, and acting on it is your call. The body is never in the proof or the trail. By default the raw email and its attachments are kept in a local store beside the trail (outside git, owner-only files, removed after `content.days` or by `forget`); `content: { store: false }` turns that off.

## Install

```
npm install mailproof
```

Node.js >= 22.19. Pure ESM. Ships TypeScript types generated from JSDoc.

## Quick start

```js
import { Mailproof } from 'mailproof';

const mp = new Mailproof({ trailDir: './trails' });

await mp.check(rawEmail);                              // a verdict now; writes nothing
const { id } = await mp.record(rawEmail, { direction: 'in' });   // keep the proof
await mp.verify(id);                                   // later, offline, from the record alone
const reply = await mp.replyText(rawEmail);            // the sender's new words, and reply.proven
```

## What leaves your machine

mailproof reads mail and writes proofs locally. Everything that goes over the network is listed here, with its off switch.

| Path | What is sent | To whom | Off switch |
|---|---|---|---|
| **IMAP** (`sync`, `watch`, `mailproof-sync`) | Your login, and read-only requests for new mail. Nothing is marked, moved or deleted. | Your mail provider, over TLS (certificates always checked). | Do not run `sync`; capture by pipe (`record`) needs no IMAP. |
| **DNS** (verification at capture: `check`, `record`) | Lookups for the sender's DKIM key, DMARC and SPF records. | Your DNS resolver. | None while capturing; `verify` and every read re-check offline from the stored key, with no network. |
| **OpenTimestamps calendars** (the stamp job: `sync`, `watch`, `stamp`) | One 32-byte hash of a manifest per run (a list of file hashes), at most every `stamp.everyHours` (default 6). Never content, subjects or addresses. The calendars see your IP address and the timing. | Public OpenTimestamps calendar servers, through the `ots` command. | `otsBin: null` in the library, `"ots": false` in the account config, `MAILPROOF_OTS=off` for `mailproof-sync`. |

`record()`, `check()`, `verify()` and every read never touch the OpenTimestamps calendars: only `sync()` and `stamp()` do. Without the `ots` binary installed nothing breaks: records are kept and listed in manifests, capture is unaffected, and the result says `ots not installed: records are not sealed; install opentimestamps-client or set ots: false`.

## Five ways to use it

1. **Library**: `check`, `record`, `verify`, `matchBody`, `matchFile`, `list`, `copies`, `replyText`, `replyFacts`, `counterparties`, `linked`, `checkProfile`, `proofParts`, `rawEmail`, `attachment`, `expireContent`, `forget`, `prune`, `upgradeStamps`, `stamp`, `export`, plus the standalone `verifyRecord` and `verifyBundle`. Use it in your own pipeline, for example a Postfix pipe.
2. **IMAP capture**: `mp.sync({...})` reads a mailbox (Gmail first) read-only and records every message. Run it again to pick up new mail.
3. **The `mailproof` command**: run it for a menu, or use its subcommands (`sync`, `watch`, `list`, `show`, `verify`, `replies`, `check`, `forget`, `prune`, `backup`, `status`, `stamp`, `export`, `verify-bundle`, ...) in scripts. Your mailboxes live in one config file and the password is always read from a command or a file you name, never typed or stored. `mailproof-sync` stays for one sync run under cron or a systemd timer.
4. **MCP server**: `mailproof mcp` gives Claude Code or any MCP client 22 tools over your accounts (`claude mcp add mailproof -- mailproof mcp`). Known limit: the read-only/destructive hints are advisory and Claude Code does not act on them, so scope by tool name (or one server per account with `--account`); `forget` and `prune` only preview until called with `confirm`, the only server-side guard. [Usage guide](docs/product/usage-guide.md#ai-agents-the-mcp-server-mailproof-mcp).
5. **AI agents**: `primitives.json` is a machine-readable menu of every verb (`when`, `import`, `signature`, `fails`, `example`), generated from source. Also on unpkg: `unpkg.com/mailproof/primitives.json`. Hand your assistant `mailproof.context.md` for the full contract.

### The command line

```bash
mailproof config add-account     # asks a few questions, shows the result, writes the config only after you say yes
mailproof                        # the menu: sync, list, show, verify, backup, ...
mailproof sync --account personal
mailproof list --with bob@example.org --after 2026-01-01
mailproof verify 3f2a9c1d        # an id prefix of 8+ characters is enough; exit 2 means "does not verify"
mailproof watch                  # sync every 5 minutes in the foreground (run it under systemd --user)
mailproof backup --with-content  # a git bundle of the proofs, plus a tar of the stored mail
```

`mailproof help` lists everything. How-to, systemd and cron examples, restoring a backup: [usage guide](docs/product/usage-guide.md#the-mailproof-command).

### Handing a counterparty the proof (`export`, `verify-bundle`)

```bash
mailproof stamp --account personal                       # seal and upgrade first, so the proofs are as far along as they can be
mailproof export --account personal --with bob@example.org --after 2026-01-01
#   wrote ./mailproof-bundle-personal-20261112-093000 (41 records, ...)
#   bundle sha256 3f2a...  (tell the recipient this out of band)
mailproof verify-bundle ./mailproof-bundle-personal-20261112-093000 --expect 3f2a...   # on the other side, with no account
```

`export` writes a directory (`--tar` also packs it into one file) of the signed headers, signatures, archived keys and seals of every email that names any of the addresses you give, on From, To, Cc or Reply-To. It holds no email bodies and no attachments. `verify-bundle` re-checks every signature offline, that the files are the ones listed, the chain of seal manifests, and each seal with `ots info` (it never contacts a calendar or a Bitcoin node). Be clear about what that proves:

- **It proves**, per email, that the sender's domain signed those header lines, and that the record existed no later than its seal. **Anchored** means the proof is for exactly these bytes and carries a Bitcoin block attestation; the block header is *not* checked against Bitcoin (run `ots verify` yourself for that). **Pending** means the seal is not in a block yet; `mailproof stamp` and export again.
- **It does not prove completeness.** You chose the selection; nothing shows that no other email between you exists. The seal manifests list other records as bare hashes, so a recipient who holds an email you left out can notice if it was sealed in a batch the bundle shows. That is evidence, not a guarantee.
- **Privacy.** A bundle names every person you wrote to or heard from in it, and the subjects. Its manifests also reveal that other records exist (how many, and when each batch was sealed), never what they were. It is written 0700/0600; sharing it is your act.
- `verify-bundle` is lenient by default (an unsigned email or a pending seal is reported, not a failure); `--strict` fails unless every email is DKIM-verified and every seal is anchored. `--expect <sha256>` also fails when `bundle.json` is not the one you were told about.

## What you can rely on

- **Received at Gmail:** the reply's words are provable, whoever sent it.
- **Received at Outlook/msn from outside:** Microsoft alters the body, so the words are unproven. The sender and signed headers still verify. mailproof tells you which case you're in (`proven`), and never hides it.
- **Unsigned mail and your own Sent copies** are recorded but `unverified`. The proof is the other side's signed copy.
- **Every email is recorded**, even when it can't be verified or is over a size limit, and it is flagged with the reason.

Replies whose words matter, such as approvals, belong in a Gmail inbox.

## Docs

- **[Usage guide](docs/product/usage-guide.md)**: every surface, how to read each result, running on a timer, limits and recovery.
- **[Integration guide](mailproof.context.md)**: the dense contract for wiring mailproof into code or an agent.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
