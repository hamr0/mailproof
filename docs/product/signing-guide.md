# Sign your own mail: OpenDKIM and your mail client

> **Status: a guide, not a product.** It is written from the gitdone operators' records (a production Postfix box) and the Postfix documentation, **not from a fresh box run for mailproof**. Every step is marked in the table at the end. Source tags: **LIVE** = read or run on a real box by the gitdone operators; **PDOCS** = from the Postfix documentation, not run; **UNVERIFIED** = neither. This guide has two parts: **Part 1** (sections 1-14) is OpenDKIM, your domain signs your outbound mail; **Part 2** (sections 15-20) is your mail client, sending from Thunderbird, Apple Mail or any client through your server so the mail is signed and recorded. **Every step of Part 2 is UNVERIFIED (not run on a real box).** The command `mailproof record` that this guide pipes mail into is **built** (2026-11-22, branch `feat/m5-record`, not yet released; SPEC B14) and tested against stubs and real child processes, but **no step of this guide has been run on a box**: the box steps below stay UNVERIFIED.
>
> All names here are placeholders: `example.com`, `mail.example.com`, `203.0.113.10`. Use your own. Never paste real keys or addresses into a shared place.

# Part 1: OpenDKIM, your domain signs your outbound mail

## 1. Who this is for, and when you need it

mailproof proves an email from the **signed headers** of that email. Mail you send has a problem: the copy in your Sent folder is **unsigned** (Gmail and Outlook sign it later, on the way out, and the Sent copy never gets the signature). So for "I sent you this", mailproof alone holds only an unsigned, self-recorded copy. See PRD §5.

If you run your own mail server (Postfix with OpenDKIM), your server signs each outbound mail with your own DKIM key. A copy of that signed mail can be recorded. Then "I sent you this" has the same proof as mail you receive.

You need this guide only if you want **signed copies of what you send**. If you do not:

- Receiving and proving mail from other people works today with IMAP `sync`. No server needed.
- Replies from the other person are signed by them. That is already the strong proof.

Be honest about the cost. A mail server is a thing you keep running: patches, DNS, reputation, blocklists. This guide gets you to a working box. It does not make the hard parts go away (see "Gotchas").

**Why there is no Docker image.** The hard parts are outside the container: DNS records, the PTR record, an open port 25 and the reputation of the IP. A container cannot set those. An image would also turn mailproof into a mail-server product that has to be patched. So: a command in the npm package, and this guide. Nothing else is shipped. (decisions-log, "M5: a record command and a self-hosting guide, not a Docker image".)

## 2. What you need

