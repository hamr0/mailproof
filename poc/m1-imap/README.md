# M1 IMAP capture POC (throwaway, never shipped)

Read-only run against a real Gmail account: connect, fetch the latest 30 messages of INBOX and the `\Sent`
folder, `check()` each and cross-check with `mailauth`, observe ARC / Authentication-Results, simulate UID
resume, and probe the size bound. Findings: [F17](../../docs/product/findings.md).

Read-only by construction: `getMailboxLock(path, { readOnly: true })` (EXAMINE), `fetch` with `source: true`
(BODY.PEEK[]), no STORE / APPEND / MOVE / DELETE / EXPUNGE anywhere in the script.

## Re-run

```bash
# imapflow is not in package.json yet: install it somewhere outside the repo
mkdir -p "$S/imapflow-eval" && (cd "$S/imapflow-eval" && npm init -y && npm i imapflow@2)

export M1_SCRATCH=$S                 # raw mail, trail, wire log and results.json go here, never in the repo
export M1_USER=you@gmail.com
# M1_PASS_ENTRY (default mailproof/gmail_pass), M1_CAP (default 30), M1_IMAPFLOW_DIR are optional
node poc/m1-imap/m1-imap-poc.mjs
```

The app password is read from `pass show <entry>` (first line, whitespace removed) at runtime. It is never
printed, written, or passed through argv or env. The wire log (`$M1_SCRATCH/m1-wire.log`) is redacted of the
secret, the AUTHENTICATE line and SASL responses; message bodies are not logged.

Output is aggregate only (counts, verdict tallies, well-known signing domains; any other domain is
`(other)`); it is also written to `$M1_SCRATCH/m1-results.json`.
