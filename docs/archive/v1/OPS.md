# OPS — running the bundled mail stack

mailproof is **self-hosted by design**: outbound mail goes through a local
Postfix that opendkim signs, and inbound mail is delivered to your app by a
Postfix **pipe transport**. There is no third-party mail provider to configure.
This is the operator checklist for that stack. It is grounded in the working
`gitdone` deployment (Fedora + Postfix + opendkim); adapt paths/domain for your
host.

> **Status:** P1 has not bundled the transport yet. This describes the target
> deployment the lift produces. `{domain}` = your mail domain;
> `{ip}` = the host's public IPv4.

---

## 1. Why this shape

- **Outbound via `sendmail(8)`.** Postfix ships a drop-in `/usr/sbin/sendmail`
  that takes raw RFC-822 on stdin and injects into the queue. opendkim is wired
  as a `non_smtpd` milter, so locally-submitted mail is signed automatically —
  zero Node-side crypto, no SMTP AUTH/TLS/retry logic to maintain.
- **Inbound via pipe transport.** Postfix hands each delivered message to your
  app on stdin, with envelope fields as argv. `maxproc=1` serializes deliveries
  so only one process touches an event's git repo at a time (the kernel relies
  on this — see SPEC §5).

---

## 2. DNS records (do these first — they take time to propagate)

| Type | Name | Value | Purpose |
|---|---|---|---|
| `A` | `{domain}` | `{ip}` | Host address. |
| `A` | `mail.{domain}` | `{ip}` | MX target. |
| `MX` | `{domain}` | `10 mail.{domain}.` | Where inbound mail goes. |
| `TXT` | `{domain}` | `v=spf1 mx -all` | SPF: only our MX may send. |
| `TXT` | `{selector}._domainkey.{domain}` | `v=DKIM1; k=rsa; p={pubkey}` | opendkim public key. |
| `TXT` | `_dmarc.{domain}` | `v=DMARC1; p=none; rua=mailto:postmaster@{domain}; aspf=s; adkim=s` | DMARC. Start at `p=none`, tighten to `quarantine`/`reject` once aligned. |
| `PTR` | (reverse zone for `{ip}`) | `mail.{domain}.` | **rDNS.** Set via your hosting provider, not your DNS host. |

**PTR / FCrDNS is not optional for deliverability.** Forward-confirmed reverse
DNS (the PTR resolves to a name whose A record points back to `{ip}`) is what
keeps your mail out of spam. Many receivers reject mail from IPs with generic
or missing rDNS.

---

## 3. Packages (Fedora)

```bash
sudo dnf install -y postfix opendkim opendkim-tools opentimestamps-client
# opentimestamps-client only if you enable OTS anchoring (optional).
```

---

## 4. opendkim — sign outbound

Generate a key, publish the public half as the DKIM TXT record above, then:

```
# /etc/opendkim.conf
Domain       {domain}
Selector     {selector}
KeyFile      /etc/opendkim/keys/{domain}/{selector}.private
Socket       inet:8891@localhost
Mode         sv
SubDomains   yes
```

> **Backup the private key.** `/etc/opendkim/keys/` is **irreplaceable** —
> losing it means every outbound message fails DKIM until you publish a new key
> and wait for propagation. Back it up offline.

---

## 5. Postfix — inbound pipe + outbound milter

`/etc/postfix/master.cf` — pipe transport. Pass the envelope fields the kernel
needs for commit metadata (client IP + HELO + sender + original recipient):

```
mailproof unix - n n - 1 pipe
  flags=DRhu user=mailproof maxproc=1
  argv=/opt/mailproof/bin/receive.sh ${client_address} ${client_helo} ${sender} ${original_recipient}
```

`maxproc=1` is required (serializes git-repo writes). `${original_recipient}`
preserves the `event+{id}-{step}@` plus-tag through delivery — the router
parses it (SPEC §2).

`/etc/postfix/main.cf`:

```
mydestination = localhost
virtual_transport = mailproof
smtpd_milters = inet:localhost:8891
non_smtpd_milters = inet:localhost:8891
milter_default_action = accept
message_size_limit = 10485760        # cap inbound; the app streams, never buffers whole
```

```bash
sudo systemctl enable --now opendkim postfix
```

### 5.1 Role-address aliases

The pipe transport catches **all** `*@{domain}` recipients, so `postmaster@`,
`abuse@`, etc. would never reach a human. Add virtual aliases that forward RFC
2142 role addresses to the operator **before** relying on the pipe fallback:

```bash
sudo postconf -e 'virtual_alias_maps = hash:/etc/postfix/virtual'
# /etc/postfix/virtual:  postmaster@{domain}  you@example.com
sudo postmap /etc/postfix/virtual && sudo postfix reload
```

Required for Microsoft SNDS / Google Postmaster Tools sign-up (verification
goes to `abuse@`).

---

## 6. Port 25

- **Inbound (ingress):** receivers connect to **:25** on `{ip}`. Open it in the
  host firewall and any cloud security group.
- **Outbound (egress):** your Postfix connects out on **:25** to deliver. Most
  cloud providers (AWS, GCP, Azure, DigitalOcean, Oracle) **block outbound :25
  by default** to fight spam. You must request an unblock, or relay through a
  smarthost. Without this, mail silently queues and never leaves.

Verify egress: `nc -zv gmail-smtp-in.l.google.com 25`.

---

## 7. The two flows, end to end

**Inbound:** sender → `:25` → Postfix → opendkim/verification headers →
pipe(`maxproc=1`) → `receive.sh` → app `ingest(rawBuffer, envelope)` → kernel
verifies (mailauth) → routes → commits (accept-with-flag) → advances → fires
the next notification.

**Outbound:** app builds RFC-822 (CRLF) → `sendmail -i -f {from} -t` → opendkim
milter signs → Postfix queue → recipient.

---

## 8. Operational checklist

- [ ] DNS A/MX/SPF/DKIM/DMARC published and propagated (`dig MX {domain}`).
- [ ] PTR set and forward-confirmed (`dig -x {ip}` → `mail.{domain}` → A → `{ip}`).
- [ ] opendkim signing verified (send to a `check-auth@` reflector; expect DKIM=pass).
- [ ] Outbound :25 confirmed open (provider unblock done).
- [ ] Pipe transport delivers a test mail to the app (`maxproc=1` set).
- [ ] opendkim private key backed up offline.
- [ ] DMARC tightened from `p=none` once your own mail aligns.
