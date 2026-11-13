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

<p align="center">
  <a href="https://github.com/hamr0/mailproof/actions/workflows/ci.yml"><img src="https://github.com/hamr0/mailproof/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/mailproof?label=version&color=2a4f8c" alt="version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

## What you get

- **A verdict now.** Did this email really come from that address? One answer: `verified`, `forwarded`, `authorized` or `unverified`.
- **Proof later, offline.** The signed headers, the signature and the sender's public key go into a git repo you own. Anyone can re-check the email from that record alone, even after the sender drops the key from DNS.
- **A time seal.** Records are sealed with OpenTimestamps, so you can show an email existed no later than a given time.
- **Replies you can trust.** `replyText` returns only what the sender newly wrote, and says whether those words are proven.
- **A bundle for the other side.** Export what you exchanged with one person; they check it with no account and no trail.

Not a mail client, not a sender, not spam filtering, not proof of delivery. It never decides what a reply means: it gives you the verified text, and acting on it is your call.

## What it checks and captures

| Signal | What mailproof does |
|---|---|
| **DKIM** | The proof. The signed headers, the signature and the sender's key (archived at capture) are stored, so the check repeats offline at any time. |
| **DMARC** | Must pass when the domain publishes a policy, or the email is not `verified`. |
| **SPF, ARC** | Checked and recorded at capture. They cannot be re-checked offline, so the offline verdict is DKIM only. |
| **OpenTimestamps** | On by default. New records are sealed in batches (one hash per run, about every 6 hours) by `sync`, `watch` or `stamp`. Needs the optional `ots` binary; without it nothing is sealed and nothing breaks. |
| **Threading** | In-Reply-To and References are stored. A reply's link to your message is graded `signed`, `unsigned` or `none`; Microsoft does not sign these headers. `replyText` and `replyFacts` read the thread. |

The body is never in the proof or the trail. The raw email and attachments are kept in a local store beside the trail (outside git, owner-only, removed after 730 days or by `forget`; `content: { store: false }` turns it off). Every email is recorded, even unsigned, unverifiable or over a size limit, and flagged with the reason.

## Use it

### Humans: the `mailproof` command

```bash
npm install -g mailproof        # Node >= 22.19; optional: the `ots` binary for sealing
mailproof                       # no arguments on a terminal: the menu
```

First run walks you through adding an account (provider first, login tested before anything is written; the password is read from a file or command you name, never typed or stored). The menu header shows records, verified, last sync and seal state. Each item is a number (or its name) and runs the same code as the subcommand:

| | | |
|---|---|---|
| **Mail** | 1 `sync`, 2 `watch` | fetch new mail and record it; keep doing so on a timer |
| **Look** | 3 `people`, 4 `list`, 5 `show`, 6 `replies` | who is in the trail, browse emails, one address's emails and proof, what people answered |
| **Check** | 7 `verify`, 8 `check`, 9 `check .eml`, 10 `verify-bundle` | re-check offline, test against a trust profile, check a saved file, check a bundle you were sent |
| **Share and keep** | 11 `export`, 12 `seal`, 13 `backup` | bundle for a counterparty, seal now, save a copy of the trail |
| **Clean up** | 14 `forget`, 15 `prune` | delete stored content (proofs stay), remove old proofs |
| **Setup** | 16 `status`, 17 `config`, 18 `update`, 19 `mcp` | trail health, settings, upgrade, connect an AI assistant |

The same things as subcommands, for scripts:

```bash
mailproof sync --account personal
mailproof show bob@example.org        # every email with that address, and what its signature proves
mailproof verify bob@example.org      # re-check offline; exit 2 if a received email does not verify
mailproof stamp && mailproof export --with bob@example.org --after 2026-01-01 --tar
mailproof verify-bundle <bundle> --expect <sha256>     # the recipient's side, no account
```

