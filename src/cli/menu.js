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
import { defaultBundleOut } from './bundle.js';
import { stateDir } from './state.js';
import { classifyTarget } from './target.js';
import { styleOf } from './style.js';
import { headerFacts } from './status.js';
import { mainHeader, firstRun, MAIN_ITEMS, MORE_ITEMS } from './menu-header.js';
import { checkFileCmd } from './check-file.js';
import { configPath } from './config.js';

/** @typedef {import('./session.js').Ctx} Ctx */

/** Every command the menu can run, by number (the action line shows 1-7, `?` lists 8-17) and by name. */
/** @type {Map<string, string>} */
const BY_KEY = new Map([...MAIN_ITEMS.map(([k, cmd]) => /** @type {[string, string]} */ ([k, cmd])), ...MORE_ITEMS.map(([k, cmd]) => /** @type {[string, string]} */ ([k, cmd]))]);
/** @type {Map<string, string>} */
const BY_NAME = new Map([...[...BY_KEY.values()].map((c) => /** @type {[string, string]} */ ([c, c])), ['seal', 'stamp']]);

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
  const st = styleOf(ctx);
  const now = () => (ctx.deps.now ?? (() => new Date()))();
  /** The home directory shown as `~`. @param {string} f */
  const tilde = (f) => { const h = ctx.env.HOME; return h && f.startsWith(`${h}/`) ? `~${f.slice(h.length)}` : f; };
  /**
   * The screen when there is no config: set up an account, check a saved .eml, verify a bundle.
   * @returns {Promise<import('./config.js').Config | number>}  The config once an account exists, or the menu's exit code.
   */
  const firstRunScreen = async () => {
    for (;;) {
      out('');
      for (const l of firstRun(st, { version: version(), configFile: tilde(configPath(opts.configFlag, ctx.env)) })) out(l);
      const choice = await p.ask('> ');
      if (choice === null) return 0;
      const c = choice.trim().toLowerCase();
      if (c === 'q') return 0;
      if (c === '') continue;
      try {
        if (c === '1') {
          await exec([...pre, 'config', 'add-account'], base);
          try { return (await loadCtxConfig(cfgArgs, ctx)).config; } catch { continue; }
        } else if (c === '2') {
          await checkFileCmd(await ask({ label: 'Path of the .eml file', example: 'e.g. ~/Downloads/mail.eml' }), base).catch((e) => { warn(ctx, `mailproof: ${/** @type {Error} */ (e).message}`); });
        } else if (c === '3') {
          await exec([...pre, 'verify-bundle', await ask({ label: 'Bundle directory', example: 'the directory mailproof export wrote' })], base);
        } else if (c === '?' || c === 'h') await exec([...pre, 'help'], base);
        else out(`not a menu item: ${c}`);
      } catch (e) {
        if (e instanceof Cancel) { if (e.reason === 'eof') return 0; out('cancelled'); continue; }
        throw e;
      }
      if ((await p.ask('Press Enter ')) === null) return 0;
    }
  };
  try {
    // the config is needed before anything: a missing one starts the first-run screen, an untrusted or invalid one is said once, clearly
    /** @type {import('./config.js').Config} */
    let config;
    try { ({ config } = await loadCtxConfig(cfgArgs, ctx)); }
    catch (e) {
      if (!(e instanceof UsageError) || !/no config file/.test(e.message)) { err(`mailproof: ${/** @type {Error} */ (e).message}`); return EX_USAGE; }
      const got = await firstRunScreen();
      if (typeof got === 'number') return got;
      config = got;
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

    /** The export questions for the given addresses (shared by the Export item and People). @param {string} who */
    const exportFor = async (who) => {
      const after = await askDate('After', '--after', 'date, e.g. 2026-01-01, empty = from the beginning');
      const before = await askDate('Before', '--before', 'date, e.g. 2026-08-19, empty = until now');
      const dflt = defaultBundleOut(account, (ctx.deps.now ?? (() => new Date()))(), false);
      const outPath = await ask({ label: 'Write the bundle to', example: 'a new directory', def: dflt });
      const tar = await confirm(p, 'Also pack it into one .tar file for mailing?');
      await go(['export', '--with', who, ...(after ? ['--after', after] : []), ...(before ? ['--before', before] : []), ...(outPath === dflt ? [] : ['--out', outPath]), ...(tar ? ['--tar'] : [])]);
    };
    /** One target: an address, a Message-ID or a record id. */
    const askTarget = () => ask({ label: 'Target', example: 'an address like bob@example.org, a <message-id>, or a record id (8+ hex)', validate: (s) => { classifyTarget(s); return s.trim(); } });

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
      show: async () => { await go(['show', await askTarget()]); },
      verify: async () => {
        const target = await askTarget();
        const at = await askDate('At', '--at', 'judge as of this date, empty = the capture time');
        await go(['verify', target, ...(at ? ['--at', at] : [])]);
      },
      people: async () => {
        // the table is the `people` command's own text, numbered here so a row can be picked; the rows come from the same `people --json`
        /** @type {string[]} */
        const chunks = [];
        const code = await exec([...pre, 'people', '--json', '--account', account], { ...base, stdout: { write: (x) => { chunks.push(String(x)); return true; } } });
        if (code !== 0) return;
        /** @type {Array<{ address: string, emails: number, verified: number, you: boolean }>} */
        const people = JSON.parse(chunks.join(''));
        if (!people.length) { out('no emails recorded'); return; }
        /** @type {string[]} */
        const text = [];
        await exec([...pre, 'people', '--account', account], { ...base, stdout: { write: (x) => { text.push(String(x)); return true; }, isTTY: ctx.stdout.isTTY, ...(ctx.stdout.columns ? { columns: ctx.stdout.columns } : {}) } });
        text.join('').split('\n').filter(Boolean).forEach((l, i) => out(i === 0 ? `    ${l}` : `${String(i).padStart(3)} ${l}`));
        out(st.dim('pick a person (number or address), then ') + `${st.cyan('s')} show  ${st.cyan('v')} verify  ${st.cyan('e')} export`);
        const ACTIONS = /** @type {Record<string, string>} */ ({ s: 'show', show: 'show', v: 'verify', verify: 'verify', e: 'export', export: 'export' });
        const answer = await ask({ label: 'Person', example: 'a number or an address, then s, v or e (default show), e.g. 3 v', validate: (line) => {
          const tokens = line.trim().split(/\s+/);
          const act = tokens.length > 1 && Object.hasOwn(ACTIONS, tokens[tokens.length - 1].toLowerCase()) ? ACTIONS[tokens.pop()?.toLowerCase() ?? 's'] : 'show';
          if (tokens.length !== 1) throw new UsageError('give one person, then optionally s, v or e');
          const first = tokens[0];
          const n = /^\d+$/.test(first) ? people[Number(first) - 1]?.address : undefined;
          if (/^\d+$/.test(first) && !n) throw new UsageError(`choose 1 to ${people.length}`);
          return `${n ?? parseAddress(first, 'Person')} ${act}`;
        } });
        const [pick, what] = answer.split(' ');
        if (what === 'export') await exportFor(pick); else await go([what, pick]);
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
      export: async () => {
        await exportFor(await ask({ label: 'With', example: 'exact addresses, comma separated, e.g. bob@example.org,bob@work.example', validate: (s) => { s.split(',').map((x) => parseAddress(x.trim(), 'With')); return s; } }));
      },
      stamp: async () => { await go(['stamp']); },
      mcp: async () => { await go(['mcp']); },
    };

    let showHeader = true;
    for (;;) {
      if (showHeader) {
        out('');
        /** @type {Awaited<ReturnType<typeof headerFacts>> | null} */
        let f = null;
        try { f = await headerFacts(config.accounts[account], ctx); } catch { /* a broken trail still gets a menu */ }
        const h = { version: version(), user: config.accounts[account].user, account, trailOk: false, lastSync: null, records: null, seal: { state: /** @type {const} */ ('off'), nextDue: null }, watch: false, ...f, manyAccounts: names.length > 1 };
        for (const l of mainHeader(st, h, now())) out(l);
      }
      showHeader = true;
      const choice = await p.ask('> ');
      if (choice === null) return 0;
      const c = choice.trim().toLowerCase();
      if (c === 'q') return 0;
      if (c === '') continue;
      if (c === 'h') { await exec([...pre, 'help'], base); continue; }
      if (c === '?') {
        for (const [k, cmd] of MORE_ITEMS) out(`${st.cyan(k.padStart(3))} ${cmd.padEnd(8)} ${st.dim(summaryOf(cmd))}`);
        out(st.dim('type a number or a name, h for the full help'));
        showHeader = false;
        continue;
      }
      if ((c === 'a' || c === 'b') && names.length > 1) { account = await pickAccount(); continue; }
      const cmd = BY_KEY.get(c) ?? BY_NAME.get(c);
      if (!cmd) { out(`not a menu item: ${c}`); showHeader = false; continue; }
      try { await handlers[cmd](); }
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
