// TEST-ONLY. A throw-away world for the `mailproof` CLI: its own config dir, state dir and home (so the real
// ~/.config and ~/.local/state are never touched), a config file with mode 0600, and two ways to run a command line:
// in-process (injected streams and deps, no IMAP ever) or as a spawned child. NEVER imported from src/.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { run } from '../../src/cli/run.js';
import { makeTmpDir } from './tmp.js';

// OpenTimestamps is on by default (SPEC B13.1.1), so a CLI test that syncs would run the job and the machine's real `ots`
// would reach the public calendars. Every world's PATH starts with a stub `ots` that only fails: no test touches the network.
const stubDir = makeTmpDir('mp-cli-ots-stub-');
fs.writeFileSync(path.join(stubDir, 'ots'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });

export const BIN = path.resolve(import.meta.dirname, '../../bin/mailproof.js');

/**
 * @param {{ accounts?: Record<string, object>, config?: object | null }} [o]  `accounts`: merged into a `{ v: 1, accounts }` config; `config: null` writes no file.
 */
export function makeWorld({ accounts, config } = {}) {
  const root = makeTmpDir('mp-cli-world-');
  const home = path.join(root, 'home');
  const cfgDir = path.join(root, 'cfg');
  const state = path.join(root, 'state');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: cfgDir, XDG_STATE_HOME: state, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` };
  const configFile = path.join(cfgDir, 'mailproof', 'config.json');
  const write = (json, mode = 0o600) => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.rmSync(configFile, { force: true });
    fs.writeFileSync(configFile, typeof json === 'string' ? json : JSON.stringify(json, null, 2), { mode });
    fs.chmodSync(configFile, mode);
  };
  if (config !== null) write(config ?? { v: 1, accounts: accounts ?? {} });
  const world = {
    root, home, cfgDir, state, env, configFile, write,
    stateDir: path.join(state, 'mailproof'),
    /** In-process: no IMAP, streams captured. `input`: scripted stdin lines; `tty`/`columns`/`stderrTty`: what the output streams claim to be (style.js reads them). */
    async run(argv, { input, interactive = false, deps = {}, euid, env: extra, signal, tty = false, columns, stderrTty = false } = {}) {
      const out = []; const err = [];
      const ctx = {
        stdout: { write: (s) => { out.push(Buffer.from(s)); return true; }, isTTY: tty, ...(columns ? { columns } : {}) },
        stderr: { write: (s) => { err.push(Buffer.from(s)); return true; }, isTTY: stderrTty },
        stdin: input === undefined ? null : Readable.from([input]),
        interactive, env: { ...env, ...extra }, euid, signal: signal ?? new AbortController().signal,
        // the network is never reached from a test: a wizard login test and a menu "check a .eml" fail loudly unless the test injects its own
        deps: { testLogin: async () => { throw new Error('IMAP must not be contacted from a test'); }, check: async () => { throw new Error('DNS must not be asked from a test'); }, ...deps },
      };
      const code = await run(argv, ctx);
      return { code, stdout: Buffer.concat(out).toString(), stdoutBytes: Buffer.concat(out), stderr: Buffer.concat(err).toString() };
    },
    /** A spawned `bin/mailproof.js`. */
    spawn(argv, { input = '', env: extra = {} } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, ...argv], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
        const out = []; const err = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stdoutBytes: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
        child.stdin.end(input);
      });
    },
  };
  return world;
}

/** The account entry for a trail directory (the secret is a command that is never run in these tests). */
export const account = (trailDir, extra = {}) => ({ user: 'me@owner.example', host: 'imap.test', trailDir, passCommand: 'echo not-used', ...extra });

export const lines = (s) => s.split('\n').filter(Boolean);
