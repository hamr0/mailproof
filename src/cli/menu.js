// The menu (SPEC B11.4): `mailproof` with no arguments on a terminal. Every item asks for exactly the parameters of
// its subcommand, builds that subcommand's argument vector and hands it to the same dispatcher: there is no second
// implementation. The streams are injected, so a test drives it with scripted input.

import { UsageError, EX_USAGE } from './errors.js';
import { createPrompter, askValue, confirm, Cancel, isTerminal } from './prompt.js';
import { parseDate, parseAddress, parseDuration, parseSent, parseFolders, parseChoice, MIN_INTERVAL_MS, FULL_ID_RE, messageIdOf } from './parse.js';
import { loadCtxConfig, print, warn } from './session.js';
import { defaultBundlePath, PUSH_WARNING, redactUrl } from './backup.js';
import { version } from './misc.js';
import { defaultBundleOut } from './bundle.js';
import { stateDir } from './state.js';
import { classifyTarget } from './target.js';
import { styleOf } from './style.js';
import { makePager } from './pager.js';
import { headerFacts } from './status.js';
import { mainHeader, fullMenu, shortLine, firstRun, MENU_ITEMS, MENU_ALIASES } from './menu-header.js';
import { checkFileCmd } from './check-file.js';
import { configPath } from './config.js';

/** @typedef {import('./session.js').Ctx} Ctx */

/** Every command the menu can run, by number (1-19) and by name (its label, its command, an alias). */
/** @type {Map<string, string>} */
const BY_KEY = new Map(MENU_ITEMS.map((i) => [i.key, i.cmd]));
/** @type {Map<string, string>} */
const BY_NAME = new Map([...MENU_ITEMS.flatMap((i) => [[i.label, i.cmd], [i.cmd, i.cmd]]), ...MENU_ALIASES].map(([n, c]) => /** @type {[string, string]} */ ([n, c])));