- A **VPS that allows inbound and outbound port 25.** Many providers block it by default. Ask before you buy. Test it (section 13).
- A **domain** you control, with DNS you can edit.
- The provider's control panel for the **PTR** (reverse DNS) record. You cannot set PTR in your own DNS zone.
- A dedicated IP if you can. A shared IP shares its reputation (section 14).
- Node.js 22.19 or newer, git, and `mailproof` installed (`npm install -g mailproof`, or `npm i --prefix /var/lib/mailproof/npm mailproof` as the `mailproof` user: a global install is not required (but with SELinux enforcing the code must be in `/usr/local`, section 14), but the wrapper's binary path must then point at the installed command. LIVE, Fedora 44: a non-global `npm i --prefix /var/lib/mailproof/npm mailproof` puts it at `/var/lib/mailproof/npm/node_modules/.bin/mailproof`, not `<prefix>/bin/mailproof`; only `npm i -g --prefix <dir>` makes `<dir>/bin/mailproof`. The wrapper, the systemd unit and the cron line below use `/usr/bin/mailproof`: change them to your path).
- **Linux glibc 2.34 or newer** (EL9, Debian 12, Ubuntu 22.04 or newer). The trail index (`list`, `show`, `copies`, `counterparties`, and the commands built on them) needs `better-sqlite3`'s Linux prebuilt binary, which needs glibc 2.34. On older systems (EL8, Debian 11, Ubuntu 20.04) `npm install` finishes without a warning, but every index command then fails with `ERR_INDEX_UNAVAILABLE`; `record`, `verify` and `stamp` still work. On EL8 (or any glibc below 2.34) build the add-on once from source:

```bash
sudo dnf install -y gcc-toolset-12-gcc-c++ make python39
npm i --prefix /var/lib/mailproof/npm mailproof        # command: /var/lib/mailproof/npm/node_modules/.bin/mailproof; or -g; the prebuild installs and fails to load, that is expected
cd /var/lib/mailproof/npm/node_modules/better-sqlite3  # with -g: $(npm root -g)/mailproof/node_modules/better-sqlite3
scl enable gcc-toolset-12 -- env PYTHON=/usr/bin/python3.9 \
  node /usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1
```

(`node-gyp.js` is npm's bundled node-gyp, NodeSource's npm; the path differs if npm is installed elsewhere.) `--force_build=1` is required: `npm rebuild --build-from-source` exits 0 but compiles nothing, because the prebuild is present. `PYTHON` must be 3.8 or newer (EL8's `python3` is 3.6). EL8's system GCC 8.5 cannot do C++20, hence the toolset. The build takes about 7 minutes on 1 vCPU and 1 GB. The built file uses only system libraries (glibc 2.28 or older), so you may remove the toolset afterwards (`dnf history undo <id>`) and `list` still works. **Rebuild after any reinstall of mailproof or `better-sqlite3`, or a Node major upgrade**: npm brings back the prebuild and drops `build/`. LIVE: AlmaLinux 8.10, glibc 2.28, Node 22.22.2, better-sqlite3 13.2.0, 2026-11-22.
- Size: the production box the operators ran this on has 1 vCPU and 1 GB RAM (LIVE). That is enough for gitdone's load; mailproof itself is not measured there.

## 3. Packages

On AlmaLinux / RHEL (the live box is AlmaLinux 8), `opendkim` comes from EPEL, so enable that first (LIVE):

```bash
sudo dnf install -y epel-release
sudo dnf install -y postfix opendkim opendkim-tools certbot git s-nail nmap-ncat
```

- **Node.js 22.19 or newer from NodeSource** (LIVE; the distro Node is too old). Follow NodeSource's setup script for your release, then `sudo dnf install -y nodejs`.
- **OpenTimestamps (optional, for M4 seals):** `sudo pip install opentimestamps-client` installs `ots` in `/usr/local/bin` (LIVE). Make sure that directory is on the pipe's `PATH` (section 9).
- `s-nail` gives you the `mail` command and `nmap-ncat` gives `nc`; section 13 uses both.

**Debian / Ubuntu (CONTAINER: checked in podman containers of debian:12, ubuntu:22.04 and ubuntu:24.04, 2026-11-22; not a mail box).** These differ from the RHEL names:

```bash
sudo apt-get install -y postfix opendkim opendkim-tools certbot git ncat python3-pip bsd-mailx dovecot-core
```

- `nmap-ncat` does not exist: the package is `ncat` (it installs `ncat` and `nc`).
- `s-nail` installs only `/usr/bin/s-nail`, with no `mail` or `mailx`. Use `bsd-mailx` for the `mail` command (that name was **not run** in the container), or call `s-nail` directly.
- `opendkim-tools` provides `opendkim-genkey` and `opendkim-testmsg`; `opendkim-genkey -b 2048 -d example.com -s test -D dir` works. The package names above, the config paths (`/etc/opendkim.conf`, `master.cf`, Dovecot `conf.d/10-master.conf` and `10-auth.conf`) and the service names were checked.
- **Node.js:** the distro `nodejs` is too old (18 on Debian 12, 12 on Ubuntu 20.04, 18 on Ubuntu 22.04). Run NodeSource's `setup_22.x` script (it needs `curl`, `ca-certificates`, `gnupg`), then `sudo apt-get install -y nodejs`.
- **`ots`:** on Debian 12 and Ubuntu 24.04 a plain `sudo pip install opentimestamps-client` is refused (PEP 668, externally-managed-environment). Either `sudo pip install --break-system-packages opentimestamps-client` (CONTAINER) or `sudo PIPX_BIN_DIR=/usr/local/bin pipx install opentimestamps-client` (**not run**). On Ubuntu 22.04 a plain `sudo pip install opentimestamps-client` works (CONTAINER); the `--break-system-packages` flag does not exist in its pip 22.0.
- glibc is 2.36 (Debian 12), 2.35 (Ubuntu 22.04) and 2.39 (Ubuntu 24.04), all above the 2.34 floor; the published mailproof 4.0.0's `better-sqlite3` prebuild loads on all three (CONTAINER).

gitdone also installs nginx because it serves a website. You do not need a web server: use `certbot certonly --standalone` (section 11). **UNVERIFIED:** Debian/Ubuntu names (the same packages with `apt-get`, no EPEL step).

## 4. A system user for the pipe

Postfix runs the pipe as a user you choose. Give it no shell and its own data directory. The code stays owned by root and read-only; only the data is writable.

```bash
sudo useradd --system --home-dir /var/lib/mailproof --shell /sbin/nologin mailproof
sudo install -d -o mailproof -g mailproof -m 0700 /var/lib/mailproof /var/log/mailproof
```

The mailproof config file must be owned by that user with mode 0600 (SPEC B11.2 refuses it otherwise):

```bash
sudo install -d -o mailproof -g mailproof -m 0700 /var/lib/mailproof/.config/mailproof
sudoedit /var/lib/mailproof/.config/mailproof/config.json     # see section 9
sudo chown mailproof:mailproof /var/lib/mailproof/.config/mailproof/config.json
sudo chmod 0600 /var/lib/mailproof/.config/mailproof/config.json
```

## 5. DNS records

Set these at your DNS host. Replace the name and the IP.

| Type | Name | Value | Note |
|---|---|---|---|
| A | `example.com` | `203.0.113.10` | |
| A | `mail.example.com` | `203.0.113.10` | the mail host |
| MX | `example.com` | `10 mail.example.com.` | note the trailing dot |
| TXT | `example.com` | `v=spf1 mx -all` | only your MX may send |
| TXT | `sel202611._domainkey.example.com` | `v=DKIM1; k=rsa; p=MIIB...` | from section 6 |
| TXT | `_dmarc.example.com` | `v=DMARC1; p=none; rua=mailto:postmaster@example.com; aspf=s; adkim=s` | start at `p=none` |
| PTR | `203.0.113.10` | `mail.example.com.` | **set at the provider** |

- **The DKIM TXT value is long.** A 2048-bit key does not fit in one DNS string: a single TXT string is at most 255 characters. Split the value into several quoted strings inside one record, for example `"v=DKIM1; k=rsa; p=MIIB..." "...rest..."`. Many DNS panels split it for you; others want you to. The file `opendkim-genkey` writes (`sel202611.txt`) is already split.
- **PTR must match `myhostname`** (section 8) and the HELO name. Check it: `dig -x 203.0.113.10 +short` must print `mail.example.com.`. A missing or generic PTR is the most common reason mail lands in spam (knowless OPS §5.3). PTR is not in the gitdone repo, so this step comes from knowless, not from a gitdone box.
- **SPF:** gitdone publishes `v=spf1 mx -all`. knowless uses `mx a ~all`. `-all` is strict; start with `~all` if you are unsure and tighten later.
- **DMARC:** `aspf=s; adkim=s` is strict alignment: From must be on exactly your domain.
- **IPv6.** If your VPS has an IPv6 address, mail sent over it needs its own PTR and an SPF entry for it, or Gmail rejects the mail. The simple route: `inet_protocols = ipv4` in Postfix (section 8) and publish no AAAA for the mail host. `inet_protocols = ipv4` is PROVEN (LIVE).
- Wait for DNS to spread, then check: `dig +short TXT sel202611._domainkey.example.com`.

## 6. DKIM key generation and dated selectors

Name each selector with a date: `<prefix><YYYYMM>`, for example `sel202611`. The date tells you when it started and makes rotation easy (section 12).

```bash
sudo install -d -o opendkim -g opendkim -m 0750 /etc/opendkim/keys/example.com
sudo opendkim-genkey -b 2048 -d example.com -s sel202611 -D /etc/opendkim/keys/example.com/
sudo chown opendkim:opendkim /etc/opendkim/keys/example.com/sel202611.private
sudo chmod 0600 /etc/opendkim/keys/example.com/sel202611.private
sudo cat /etc/opendkim/keys/example.com/sel202611.txt     # the TXT value for section 5
```

The ownership and modes are what the live box uses (LIVE): `/etc/opendkim/keys` owned `opendkim:opendkim` mode 0750, each `*.private` owned `opendkim:opendkim` mode 0600. `opendkim-genkey` also writes a `.txt` file next to the key. Once the TXT record is published, `chown` it to `opendkim` or delete it; it holds no secret. The `opendkim-genkey` flags themselves (`-b 2048 -d -s -D`) are from the opendkim documentation and are not in the gitdone repo (**UNVERIFIED**; 2048 bits is consistent with the live key).

**Back up the private key offline.** If you lose it you must publish a new selector; old proofs stay valid (section 12). Never put the key in git, in mailproof's trail, or in a shared folder.

## 7. OpenDKIM

Use the multi-domain form, even for one domain. It is what runs on a production Postfix box (the gitdone operators, 2026-11-11, LIVE). It lets the same box sign more domains later without a rewrite. (gitdone's wiki still shows a single-key config; that page is stale, do not copy it.)

`/etc/opendkim.conf`. On Debian and Ubuntu the packaged file ships an active `Socket local:/run/opendkim/opendkim.sock` line: **replace** it with the `Socket inet:8891@127.0.0.1` line below, do not add a second one (CONTAINER). Postfix runs chrooted there, which is why a TCP socket is simpler than a Unix one.

```
Mode                 sv
Socket               inet:8891@127.0.0.1
UserID               opendkim:opendkim
Umask                002
Canonicalization     relaxed/relaxed
SigningTable         refile:/etc/opendkim/SigningTable
KeyTable             refile:/etc/opendkim/KeyTable
ExternalIgnoreList   refile:/etc/opendkim/TrustedHosts
InternalHosts        refile:/etc/opendkim/TrustedHosts
OversignHeaders      From,To,Subject      # From proven; To and Subject recommended, untested
SignHeaders          From,To,Cc,Subject,Date,Message-ID,In-Reply-To,References,Reply-To,MIME-Version,Content-Type
```

The table files are owned `opendkim:opendkim`, mode 0640, in a directory owned `root:opendkim`, mode 0755 (LIVE).

`/etc/opendkim/SigningTable`:

```
*@example.com   sel202611._domainkey.example.com
```

`/etc/opendkim/KeyTable`:

```
sel202611._domainkey.example.com   example.com:sel202611:/etc/opendkim/keys/example.com/sel202611.private
```

`/etc/opendkim/TrustedHosts` (hosts whose mail you sign):

```
127.0.0.1
localhost
```

- `Mode sv` means sign outbound and verify inbound.
- **Why a TCP socket (`inet:8891@127.0.0.1`).** Postfix often runs its daemons in a chroot. A unix socket outside the chroot is then unreachable. A TCP socket on localhost has no such problem. This is the reason gitdone uses it.
- **`SignHeaders`: recommended, not yet tested on a box.** This matters for proofs. A real signature made on a production box (LIVE, `d=` its own domain) was `h=From:To:Subject:Date:From`: **Message-ID, MIME-Version and Content-Type were not signed** (Date was). The test mail had no In-Reply-To or References, so nothing is known about them, and OpenDKIM's default list includes them. A proof of your outbound mail that does not sign Message-ID does not bind it: a reply's link to your mail (the reply cites your Message-ID) can only be proven if your Message-ID is signed (mailproof F11). So set `SignHeaders` explicitly, as above. Check the directive against `man opendkim.conf` and test it (section 13 step 4).
- **`OversignHeaders`.** Oversigning `From` is PROVEN (LIVE: it is why `From` appears twice in that `h=`). It stops someone adding a second `From` after signing. Adding `To` and `Subject` to the oversign list is recommended, untested.
- Start it: `sudo systemctl enable --now opendkim`.

## 8. Postfix

`/etc/postfix/main.cf` (the lines that matter; keep your distro's defaults for the rest):

```
myhostname = mail.example.com
mydestination = $myhostname, localhost
inet_protocols = ipv4

# Everything for your domain goes to the pipe transport (section 8.2)
virtual_mailbox_domains = example.com
virtual_mailbox_maps = static:nothing
virtual_transport = mailproof
virtual_alias_maps = hash:/etc/postfix/virtual

# Sign with OpenDKIM. smtpd_milters for mail received over SMTP,
# non_smtpd_milters for mail handed in by sendmail(1)
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = inet:127.0.0.1:8891
milter_default_action = accept

message_size_limit = 10485760
```

- `milter_default_action = accept`: if OpenDKIM is down, mail still flows, **unsigned**. Watch for that (section 14).
- `message_size_limit` is the first bound on mail size (10 MB here, gitdone's value). The pipe also caps what it reads (section 9).
- `virtual_mailbox_domains` plus `virtual_mailbox_maps = static:nothing` is what makes the catch-all work: the domain is deliverable and every recipient is accepted, then handed to `virtual_transport`. PROVEN (LIVE, the operators' box).

### 8.1 Role addresses

A catch-all pipe swallows `postmaster@`, `abuse@` and friends. They must reach a person (Microsoft SNDS and Google Postmaster Tools send their checks there). Put them in a virtual alias map. Aliases resolve before the catch-all transport.

`/etc/postfix/virtual`:

```
postmaster@example.com   you@your-real-mailbox.example.net
abuse@example.com        you@your-real-mailbox.example.net
hostmaster@example.com   you@your-real-mailbox.example.net
security@example.com     you@your-real-mailbox.example.net
```

```bash
sudo postmap /etc/postfix/virtual && sudo postfix reload
postmap -q 'postmaster@example.com' hash:/etc/postfix/virtual
```

Let `noreply@` (if you use one) fall through to the pipe, so bounces (DSNs) sent to it are recorded too.

### 8.2 Inbound: the pipe

`/etc/postfix/master.cf`, one entry (indent the second line):

```
mailproof unix - n n - 1 pipe
  flags=R user=mailproof argv=/usr/local/bin/mailproof-pipe in --client-ip=${client_address} --client-helo=${client_helo} --sender=${sender}
```

- `flags=R` adds a `Return-Path` header at the top. It records the envelope sender in the message. Do not use `F` or `O`: they change the bytes mailproof records (the record id is the sha256 of the raw bytes).
- Use `--name=${macro}` and not bare `${macro}` words, so an empty value cannot shift the other arguments (LIVE on the box run, 2026-11-22). Two facts from pipe(8) (PDOCS, not run):
  - For a null envelope sender (a bounce), `${sender}` expands to `MAILER-DAEMON` unless the transport sets `null_sender=` (empty). Set it explicitly: add `null_sender=` to the transport's argument list in master.cf, so a bounce reaches mailproof as an empty sender, which it treats as null.
  - `${client_address}` and `${client_helo}` are empty for mail submitted locally (the `out` transport below). Expect `--client-ip=` and `--client-helo=` with no value. `mailproof record` accepts them (SPEC B14); with no client IP no SPF check is made and the record's `spf` is null (LIVE; fixed on this branch, F42).
- The flag names are the ones SPEC B14.1 specifies (`--recipient` is not one: the library reads no envelope recipient). gitdone's own script uses positional arguments; mailproof's does not.
- **maxproc (the `1` in the maxproc column, before `pipe`).** gitdone pins it to 1 because its writes have no lock. mailproof has its own trail lock (SPEC B3), so more than 1 is *possible*. Do not raise it without a reason:
  - **A held trail lock** makes `record` wait up to `lockTimeoutMs` (default 30 s; LIVE: exit 75 after about 34 s) inside the pipe, and with maxproc 1 that stalls the pipe slot for those seconds on every locked attempt.
  - **With 1:** Postfix delivers one mail at a time. No lock waits from other pipe processes. Memory is bounded: one message in flight (the library caps a message at 25 MiB, and each pipe process starts a worker thread by default). Mail queues up during a burst and drains later.
  - **With N > 1:** every process still waits on the same trail lock (one writer per trail), so there is little gain. A wait longer than `lockTimeoutMs` (default 30 s) ends in `ERR_TRAIL_LOCKED`, which defers the mail and retries it, wasting work. Memory grows to about N times the per-process peak.
  - For one person's mail, 1 is right. "No gain above 1" is reasoning from the lock design, **UNVERIFIED** by measurement.
- **Backfills.** If you also run `mailproof sync`, it holds its own lock but never the trail lock across the network, so a pipe delivery waits behind at most one commit (usage guide, "Locking").

### 8.3 Outbound: record a copy of what you send

> **Status.** TESTED (LIVE, production Postfix box, 2026-11-11): a message handed to `sendmail(8)` and delivered locally on the same box carries OpenDKIM's `DKIM-Signature`, added in `cleanup` on the one queue file before any delivery (maillog: "DKIM-Signature field added"), and it verifies (`opendkim-testmsg` exit 0). Headers added at delivery (`Return-Path`, `X-Original-To`, `Delivered-To`, `Received`) come after signing and are unsigned, which is harmless. **Strongly implied by the mechanism, NOT tested:** that the `sender_bcc_maps` copy carries the signature too (it is the same queue file). **Still open:** the end-to-end check with `mailproof record` and `mailproof verify` (section 13 step 5). If the BCC copy turns out unsigned, the design must change (for example, record at the milter step, or re-inject through a content filter). Do not rely on the outbound copy until step 5 has passed on your box.
>
> **Scope: local `sendmail(8)` submission only.** That is what the live box proves. Sending from a mail client is Part 2 of this guide (sections 15-20), written but unverified.

The idea. Postfix adds a recipient to a mail in `cleanup`, with `always_bcc` or `sender_bcc_maps`. The milter's edits (the `DKIM-Signature` header) are applied to that one queue file, so the BCC recipient should receive the same message, signature included. A `content_filter` or a re-injection step could break this.

Add to `main.cf`:

```
sender_bcc_maps = hash:/etc/postfix/sender_bcc
transport_maps = hash:/etc/postfix/transport
```

`transport_maps` overrides `virtual_transport` for the record address; both coexist (LIVE).

`/etc/postfix/sender_bcc` (copy mail that *you* send, from your domain, to a record address):

```
you@example.com    mailproof-out@example.com
```

`/etc/postfix/transport` (send the record address to the second transport, not the inbound one):

```
mailproof-out@example.com    mailproofout:
```

```bash
sudo postmap /etc/postfix/sender_bcc /etc/postfix/transport && sudo postfix reload
```

`master.cf`, a second pipe entry (same user, same wrapper, direction `out`):

```
mailproofout unix - n n - 1 pipe
  flags=R user=mailproof argv=/usr/local/bin/mailproof-pipe out --client-ip=${client_address} --client-helo=${client_helo} --sender=${sender}
```

Notes:

- Both transports write to the same trail. They can run at once; the trail lock serialises them. Keep each at maxproc 1.
- Only mail with the envelope sender `you@example.com` is copied.
- **Reply-To.** Outbound mail must carry a Reply-To that is routable, or replies go nowhere (a launch-day loss at gitdone). This matters for how you send, not for mailproof.
- If a hardened systemd service hands mail to `sendmail(1)`, it needs `SupplementaryGroups=postdrop` and `ReadWritePaths=/var/spool/postfix/maildrop` (gitdone's unit, LIVE).

#### Security: spoofed senders and the record address (PDOCS, not run)

`sender_bcc_maps` fires on the envelope sender, whoever sent the mail. Two holes follow, and both need a restriction.

1. **A spoofed sender is recorded as yours.** An outsider can connect on port 25 and say `MAIL FROM:<you@example.com>`. The BCC rule copies it to the record address and it is recorded as an `out` mail. Refuse your own domain from outside:

   ```
   # main.cf
   smtpd_sender_restrictions = permit_mynetworks, check_sender_access hash:/etc/postfix/own_domains

   # /etc/postfix/own_domains   (then: postmap /etc/postfix/own_domains)
   example.com   REJECT
   ```

   `permit_mynetworks` lets local `sendmail(8)` and your own host through first. mailproof gives a second line of defence that you should rely on **plainly**: an `out` record whose DKIM signature is not your own, aligned `d=` shows as `unverified`. A spoofed copy is therefore never a proof. It would still sit in the trail, which is why the restriction above is worth having.
2. **The record address is reachable from outside.** Anyone can write to `mailproof-out@example.com`. Reject it from SMTP clients, in `smtpd_recipient_restrictions`, before `permit_auth_destination`:

   ```
   # main.cf
   smtpd_recipient_restrictions =
       check_recipient_access hash:/etc/postfix/protected_rcpt,
       permit_mynetworks, reject_unauth_destination

   # /etc/postfix/protected_rcpt   (then: postmap /etc/postfix/protected_rcpt)
   mailproof-out@example.com   REJECT
   ```

   (Keep the rest of your existing `smtpd_recipient_restrictions`; the point is only the order: the `check_recipient_access` line comes first.) Recipients added by `sender_bcc_maps` in `cleanup` bypass the smtpd restrictions, so the BCC copy still lands. Both restrictions are from the Postfix documentation and are **untested** (PDOCS).

#### Sending from your mail client

This section covers mail handed to `sendmail(8)` on the box. Sending from a mail client on your laptop or phone is **Part 2** (sections 15-20). It is written but **UNVERIFIED**: until it is run on a real box, treat nothing sent from a client as recorded as signed.

## 9. The pipe wrapper

Postfix does **not** run the pipe under systemd. The program starts with an almost empty environment. A wrapper must load the environment itself. gitdone lost time to this: without it the program silently used default settings.

`/usr/local/bin/mailproof-pipe` (root-owned, mode 0755):

```bash
#!/bin/bash
# Postfix pipe entry for mailproof. Usage: mailproof-pipe <in|out> [flags passed through]
# Exit codes to Postfix: 0 = recorded; 75 = try again later (EX_TEMPFAIL). Nothing else.
set -u
DIRECTION="${1:-}"; [ -n "$DIRECTION" ] || { logger -t mailproof-pipe "missing direction argument"; exit 75; }; shift

# The pipe does not run under systemd: load the environment ourselves.
if [ -r /etc/default/mailproof ]; then
  set -a; . /etc/default/mailproof; set +a
fi

# Never let mailproof's output reach Postfix: send it to the log.
/usr/bin/mailproof record --direction "$DIRECTION" --source "pipe:postfix" "$@" 2>&1 | logger -t mailproof-record
rc=${PIPESTATUS[0]}

case "$rc" in
  0) exit 0 ;;
  *) logger -t mailproof-pipe "record failed with exit $rc (direction $DIRECTION): deferring"
     exit 75 ;;
esac
```

The binary path above (`/usr/bin/mailproof`) must match where you installed it (section 2: a `--prefix` install without `-g` is `<prefix>/node_modules/.bin/mailproof`).

`/etc/default/mailproof` (owner root, group mailproof, mode 0640):

```
HOME=/var/lib/mailproof
XDG_CONFIG_HOME=/var/lib/mailproof/.config
XDG_STATE_HOME=/var/lib/mailproof/.local/state
PATH=/usr/local/bin:/usr/bin:/bin   # /usr/local/bin for ots
```

**Why every non-zero code becomes 75.** What Postfix `pipe(8)` does with an exit code (PDOCS, not run): it **defers** on 75 (`EX_TEMPFAIL`) and 71 (`EX_OSERR`), and on codes outside `sysexits.h` (1, 2, ...); it **bounces** the mail to the sender on most other sysexits codes (64, 65, 67, 77, 78 ...). mailproof's own codes (SPEC B11.8) include 64 (bad usage) and 77 (permission). A typo in your config would then bounce real mail back to the people who wrote to you. Mapping everything to 75 is explicit and safe: the mail stays in the queue, you fix the config and lose nothing. The cost: a broken setup defers mail until it expires (Postfix default 5 days, then it bounces), so watch the queue (section 14). The wrapper logs each failure to syslog.

**Never send mailproof's output back to Postfix.** If the command's output starts with an enhanced status code (`5.x.x`), pipe(8) may use it as the delivery status and bounce the mail even when the exit code is 75. The wrapper above sends stdout and stderr to `logger`, so Postfix sees only the exit code.

| Exit from `mailproof record` | Meaning | Wrapper sends Postfix |
|---|---|---|
| 0 | recorded (an already-recorded duplicate is success too) | 0: delivered |
| 75 | temporary: `ERR_TRAIL_LOCKED`, secret or I/O trouble | 75: Postfix retries |
| 64, 77, 1, anything else (or a missing argument) | usage, permission, or write failure | 75, plus a syslog line |

- **Empty stdin** is an error (the library refuses an empty message): `record` exits non-zero, so Postfix defers. (gitdone exits 2 for it.)
- **Size cap.** `message_size_limit` is the outer bound. `mailproof record` keeps at most the library's own bound in memory (25 MiB, `MAX_TOTAL_BYTES` in `limits.js`): a larger message is hashed as it streams in and recorded `unverified` (`over limit: total_bytes`), never loaded whole. See SPEC B14.2.
- **Mail is recorded even when unverified.** A mail that fails DKIM is still a record (accept-with-flag). Exit 0 means "recorded", not "verified".

The mailproof config for the `mailproof` user (`config.json`, SPEC B11.2): one **pipe-only account** (no `host`: nothing to log in to, mail arrives through the pipe). `user` is optional there and marks "(you)" in `people`. Leave `port`, `folders`, `sent` and the password keys out: adding any of them makes it an IMAP account on `imap.gmail.com` (as in 4.0.0), not a pipe-only one. On a pipe-only account `sync` and `watch` say `me has no IMAP server (a pipe-only account): mail arrives through mailproof record`. The pipe-only account is built (SPEC B14.3, tested); using it on a real box is UNVERIFIED.

```json
{
  "v": 1,
  "accounts": {
    "me": { "user": "me@example.com", "trailDir": "/var/lib/mailproof/trails", "trail": "default" }
  }
}
```

### 9a. Sealing on a timer, and retention

On an IMAP account `mailproof sync` seals (OpenTimestamps) and sweeps expired content at the end of each run. A pipe-only box never runs `sync`, and `mailproof record` stays offline: it never contacts the calendars. **Retention:** `record` runs the due content sweep itself, after the record is committed (SPEC B14.4); nothing for you to set up. **The seal** is a timer. `/etc/systemd/system/mailproof-stamp.service`:

```
[Unit]
Description=Seal the mailproof trail (OpenTimestamps)

[Service]
Type=oneshot
User=mailproof
Environment=HOME=/var/lib/mailproof
Environment=XDG_CONFIG_HOME=/var/lib/mailproof/.config
Environment=XDG_STATE_HOME=/var/lib/mailproof/.local/state
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/mailproof stamp --account me
```

`/etc/systemd/system/mailproof-stamp.timer`:

```
[Unit]
Description=Seal the mailproof trail every 6 hours

[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now mailproof-stamp.timer
```

`mailproof stamp` handles "nothing due" (it exits 0 and does nothing), and it never blocks a delivery for more than one short commit (SPEC B14.5). Without systemd, `/etc/cron.d/mailproof` does the same:

```
HOME=/var/lib/mailproof
XDG_CONFIG_HOME=/var/lib/mailproof/.config
XDG_STATE_HOME=/var/lib/mailproof/.local/state
PATH=/usr/local/bin:/usr/bin:/bin
0 */6 * * * mailproof /usr/bin/mailproof stamp --account me
```

**UNVERIFIED (not run on a real box)**; the `ots` binary must be on the `PATH` shown (section 3).

## 10. A first try without Postfix

Before you wire the pipe, check the command by hand, as the pipe user:

```bash
sudo -u mailproof -H env XDG_CONFIG_HOME=/var/lib/mailproof/.config \
  mailproof record --direction in --account me < some-saved-mail.eml
echo "exit: $?"      # 0
sudo -u mailproof -H env XDG_CONFIG_HOME=/var/lib/mailproof/.config mailproof list --account me
```

(Keep your saved sample mail outside any repository.)

## 11. TLS and the certbot reload hook

The live box does **not** use Let's Encrypt for Postfix: it runs on the distro's default certificate, and its certbot hook reloads nginx only. `smtp_tls_security_level = may` matches the live box. Everything about a Let's Encrypt certificate for Postfix below is **recommended, standard certbot, not proven on a box**.

Other mail servers use TLS to talk to yours when it is offered. To get a certificate for the mail host without a web server:

```bash
sudo certbot certonly --standalone -d mail.example.com
```

(It needs port 80 free, now and on each renewal.) Point Postfix at it, in `main.cf`:

```
smtpd_tls_cert_file = /etc/letsencrypt/live/mail.example.com/fullchain.pem
smtpd_tls_key_file  = /etc/letsencrypt/live/mail.example.com/privkey.pem
smtpd_tls_security_level = may
smtp_tls_security_level = may
```

**Renewal must reload whatever serves the certificate.** certbot writes the new certificate to disk, but a running daemon keeps the old one in memory until it reloads. gitdone's served nginx certificate went stale this way, with a fresh one on disk; its fix is a `renew_hook = systemctl reload nginx` in the renewal conf (LIVE, for nginx). For Postfix, the equivalent is a deploy hook (not proven):

```bash
sudo install -d /etc/letsencrypt/renewal-hooks/deploy   # absent until certbot has run once (CONTAINER)
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-postfix.sh >/dev/null <<'HOOK'
#!/bin/sh
systemctl reload postfix
HOOK
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-postfix.sh
sudo certbot renew --dry-run
```

The hook lives only on the box, not in any repo. Add it again after a rebuild or a restore of `/etc/letsencrypt`.

## 12. Key rotation

Rotate on a schedule you pick (yearly is common) and at once if the private key may have leaked.

1. Keep `.bak` copies of the two tables first: `sudo cp -p /etc/opendkim/KeyTable /etc/opendkim/KeyTable.bak`, the same for `SigningTable` (LIVE practice).
2. Generate a new key with a new dated selector (section 6), for example `sel202711`.
3. Publish its TXT record. Wait for DNS.
4. Add a line to `/etc/opendkim/KeyTable` for the new selector, and point the `SigningTable` entry at it:
   ```
   # KeyTable (add; keep the old line for now)
   sel202711._domainkey.example.com   example.com:sel202711:/etc/opendkim/keys/example.com/sel202711.private
   # SigningTable (change the right-hand side)
   *@example.com   sel202711._domainkey.example.com
   ```
5. `sudo systemctl reload opendkim`. `opendkim.conf` is unchanged. New mail now signs with the new key. (LIVE: this is the multi-domain form's rotation.)
6. **Keep the old TXT record published for a few weeks.** Mail already in flight, or in a slow queue, still needs it.
7. Then remove the old TXT (and, if you like, the old KeyTable line).

**What happens to old proofs.** mailproof archives the signer's public key in the trail **at capture**. A record you made while the old key was in DNS stays re-checkable offline after you delete the old TXT. That is the point of the archive, and it is the one rotation step you do not have to worry about. (The archive is documented mailproof behaviour; the rotation sequence is gitdone's practice, not run with mailproof.)

## 13. Testing

Do these in order. Stop at the first failure.

1. **Services.** `systemctl status postfix opendkim`; `ss -ltn | grep -E ':25 |:8891 '`.
2. **Port 25.** From another machine: `nc -vz mail.example.com 25`. From the VPS to the world: `nc -vz gmail-smtp-in.l.google.com 25`. A block here means your provider filters port 25.
3. **DNS.** `dig +short MX example.com`, `dig +short TXT example.com`, `dig +short TXT sel202611._domainkey.example.com`, `dig -x 203.0.113.10 +short`.
4. **Signing.** Send a mail from the box to a Gmail address you own: `echo test | mail -s test -r you@example.com you@gmail.com`. To test signing without touching the pipe or the outside world, send to the local root mailbox instead: `echo test | mail -s test -r you@example.com root@localhost`, then read it in `/var/mail/root` and check the `DKIM-Signature` header (this is how the LIVE proof was made); `opendkim-testmsg < /var/mail/root` verifies it. In Gmail, open "Show original". Expect `SPF: PASS`, `DKIM: PASS` with `d=example.com`, `DMARC: PASS`. **Then check the signed header list:** in the raw message, the `DKIM-Signature` line's `h=` must include `message-id` (and `in-reply-to` / `references` on a reply). If it lists only `From:To:Subject:Date:From`, your `SignHeaders` line did not take effect (section 7). mail-tester.com gives a score (knowless OPS says to expect 9 to 10 out of 10).
5. **The outbound copy (the open evidence task).** After step 4, find the recorded `out` copy and check it:
   ```bash
   mailproof list --account me          # run as the mailproof user, as in section 10
   mailproof show <id> --account me
   mailproof verify <id> --account me
   mailproof show <id> --account me --raw > copy.eml     # then look for the DKIM-Signature header yourself
   ```
   Pass: the record's direction is `out`, it holds a `DKIM-Signature` with `d=example.com`, and `verify` says the portable verdict is `verified`. Also check `h=`: on the live box it is `From:To:Subject:Date` (plus `Reply-To` when present) `:From`, and **Message-ID is not signed** unless you add the `SignHeaders` line (section 6; the line itself is UNVERIFIED). A thread link to your own sent mail needs a signed Message-ID. **If it is `unverified` with no signature, the BCC copy was taken before signing and the design in 8.3 fails. Report it; do not work around it silently.**
6. **Inbound.** Send a mail from Gmail to `you@example.com`. `mailproof list` shows an `in` record with the verdicts for Gmail's signature. Each delivery logs one line (`journalctl -t mailproof-record`) of the form `recorded <id> in verified/verified` (live and portable trust words; `unverified` when a check fails), or `already recorded <id>` for a repeat. LIVE: about 4 to 4.5 s per delivery.
7. **Retry behaviour (LIVE).** Make the trail directory unwritable on purpose, send a mail, see it deferred in `mailq`, restore the mode, run `postqueue -f`, see it recorded.
8. **Logs.** `journalctl -t mailproof-pipe` and `/var/log/maillog` for anything deferred.

## 14. Gotchas

All of these are from the gitdone and knowless records. None were re-tested for mailproof.

- **Catch-all swallows role addresses.** `postmaster@` and `abuse@` must be aliased (section 8.1). Microsoft SNDS and Google Postmaster Tools need `abuse@`.
- **From must be on your domain.** An outside From address fails DKIM and DMARC alignment; Gmail rejects it (`550-5.7.26`).
- **Shared IP reputation.** On a shared IP, other tenants' mail can get the IP blocklisted (Microsoft blocklists in particular). Use a dedicated IP, or cap how many mails you send. Microsoft delisting is a manual request.
- **"It didn't arrive" is often Gmail spam.** Look in the spam folder before debugging Postfix.
- **Watch the queue.** gitdone alerts at 50 or more queued mails (`mailq`). A deferred pipe fills the queue.
- **The pipe does not see systemd's environment.** Source it in the wrapper (section 9).
- **maxproc is a column in master.cf.** The `1` before `pipe`, not the default `100`. A master.cf rebuild can reset it.
- **pipe(8) defers on 75, 71 and codes outside sysexits (1, 2 ...), and bounces most other sysexits codes (64, 65, 67, 77, 78 ...).** Hence the wrapper maps everything to 75. Keep the command's output away from Postfix (section 9).
- **OpenDKIM down means unsigned mail, silently** (`milter_default_action = accept`). Check a sent mail's headers after any change.
- **Firewall (LIVE):** `sudo firewall-cmd --add-service=smtp --permanent` (and `--add-service=http` for certbot standalone), then `sudo firewall-cmd --reload`.
- **Mail recorded twice from one `.eml`.** LIVE: sending the same `.eml` twice with `sendmail` gives two records, because Postfix adds its own `Received` header each time, so the bytes and the ids differ. A Postfix retry of a deferred message is the same queue file and records once.
- **SELinux enforcing (LIVE: Fedora 44, SELinux enforcing, Postfix 3.10.14, system nodejs 22.22.2, 2026-11-22).** Debian and Ubuntu use AppArmor, not SELinux, by default; this applies to RHEL-family systems. Three things stop the pipe, in this order:
  1. **Code under `/var/lib` cannot be run by Postfix:** `postfix_pipe_t` is denied `execute` on `var_lib_t` (exit 126). Install the code root-owned in a system location instead, `sudo npm i -g --prefix /usr/local mailproof` (labelled `lib_t` and `bin_t`), and point the wrapper at `/usr/local/bin/mailproof`. This is also the guide's own rule, code root-owned and read-only. The per-user `--prefix /var/lib/mailproof/npm` install (section 2) works only with SELinux disabled or permissive.
  2. **Even then Node crashes in the pipe (exit 133, SIGTRAP):** `postfix_pipe_t` is denied `execmem` (V8's JIT) and `create` on the io_uring anonymous inode (libuv). Writing the trail is denied too: `var_lib_t` directory and file writes, and the lock file.
  3. **The fix is a small local policy module** that gives `/var/lib/mailproof` its own type and allows only that. Save as `mailproof_pipe.te`:

```
module mailproof_pipe 1.1;

require {
	type postfix_pipe_t;
	type io_uring_t;
	type var_lib_t;
	attribute file_type;
	attribute non_security_file_type;
	attribute non_auth_file_type;
	class anon_inode { create map read write };
	class process execmem;
	class dir { add_name create getattr open read remove_name rmdir search setattr write };
	class file { append create getattr ioctl link lock map open read rename setattr unlink write };
	class lnk_file { create getattr read unlink };
}

# The mailproof data directory (/var/lib/mailproof) gets its own type; only it is writable by the pipe.
type mailproof_data_t;
typeattribute mailproof_data_t file_type, non_security_file_type, non_auth_file_type;

# Node itself: V8's JIT needs execmem, libuv's thread pool uses io_uring.
allow postfix_pipe_t self:process execmem;
allow postfix_pipe_t io_uring_t:anon_inode { create map read write };

# Reach /var/lib, and read/write only mailproof's own data.
allow postfix_pipe_t var_lib_t:dir search;
allow postfix_pipe_t mailproof_data_t:dir { add_name create getattr open read remove_name rmdir search setattr write };
allow postfix_pipe_t mailproof_data_t:file { append create getattr ioctl link lock map open read rename setattr unlink write };
allow postfix_pipe_t mailproof_data_t:lnk_file { create getattr read unlink };
```

Install it:

```bash
sudo dnf install -y policycoreutils-python-utils checkpolicy   # semanage, checkmodule
checkmodule -M -m -o mailproof_pipe.mod mailproof_pipe.te
semodule_package -o mailproof_pipe.pp -m mailproof_pipe.mod
sudo semodule -i mailproof_pipe.pp
sudo semanage fcontext -a -t mailproof_data_t '/var/lib/mailproof(/.*)?'
sudo restorecon -R /var/lib/mailproof
```

  Result (LIVE): inbound deliveries (signed, unsigned, re-sent) were `status=sent` and recorded with 0 AVC denials, and `list` and `verify` still worked as the `mailproof` user. Check for denials with `sudo ausearch -m AVC -ts recent`. To remove it, in this order (the label uses the module's type): `sudo semanage fcontext -d '/var/lib/mailproof(/.*)?'`, remove or relabel the data, then `sudo semodule -r mailproof_pipe`.

  **Trade-offs.** The module grants `postfix_pipe_t` `execmem`. That domain is shared by every `pipe(8)` transport on the box: a known trade-off for running Node under Postfix. A generic `audit2allow` module would instead allow writes to all of `var_lib_t`, which is why this guide uses its own type. **Not tested** (reasoning, not run): the stamp timer under SELinux; a systemd service runs as `unconfined_service_t`, outside this domain.
- **Hardened systemd units that call `sendmail`** need `SupplementaryGroups=postdrop`.
- **Back up the DKIM key offline**, and the trail (`mailproof backup`).
- **The trail holds other people's addresses and subjects**, in a git repo on an internet-facing box. Keep the data directory mode 0700 and the box patched.

# Part 2: Your mail client

> **Status: every step in Part 2 is UNVERIFIED (not run on a real box).** It is written from the Postfix and Dovecot documentation and from the mechanism in Part 1. Nobody has run it end to end, and the signed, recorded copy of a client-submitted mail has not been tested. Do not read any line here as a result. Section 20 lists each step as unverified.

## 15. What this part does, and what it needs

Part 1 signs and records mail handed to `sendmail(8)` on the box. Most people send from a mail client (Thunderbird, Apple Mail, a phone app). For that mail to be signed by your domain and recorded, the client must **send through your server**, not through Gmail or another provider. The route:

```
client --(587, STARTTLS, login)--> Postfix submission --> OpenDKIM signs --> delivery + recorded copy
```

You need everything from Part 1 working first: DNS, the OpenDKIM key and milter, TLS (section 11) and the `sender_bcc_maps` copy (section 8.3). Part 2 adds a login-protected submission port in front of that.

Two warnings. (1) Your Sent folder in the client still holds an unsigned copy; the proof is the signed copy recorded on the server. (2) If you also send from a client that goes through another provider, that mail is not signed by your domain and is not covered.

## 16. A submission service on port 587 (and 465)

Port 25 is for server-to-server mail. Clients use **submission**: port 587 with STARTTLS, or 465 with implicit TLS. In `/etc/postfix/master.cf` (UNVERIFIED):

```
submission inet n       -       n       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_tls_auth_only=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=private/auth
  -o smtpd_sender_login_maps=hash:/etc/postfix/sender_logins
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=reject_sender_login_mismatch,permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING

# optional: implicit TLS on 465
smtps     inet  n       -       n       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=private/auth
  -o smtpd_sender_login_maps=hash:/etc/postfix/sender_logins
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=reject_sender_login_mismatch,permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
```

`smtpd_tls_auth_only=yes` means a password is never accepted without TLS. `smtpd_tls_security_level=encrypt` on 587 makes STARTTLS mandatory. The certificate settings are the ones from section 11. `milter_macro_daemon_name=ORIGINATING` marks the mail as outbound for OpenDKIM (its `InternalHosts` / signing tables must match; see section 7).

## 17. Login: Dovecot SASL

A client must prove who it is before Postfix accepts mail from it. Dovecot SASL is the common choice (UNVERIFIED here). Packages: `dovecot-core` (and your distro's auth packages). In Dovecot, expose an auth socket Postfix can reach (`/etc/dovecot/conf.d/10-master.conf`):

```
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
```

and allow plain login only over TLS (`/etc/dovecot/conf.d/10-auth.conf`): `disable_plaintext_auth = yes`, `auth_mechanisms = plain login`. "Plain" here is the login mechanism, carried inside the TLS session; it is the normal setup. Create the users and their passwords with whatever your Dovecot user database is (system users or a passwd-file); use a long, unique password per user. Restart Dovecot and reload Postfix.

## 18. Only your own addresses: `smtpd_sender_login_maps`

Without a check, any logged-in user could send as any address on your domain. Map each login to the addresses it may use (`/etc/postfix/sender_logins`, then `postmap /etc/postfix/sender_logins`):

```
alice@example.com   alice@example.com
```

Left side: the address; right side: the login name that owns it. `reject_sender_login_mismatch` (in the `submission` entry above) refuses mail whose `MAIL FROM` is not owned by the authenticated login. With this in place, the OpenDKIM signing and the `sender_bcc_maps` copy (section 8.3) apply to mail from an authenticated owner of the address. This also closes the spoofed-sender hole of section 8.3 for the submission port. Check that signing still happens for submitted mail: the milter must be set for `smtpd` (`smtpd_milters`, section 8), and the signing table must list your domain and key (section 7).

## 19. Client settings, DNS and firewall

In the client (Thunderbird, Apple Mail, a phone app), outgoing mail (SMTP):

| Setting | Value |
|---|---|
| Server | `mail.example.com` |
| Port | 587 (or 465) |
| Security | STARTTLS on 587 (SSL/TLS on 465) |
| Authentication | normal password |
| Username | the login from section 17 (for example `alice`, or your Dovecot login form) |
| Password | the login's password |

The client keeps its own account for **receiving**. This guide does not set up IMAP for the client; you can keep reading mail where you do now.

DNS: the A record for `mail.example.com` and the certificate (section 11) must match the server name the client uses. No new DNS record is needed for submission itself (the SRV records some clients auto-discover are optional). Firewall: open the submission port (`sudo firewall-cmd --add-service=smtp-submission --permanent`, and `smtps` for 465; then `--reload`), as you opened `smtp` in section 8. Some home and mobile networks block 25 but allow 587, which is why clients use it.

Test it: send a mail from the client to an address you can read at a provider that shows full headers (Gmail "Show original"). Look for `dkim=pass header.d=example.com`. Then run the recording checks from section 13 (testing step 5): the recorded `out` copy must verify with `mailproof verify`. **None of this has been run.**

## 20. Part 2: verified and unverified

Every row of Part 2 is **UNVERIFIED (not run on a real box)**; the rows are added to the table in section 21.

## 21. Verified and unverified (both parts)

Tags: **LIVE** = read or run on a real production Postfix box by the gitdone operators (gitdone repo records, hamr0/gitdone `docs/wiki/deployment.md` §5/§6; the author of this guide did not re-run it; the rows tagged with a date of 2026-11-22 and Fedora 44 or AlmaLinux 8.10 were run on those boxes for mailproof). **CONTAINER** = checked inside a podman container of debian:12, ubuntu:22.04 or ubuntu:24.04 (packages, paths, install commands; not a running mail box). **PDOCS** = from the Postfix documentation, not run. **UNVERIFIED** = neither. **A real-box test passed steps 1-7 of section 13** (AlmaLinux 8.10, Postfix, OpenDKIM, 2026-11-22; [F42](findings.md)); rows marked LIVE in the table were run there. Everything else stays UNVERIFIED: the `SignHeaders` values, ownsub specifics, a null `--sender`, spoof and recipient restrictions, submission on 587, SELinux (disabled on that box), and all of Part 2. **Part 2 (mail client) is entirely UNVERIFIED.**

| Step | Status | Source / note |
|---|---|---|
| Packages on Alma/RHEL: EPEL, postfix, opendkim, certbot, git, s-nail, nmap-ncat | LIVE | operators |
| Node 22.19+ from NodeSource | LIVE | operators |
| `ots` via `pip install opentimestamps-client` (`/usr/local/bin`) | LIVE | operators |
| Debian/Ubuntu package names (`ncat`, `opendkim-tools`, `certbot`, `git`, `dovecot-core`, `python3-pip`), config paths, service names, `opendkim-genkey`, NodeSource Node, `pip --break-system-packages`, glibc and the better-sqlite3 prebuild | **CONTAINER** (2026-11-22) | section 3 |
| Debian/Ubuntu: `bsd-mailx` for `mail`, `pipx install opentimestamps-client` | not run | section 3 |
| 1 vCPU / 1 GB RAM sizing | LIVE (the box's size, not a mailproof measurement) | |
| System user with `/sbin/nologin`, root-owned code | LIVE | gitdone §3-4 |
| DNS: A, MX, SPF, DMARC, dated DKIM TXT | LIVE | gitdone §1 |
| DKIM TXT split into 255-char strings | LIVE in practice | |
| PTR set to `myhostname` | PDOCS-level: documented by knowless, not read on the box | knowless OPS §5.3 |
| `inet_protocols = ipv4` | LIVE | |
| `opendkim-genkey` flags | UNVERIFIED (2048 bits is consistent with the live key) | |
| Key and table ownership and modes (0750/0600/0640, root:opendkim 0755) | LIVE | |
| OpenDKIM multi-domain config, TCP socket | LIVE | gitdone wiki §5 updated on branch `docs/deployment-live-mail-config` |
| `OversignHeaders From` | LIVE | |
| `OversignHeaders` To and Subject | UNVERIFIED: recommended, untested | |
| `SignHeaders` explicit list (binds Message-ID) | UNVERIFIED: recommended, not yet tested | LIVE observation: without it Message-ID, MIME-Version, Content-Type are unsigned |
| Postfix milter lines, `milter_default_action`, `message_size_limit` | LIVE | gitdone §6 |
| `virtual_mailbox_domains` + `virtual_mailbox_maps = static:nothing` | LIVE | |
| Role-address virtual aliases | LIVE | gitdone §6.1 |
| Inbound pipe entry, `flags=R`, maxproc 1 (gitdone's own script) | LIVE | |
| Pipe with `mailproof record` and `--name=${macro}` flags (flags=R, maxproc 1, user=mailproof) | **LIVE** (2026-11-22) | command built (SPEC B14); `--name=` and empty values are pinned by tests; the Postfix pipe itself not run on a box |
| `${sender}` is `MAILER-DAEMON` for a null sender; `null_sender=`; empty client fields for local mail | PDOCS | pipe(8) |
| maxproc above 1 gives no gain with the trail lock | UNVERIFIED | reasoning from SPEC B3 |
| Wrapper (env sourcing, logger, PIPESTATUS, every failure to 75); `/etc/default/mailproof` with an inline comment works when sourced | **LIVE** (2026-11-22) | |
| Exit 75 makes Postfix defer (dsn 4.3.0) and later deliver | **LIVE** (2026-11-22) | |
| Output kept away from Postfix (enhanced status codes) | PDOCS | |
| `ERR_TRAIL_LOCKED` to exit 75 retried by Postfix | **LIVE** (2026-11-22; after about 34 s) | SPEC B3 |
| Stdin cap in the program | LIVE for gitdone (25 MB); mailproof's built and tested (hash and record over the cap, memory bounded), not run on a box | SPEC B14.2 |
| Pipe-only account (no `host`) accepted by the CLI config | **LIVE** (2026-11-22; also built and tested: config validation with the lenient rule, `status`, the `sync` and `watch` refusal) | SPEC B14.3 |
| `mailproof stamp` with `ots` on the PATH seals the trail | **LIVE** (2026-11-22) | |
| `mailproof-stamp.service` and `.timer` (every 6 hours) on a pipe-only box; `record` runs the due content sweep | UNVERIFIED (the timer units not run on a real box) | SPEC B14.4, section 9a |
| Distro default certificate, `smtp_tls_security_level = may` | LIVE | |
| Let's Encrypt for Postfix, and the `renewal-hooks/deploy` script | UNVERIFIED: standard certbot, not proven on a box | |
| certbot `renew_hook` reloads nginx | LIVE | gitdone §9 |
| Firewall `firewall-cmd --add-service=smtp --permanent` | LIVE | |
| Port 25 reachable from the provider | LIVE for the operators' provider; check yours | |
| SELinux enforcing mode: local policy module `mailproof_pipe`, code in `/usr/local` | **LIVE** (Fedora 44, 2026-11-22; the gitdone box has SELinux disabled) | section 14 |
| Stamp timer under SELinux | not run (reasoning: `unconfined_service_t`) | section 14 |
| A locally delivered copy of an outbound message carries a valid DKIM-Signature | **LIVE** | maillog "DKIM-Signature field added", `opendkim-testmsg` exit 0 |
| Testing the signature with `root@localhost` (`/var/mail/root`) | LIVE | |
| EL8 (glibc 2.28): `better-sqlite3` built from source with gcc-toolset-12 and python3.9 (`--force_build=1`), after which `list` works; about 7 min on 1 vCPU / 1 GB | **LIVE** (2026-11-22) | section 2 |
| `sender_bcc_maps` copy to a second transport; `transport_maps` overrides `virtual_transport` for one address | **LIVE** (2026-11-22) | |
| **The BCC copy, recorded by `mailproof record`, verifies with `mailproof verify`** (the copy is the DKIM-signed queue file: OpenDKIM signs in cleanup before the copy; portable verified) | **LIVE** (2026-11-22) | testing step 5 |
| Real SPF on inbound mail from the envelope flags (`--client-ip`, `--client-helo`, `--sender`) | **LIVE** (2026-11-22; 5 inbound: DKIM, SPF and DMARC pass) | |
| Observed signed headers on the box: `From:To:Subject:Date` (plus `Reply-To`) `:From`; Message-ID not signed (no `SignHeaders` line, only `OversignHeaders From`) | **LIVE observation** | F42 |
| `smtpd_sender_restrictions` against spoofed own-domain senders | PDOCS, untested | |
| `check_recipient_access` protecting the record address | PDOCS, untested | |
| An `out` record without your own aligned `d=` is `unverified` | mailproof behaviour (verdicts); not tested with a spoofed copy | |
| Sending from a mail client: see the Part 2 rows at the end of this table | UNVERIFIED | Part 2 |
| Key rotation with KeyTable and SigningTable | LIVE (the multi-domain form) | not run with mailproof |
| Old proofs survive after the old TXT is removed | Covered by the key-archive design and tests | not tied to a rotation on a real box |
| Shared-IP blocklist risk, queue alert, `postdrop` group | LIVE (gitdone operations) | |
| **Part 2: submission service** (`submission` on 587 with `smtpd_tls_security_level=encrypt`, `smtpd_tls_auth_only`; optional `smtps` on 465), section 16 | **UNVERIFIED (not run on a real box)** | Postfix docs |
| Part 2: Dovecot SASL (`smtpd_sasl_type=dovecot`, auth socket in the Postfix queue dir, `disable_plaintext_auth = yes`), section 17 | **UNVERIFIED (not run on a real box)** | Postfix and Dovecot docs |
| Part 2: `smtpd_sender_login_maps` with `reject_sender_login_mismatch`, section 18 | **UNVERIFIED (not run on a real box)** | Postfix docs |
| Part 2: OpenDKIM signs mail received on the submission port (`milter_macro_daemon_name=ORIGINATING`) | **UNVERIFIED (not run on a real box)** | mechanism of Part 1 |
| Part 2: the `sender_bcc_maps` copy of client-submitted mail is recorded and verifies | **UNVERIFIED (not run on a real box)** | same open evidence task as section 8.3 |
| Part 2: client settings (server, port 587, STARTTLS, normal password, username), section 19 | **UNVERIFIED (not run on a real box)** | |
| Part 2: DNS and firewall (`smtp-submission` / `smtps` services; no new DNS record) | **UNVERIFIED (not run on a real box)** | firewalld docs |
