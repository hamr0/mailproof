// The process side of `mailproof`: real streams, real signals, the exit code. Everything else is in run.js.

import { run, detectCommand } from './run.js';

/**
 * @param {NodeJS.Process} proc
 * @returns {Promise<number>}
 */
export async function main(proc) {
  const argv = proc.argv.slice(2);
  const ac = new AbortController();
  const interactive = Boolean(proc.stdin.isTTY && proc.stdout.isTTY);
  // `watch` and `mcp` are the long-running commands: the first signal lets the work in progress finish, the second exits at once.
  // The menu handles Ctrl-C itself; any other command is simply ended by the signal.
  let signals = 0;
  const onSignal = () => { if (++signals > 1) proc.exit(130); else ac.abort(); };
  if (['watch', 'mcp'].includes(detectCommand(argv).cmd ?? '')) for (const s of /** @type {const} */ (['SIGINT', 'SIGTERM'])) proc.on(s, onSignal);
  proc.stdout.on('error', () => {});   // a closed pipe (| head) is not an error
  return run(argv, {
    stdout: proc.stdout, stderr: proc.stderr, stdin: proc.stdin, interactive, env: proc.env, signal: ac.signal, deps: {},
  });
}
