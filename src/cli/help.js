// `mailproof help`: rendered from the generated table (SPEC B11.11); nothing here describes a command itself.

import { HELP } from './help.generated.js';

/** @param {string} s @param {number} width @returns {string} */
function wrap(s, width) {
  const out = [];
  let line = '';
  for (const w of s.split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}

/** @param {import('./help.generated.js').HelpFlag[]} flags @returns {string} */
function flagLines(flags) {
  const rows = flags.map((f) => [`  ${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.arg ? ` ${f.arg}` : ''}`, f.help]);
  const w = Math.max(0, ...rows.map((r) => r[0].length)) + 2;
  return rows.map(([a, b]) => `${a.padEnd(w)}${b}`).join('\n');
}

/**
 * The command list.
 * @returns {string}
 */
export function renderList() {
  const names = Object.keys(HELP.commands);
  const w = Math.max(...names.map((n) => n.length)) + 2;
  return [
    'Usage: mailproof [command] [flags]',
    '',
    'With no command on a terminal, mailproof shows a menu. Commands:',
    '',
    ...names.map((n) => `  ${n.padEnd(w)}${HELP.commands[n].summary}`),
    '',
    'Global flags (before or after the command):',
    flagLines(HELP.globalFlags),
    '',
    'Run "mailproof help <command>" for one command. Exit codes: 0 done, 2 a check ran and the answer is no,',
    '64 bad usage, 75 try again later, 77 permission or login refused, 1 anything else.',
    '',
  ].join('\n');
}

/**
 * One command's help, or null for an unknown command.
 * @param {string} name
 * @returns {string | null}
 */
export function renderCommand(name) {
  const c = Object.hasOwn(HELP.commands, name) ? HELP.commands[name] : null;
  if (!c) return null;
  return [
    `Usage: ${c.usage}`,
    '',
    wrap(c.when, 100),
    ...(c.flags.length ? ['', 'Flags:', flagLines(c.flags)] : []),
    ...(c.account ? ['', 'Also: --account <name>, --config <path>, --json, -h/--help'] : []),
    ...(c.fails ? ['', 'Fails:', wrap(c.fails, 100)] : []),
    '',
  ].join('\n');
}

/** @returns {string[]} */
export const commandNames = () => Object.keys(HELP.commands);

/** @param {string} name @returns {string} The menu label of a command. */
export const summaryOf = (name) => HELP.commands[name]?.summary ?? '';
