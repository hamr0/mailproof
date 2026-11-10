// The menu (SPEC B11.4): `mailproof` with no arguments on a terminal. Every item asks for exactly the parameters of
// its subcommand, builds that subcommand's argument vector and hands it to the same dispatcher: there is no second
// implementation. The streams are injected, so a test drives it with scripted input.

import { UsageError, EX_USAGE } from './errors.js';
import { createPrompter, askValue, confirm, Cancel, isTerminal } from './prompt.js';
import { parseDate, parseAddress, parseDuration, parseSent, parseFolders, parseChoice, MIN_INTERVAL_MS, FULL_ID_RE, messageIdOf } from './parse.js';
import { loadCtxConfig, print, warn } from './session.js';
import { summaryOf } from './help.js';
import { defaultBundlePath, PUSH_WARNING, redactUrl } from './backup.js';
import { version } from './misc.js';
import { stateDir } from './state.js';

/** @typedef {import('./session.js').Ctx} Ctx */

/** The numbered items: key, command, label. The description comes from the help table. */
const ITEMS = [
  ['1', 'sync', 'Sync now'], ['2', 'watch', 'Watch'], ['3', 'list', 'List emails'], ['4', 'show', 'Show one email'], ['5', 'verify', 'Verify one email'],
  ['6', 'replies', 'Replies to a message'], ['7', 'check', 'Check against profile'], ['8', 'forget', 'Forget'], ['9', 'prune', 'Prune'], ['10', 'backup', 'Backup'],
  ['11', 'status', 'Status'], ['12', 'update', 'Update mailproof'], ['13', 'config', 'Config'], ['14', 'export', 'Export'],
];

/** @param {string} s @returns {string} */
const idArg = (s) => {
  const t = s.trim().toLowerCase();
  if (!FULL_ID_RE.test(t) && !/^[0-9a-f]{8,31}$/.test(t)) throw new UsageError('give 32 hex characters, or a unique prefix of at least 8');
  return t;
};

/**
 * @param {Ctx} ctx
 * @param {(argv: string[], ctx: Ctx) => Promise<number>} exec  The dispatcher: runs an argument vector, returns its exit code.
 * @param {{ configFlag?: string }} [opts]
 * @returns {Promise<number>}  The menu's own exit code: 0 on quit, 64 when it cannot start.
 */
