// `config add-account` (SPEC B11.2, B11.12): an interactive wizard. Provider first (Gmail, Outlook/Hotmail, other IMAP), then each field with a
// hint, default and validation; for a password file that does not exist yet it offers to create it (mode 0600, the secret typed with the echo
// off, never printed, never stored in the config); it can test the login before anything is written, shows the account JSON and writes the
// config only after an explicit yes: atomically, mode 0600, other accounts kept. The config never holds a password: only the command, file
// or token command that yields one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageError, EX_OK, EX_USAGE } from './errors.js';
import { createPrompter, askValue, confirm, Cancel, isTerminal } from './prompt.js';
import { printable } from './printable.js';
import { ACCOUNT_NAME_RE, readTrustedFile, validateConfig, writeConfigAtomic, expandHome } from './config.js';
import { parseFolders, parseSent } from './parse.js';
import { print, warn } from './session.js';
import { styleOf } from './style.js';
import { resolveAuth } from './secrets.js';
import { testLogin } from './login-test.js';
import { TRAIL_NAME_RE } from '../proof/trail.js';

/** @param {string} s @returns {string} */
const yn = (s) => {
  const t = s.toLowerCase();
  if (t === 'y' || t === 'yes') return 'y';
  if (t === 'n' || t === 'no') return 'n';
  throw new UsageError('answer y or n');
};

/** The providers (SPEC B11.12): what the wizard fixes for each. `proven`: tried against a real server (findings F17). */
const PROVIDERS = /** @type {const} */ ({
  1: { name: 'Gmail', host: 'imap.gmail.com' },
  2: { name: 'Outlook/Hotmail', host: 'outlook.office365.com' },
  3: { name: 'other IMAP', host: '' },
});

const SETUP_GUIDE = 'docs/product/setup-guide.md';

/**
 * Create the password file the person pastes into: the directory 0700 when it is new, the file 0600 and never overwritten (`wx`).
 * The secret is written once and not kept.
 * @param {string} file  Absolute.
 * @param {string} secret
 * @returns {Promise<void>}
 */
