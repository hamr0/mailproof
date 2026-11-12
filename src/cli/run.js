// The dispatcher (SPEC B11.1): arguments in, an exit code out. Every command, from the shell or from the menu, goes
// through `run()`. It never calls process.exit and never reads process.* itself: the Ctx carries the streams.

import { parseArgs } from 'node:util';
import { UsageError, EX_OK, EX_USAGE, exitForError } from './errors.js';
import { COMMANDS, GLOBAL_FLAGS } from './commands.js';
import { renderList, renderCommand } from './help.js';
import { print, warn } from './session.js';
import { printable as p } from './printable.js';
import { listCmd, peopleCmd, showCmd, verifyCmd, repliesCmd, checkCmd, forgetCmd, pruneCmd } from './ops.js';
import { syncCmd, updateCmd, configCmd, mcpCmd, stampCmd, version } from './misc.js';
import { exportCmd, verifyBundleCmd } from './bundle.js';
import { watchCmd } from './watch.js';
import { backupCmd } from './backup.js';
import { statusCmd } from './status.js';
import { runMenu } from './menu.js';
import { ID_HINT } from './target.js';
import { styleOf } from './style.js';
import { expandHome } from './paths.js';

/** The setup guide, where an error hint points. */
export const GUIDE_URL = 'https://github.com/hamr0/mailproof/blob/main/docs/product/setup-guide.md';
/** One line of advice per error code that has a well-known fix (SPEC B11.7a). */
const HINTS = {
  ERR_IMAP_AUTH: 'the server refused the login: check the account\'s password source (for Gmail an app password, not your account password)',
  ERR_IMAP_CONNECT: 'cannot reach the mail server: check the host, the port and your network',
  EX_SECRET_COMMAND: 'the command that yields the password or token failed: run it by hand to see why',
};

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
async function helpCmd(a, ctx) {
  if (a.positionals.length) {
    const text = renderCommand(a.positionals[0]);
    if (!text) throw new UsageError(`unknown command "${a.positionals[0]}"`);
    ctx.stdout.write(text);
  } else ctx.stdout.write(renderList());
  return EX_OK;
}

/** @type {Record<string, (a: Args, ctx: Ctx) => Promise<number>>} */
const HANDLERS = {
  sync: syncCmd, watch: watchCmd, list: listCmd, people: peopleCmd, show: showCmd, verify: verifyCmd, replies: repliesCmd, check: checkCmd, forget: forgetCmd, prune: pruneCmd,
  backup: backupCmd, stamp: stampCmd, status: statusCmd, update: updateCmd, config: configCmd, export: exportCmd, 'verify-bundle': verifyBundleCmd, mcp: mcpCmd, help: helpCmd,
};

/** The commands that have a handler (a test checks the table and the handlers name the same ones). */
export const HANDLER_NAMES = Object.keys(HANDLERS);

/** @param {Record<string, import('./commands.js').FlagSpec>} flags @returns {Record<string, { type: 'string' | 'boolean', short?: string }>} */
const optionsOf = (flags) => Object.fromEntries(Object.entries(flags).map(([k, f]) => [k, { type: f.type, ...(f.short ? { short: f.short } : {}) }]));

/**
 * A leading `~` in a path argument is the home directory (a quoted `--out=~/x` or a menu answer never went through the shell): every flag the
 * command table marks `path`, and a path positional.
 * @param {import('./commands.js').CommandSpec} spec
 * @param {{ values: Record<string, any>, positionals: string[] }} parsed
 * @param {Record<string, string | undefined>} env
 */
function expandPaths(spec, parsed, env) {
  for (const [name, f] of Object.entries({ ...GLOBAL_FLAGS, ...spec.flags })) {
    if (f.path && typeof parsed.values[name] === 'string') parsed.values[name] = expandHome(parsed.values[name], env);
  }
  if (spec.pathPositional && parsed.positionals[0] !== undefined) parsed.positionals[0] = expandHome(parsed.positionals[0], env);
}

/**
 * The command named in an argument list: the first positional, looking past the global flags that take a value.
 * @param {string[]} argv
 * @returns {{ cmd: string | null, index: number }}
 */