export async function runMenu(ctx, exec, opts = {}) {
  if (!ctx.stdin) return EX_USAGE;
  const p = createPrompter(ctx.stdin, ctx.stdout, isTerminal(ctx));
  const out = (/** @type {string} */ s) => print(ctx, s);   // through the output backstop (F28)
  const err = (/** @type {string} */ s) => warn(ctx, s);
  /** @type {Ctx} */
  const base = { ...ctx, prompter: p };
  /** @param {import('./prompt.js').ValueSpec} spec */
  const ask = (spec) => askValue(p, ctx.stdout, spec);
  const pre = opts.configFlag ? ['--config', opts.configFlag] : [];
  const cfgArgs = { cmd: '', values: { config: opts.configFlag }, positionals: /** @type {string[]} */ ([]) };
  /** An optional date prompt. @param {string} label @param {string} flag @param {string} [example] */
  const askDate = (label, flag, example = 'date, e.g. 2026-08-19') => ask({ label, example, optional: true, validate: (s) => { parseDate(s, flag); return s; } });
  try {
    // the config is needed before anything: a missing or untrusted one is said once, clearly
    /** @type {import('./config.js').Config} */
    let config;
    try { ({ config } = await loadCtxConfig(cfgArgs, ctx)); }
    catch (e) {
      err(`mailproof: ${/** @type {Error} */ (e).message}`);
      if (!(e instanceof UsageError) || !/no config file/.test(e.message)) return EX_USAGE;
      if (!(await confirm(p, 'Create it now with the account wizard?', true))) return EX_USAGE;
      await exec([...pre, 'config', 'add-account'], base);
      try { ({ config } = await loadCtxConfig(cfgArgs, ctx)); } catch { return EX_USAGE; }
    }
    const names = Object.keys(config.accounts);
    const pickAccount = async () => (names.length === 1 ? names[0] : ask({
      label: 'Account', example: names.join('/'), validate: (s) => { if (!names.includes(s)) throw new UsageError(`choose one of ${names.join(', ')}`); return s; },
    }));
    let account = await pickAccount();

    /** Run a command with the account, Ctrl-C cutting the command and not the menu. @param {string[]} argv @returns {Promise<number>} */
    const go = async (argv) => {
      const ac = new AbortController();
      p.onInterrupt(() => ac.abort());
      try { return await exec([...pre, ...argv, '--account', account], { ...base, signal: ac.signal }); }
      finally { p.onInterrupt(null); }
    };
    /** Type the account name to confirm a destructive step. @returns {Promise<boolean>} */
    const typedName = async () => {
      const ans = await p.ask(`Type the account name (${account}) to proceed, anything else cancels: `);
      if (ans !== null && ans.trim() === account) return true;
      out('nothing changed');
      return false;
    };
    /** @param {string[]} argv The destructive command with its parameters: summary first, then the typed name, then --yes. */
    const destructive = async (argv) => {
      await go([...argv, '--dry-run']);
      if (await typedName()) await go([...argv, '--yes']);
    };

    /** @type {Record<string, () => Promise<void>>} */
    const handlers = {
      sync: async () => {
        const folders = await ask({ label: 'Folders', example: 'comma separated, empty = the account\'s', optional: true, validate: (s) => { parseFolders(s); return s; } });
        const sent = await ask({ label: 'Sent', example: 'on, off or a folder path, empty = the account\'s', optional: true, validate: (s) => { parseSent(s); return s; } });
        await go(['sync', ...(folders ? ['--folders', folders] : []), ...(sent ? ['--sent', sent] : [])]);
      },
      watch: async () => {
        const interval = await ask({ label: 'Interval', example: '30s, 5m, 1h', def: '5m', validate: (s) => { parseDuration(s, 'Interval', ctx.deps.minIntervalMs ?? MIN_INTERVAL_MS); return s; } });
        await go(['watch', '--interval', interval]);
      },
      list: async () => {
        const who = await ask({ label: 'With', example: 'email address, e.g. bob@example.org, empty = everyone', optional: true, validate: (s) => parseAddress(s, 'With') });
        const role = who ? await ask({ label: 'Role', example: 'from, to, cc, reply-to, empty = any', optional: true, validate: (s) => parseChoice(s, 'Role', 'from', 'to', 'cc', 'reply-to') }) : '';
        const direction = await ask({ label: 'Direction', example: 'in, out, empty = both', optional: true, validate: (s) => parseChoice(s, 'Direction', 'in', 'out') });
        const before = await askDate('Before', '--before', 'date, e.g. 2026-08-19, empty = no limit');
        const after = await askDate('After', '--after', 'date, e.g. 2026-01-01, empty = no limit');
        const limit = await ask({ label: 'Limit', example: 'a number, 0 = all', def: '50', validate: (s) => { if (!/^\d+$/.test(s)) throw new UsageError('a whole number'); return s; } });
        await go(['list', ...(who ? ['--with', who] : []), ...(role ? ['--role', role] : []), ...(direction ? ['--direction', direction] : []), ...(before ? ['--before', before] : []), ...(after ? ['--after', after] : []), '--limit', limit]);
      },
      show: async () => { await go(['show', await ask({ label: 'Id', example: '32 hex characters, or a unique prefix of 8 or more', validate: idArg })]); },
      verify: async () => {
        const id = await ask({ label: 'Id', example: '32 hex characters, or a unique prefix of 8 or more', validate: idArg });
        const at = await askDate('At', '--at', 'judge as of this date, empty = the capture time');
        await go(['verify', id, ...(at ? ['--at', at] : [])]);
      },
      replies: async () => { await go(['replies', await ask({ label: 'Message-ID', example: 'the request\'s, e.g. <q-123@mail.example>', validate: (s) => messageIdOf(s) })]); },
      check: async () => {
        const id = await ask({ label: 'Id', example: '32 hex characters, or a unique prefix of 8 or more', validate: idArg });
        const profile = await ask({ label: 'Profile', example: 'a JSON file path, or a name in the profiles directory' });
        const parent = await ask({ label: 'Request Message-ID', example: 'for a profile that requires a link, empty = none', optional: true });
        await go(['check', id, '--profile', profile, ...(parent ? ['--parent', parent] : [])]);
      },
      forget: async () => {
        const ids = await ask({ label: 'Ids', example: 'record ids separated by spaces; empty = by person', optional: true, validate: (s) => { s.split(/\s+/).forEach(idArg); return s; } });
        if (ids) { await destructive(['forget', ...ids.split(/\s+/)]); return; }
        const who = await ask({ label: 'With', example: 'email address, e.g. bob@example.org', validate: (s) => parseAddress(s, 'With') });
        const before = await askDate('Before', '--before');
        const after = await askDate('After', '--after');
        await destructive(['forget', '--with', who, ...(before ? ['--before', before] : []), ...(after ? ['--after', after] : [])]);
      },
      prune: async () => {
        const before = await ask({ label: 'Before', example: 'date, e.g. 2026-08-19', validate: (s) => { parseDate(s, '--before'); return s; } });
        const del = await confirm(p, 'Also delete the pre-prune backup afterwards (the removal is only final then)?');
        await destructive(['prune', '--before', before, ...(del ? ['--delete-backup'] : [])]);
      },
      backup: async () => {
        const dflt = defaultBundlePath(stateDir(ctx.env), account, (ctx.deps.now ?? (() => new Date()))());
        const outPath = await ask({ label: 'Write the bundle to', example: 'a path', def: dflt });
        const content = await confirm(p, 'Also archive the content store (other people\'s mail, not encrypted)?');
        const remote = config.accounts[account].backupRemote;
        const push = remote ? await confirm(p, `Also push to ${redactUrl(remote)}?`) : false;
        if (push) {
          out(PUSH_WARNING);
          if (!(await confirm(p, 'Is that remote one you trust to hold that?'))) { out('nothing changed'); return; }
        }
        await go(['backup', ...(outPath === dflt ? [] : ['--out', outPath]), ...(content ? ['--with-content'] : []), ...(push ? ['--push', '--yes'] : [])]);
      },
      status: async () => { await go(['status']); },
      update: async () => {
        await go(['update']);
        if (await confirm(p, 'Run it now?')) await go(['update', '--run']);
      },
      config: async () => {
        const action = await ask({ label: 'Action', example: 'path, validate, template, add-account', def: 'validate', validate: (s) => parseChoice(s, 'Action', 'path', 'validate', 'template', 'add-account') });
        await go(['config', action]);
      },
      export: async () => { await go(['export']); },
    };

    for (;;) {
      out(`\nmailproof ${version()}   account: ${account}${names.length > 1 ? '  [b: change]' : ''}`);
      for (const [k, cmd, label] of ITEMS) out(`${k.padStart(2)}) ${label.padEnd(22)} ${summaryOf(cmd)}`);
      out(' h) Help      q) Quit');
      const choice = await p.ask('> ');
      if (choice === null) return 0;
      const c = choice.trim().toLowerCase();
      if (c === 'q') return 0;
      if (c === '') continue;
      if (c === 'h') { await exec([...pre, 'help'], base); continue; }
      if (c === 'b' && names.length > 1) { account = await pickAccount(); continue; }
      const item = ITEMS.find(([k]) => k === c);
      if (!item) { out(`not a menu item: ${c}`); continue; }
      try { await handlers[item[1]](); }
      catch (e) {
        if (e instanceof Cancel) { if (e.reason === 'eof') return 0; out('cancelled'); continue; }
        throw e;
      }
      if ((await p.ask('Press Enter ')) === null) return 0;
    }
  } catch (e) {
    if (e instanceof Cancel) return 0;
    throw e;
  } finally { p.close(); }
}
