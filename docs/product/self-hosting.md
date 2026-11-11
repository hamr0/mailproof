# Hosting your own mail server for signed copies (M5 guide)

> **Status: a guide, not a product.** It is written from the gitdone operators' records (a production Postfix box) and the Postfix documentation, **not from a fresh box run for mailproof**. Every step is marked in the table at the end. Source tags: **LIVE** = read or run on a real box by the gitdone operators; **PDOCS** = from the Postfix documentation, not run; **UNVERIFIED** = neither. The command `mailproof record` that this guide pipes mail into is **specified, not built yet** (SPEC B14, PRD §7 M5). Until it ships, the pipe steps cannot be run as written.
>
> All names here are placeholders: `example.com`, `mail.example.com`, `203.0.113.10`. Use your own. Never paste real keys or addresses into a shared place.

## 1. Who this is for, and when you need it

mailproof proves an email from the **signed headers** of that email. Mail you send has a problem: the copy in your Sent folder is **unsigned** (Gmail and Outlook sign it later, on the way out, and the Sent copy never gets the signature). So for "I sent you this", mailproof alone holds only an unsigned, self-recorded copy. See PRD §5.

If you run your own mail server, your server signs each outbound mail with your own DKIM key. A copy of that signed mail can be recorded. Then "I sent you this" has the same proof as mail you receive.

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
- Node.js 22.19 or newer, git, and `mailproof` installed (`npm install -g mailproof`).
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

`/etc/opendkim.conf`:

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
  flags=R user=mailproof argv=/usr/local/bin/mailproof-pipe in --client-ip=${client_address} --client-helo=${client_helo} --sender=${sender} --recipient=${original_recipient}