export function detectCommand(argv) {
  const { tokens } = parseArgs({ args: argv, options: optionsOf(GLOBAL_FLAGS), allowPositionals: true, strict: false, tokens: true });
  const t = tokens.find((x) => x.kind === 'positional');
  return t ? { cmd: /** @type {string} */ (t.value), index: t.index } : { cmd: null, index: -1 };
}

/**
 * Run one command line.
 * @param {string[]} argv  Without `node` and the script.
 * @param {Ctx} ctx
 * @returns {Promise<number>} The exit code.
 */
export async function run(argv, ctx) {
  /** @type {string | null} */
  let cmd = null;
  try {
    if (argv.includes('--version')) { print(ctx, `mailproof ${version()}`); return EX_OK; }
    const found = detectCommand(argv);
    cmd = found.cmd;
    if (cmd === null) {
      const help = argv.includes('-h') || argv.includes('--help');
      if (help) { ctx.stdout.write(renderList()); return EX_OK; }
      if (ctx.interactive && ctx.stdin) {
        const { values } = parseArgs({ args: argv, options: optionsOf(GLOBAL_FLAGS), allowPositionals: false, strict: true });
        return runMenu(ctx, (v, c) => run(v, c), { configFlag: typeof values.config === 'string' ? expandHome(values.config, ctx.env) : undefined });
      }
      ctx.stdout.write(renderList());
      return EX_USAGE;
    }
    if (!Object.hasOwn(COMMANDS, cmd)) throw new UsageError(`unknown command "${cmd}"`);
    const spec = COMMANDS[cmd];
    const rest = argv.filter((_, i) => i !== found.index);
    /** @type {{ values: Record<string, any>, positionals: string[] }} */
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...optionsOf(GLOBAL_FLAGS), ...optionsOf(spec.flags) }, allowPositionals: true, strict: true });
    } catch (e) {
      const m = /** @type {Error} */ (e).message.replace(/\. To specify a positional argument starting with a '-'.*$/, '');
      const hex = /^Unknown option '--[0-9a-fA-F]+'/.test(m) && ['show', 'verify', 'check'].includes(cmd);
      throw new UsageError(hex ? `${m}. ${ID_HINT}` : m);
    }
    if (parsed.values.help) { ctx.stdout.write(/** @type {string} */ (renderCommand(cmd))); return EX_OK; }
    expandPaths(spec, parsed, ctx.env);
    if (parsed.positionals.length < spec.min) throw new UsageError(`${cmd} needs ${spec.positional || 'no arguments'}`);
    if (parsed.positionals.length > spec.max) throw new UsageError(`${cmd}: unexpected argument "${parsed.positionals[spec.max]}"`);
    return await HANDLERS[cmd]({ cmd, values: parsed.values, positionals: parsed.positionals }, ctx);
  } catch (e) {
    return report(e, cmd, ctx);
  }
}

/**
 * One human line on stderr (a UsageError adds where to look), and the exit code.
 * @param {unknown} e
 * @param {string | null} cmd
 * @param {Ctx} ctx
 * @returns {number}
 */
function report(e, cmd, ctx) {
  const err = /** @type {{ code?: string, message?: string }} */ (e);
  if (e instanceof UsageError) warn(ctx, `mailproof: ${p(e.message, { keepNewline: true })}\nsee: mailproof help${cmd && Object.hasOwn(COMMANDS, cmd) ? ` ${cmd}` : ''}`);
  else warn(ctx, `mailproof: ${err?.code && !/^ERR_|^EX_/.test(String(err.message)) ? `${p(err.code)}: ` : ''}${p(err?.message ?? e, { keepNewline: true })}`);
  const hint = typeof err?.code === 'string' && Object.hasOwn(HINTS, err.code) ? HINTS[/** @type {keyof typeof HINTS} */ (err.code)] : null;
  if (hint) {
    const st = styleOf(ctx, 'stderr');
    warn(ctx, `  ${st.dim('hint:')} ${hint}; ${st.links ? st.link('setup guide', GUIDE_URL) : `see ${GUIDE_URL}`}`);
  }
  return exitForError(e);
}
