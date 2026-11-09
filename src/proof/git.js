// The git binary via child_process (no wrapper library): the few plumbing
// calls the ledgers need, one execFile each.

import { execFile } from 'node:child_process';
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

export { git, GIT_IDENTITY };
