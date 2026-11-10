// The git binary via child_process (no wrapper library): the few plumbing
// calls the ledgers need, one execFile each.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const _execFile = promisify(execFile);

// Git author for ledger commits. Cosmetic: the proof is the commit chain and
// its content, not the author. Neutral + non-routable (RFC 2606 .invalid).
const GIT_IDENTITY = { name: 'mailproof', email: 'noreply@mailproof.invalid' };

/**
 * Run a git subcommand in `cwd`; resolve trimmed stdout, reject with git's stderr.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBuffer?: number, config?: string[] }} [opts]  `maxBuffer` (bytes of stdout) overrides the 16 MB default for this call only; `config` is `key=value` pairs passed as `git -c` for this call only.
 * @returns {Promise<string>}  Rejects with the original error as `cause`.
 */
async function git(cwd, args, opts = {}) {
  try {
    const { stdout } = await _execFile('git', [...(opts.config ?? []).flatMap((c) => ['-c', c]), ...args], { cwd, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = /** @type {{ stderr?: string, message?: string }} */ (err);
    const detail = (e.stderr || '').trim() || e.message;
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause: err });
  }
}

/**
 * Run a git subcommand in `cwd` and hand its stdout to `onLine` one `sep`-terminated record at a time, as it arrives:
 * the output is never held whole, so it has no size ceiling (`git()` buffers and stops at `maxBuffer`). Chunks are
 * pulled through an async iterator, so a slow `onLine` (one that returns a promise) pauses git's pipe. `onLine` may
 * return `false` to stop early or throw to abort; either kills git, and the child is always reaped before this
 * resolves or rejects (no process or fd is left behind).
 * @param {string} cwd
 * @param {string[]} args
 * @param {(line: string) => unknown} onLine  A line without its separator (a final unterminated piece counts as a line). May be async.
 * @param {{ sep?: string, config?: string[] }} [opts]  `sep` is the record separator (default `\n`; use `\0` for `-z` output); `config` is `key=value` pairs passed as `git -c`.
 * @returns {Promise<void>}  Resolves when git exits 0 (or on early stop); rejects like `git()`: `git <subcommand> failed: <stderr>`, with the original error as `cause`.
 */
async function gitLines(cwd, args, onLine, opts = {}) {
  const sep = opts.sep ?? '\n';
  const child = spawn('git', [...(opts.config ?? []).flatMap((c) => ['-c', c]), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += d; });
  /** @type {Promise<{ code: number | null, signal: string | null, error?: Error }>} */
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stopped = false;
  let finished = false; // stdout reached EOF: git is exiting by itself, never kill it then
  /** @type {{ code: number | null, signal: string | null, error?: Error } | undefined} */
  let res;
  try {
    child.stdout.setEncoding('utf8'); // a decoder keeps a multi-byte character split across chunks whole
    let rest = '';
    outer: for await (const chunk of child.stdout) {
      rest += chunk;
      let start = 0;
      for (let i = rest.indexOf(sep, start); i >= 0; i = rest.indexOf(sep, start)) {
        let r = onLine(rest.slice(start, i));
        if (r instanceof Promise) r = await r;
        start = i + sep.length;
        if (r === false) { stopped = true; break outer; }
      }
      rest = rest.slice(start);
    }
    if (!stopped && rest) { const r = onLine(rest); if (r instanceof Promise) await r; }
    finished = !stopped;
  } finally {
    if (!finished && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    res = await closed;
  }
  const { code, signal, error } = res;
  if (stopped) return;
  if (error || code !== 0) {
    const detail = stderr.trim() || error?.message || (signal ? `killed by ${signal}` : `exit code ${code}`);
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause: error ?? new Error(detail) });
  }
}

export { git, gitLines, GIT_IDENTITY };
