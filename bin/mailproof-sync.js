#!/usr/bin/env node
// mailproof-sync: one resumable, read-only IMAP capture run (SPEC B4.1), for cron and systemd timers.
// The password never travels on the command line or in a plain env value: it comes from a command, a file or stdin.
// stdout: one JSON line (the sync result, no secret). stderr: human-readable errors. Exit codes: see USAGE.

import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { Mailproof } from '../src/index.js';

const EX_USAGE = 64;
const EX_NOPERM = 77;
const EX_TEMPFAIL = 75;

const USAGE = `Usage: mailproof-sync --trail-dir <dir> --user <user> [options]

One resumable, read-only IMAP capture run into a mailproof trail. Safe to run from cron or a systemd timer.

Options (env fallback in brackets):
  --trail-dir <dir>              trail directory [MAILPROOF_TRAIL_DIR]
  --trail <name>                 trail name, default "default" [MAILPROOF_TRAIL]
  --host <host>                  IMAP host, default imap.gmail.com [MAILPROOF_HOST]
  --port <n>                     IMAP port (implicit TLS), default 993 [MAILPROOF_PORT]
  --user <user>                  IMAP user [MAILPROOF_USER]
  --folders <a,b>                comma-separated folders, default INBOX [MAILPROOF_FOLDERS]
  --sent <on|off>                also sync the \\Sent folder, default on [MAILPROOF_SENT]

Secret (exactly one source; a plain password in an env var or flag is not accepted):
  --pass-command "<cmd>"         run <cmd> (split into arguments, no shell); first stdout line is the password
                                 [MAILPROOF_PASS_COMMAND], e.g. --pass-command "pass show mailproof/gmail_pass"
  --pass-file <path>             file holding the password [MAILPROOF_PASS_FILE]
  (neither)                      read the password from stdin when stdin is not a terminal
  --access-token-command "<cmd>" OAuth2: first stdout line is a fresh access token (XOAUTH2)
                                 [MAILPROOF_ACCESS_TOKEN_COMMAND]
  -h, --help                     this text

Output: one JSON line on stdout (the sync result). Errors go to stderr.

Exit codes:
  0   run finished. A partial run (a cap was hit, "complete": false, no error) also exits 0: the next
      run continues from the saved cursor.
  75  try again later: another sync or writer holds the lock (ERR_SYNC_LOCKED, ERR_TRAIL_LOCKED), server
      unreachable or TLS failed (ERR_IMAP_CONNECT), timeout, throttled, UIDVALIDITY changed, secret command failed
  77  login refused (ERR_IMAP_AUTH)
  64  bad usage
  1   anything else (for example a missing folder or a record() failure)
`;

class UsageError extends Error {}

/** Split a command line into argv: whitespace separated, with '...' and "..." quoting and backslash escapes. No shell. */
export function splitCommand(/** @type {string} */ s) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let has = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) throw new UsageError('unterminated quote in command');
  if (has) out.push(cur);
  return out;
}

/** @param {string} cmd @returns {Promise<string>} first line of stdout */
function runSecretCommand(cmd, /** @type {string} */ what) {
  const argv = splitCommand(cmd);
  if (!argv.length) throw new UsageError(`${what} is empty`);
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => {
      // never echo the command's stderr or stdout: either could hold the secret
      if (err) return reject(Object.assign(new Error(`${what} failed (${/** @type {any} */ (err).code ?? err.name})`), { code: 'EX_SECRET_COMMAND' }));
      resolve(String(stdout).split('\n')[0]);
    });
  });
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.split('\n')[0];
}

