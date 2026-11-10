// Line prompts on stdin/stdout (stdlib readline), shared by the menu and the `config add-account` wizard. Input comes
// through a queue, so scripted stdin works the same as a terminal, and the end of input is a value (null), never a hang.

import readline from 'node:readline';
import { UsageError } from './errors.js';
import { printable } from './printable.js';

/** Output backstop for what a prompt writes (typed input is echoed back, validators quote it): F28. @param {string} s @returns {string} */
const safe = (s) => printable(s, { keepNewline: true, keepBackslash: true });

/** Raised when the person cannot be asked any more: the input ended, Ctrl-C at a prompt, or three bad answers. */
export class Cancel extends Error {
  /** @param {'eof' | 'tries'} reason */
  constructor(reason) { super(reason === 'eof' ? 'input ended' : 'too many invalid answers'); this.reason = reason; }
}

/**
 * Whether the streams are really a terminal (line editing needs the real TTY streams); `ctx.interactive` only says the menu may start.
 * @param {{ stdin: NodeJS.ReadableStream | null, stdout: { isTTY?: boolean } }} ctx
 * @returns {boolean}
 */
export const isTerminal = (ctx) => ctx.stdout.isTTY === true && /** @type {{ isTTY?: boolean } | null} */ (ctx.stdin)?.isTTY === true;

/**
 * @typedef {Object} Prompter
 * @property {(label: string) => Promise<string | null>} ask  One line, or null when the input ended.
 * @property {(fn: (() => void) | null) => void} onInterrupt  What Ctrl-C does while a command runs (null: end the input).
 * @property {() => void} close
 */

/**
 * @param {NodeJS.ReadableStream} input
 * @param {{ write: (s: string) => unknown }} output
 * @param {boolean} terminal
 * @returns {Prompter}
 */
export function createPrompter(input, output, terminal) {
  // a terminal needs the real output stream for line editing; otherwise the prompts are written here and readline only reads
  const rl = readline.createInterface({ input, output: terminal ? /** @type {any} */ (output) : undefined, terminal, prompt: '' });
  /** @type {string[]} */
  const queue = [];
  /** @type {((l: string | null) => void) | null} */
  let waiter = null;
  let closed = false;
  /** @type {(() => void) | null} */
  let interrupt = null;
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  rl.on('SIGINT', () => { if (interrupt) interrupt(); else rl.close(); });
  return {
    ask(label) {
      if (terminal) {
        if (closed) return Promise.resolve(null);
        rl.setPrompt(label);
        rl.prompt();
        return new Promise((resolve) => { waiter = resolve; });
      }
      // not a terminal: nothing echoes the typed line, so it is echoed here and a transcript reads like a session
      output.write(safe(label));
      /** @param {string | null} l */
      const echo = (l) => { output.write(`${safe(l ?? '')}\n`); return l; };
      if (queue.length) return Promise.resolve(echo(/** @type {string} */ (queue.shift())));
      if (closed) return Promise.resolve(echo(null));
      return new Promise((resolve) => { waiter = (l) => resolve(echo(l)); });
    },
    onInterrupt(fn) { interrupt = fn; },
    close() { rl.close(); },
  };
}

/**
 * @typedef {Object} ValueSpec
 * @property {string} label  `With`
 * @property {string} [example]  `email address, e.g. bob@example.org, empty = everyone`
 * @property {string} [def]  The default: an empty answer takes it.
 * @property {boolean} [optional]  An empty answer is allowed and gives ''.
 * @property {string} [hint]  Printed for `?`.
 * @property {(s: string) => string} [validate]  Throws UsageError with the reason.
 */

/**
 * Ask for one value (SPEC B11.4): label, example and default in brackets, `?` re-prints the hint, a bad value prints
 * the reason and asks again, three bad answers give up.
 * @param {Prompter} p
 * @param {{ write: (s: string) => unknown }} out
 * @param {ValueSpec} spec
 * @returns {Promise<string>}
 * @throws {Cancel}
 */
export async function askValue(p, out, spec) {
  const label = `${spec.label}${spec.example ? ` (${spec.example})` : ''}${spec.def !== undefined && spec.def !== '' ? ` [${spec.def}]` : ''}: `;
  for (let tries = 0; tries < 3;) {
    const ans = await p.ask(label);
    if (ans === null) throw new Cancel('eof');
    const t = ans.trim();
    if (t === '?') { out.write(`${safe(spec.hint ?? spec.example ?? 'no further help')}\n`); continue; }
    if (t === '') {
      if (spec.def !== undefined) return spec.def;
      if (spec.optional) return '';
      out.write('a value is needed\n');
      tries++;
      continue;
    }
    try { return spec.validate ? spec.validate(t) : t; }
    catch (e) {
      if (!(e instanceof UsageError)) throw e;
      out.write(`${safe(e.message)}\n`);
      tries++;
    }
  }
  throw new Cancel('tries');
}

/**
 * y/N question.
 * @param {Prompter} p
 * @param {string} question
 * @param {boolean} [defYes]
 * @returns {Promise<boolean>}  False for anything but yes, and for the end of input.
 */
export async function confirm(p, question, defYes = false) {
  const ans = await p.ask(`${question} ${defYes ? '[Y/n]' : '[y/N]'} `);
  if (ans === null) return false;
  const t = ans.trim().toLowerCase();
  return t === '' ? defYes : t === 'y' || t === 'yes';
}