```

- `flags=R` adds a `Return-Path` header at the top. It records the envelope sender in the message. Do not use `F` or `O`: they change the bytes mailproof records (the record id is the sha256 of the raw bytes).
- Use `--name=${macro}` and not bare `${macro}` words, so an empty value cannot shift the other arguments (UNVERIFIED on this exact line). Two facts from pipe(8) (PDOCS, not run):
  - For a null envelope sender (a bounce), `${sender}` expands to `MAILER-DAEMON` unless the transport sets `null_sender=` (empty). Set it explicitly: add `null_sender=` to the transport's argument list in master.cf, so a bounce reaches mailproof as an empty sender, which it treats as null.
  - `${client_address}` and `${client_helo}` are empty for mail submitted locally (the `out` transport below). Expect `--client-ip=` and `--client-helo=` with no value. `mailproof record` must accept them (SPEC B14).
- The flag names are the ones SPEC B14 specifies. gitdone's own script uses positional arguments; mailproof's does not.
- **maxproc (the `1` in the maxproc column, before `pipe`).** gitdone pins it to 1 because its writes have no lock. mailproof has its own trail lock (SPEC B3), so more than 1 is *possible*. Do not raise it without a reason:
  - **With 1:** Postfix delivers one mail at a time. No lock waits. Memory is bounded: one message in flight (the library caps a message at 25 MiB, and each pipe process starts a worker thread by default). Mail queues up during a burst and drains later.
  - **With N > 1:** every process still waits on the same trail lock (one writer per trail), so there is little gain. A wait longer than `lockTimeoutMs` (default 30 s) ends in `ERR_TRAIL_LOCKED`, which defers the mail and retries it, wasting work. Memory grows to about N times the per-process peak.
  - For one person's mail, 1 is right. "No gain above 1" is reasoning from the lock design, **UNVERIFIED** by measurement.
- **Backfills.** If you also run `mailproof sync`, it holds its own lock but never the trail lock across the network, so a pipe delivery waits behind at most one commit (usage guide, "Locking").

### 8.3 Outbound: record a copy of what you send

> **Status.** TESTED (LIVE, production Postfix box, 2026-11-11): a message handed to `sendmail(8)` and delivered locally on the same box carries OpenDKIM's `DKIM-Signature`, added in `cleanup` on the one queue file before any delivery (maillog: "DKIM-Signature field added"), and it verifies (`opendkim-testmsg` exit 0). Headers added at delivery (`Return-Path`, `X-Original-To`, `Delivered-To`, `Received`) come after signing and are unsigned, which is harmless. **Strongly implied by the mechanism, NOT tested:** that the `sender_bcc_maps` copy carries the signature too (it is the same queue file). **Still open:** the end-to-end check with `mailproof record` and `mailproof verify` (section 13 step 5). If the BCC copy turns out unsigned, the design must change (for example, record at the milter step, or re-inject through a content filter). Do not rely on the outbound copy until step 5 has passed on your box.
>
> **Scope: local `sendmail(8)` submission only.** That is what the live box proves. Sending from a mail client is not covered yet (end of this section).

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

#### Not covered yet: sending from your mail client

This guide covers mail handed to `sendmail(8)` on the box. It does **not** cover sending from a mail client on your laptop or phone. That needs more than is proven here:

- a submission service (port 587, or 465) with SASL authentication, in `master.cf`;
- `smtpd_sender_login_maps` and `reject_sender_login_mismatch`, so that signing and the BCC copy apply only to mail from an authenticated sender who owns that address;
- the TLS settings of section 11, required for submission.

Until that is written and run on a real box, nothing sent from a mail client passes through this server, and so none of it is recorded as signed. (Decided by the owner, 2026-11-11; on the PRD M5 open list.)

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
- **Size cap.** `message_size_limit` is the outer bound. `mailproof record` also stops reading stdin at the library's own bound (25 MiB, `MAX_TOTAL_BYTES` in `limits.js`), so it never loads an unbounded message into memory. See SPEC B14.
- **Mail is recorded even when unverified.** A mail that fails DKIM is still a record (accept-with-flag). Exit 0 means "recorded", not "verified".

The mailproof config for the `mailproof` user (`config.json`, SPEC B11.2): one account whose trail lives under `/var/lib/mailproof`. Check the exact keys against `mailproof help config`. **UNVERIFIED:** whether the CLI config accepts an account with no IMAP block (the CLI was built around IMAP accounts; to be settled at build, SPEC B14).

```json
{
  "v": 1,
  "accounts": {
    "me": { "trailDir": "/var/lib/mailproof/trails", "trail": "default" }
  }
}
```

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
   Pass: the record's direction is `out`, it holds a `DKIM-Signature` with `d=example.com`, and `verify` says the portable verdict is `verified`. Also confirm `h=` lists `message-id`. **If it is `unverified` with no signature, the BCC copy was taken before signing and the design in 8.3 fails. Report it; do not work around it silently.**
6. **Inbound.** Send a mail from Gmail to `you@example.com`. `mailproof list` shows an `in` record with the verdicts for Gmail's signature.
7. **Retry behaviour.** Make the trail directory unwritable on purpose, send a mail, see it deferred in `mailq`, restore the mode, run `postqueue -f`, see it recorded.
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
- **SELinux.** The live box has SELinux **disabled**, so nothing here is proven for enforcing mode. With SELinux enforcing, the pipe writing under `/var/lib/mailproof` may be denied; you may need `semanage fcontext` and `restorecon` for that directory. Test this.
- **Hardened systemd units that call `sendmail`** need `SupplementaryGroups=postdrop`.
- **Back up the DKIM key offline**, and the trail (`mailproof backup`).
- **The trail holds other people's addresses and subjects**, in a git repo on an internet-facing box. Keep the data directory mode 0700 and the box patched.

## 15. Verified and unverified

Tags: **LIVE** = read or run on a real production Postfix box by the gitdone operators (gitdone repo records, hamr0/gitdone `docs/wiki/deployment.md` §5/§6; the author of this guide did not re-run it). **PDOCS** = from the Postfix documentation, not run. **UNVERIFIED** = neither. **No step has been run for mailproof itself**, because `mailproof record` does not exist yet.

| Step | Status | Source / note |
|---|---|---|
| Packages on Alma/RHEL: EPEL, postfix, opendkim, certbot, git, s-nail, nmap-ncat | LIVE | operators |
| Node 22.19+ from NodeSource | LIVE | operators |
| `ots` via `pip install opentimestamps-client` (`/usr/local/bin`) | LIVE | operators |
| Debian/Ubuntu package names | UNVERIFIED | |
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
| `SignHeaders` explicit list (binds Message-ID) | UNVERIFIED: recommended, not yet tested on the box | observed default: Message-ID, MIME-Version, Content-Type unsigned |
| Postfix milter lines, `milter_default_action`, `message_size_limit` | LIVE | gitdone §6 |
| `virtual_mailbox_domains` + `virtual_mailbox_maps = static:nothing` | LIVE | |
| Role-address virtual aliases | LIVE | gitdone §6.1 |
| Inbound pipe entry, `flags=R`, maxproc 1 (gitdone's own script) | LIVE | |
| Pipe with `mailproof record` and `--name=${macro}` flags | UNVERIFIED | command not built |
| `${sender}` is `MAILER-DAEMON` for a null sender; `null_sender=`; empty client fields for local mail | PDOCS | pipe(8) |
| maxproc above 1 gives no gain with the trail lock | UNVERIFIED | reasoning from SPEC B3 |
| Wrapper sources the env file | LIVE (gitdone `receive.sh`) | |
| Exit-code behaviour of pipe(8); wrapper maps all non-zero to 75 | PDOCS (design) | |
| Output kept away from Postfix (enhanced status codes) | PDOCS | |
| `ERR_TRAIL_LOCKED` to exit 75 retried by Postfix | Documented, not proven on a box | SPEC B3 |
| Stdin cap in the program | LIVE for gitdone (25 MB); mailproof's specified only | SPEC B14 |
| Distro default certificate, `smtp_tls_security_level = may` | LIVE | |
| Let's Encrypt for Postfix, and the `renewal-hooks/deploy` script | UNVERIFIED: standard certbot, not proven on a box | |
| certbot `renew_hook` reloads nginx | LIVE | gitdone §9 |
| Firewall `firewall-cmd --add-service=smtp --permanent` | LIVE | |
| Port 25 reachable from the provider | LIVE for the operators' provider; check yours | |
| SELinux enforcing mode | UNVERIFIED: the live box has SELinux disabled | |
| A locally delivered copy of an outbound message carries a valid DKIM-Signature | **LIVE** | maillog "DKIM-Signature field added", `opendkim-testmsg` exit 0 |
| Testing the signature with `root@localhost` (`/var/mail/root`) | LIVE | |
| `sender_bcc_maps` copy to a second transport; `transport_maps` overrides `virtual_transport` for it | Coexistence LIVE; the BCC copy strongly implied by mechanism, not tested | |
| **The BCC copy, recorded by `mailproof record`, verifies with `mailproof verify`** | **Open: the M5 evidence task** | testing step 5 |
| `smtpd_sender_restrictions` against spoofed own-domain senders | PDOCS, untested | |
| `check_recipient_access` protecting the record address | PDOCS, untested | |
| An `out` record without your own aligned `d=` is `unverified` | mailproof behaviour (verdicts); not tested with a spoofed copy | |
| Sending from a mail client (port 587, SASL, `reject_sender_login_mismatch`) | Not covered yet | owner scope decision |
| Key rotation with KeyTable and SigningTable | LIVE (the multi-domain form) | not run with mailproof |
| Old proofs survive after the old TXT is removed | Covered by the key-archive design and tests | not tied to a rotation on a real box |
| Shared-IP blocklist risk, queue alert, `postdrop` group | LIVE (gitdone operations) | |