async function main() {
  const env = process.env;
  let v;
  try {
    ({ values: v } = parseArgs({
      options: {
        'trail-dir': { type: 'string' }, trail: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
        user: { type: 'string' }, folders: { type: 'string' }, sent: { type: 'string' },
        'pass-command': { type: 'string' }, 'pass-file': { type: 'string' }, 'access-token-command': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (e) { throw new UsageError(/** @type {Error} */ (e).message); }
  if (v.help) { process.stdout.write(USAGE); return 0; }

  const trailDir = v['trail-dir'] ?? env.MAILPROOF_TRAIL_DIR;
  const user = v.user ?? env.MAILPROOF_USER;
  if (!trailDir) throw new UsageError('--trail-dir (or MAILPROOF_TRAIL_DIR) is required');
  if (!user) throw new UsageError('--user (or MAILPROOF_USER) is required');
  const host = v.host ?? env.MAILPROOF_HOST ?? 'imap.gmail.com';
  const portS = v.port ?? env.MAILPROOF_PORT ?? '993';
  if (!/^\d+$/.test(portS) || +portS < 1 || +portS > 65535) throw new UsageError('--port must be an integer 1-65535');
  const folders = (v.folders ?? env.MAILPROOF_FOLDERS ?? 'INBOX').split(',').map((f) => f.trim()).filter(Boolean);
  if (!folders.length) throw new UsageError('--folders needs at least one folder');
  const sentS = (v.sent ?? env.MAILPROOF_SENT ?? 'on').toLowerCase();
  if (!['on', 'off'].includes(sentS)) throw new UsageError('--sent must be on or off');

  const tokenCmd = v['access-token-command'] ?? env.MAILPROOF_ACCESS_TOKEN_COMMAND;
  const passCmd = v['pass-command'] ?? env.MAILPROOF_PASS_COMMAND;
  const passFile = v['pass-file'] ?? env.MAILPROOF_PASS_FILE;
  if (tokenCmd && (passCmd || passFile)) throw new UsageError('give an access-token command or a password source, not both');
  if (passCmd && passFile) throw new UsageError('give --pass-command or --pass-file, not both');

  const mp = (() => {
    try { return new Mailproof({ trailDir, trail: v.trail ?? env.MAILPROOF_TRAIL }); }
    catch (e) { throw new UsageError(/** @type {Error} */ (e).message); }
  })();
  try {
    /** @type {{ pass: string } | { accessToken: string }} */
    let auth;
    if (tokenCmd) {
      const accessToken = (await runSecretCommand(tokenCmd, 'access-token command')).trim();
      if (!accessToken) throw new UsageError('the access-token command printed nothing');
      auth = { accessToken };
    } else {
      let raw;
      if (passCmd) raw = await runSecretCommand(passCmd, 'pass command');
      else if (passFile) {
        try { raw = (await fs.readFile(passFile, 'utf8')).split('\n')[0]; }
        catch (e) { throw new UsageError(`cannot read --pass-file: ${/** @type {any} */ (e).code ?? 'error'}`); }
      } else if (!process.stdin.isTTY) raw = await readStdin();
      else throw new UsageError('no password source: use --pass-command, --pass-file or pipe it on stdin');
      // Google shows app passwords in groups with spaces; the spaces are not part of the password
      const pass = raw.replace(/\s+/g, '');
      if (!pass) throw new UsageError('the password source gave an empty password');
      auth = { pass };
    }

    let result;
    try {
      result = await mp.sync({ host, port: +portS, user, auth, folders, sent: sentS === 'on' });
    } catch (e) {
      if (e instanceof TypeError) throw new UsageError(e.message);
      throw e;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    const bad = result.folders.find((f) => f.error);
    if (!bad) return 0; // complete, or partial because a cap was hit: the next run continues
    process.stderr.write(`mailproof-sync: ${bad.folder}: ${bad.error?.code}: ${bad.error?.message}\n`);
    return exitFor(bad.error?.code);
  } finally {
    await mp.close();
  }
}

/** @param {string | undefined} code */
function exitFor(code) {
  switch (code) {
    case 'ERR_SYNC_LOCKED': case 'ERR_TRAIL_LOCKED': case 'ERR_IMAP_CONNECT': case 'ERR_IMAP_TIMEOUT':
    case 'ERR_IMAP_THROTTLED': case 'ERR_IMAP_UIDVALIDITY': case 'EX_SECRET_COMMAND':
      return EX_TEMPFAIL;
    case 'ERR_IMAP_AUTH': return EX_NOPERM;
    default: return 1;
  }
}

main().then((c) => { process.exitCode = c; }, (e) => {
  if (e instanceof UsageError) {
    process.stderr.write(`mailproof-sync: ${e.message}\nTry "mailproof-sync --help".\n`);
    process.exitCode = EX_USAGE;
  } else {
    process.stderr.write(`mailproof-sync: ${e?.code ? e.code + ': ' : ''}${e?.message ?? e}\n`);
    process.exitCode = exitFor(e?.code);
  }
});