`mailproof help` lists everything. Exit codes, systemd and cron examples, restoring a backup: [usage guide](https://github.com/hamr0/mailproof/blob/main/docs/product/usage-guide.md#the-mailproof-command). First time: the [setup guide](https://github.com/hamr0/mailproof/blob/main/docs/product/setup-guide.md). Want your own outbound mail DKIM-signed too: [self-hosting guide](https://github.com/hamr0/mailproof/blob/main/docs/product/self-hosting.md) (OpenDKIM and Postfix).

### Agents: the MCP server

```bash
claude mcp add mailproof -- mailproof mcp
```

`mailproof mcp` serves every configured account to any MCP client as 30 tools. Tool names equal the library method names. Two are server-only: `accounts` and `profiles`. `forget`, `prune`, `export` and `backup` only preview until called with `confirm: true`. Claude Code does not act on read-only/destructive hints, so scope tools by name in your allow rules. Details: [usage guide](https://github.com/hamr0/mailproof/blob/main/docs/product/usage-guide.md#ai-agents-the-mcp-server-mailproof-mcp). Hand your assistant the [integration guide](https://github.com/hamr0/mailproof/blob/main/mailproof.context.md) for the full contract.

### Code: the library

```bash
npm install mailproof
```

```js
import { Mailproof } from 'mailproof';

const mp = new Mailproof({ trailDir: './trails' });

await mp.check(rawEmail);                                        // a verdict now; writes nothing
const { id } = await mp.record(rawEmail, { direction: 'in' });   // keep the proof
await mp.verify(id);                                             // later, offline, from the record alone
const reply = await mp.replyText(rawEmail);                      // the sender's new words, and reply.proven
```

Pure ESM, types generated from JSDoc. Good for a Postfix pipe or your own pipeline.

### The primitives

The whole public surface. [`primitives.json`](https://github.com/hamr0/mailproof/blob/main/primitives.json) (also at `unpkg.com/mailproof/primitives.json`) adds `when`, `signature`, `fails` and an example for each.

| Primitive | Purpose |
|---|---|
| `new Mailproof({ trailDir })` | One instance per trail (a git repo of records). |
| `check(raw)` | Verdict on an email now; writes nothing. |
| `record(raw, opts)` | Keep the proof of one email. |
| `verify(id)` | Re-check a record offline. |
| `verifyWith(address)` | Do all emails with this address verify? |
| `verifyRecord(record)` | Standalone offline re-check of an exported record. |
| `verifyBundle(dir)` | Standalone check of a pair bundle, no trail needed. |
| `list`, `get`, `describe` | Find records, read one, see an email or an address in one call. |
| `copies(id)` | Every route one signed message reached you by. |
| `counterparties()` | Who is in the trail. |
| `linked(id)` | The thread around a record, graded signed/unsigned/none. |
| `replyText(raw)` | The sender's new words in a reply, and whether they are proven. |
| `replyFacts({ messageId })` | Flat facts on each direct reply, for a rule to judge. |
| `checkProfile(record, profile)` | Pass or fail a record against a trust profile, with reasons. |
| `matchBody`, `matchFile` | Show a later-found email or file is the one recorded. |
| `proofParts(id)` | Email proof and each attachment's match, separately. |
| `rawEmail`, `attachment` | Read stored content back. |
| `sync(opts)` | Record a mailbox over IMAP, read-only. |
| `stamp()`, `upgradeStamps()` | Seal new records; fold in Bitcoin attestations. |
| `export(opts)` | Write a pair bundle for a counterparty. |
| `backup(opts)` | Write a git bundle of the trail. |
| `status()` | What the trail holds and how it is kept. |
| `expireContent`, `forget`, `prune` | Retention: drop old content, content on request, or old proofs. |
| `hashDocument(file)` | Hash a file the way mailproof does. |
| `close()` | Release worker threads. |

## Guard a workflow with a signed reply

A risky step can wait for a human's signed email reply. mailproof supplies the facts; the rule is yours. It works with [bareguard](https://www.npmjs.com/package/bareguard) (`^0.34.0`), the sibling library that holds an agent's action until a rule allows it. Send the question from your own account, then read the replies:

```js
const replies = await mp.replyFacts({ messageId: '<question-1@example.com>' });
```

Group them by `messageKey`. Allow only if at least one reply is green and none is red. Green, for example: `firstLine` is your approval word, `from` is `alice@example.com`, `fromDkimAligned` is `pass`, `bodyProven` is `proven`, `link` is `signed`. No reply, or a mix, means deny. A second contradictory reply can deny an approval, never grant one. The full field list and the exact rule are in the [integration guide](https://github.com/hamr0/mailproof/blob/main/mailproof.context.md).

## What leaves your machine

mailproof reads mail and writes proofs locally. Everything that uses the network:

| When | What is sent | To whom | Off switch |
|---|---|---|---|
| **IMAP** (`sync`, `watch`) | Your login, and read-only requests for new mail. Nothing is marked, moved or deleted. | Your mail provider, over TLS. | Do not run `sync`; capture by pipe needs no IMAP. |
| **DNS** (`check`, `record`) | Lookups of the sender's DKIM key, DMARC and SPF records. | Your DNS resolver. | None at capture; `verify` and every read use no network. |
| **OpenTimestamps** (`sync`, `watch`, `stamp`) | One 32-byte hash of a manifest per run, at most every 6 hours. Never content, subjects or addresses. The calendars see your IP and the timing. | Public calendar servers, through `ots`. | `otsBin: null` (library), `"ots": false` (config), `MAILPROOF_OTS=off` (`mailproof-sync`). |

`record()`, `check()`, `verify()` and every read never contact the calendars.

## What you can rely on

- **Received at Gmail:** the reply's words are provable, whoever sent it.
- **Received at Outlook or msn from outside:** Microsoft alters the body, so the words are unproven. The sender and signed headers still verify. `proven` tells you which case you are in.
- **Unsigned mail and your own Sent copies** are recorded but `unverified`. The proof is the other side's signed copy.
- **An export proves** that a domain signed those headers, and (once anchored) that the record existed by a time. It does not prove completeness: nothing shows that no other email exists.

Replies whose words matter, such as approvals, belong in a Gmail inbox.

## More

[Usage guide](https://github.com/hamr0/mailproof/blob/main/docs/product/usage-guide.md) | [Setup guide](https://github.com/hamr0/mailproof/blob/main/docs/product/setup-guide.md) | [Self-hosting guide](https://github.com/hamr0/mailproof/blob/main/docs/product/self-hosting.md) | [Integration guide](https://github.com/hamr0/mailproof/blob/main/mailproof.context.md) | [Changelog](https://github.com/hamr0/mailproof/blob/main/CHANGELOG.md) | [License](https://github.com/hamr0/mailproof/blob/main/LICENSE) (Apache 2.0)