/** The command a menu answer selects: a number 1-19, a label, a command name or an alias; undefined when it is none of them. @param {string} c @returns {string | undefined} */
export const menuCommand = (c) => BY_KEY.get(c) ?? BY_NAME.get(c);

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
  const st = styleOf(ctx);
  const rawPrompter = createPrompter(ctx.stdin, ctx.stdout, isTerminal(ctx));
  // on a terminal an action's output is held back and paged (pager.js); on a pipe there is no pager and the menu keeps its "Press Enter" step
  const pager = ctx.stdout.isTTY === true ? makePager(ctx.stdout, rawPrompter, st) : null;
  const p = pager ? pager.prompter : rawPrompter;
  const outStream = pager ? pager.stream : ctx.stdout;
  const errStream = pager ? { write: (/** @type {string} */ s) => { pager.flush(); return ctx.stderr.write(s); }, ...(ctx.stderr.isTTY !== undefined ? { isTTY: ctx.stderr.isTTY } : {}), ...(ctx.stderr.columns ? { columns: ctx.stderr.columns } : {}) } : ctx.stderr;
  /** @type {Ctx} */
  const base = { ...ctx, stdout: outStream, stderr: errStream, prompter: p };
  const out = (/** @type {string} */ s) => print(base, s);   // through the output backstop (F28)
  const err = (/** @type {string} */ s) => warn(base, s);
  /** @param {import('./prompt.js').ValueSpec} spec */
  const ask = (spec) => askValue(p, outStream, spec, st);
  /** A y/N question in the stream's style. @param {string} q @param {boolean} [d] */
  const askYes = (q, d) => confirm(p, q, d, st);
  const pre = opts.configFlag ? ['--config', opts.configFlag] : [];
  const cfgArgs = { cmd: '', values: { config: opts.configFlag }, positionals: /** @type {string[]} */ ([]) };
  /** An optional date prompt. @param {string} label @param {string} flag @param {string} [example] */
  const askDate = (label, flag, example = 'date, e.g. {2026-08-19}') => ask({ label, example, optional: true, validate: (s) => { parseDate(s, flag); return s; } });
  const now = () => (ctx.deps.now ?? (() => new Date()))();
  /** The home directory shown as `~`. @param {string} f */
  const tilde = (f) => { const h = ctx.env.HOME; return h && f.startsWith(`${h}/`) ? `~${f.slice(h.length)}` : f; };
  /** After an action: on a terminal show its output (paged when long); on a pipe ask for Enter. @returns {Promise<boolean>} False when the input ended. */
  const afterAction = async () => (pager ? pager.show() : (await p.ask('Press Enter ')) !== null);
  /** Check a saved .eml: the same path as the first-run screen, nothing is recorded. */
  const checkEml = async () => { await checkFileCmd(await ask({ label: 'Path of the .eml file', example: 'e.g. {~/Downloads/mail.eml}' }), base).catch((e) => { warn(base, `mailproof: ${/** @type {Error} */ (e).message}`); }); };
  /** Verify a bundle: the `verify-bundle` subcommand, which needs no account. */
  const verifyBundleCmd = async () => { await exec([...pre, 'verify-bundle', await ask({ label: 'Bundle directory', example: 'the directory mailproof export wrote' })], base); };
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
          await checkEml();
        } else if (c === '3') {
          await verifyBundleCmd();
        } else if (c === '?' || c === 'h') await exec([...pre, 'help'], base);
        else out(`not a menu item: ${c}`);
      } catch (e) {
        if (e instanceof Cancel) { if (e.reason === 'eof') return 0; out('cancelled'); continue; }
        throw e;
      }
      if (!(await afterAction())) return 0;
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
      label: 'Account', example: names.map((n) => `{${n}}`).join('/'), validate: (s) => { if (!names.includes(s)) throw new UsageError(`choose one of ${names.join(', ')}`); return s; },
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
      const after = await askDate('After', '--after', 'date, e.g. {2026-01-01}, empty = from the beginning');
      const before = await askDate('Before', '--before', 'date, e.g. {2026-08-19}, empty = until now');
      const dflt = defaultBundleOut(account, (ctx.deps.now ?? (() => new Date()))(), false);
      const outPath = await ask({ label: 'Write the bundle to', example: 'a new directory', def: dflt });
      const tar = await askYes('Also pack it into one .tar file for mailing?');
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
        const who = await ask({ label: 'With', example: 'email address, e.g. {bob@example.org}, empty = everyone', optional: true, validate: (s) => parseAddress(s, 'With') });
        const role = who ? await ask({ label: 'Role', example: 'from, to, cc, reply-to, empty = any', optional: true, validate: (s) => parseChoice(s, 'Role', 'from', 'to', 'cc', 'reply-to') }) : '';
        const direction = await ask({ label: 'Direction', example: 'in, out, empty = both', optional: true, validate: (s) => parseChoice(s, 'Direction', 'in', 'out') });
        const before = await askDate('Before', '--before', 'date, e.g. {2026-08-19}, empty = no limit');
        const after = await askDate('After', '--after', 'date, e.g. {2026-01-01}, empty = no limit');
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
        text.join('').split('\n').filter(Boolean).forEach((l, i) => out(i === 0 ? `    ${l}` : `${' '.repeat(Math.max(0, 3 - String(i).length))}${st.key(String(i))} ${l}`));
        out(st.dim('pick a person (number or address), then ') + `${st.key('s')} show  ${st.key('v')} verify  ${st.key('e')} export`);
        const ACTIONS = /** @type {Record<string, string>} */ ({ s: 'show', show: 'show', v: 'verify', verify: 'verify', e: 'export', export: 'export' });
        const answer = await ask({ label: 'Person', example: 'a number or an address, then {s}, {v} or {e} (default show), e.g. {3 v}', validate: (line) => {
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
      replies: async () => { await go(['replies', await ask({ label: 'Message-ID', example: 'the request\'s, e.g. {<q-123@mail.example>}', validate: (s) => messageIdOf(s) })]); },
      check: async () => {
        const id = await ask({ label: 'Id', example: '32 hex characters, or a unique prefix of 8 or more', validate: idArg });
        const profile = await ask({ label: 'Profile', example: 'a JSON file path, or a name in the profiles directory' });
        const parent = await ask({ label: 'Request Message-ID', example: 'for a profile that requires a link, empty = none', optional: true });
        await go(['check', id, '--profile', profile, ...(parent ? ['--parent', parent] : [])]);
      },
      forget: async () => {
        const ids = await ask({ label: 'Ids', example: 'record ids separated by spaces; empty = by person', optional: true, validate: (s) => { s.split(/\s+/).forEach(idArg); return s; } });
        if (ids) { await destructive(['forget', ...ids.split(/\s+/)]); return; }
        const who = await ask({ label: 'With', example: 'email address, e.g. {bob@example.org}', validate: (s) => parseAddress(s, 'With') });
        const before = await askDate('Before', '--before');
        const after = await askDate('After', '--after');
        await destructive(['forget', '--with', who, ...(before ? ['--before', before] : []), ...(after ? ['--after', after] : [])]);
      },
      prune: async () => {
        const before = await ask({ label: 'Before', example: 'date, e.g. {2026-08-19}', validate: (s) => { parseDate(s, '--before'); return s; } });
        const del = await askYes('Also delete the pre-prune backup afterwards (the removal is only final then)?');
        await destructive(['prune', '--before', before, ...(del ? ['--delete-backup'] : [])]);
      },
      backup: async () => {
        const dflt = defaultBundlePath(stateDir(ctx.env), account, (ctx.deps.now ?? (() => new Date()))());
        const outPath = await ask({ label: 'Write the bundle to', example: 'a path', def: dflt });
        const content = await askYes('Also archive the content store (other people\'s mail, not encrypted)?');
        const remote = config.accounts[account].backupRemote;
        const push = remote ? await askYes(`Also push to ${redactUrl(remote)}?`) : false;
        if (push) {
          out(PUSH_WARNING);
          if (!(await askYes('Is that remote one you trust to hold that?'))) { out('nothing changed'); return; }
        }
        await go(['backup', ...(outPath === dflt ? [] : ['--out', outPath]), ...(content ? ['--with-content'] : []), ...(push ? ['--push', '--yes'] : [])]);
      },
      status: async () => { await go(['status']); },
      update: async () => {
        await go(['update']);
        if (await askYes('Run it now?')) await go(['update', '--run']);
      },
      config: async () => {
        const action = await ask({ label: 'Action', example: 'path, validate, template, add-account', def: 'validate', validate: (s) => parseChoice(s, 'Action', 'path', 'validate', 'template', 'add-account') });
        await go(['config', action]);
      },
      export: async () => {
        await exportFor(await ask({ label: 'With', example: 'exact addresses, comma separated, e.g. {bob@example.org,bob@work.example}', validate: (s) => { s.split(',').map((x) => parseAddress(x.trim(), 'With')); return s; } }));
      },
      stamp: async () => { await go(['stamp']); },
      'check-file': checkEml,
      'verify-bundle': verifyBundleCmd,
      mcp: async () => { await go(['mcp']); },
    };

    // what the next turn prints above the `>`: the header and the full menu at the start; after an action the short line (on a
    // terminal, with the two header lines first when the action changed state; on a pipe the whole header); nothing after `?`
    // (its list stays the last thing shown)
    /** @type {'full' | 'header' | 'refresh' | 'compact' | 'none'} */
    let mode = 'full';
    const LIVE = new Set(['watch', 'sync', 'update', 'mcp']);   // long-running: output streams, it is not held back
    const CHANGES_STATE = new Set(['sync', 'stamp', 'update', 'forget', 'prune', 'config']);
    /** @param {boolean} changed @returns {'header' | 'refresh' | 'compact'} */
    const nextMode = (changed) => (!pager ? 'header' : changed ? 'refresh' : 'compact');
    for (;;) {
      if (mode === 'compact') out(shortLine(st, names.length > 1));
      else if (mode !== 'none') {
        if (mode === 'full' || mode === 'header') out('');
        /** @type {Awaited<ReturnType<typeof headerFacts>> | null} */
        let f = null;
        try { f = await headerFacts(config.accounts[account], ctx); } catch { /* a broken trail still gets a menu */ }
        const h = { version: version(), user: config.accounts[account].user, account, trailOk: false, lastSync: null, records: null, seal: { state: /** @type {const} */ ('off'), nextDue: null }, watch: false, ...f, manyAccounts: names.length > 1 };
        const lines = mainHeader(st, h, now());
        for (const l of mode === 'refresh' ? [lines[1], lines[2]] : lines) out(l);
        if (mode === 'full') for (const l of fullMenu(st, names.length > 1)) out(l); else out(shortLine(st, names.length > 1));
      }
      mode = 'full';
      const choice = await p.ask('> ');
      if (choice === null) return 0;
      const c = choice.trim().toLowerCase();
      if (c === 'q') return 0;
      if (c === '') continue;
      if (c === 'h') {
        await exec([...pre, 'help'], base);
        if (pager) { if (!(await pager.show())) return 0; mode = 'compact'; }
        continue;
      }
      if (c === '?') {
        for (const l of fullMenu(st, names.length > 1)) out(l);
        if (pager && !(await pager.show())) return 0;
        mode = 'none';
        continue;
      }
      if ((c === 'a' || c === 'b') && names.length > 1) { account = await pickAccount(); mode = nextMode(true); if (pager && !(await pager.show())) return 0; continue; }
      const cmd = menuCommand(c);
      if (!cmd) { out(`not a menu item: ${c}`); if (pager && !(await pager.show())) return 0; mode = 'none'; continue; }
      pager?.setLive(LIVE.has(cmd));
      try { await handlers[cmd](); }
      catch (e) {
        pager?.setLive(false);
        if (e instanceof Cancel) { if (e.reason === 'eof') return 0; out('cancelled'); if (pager && !(await pager.show())) return 0; mode = nextMode(false); continue; }
        throw e;
      }
      pager?.setLive(false);
      if (!(await afterAction())) return 0;
      mode = nextMode(CHANGES_STATE.has(cmd));
    }
  } catch (e) {
    if (e instanceof Cancel) return 0;
    throw e;
  } finally { p.close(); }
}
