// `config add-account` (SPEC B11.2, B11.12): an interactive wizard. It asks for each field with a hint, default and
// validation, shows the account JSON, and writes the config only after an explicit yes: atomically, mode 0600, other
// accounts kept. It never asks for a password: only the command, file or token command that yields one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageError, EX_OK, EX_USAGE } from './errors.js';
import { createPrompter, askValue, confirm, Cancel, isTerminal } from './prompt.js';
import { printable } from './printable.js';
import { ACCOUNT_NAME_RE, readTrustedFile, validateConfig, writeConfigAtomic, expandHome } from './config.js';
import { parseFolders, parseSent } from './parse.js';
import { print, warn } from './session.js';
import { TRAIL_NAME_RE } from '../proof/trail.js';

/** @param {string} s @returns {string} */
const yn = (s) => {
  const t = s.toLowerCase();
  if (t === 'y' || t === 'yes') return 'y';
  if (t === 'n' || t === 'no') return 'n';
  throw new UsageError('answer y or n');
};

/**
 * @param {import('./session.js').Args} a
 * @param {import('./session.js').Ctx} ctx
 * @param {string} file  The config path.
 * @returns {Promise<number>}
 */
export async function addAccountWizard(a, ctx, file) {
  if (!ctx.stdin) throw new UsageError('config add-account needs input (a terminal or piped answers)');
  const own = !ctx.prompter;
  const p = ctx.prompter ?? createPrompter(ctx.stdin, ctx.stdout, isTerminal(ctx));
  /** @param {import('./prompt.js').ValueSpec} spec */
  const ask = (spec) => askValue(p, ctx.stdout, spec);
  try {
    // the existing file first: it must be trusted, and valid, or it is not rewritten
    /** @type {{ v: number, accounts: Record<string, unknown> }} */
    let base = { v: 1, accounts: {} };
    let exists = true;
    try { await fs.access(file); } catch { exists = false; }
    if (exists) {
      const text = await readTrustedFile(file, { euid: ctx.euid });
      /** @type {any} */
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new UsageError(`config ${file} is not valid JSON, so it is not rewritten: ${/** @type {Error} */ (e).message}`); }
      const { problems } = validateConfig(json, ctx.env);
      if (problems.length) throw new UsageError(`config ${file} has problems, so it is not rewritten:\n${problems.join('\n')}`);
      base = json;
    }
    print(ctx, `Adding an account to ${file}${exists ? '' : ' (it does not exist yet; it will be created with mode 0600)'}.\nAnswer ? at any prompt for help. Nothing is written until you confirm at the end.\n`);

    const name = await ask({ label: 'Account name', example: 'letters, digits, - and _, e.g. personal', validate: (s) => { if (!ACCOUNT_NAME_RE.test(s)) throw new UsageError('use [a-z0-9][a-z0-9_-]{0,31}'); return s; } });
    if (Object.hasOwn(base.accounts, name) && !(await confirm(p, `An account named "${name}" already exists. Replace it?`))) {
      print(ctx, 'nothing changed');
      return EX_OK;
    }
    const user = await ask({ label: 'IMAP user', example: 'usually your email address, e.g. ana@example.com' });
    const host = await ask({ label: 'IMAP host', def: 'imap.gmail.com', hint: 'Gmail: imap.gmail.com. Microsoft 365 / Outlook: outlook.office365.com. TLS is always used.' });
    const port = await ask({ label: 'Port', def: '993', hint: 'the implicit-TLS port, normally 993', validate: (s) => { if (!/^\d+$/.test(s) || +s < 1 || +s > 65535) throw new UsageError('a whole number 1-65535'); return s; } });
    const folders = parseFolders(await ask({ label: 'Folders to read', example: 'comma separated', def: 'INBOX', validate: (s) => { parseFolders(s); return s; } }));
    const sent = parseSent(await ask({ label: 'Also read Sent mail', example: 'on, off or a folder path', def: 'on', validate: (s) => { parseSent(s); return s; } }));
    const trailDir = await ask({
      label: 'Trail directory', def: `~/mailproof/${name}`, hint: 'where the proofs (a git repository) and the content store live; absolute, or starting with ~/',
      validate: (s) => { if (!path.isAbsolute(expandHome(s, ctx.env))) throw new UsageError('must be absolute or start with ~/'); return s; },
    });
    const trail = await ask({ label: 'Trail name', def: 'default', validate: (s) => { if (!TRAIL_NAME_RE.test(s)) throw new UsageError('use [a-z0-9][a-z0-9_-]{0,63}'); return s; } });
    print(ctx, 'mailproof never stores a password; the next questions ask for the command, file or token command that yields it, not the password itself.');
    const kind = await ask({
      label: 'Where does the password come from', example: '1 = a command, 2 = a file, 3 = an OAuth2 token command', def: '1',
      hint: 'mailproof never stores a password. 1: a command that prints it, e.g. "pass show mailproof/personal". 2: a file whose first line is the password (mode 0600). 3: a command that prints a fresh OAuth2 access token.',
      validate: (s) => { if (!['1', '2', '3'].includes(s)) throw new UsageError('answer 1, 2 or 3'); return s; },
    });
    const secretKey = /** @type {const} */ ({ 1: 'passCommand', 2: 'passFile', 3: 'accessTokenCommand' })[/** @type {'1' | '2' | '3'} */ (kind)];
    const secret = await ask({
      label: secretKey === 'passFile' ? 'Path of the password file' : 'The command (not the password itself)', example: secretKey === 'passFile' ? '/home/ana/.config/mailproof/personal.pass' : secretKey === 'passCommand' ? 'e.g. pass show mailproof/personal' : 'e.g. oauth-token --account personal',
      hint: 'Never type the password here: it would be written into the config. Give the command or file that holds it.',
      validate: (s) => { if (secretKey === 'passFile' && !path.isAbsolute(expandHome(s, ctx.env))) throw new UsageError('give an absolute path (or ~/...)'); return s; },
    });
    const store = (await ask({ label: 'Keep the raw emails in the local content store', example: 'y/n', def: 'y', validate: yn })) === 'y';
    const attachments = store ? (await ask({ label: 'Keep attachments too', example: 'y/n', def: 'y', validate: yn })) === 'y' : true;
    const days = store ? await ask({ label: 'Days to keep stored content', def: '730', validate: (s) => { if (!/^[1-9]\d*$/.test(s)) throw new UsageError('a positive whole number'); return s; } }) : '730';
    const ots = (await ask({ label: 'Timestamp records with OpenTimestamps (needs the ots binary)', example: 'y/n', def: 'n', validate: yn })) === 'y';
    const remote = await ask({ label: 'Backup remote for "backup --push"', example: 'a git URL, empty = none', optional: true });

    /** @type {Record<string, unknown>} */
    const acct = { user, host };
    if (port !== '993') acct.port = Number(port);
    if (folders.join(',') !== 'INBOX') acct.folders = folders;
    if (sent !== true) acct.sent = sent;
    acct.trailDir = trailDir;
    if (trail !== 'default') acct.trail = trail;
    acct[secretKey] = secret;
    /** @type {Record<string, unknown>} */
    const content = {};
    if (!store) content.store = false;
    if (store && !attachments) content.attachments = false;
    if (store && days !== '730') content.days = Number(days);
    if (Object.keys(content).length) acct.content = content;
    if (ots) acct.ots = true;
    if (remote) acct.backupRemote = remote;

    const next = { ...base, v: 1, accounts: { ...base.accounts, [name]: acct } };
    const { problems } = validateConfig(next, ctx.env);
    if (problems.length) { warn(ctx, `mailproof: the account is not valid, nothing was written:\n${printable(problems.join('\n'), { keepNewline: true })}`); return EX_USAGE; }
    print(ctx, `\nThis account would be added to ${file}:\n${printable(JSON.stringify({ [name]: acct }, null, 2), { keepNewline: true })}\n`);
    if (!(await confirm(p, `Write it to ${file}?`))) { print(ctx, 'nothing written'); return EX_OK; }
    await writeConfigAtomic(file, next);
    print(ctx, `written: ${file} (mode 0600)\nNext: mailproof status --account ${name}   then   mailproof sync --account ${name}`);
    return EX_OK;
  } catch (e) {
    if (e instanceof Cancel) { warn(ctx, `mailproof: ${e.message}; nothing was written`); return EX_USAGE; }
    throw e;
  } finally { if (own) p.close(); }
}