async function createSecretFile(file, secret) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fh = await fs.open(file, 'wx', 0o600);
  try { await fh.writeFile(`${secret}\n`); await fh.chmod(0o600); } finally { await fh.close(); }
}

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
  const st = styleOf(ctx);
  const { sym } = st;
  /** @param {import('./prompt.js').ValueSpec} spec */
  const ask = (spec) => askValue(p, ctx.stdout, spec);
  /** A question's label, dim. @param {string} s @returns {string} */
  const L = (s) => st.dim(s);
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
    print(ctx, `${st.rule()}\n${st.bold('Set up an account')} ${st.dim(`${sym.dot} nothing is written until you confirm`)}\nAdding to ${file}${exists ? '' : ' (it does not exist yet; it will be created with mode 0600)'}. Answer ? at any prompt for help.\n${st.rule()}`);

    // 1. the provider
    print(ctx, `${L('Mail provider')}  ${st.cyan('1')} Gmail ${st.dim('(app password, proven)')}   ${st.cyan('2')} Outlook/Hotmail ${st.yellow('(OAuth2, untested)')}   ${st.cyan('3')} other IMAP`);
    const provider = /** @type {1 | 2 | 3} */ (Number(await ask({
      label: 'Mail provider', example: '1 = Gmail, 2 = Outlook/Hotmail, 3 = other IMAP', def: '1',
      hint: '1: Gmail with an app password (the proven path). 2: Outlook/Hotmail through OAuth2 (not yet tested with mailproof). 3: any other IMAP server: you give the host.',
      validate: (s) => { if (!['1', '2', '3'].includes(s)) throw new UsageError('answer 1, 2 or 3'); return s; },
    })));
    if (provider === 2) print(ctx, `${st.yellow(`${sym.warn} Outlook/Hotmail is not yet tested with mailproof.`)} Microsoft no longer accepts passwords for IMAP there, so you need a command that prints an OAuth2 token: see ${SETUP_GUIDE} section 4.`);

    const name = await ask({ label: L('Account name'), example: 'letters, digits, - and _, e.g. personal', hint: 'a short name for this mailbox; it names the account in every command (--account NAME)', validate: (s) => { if (!ACCOUNT_NAME_RE.test(s)) throw new UsageError('use [a-z0-9][a-z0-9_-]{0,31}'); return s; } });
    if (Object.hasOwn(base.accounts, name) && !(await confirm(p, `An account named "${name}" already exists. Replace it?`))) {
      print(ctx, 'nothing changed');
      return EX_OK;
    }
    const user = await ask({ label: L('Email address'), example: 'the IMAP user, usually your address, e.g. ana@example.com' });
    /** @type {string} */
    let host = PROVIDERS[provider].host;
    let port = '993';
    if (provider === 3) {
      host = await ask({ label: L('IMAP host'), example: 'e.g. imap.example.org', hint: 'the IMAP server of your provider. TLS is always used.' });
      port = await ask({ label: L('Port'), def: '993', hint: 'the implicit-TLS port, normally 993', validate: (s) => { if (!/^\d+$/.test(s) || +s < 1 || +s > 65535) throw new UsageError('a whole number 1-65535'); return s; } });
    }

    // the secret: a file (Gmail), a token command (Outlook), or the person's choice (other)
    /** @type {'passCommand' | 'passFile' | 'accessTokenCommand'} */
    let secretKey = provider === 1 ? 'passFile' : provider === 2 ? 'accessTokenCommand' : 'passCommand';
    print(ctx, st.dim('mailproof never stores a password; the config names the file or command that yields it.'));
    if (provider === 3) {
      const kind = await ask({
        label: L('Where does the password come from'), example: '1 = a command, 2 = a file, 3 = an OAuth2 token command', def: '1',
        hint: 'mailproof never stores a password. 1: a command that prints it, e.g. "pass show mailproof/personal". 2: a file whose first line is the password (mode 0600). 3: a command that prints a fresh OAuth2 access token.',
        validate: (s) => { if (!['1', '2', '3'].includes(s)) throw new UsageError('answer 1, 2 or 3'); return s; },
      });
      secretKey = /** @type {const} */ ({ 1: 'passCommand', 2: 'passFile', 3: 'accessTokenCommand' })[/** @type {'1' | '2' | '3'} */ (kind)];
    }
    const defaultPassFile = `~/.config/mailproof/${name}.pass`;
    const secret = await ask({
      label: L(secretKey === 'passFile' ? 'Password file' : secretKey === 'passCommand' ? 'Password command' : 'Token command'),
      example: secretKey === 'passFile' ? 'an absolute path or ~/...' : secretKey === 'passCommand' ? `a command that prints it, e.g. pass show mailproof/${name}` : 'a command that prints a fresh access token, e.g. oauth-token --account personal',
      ...(secretKey === 'passFile' ? { def: defaultPassFile } : {}),
      hint: 'Never type the password here: it would be written into the config. Give the command or file that holds it.',
      validate: (s) => { if (secretKey === 'passFile' && !path.isAbsolute(expandHome(s, ctx.env))) throw new UsageError('give an absolute path (or ~/...)'); return s; },
    });
    if (secretKey === 'passFile') {
      const abs = expandHome(secret, ctx.env);
      /** @type {import('node:fs').Stats | null} */
      let info = null;
      try { info = await fs.stat(abs); } catch { /* missing */ }
      if (info) {
        const ok = info.isFile() && (info.mode & 0o077) === 0;
        print(ctx, `${' '.repeat(4)}${ok ? st.green(sym.ok) : st.yellow(sym.warn)} ${secret} ${st.dim(ok ? '(0600, yours)' : '(this file must be mode 0600: run chmod 600 on it, or it is refused)')}`);
      } else if (await confirm(p, `${st.yellow(`${sym.warn} ${secret} not found`)}; create it now? ${st.dim('(a private 0600 file; you paste the app password, nothing is shown)')}`, true)) {
        const pw = await p.askSecret('Paste the password (hidden): ');
        if (pw === null) throw new Cancel('eof');
        if (!pw.trim()) { warn(ctx, 'mailproof: nothing was typed, so no file was created'); } else {
          await createSecretFile(abs, pw.trim());
          print(ctx, `${' '.repeat(4)}${st.green(sym.ok)} ${secret} ${st.dim('(0600, yours)')}`);
        }
      } else print(ctx, st.dim(`create ${secret} before the first sync (a file only you can read, the password on its first line)`));
    }

    // folders, Sent, trail, content, seal
    /** @type {string[]} */
    let folders = ['INBOX'];
    if (provider === 1) {
      print(ctx, st.dim('Archived mail ([Gmail]/All Mail) is your whole history. The first sync then takes longer; a mail in two folders is recorded once.'));
      if ((await ask({ label: L('Include archived mail ([Gmail]/All Mail)'), example: 'y/n', def: 'y', validate: yn })) === 'y') folders = ['INBOX', '[Gmail]/All Mail'];
    } else folders = parseFolders(await ask({ label: L('Folders to read'), example: 'comma separated', def: 'INBOX', validate: (s) => { parseFolders(s); return s; } }));
    const sent = parseSent(await ask({ label: L('Also read Sent mail'), example: 'on, off or a folder path', def: 'on', validate: (s) => { parseSent(s); return s; } }));
    const trailDir = await ask({
      label: L('Trail folder'), def: `~/mailproof/${name}`, hint: 'where the proofs (a git repository) and the content store live; absolute, or starting with ~/',
      validate: (s) => { if (!path.isAbsolute(expandHome(s, ctx.env))) throw new UsageError('must be absolute or start with ~/'); return s; },
    });
    const store = (await ask({ label: L('Keep the raw emails in the local content store'), example: 'y/n', def: 'y', validate: yn })) === 'y';
    const days = store ? await ask({ label: L('Days to keep stored content'), def: '730', validate: (s) => { if (!/^[1-9]\d*$/.test(s)) throw new UsageError('a positive whole number'); return s; } }) : '730';
    const ots = (await ask({ label: L('Seal records with OpenTimestamps'), example: 'y/n; sends one 32-byte hash per run to public calendars, never content or addresses; needs the ots binary', def: 'y', validate: yn })) === 'y';
    // the rarely changed settings
    let trail = 'default';
    let attachments = true;
    let remote = '';
    if ((await ask({ label: L('Advanced settings (trail name, attachments, backup remote)'), example: 'y/n', def: 'n', validate: yn })) === 'y') {
      trail = await ask({ label: L('Trail name'), def: 'default', validate: (s) => { if (!TRAIL_NAME_RE.test(s)) throw new UsageError('use [a-z0-9][a-z0-9_-]{0,63}'); return s; } });
      if (store) attachments = (await ask({ label: L('Keep attachments too'), example: 'y/n', def: 'y', validate: yn })) === 'y';
      remote = await ask({ label: L('Backup remote for "backup --push"'), example: 'a git URL, empty = none', optional: true });
    }

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
    if (!ots) acct.ots = false;   // on is the default (SPEC B13.1.1): only the off switch is written
    if (remote) acct.backupRemote = remote;

    const next = { ...base, v: 1, accounts: { ...base.accounts, [name]: acct } };
    const { config: checked, problems } = validateConfig(next, ctx.env);
    if (problems.length || !checked) { warn(ctx, `mailproof: the account is not valid, nothing was written:\n${printable(problems.join('\n'), { keepNewline: true })}`); return EX_USAGE; }

    // test the login before writing: one login, a folder status, never a record
    print(ctx, st.rule());
    if (await confirm(p, `${L('Test login now?')}`, true)) {
      const account = checked.accounts[name];
      try {
        const auth = await resolveAuth(account.secret);
        const r = await (ctx.deps.testLogin ?? testLogin)({ host: account.host, port: account.port, user: account.user, auth, folders: account.folders, sent: account.sent });
        if (r.ok) print(ctx, `${st.green(`${sym.ok} IMAP login ok`)} ${st.dim(`${sym.dot} ${r.folders.map((f) => `${printable(f.folder.split('/').pop())} up to ${f.count.toLocaleString('en-US')}`).join(` ${sym.dot} `)}`)}`);
        else print(ctx, `${st.red(`${sym.bad} login failed`)} (${printable(r.code)}): ${printable(r.message)}`);
      } catch (e) {
        print(ctx, `${st.red(`${sym.bad} cannot test the login`)}: ${printable(/** @type {Error} */ (e)?.message ?? e)}`);
      }
    }
    print(ctx, `\nThis account would be added to ${file}:\n${printable(JSON.stringify({ [name]: acct }, null, 2), { keepNewline: true })}\n`);
    if (!(await confirm(p, `Write it to ${file}?`))) { print(ctx, 'nothing written'); return EX_OK; }
    await writeConfigAtomic(file, next);
    print(ctx, `${st.green(`${sym.ok} written`)} ${file} ${st.dim('(mode 0600)')}`);
    if (await confirm(p, `${L('First sync now?')}`, true)) {
      const { run } = await import('./run.js');
      return run(['sync', '--account', name, '--config', file], { ...ctx, ...(own ? {} : { prompter: ctx.prompter }) });
    }
    print(ctx, `${st.dim('Next:')} mailproof status --account ${name}   then   mailproof sync --account ${name}`);
    return EX_OK;
  } catch (e) {
    if (e instanceof Cancel) { warn(ctx, `mailproof: ${e.message}; nothing was written`); return EX_USAGE; }
    throw e;
  } finally { if (own) p.close(); }
}
